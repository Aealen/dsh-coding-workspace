import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { t } from './i18n.js'
import {
  fileTabsSubscribe,
  fileTabsGetSnapshot,
  closeFile,
  setFileDirty,
  activateFile,
  exitSplit,
  attachSessionPane,
  openInPane,
  planDrop,
  planSessionDrop,
  setSplitPreview,
  setSplitRatio,
  type FileTab,
} from './file-tabs.js'
import { alignLines, diffBlocks, type DiffRow } from './panel-diff.js'
import { langOf, highlightLines } from './highlight-hljs.js'
import { TOPBAR_HEIGHT } from './topbar-core.js'
import { DeepSeekIcon } from './session-status.js'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 文件编辑覆盖层:顶部栏「文件 TAB」激活时盖住宿主对话区(centerCol 矩形,
 * top 从顶栏下沿起),内嵌「编辑 / Diff」双视图。挂 shell.overlay additive
 * 第三枚(client.tsx),与 panel/topbar 同 bundle 共享 file-tabs store,
 * 无跨根通信。
 *
 * 布局套路与 topbar 同款:实测 [class*="_centerCol"] 矩形 + ResizeObserver
 * 跟随(侧栏拖宽/面板推挤都会改 rect);拿不到时回落全宽。
 */

/** 插件自有路由 POST(与 panel.tsx postJson 同形态):ok=false 抛 message。 */
async function rpc<T = any>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/dsh-coding-workspace/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json()
  if (!body?.ok) throw new Error(body?.message ?? `${method}: ${res.status}`)
  return body as T
}

/** 宿主 RPC(与 topbar 同形态):会话/工作区清单用。 */
async function apiRpc<T = any>(method: string): Promise<T> {
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {} }),
  })
  const body = await res.json()
  if (!body?.result?.ok) throw new Error(`${method}: ${body?.result?.error?.message ?? res.status}`)
  return body.result.value as T
}

/** 行评论桥:EditorOverlay inject 注入(session scope + conversation input)。 */
interface NoteBridge {
  scope: (sessionId: string) => any
  conversationInput: () => any
}

/** 行评论行数据(服务端 line-notes 路由行)。 */
interface LineNoteRow {
  id: string
  startLine: number
  endLine: number
  text: string
  createdAt: number
}

/** 复制到剪切板:优先 Clipboard API,受限策略/失焦时回退 execCommand(手势内最可靠)。 */
function copyText(text: string): Promise<void> {
  const fallback = (): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => fallback())
  }
  fallback()
  return Promise.resolve()
}

/** 行区间展示:「行 17」/「行 17-20」。 */
function lineRange(n: { startLine: number; endLine: number }): string {
  return n.startLine === n.endLine ? `${n.startLine}` : `${n.startLine}-${n.endLine}`
}

/** 发送/复制共用的评论块(围栏代码块;含 ``` 时升级四反引号)。 */
function buildNoteBlock(relPath: string, n: { startLine: number; endLine: number; text: string }): string {
  const fence = n.text.includes('```') ? '````' : '```'
  const lines = n.startLine === n.endLine ? `Line: ${n.startLine}` : `Lines: ${n.startLine}-${n.endLine}`
  return `${fence}text
File: ${relPath}
${lines}
Comment:
${n.text}
${fence}`
}

/** 某文件行评论的状态与动作(编辑/ diff 两视图共用)。 */
function useLineNotes(cwd: string, relPath: string): {
  notes: LineNoteRow[]
  reload: () => void
  add: (startLine: number, endLine: number, text: string) => Promise<void>
  update: (id: string, text: string) => Promise<void>
  remove: (id: string) => Promise<void>
} {
  const [notes, setNotes] = useState<LineNoteRow[]>([])
  const seqRef = useRef(0)
  const reload = (): void => {
    const seq = ++seqRef.current
    rpc<any>('line-notes', { action: 'list', cwd, path: relPath })
      .then((body) => {
        if (seqRef.current === seq) setNotes(body.notes ?? [])
      })
      .catch(() => {
        /* 服务缺席/失败:评论列表留空,功能降级不阻塞编辑 */
      })
  }
  useEffect(reload, [cwd, relPath])
  const mutate = async (payload: Record<string, unknown>): Promise<void> => {
    const body = await rpc<any>('line-notes', { cwd, path: relPath, ...payload })
    setNotes(body.notes ?? [])
  }
  return {
    notes,
    reload,
    add: (startLine, endLine, text) => mutate({ action: 'add', startLine, endLine, text }),
    update: (id, text) => mutate({ action: 'update', id, text }),
    remove: (id) => mutate({ action: 'delete', id }),
  }
}

let sessionsCache: any[] | null = null
let sessionsInflight: Promise<any[]> | null = null

/**
 * 正在拖拽的 TAB id 与类型(dragstart 由 topbar 写入)。
 * HTML5 安全限制:dragover 阶段 dataTransfer.getData() 恒返回空串(protected
 * mode,只有 drop 能读),所以拖拽中的落位推演只能从模块级变量拿源信息。
 */
let draggingTabId = ''
let draggingKind: 'file' | 'session' = 'file'

/** topbar dragstart 时登记拖拽源;dragend/drop 清空。 */
export function setDraggingTab(id: string, kind: 'file' | 'session'): void {
  draggingTabId = id
  draggingKind = kind
}
function loadSessions(cwd: string): Promise<any[]> {
  if (sessionsCache !== null) return Promise.resolve(sessionsCache)
  if (sessionsInflight === null) {
    sessionsInflight = Promise.all([apiRpc<any>('workspace.list'), apiRpc<any>('session.list')])
      .then(([ws, sl]) => {
        const archived = new Set(Array.isArray(ws?.archivedSessionIds) ? ws.archivedSessionIds : [])
        const norm = (x: unknown): string => (typeof x === 'string' ? x.trim().replace(/\\/g, '/') : '')
        sessionsCache = (sl?.items ?? []).filter(
          (it: any) => it?.origin !== 'subagent' && !archived.has(it.sessionId) && norm(it?.cwd) === norm(cwd),
        )
        return sessionsCache
      })
      .finally(() => {
        sessionsInflight = null
      })
  }
  return sessionsInflight
}

/** 行评论卡片(同文件行聚合):头部行号 + 每条评论(文本 + 发送/编辑/删除)。 */
function NoteCard(props: {
  line: number
  notes: LineNoteRow[]
  relPath: string
  cwd: string
  bridge?: NoteBridge
  onEdit: (n: LineNoteRow) => void
  onDelete: (n: LineNoteRow) => void
}): any {
  const { line, notes, relPath, cwd, bridge } = props
  const [picking, setPicking] = useState<string | null>(null) // 正在展开会话列表的 note id
  const [sessions, setSessions] = useState<any[] | null>(null)
  const [toast, setToast] = useState<string | undefined>(undefined)
  // mount 即预取会话列表(点发送时瞬时显示)
  const iconBtn = (title: string, path: string, onClick: () => void, key: string): any =>
    jsx('button', {
      key,
      title,
      onClick,
      style: {
        border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px',
        borderRadius: 4, display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)',
      },
      children: jsx('svg', { width: 13, height: 13, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', children: jsx('path', { d: path }) }),
    })
  const pick = (id: string): void => {
    setPicking((v) => (v === id ? null : id))
    loadSessions(cwd)
      .then((items) => setSessions(items))
      .catch(() => setSessions([]))
  }
  const send = (n: LineNoteRow, sid: string, name: string): void => {
    try {
      const actx = bridge?.scope?.(sid)
      const input = bridge?.conversationInput?.()
      if (actx === undefined || actx === null || input === undefined || input === null) {
        throw new Error(t('note.noBridge'))
      }
      const facade = input.for(actx)
      const snap = facade?.state?.getSnapshot?.()
      const draft: string = snap?.draft ?? ''
      const block = buildNoteBlock(relPath, n)
      const sep = draft === '' || draft.endsWith('\n') ? '' : '\n'
      facade.actions.setDraft(`${draft}${sep}${block}\n\n`)
      setToast(t('note.sent', { name }))
      setPicking(null)
    } catch (e) {
      setToast(t('note.sendFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }
  useEffect(() => {
    loadSessions(cwd).then((items) => setSessions((prev) => prev ?? items)).catch(() => {})
  }, [cwd])

  const title = (sid: string): string => {
    const s = sessions?.find((x) => x.sessionId === sid)
    return s?.projections?.values?.title || String(sid).replace(/^session-/, '').slice(0, 8)
  }
  return jsxs('div', {
    className: 'dshw-note-card',
    style: {
      margin: '4px 0',
      padding: '6px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
      width: 'max-content',
      minWidth: 300,
      maxWidth: 'min(620px, 92%)',
    },
    children: [
      jsx('div', { style: { fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 }, children: t('note.cardTitle', { line: lineRange(notes[0]) }) }),
      notes.map((n) =>
        jsxs('div', { style: { marginTop: 2 }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6 }, children: [
            jsx('div', { style: { flex: 1, fontSize: 12.5, lineHeight: '19px', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-primary)' }, children: n.text }),
            jsx('span', { style: { display: 'inline-flex', flexShrink: 0, paddingTop: 2 }, children: [
              iconBtn(t('note.copy'), 'M4 1.5h6.5L13 4v8.5H4V1.5zM10.5 1.5V4H13M6.5 7h4.5M6.5 9.5h4.5', () => {
                copyText(buildNoteBlock(relPath, n)).then(() => setToast(t('note.copied'))).catch(() => setToast(t('note.copyFailed')))
              }, 'c'),
              iconBtn(t('note.send'), 'M12.5 1.5 6.5 7.5M12.5 1.5 8.5 12.5 6.5 7.5 1.5 5.5l11-4z', () => pick(n.id), 's'),
              iconBtn(t('note.edit'), 'M9.5 1.8l2.7 2.7-7 7L2 12l.5-3.2 7-7z', () => props.onEdit(n), 'e'),
              iconBtn(t('note.delete'), 'M2 3.5h10M5.5 3.5V2h3v1.5M3.5 3.5l.6 8h5.8l.6-8M5.8 6v3.5M8.2 6v3.5', () => props.onDelete(n), 'd'),
            ] }),
          ] }),
          picking === n.id
            ? jsxs('div', { style: { margin: '4px 0', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 4 }, children: [
                jsx('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed)', marginBottom: 4 }, children: t('note.pickSession') }),
                sessions === null
                  ? jsx('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }, children: t('editor.loading') })
                  : sessions.length === 0
                    ? jsx('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }, children: t('note.noSession') })
                    : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 150, overflowY: 'auto' }, children:
                        sessions.map((x) =>
                          jsx('button', {
                            key: x.sessionId,
                            onClick: () => send(n, x.sessionId, title(x.sessionId)),
                            style: {
                              border: 'none', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                              padding: '4px 8px', borderRadius: 6, fontSize: 12,
                              color: 'var(--dsw-alias-label-primary)', background: 'transparent',
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                            },
                            children: [
                              jsx(DeepSeekIcon, { size: 13 }),
                              jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: title(x.sessionId) }),
                            ],
                          }),
                        ),
                      }),
              ] })
            : null,
        ] }, n.id),
      ),
      toast !== undefined
        ? jsx('div', { style: { marginTop: 4, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }, children: toast })
        : null,
    ],
  })
}

/** 行评论输入卡片(新增/编辑二用;Enter 提交,Esc 取消)。 */
function NoteComposerRow(props: { start: number; end: number; initial: string; submitLabel: string; error?: string; onSubmit: (text: string) => void; onCancel: () => void }): any {
  const [text, setText] = useState(props.initial)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return jsxs('div', {
    className: 'dshw-note-row',
    style: {
      margin: '4px 0',
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      width: 'max-content',
      minWidth: 300,
      maxWidth: 'min(560px, 90%)',
    },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }, children: [
        jsx('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-dimmed)' }, children: t('note.title', { line: props.start === props.end ? `${props.start}` : `${props.start}-${props.end}` }) }),
        props.error !== undefined ? jsx('div', { style: { fontSize: 11, color: '#f85149', flex: 1 }, children: props.error }) : null,
      ] }),
      jsx('textarea', {
        ref,
        value: text,
        onChange: (e: any) => setText(e.target.value),
        onKeyDown: (e: any) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (text.trim() !== '') props.onSubmit(text)
          }
          if (e.key === 'Escape') props.onCancel()
        },
        placeholder: t('note.placeholder'),
        style: {
          width: '100%', boxSizing: 'border-box', minHeight: 54, resize: 'none',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '6px 8px',
          background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit',
          fontSize: 12.5, lineHeight: '18px', outline: 'none',
        },
      }),
      jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }, children: [
        jsx('button', {
          onClick: props.onCancel,
          style: { border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '3px 10px' },
          children: t('action.cancel'),
        }),
        jsx('button', {
          onClick: () => { if (text.trim() !== '') props.onSubmit(text) },
          style: {
            border: '1px solid var(--dsw-alias-border-l2)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
            padding: '3px 12px', borderRadius: 6,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-interactive-bg-hover)',
          },
          children: props.submitLabel,
        }),
      ] }),
    ],
  })
}

/** 代码区右键菜单:官方 Menu 原语(panel EntryContextMenu 同款视觉——1px 锚点 +
 * portal 弹层,items 支持 icon);容器 zIndex 须高于覆盖层(20)。 */
function NoteContextMenu(props: { x: number; y: number; items: { label: string; icon?: any; onClick: () => void }[]; onClose: () => void }): any {
  const width = 190
  const left = Math.min(props.x, Math.max(0, window.innerWidth - width - 8))
  const top = Math.min(props.y, Math.max(0, window.innerHeight - props.items.length * 30 - 8))
  return jsx('div', {
    style: { position: 'fixed', left, top, width: 1, height: 1, zIndex: 30 },
    children: jsx(Primitives.Menu, {
      open: true,
      onClose: props.onClose,
      items: props.items.map((it, i) => ({ id: `m${i}`, label: it.label, icon: it.icon })),
      onSelect: (id: string) => {
        const it = props.items[Number(id.slice(1))]
        if (it) it.onClick()
      },
      portal: true,
      anchor: jsx('div', { style: { width: 1, height: 1 } }),
    }),
  })
}

// ── 右键菜单小图(14px 线性 currentColor,与 panel 菜单图同规格)──

function menuIcon(children: any): any {
  return jsx('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    xmlns: 'http://www.w3.org/2000/svg',
    children,
  })
}

/** 添加备注:对话气泡 + 加号。 */
function IconNoteAdd() {
  return menuIcon(jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M13.5 7.5a5.5 5.5 0 1 1-2.6-4.7' }),
      jsx('path', { d: 'M8 5.3v4.4M5.8 7.5h4.4' }),
    ],
  }))
}

/** 复制:双矩形。 */
function IconCopyText() {
  return menuIcon(jsxs(Fragment, {
    children: [
      jsx('rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.2' }),
      jsx('path', { d: 'M10.5 3.5h-7A1 1 0 0 0 2.5 4.5v7' }),
    ],
  }))
}

/** 剪切:剪刀。 */
function IconScissors() {
  return menuIcon(jsxs(Fragment, {
    children: [
      jsx('circle', { cx: '4', cy: '12', r: '1.8' }),
      jsx('circle', { cx: '12', cy: '12', r: '1.8' }),
      jsx('path', { d: 'M5.4 10.7 12 2.5M10.6 10.7 4 2.5' }),
    ],
  }))
}

/** 粘贴:剪贴板。 */
function IconPaste() {
  return menuIcon(jsxs(Fragment, {
    children: [
      jsx('rect', { x: '3', y: '2.8', width: '10', height: '11.2', rx: '1.4' }),
      jsx('rect', { x: '6', y: '1.5', width: '4', height: '2.6', rx: '0.8' }),
      jsx('path', { d: 'M5.5 8h5M5.5 10.8h3.4' }),
    ],
  }))
}

/** 全选:虚线选择框。 */
function IconSelectAll() {
  return menuIcon(jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11' }),
      jsx('path', { d: 'M5.5 8h5' }),
    ],
  }))
}

/** 行评论 + 按钮(gutter 内;有评论的行常显圆点)。 */
function NoteAddButton(props: { hasNote: boolean; title: string; onClick: () => void }): any {
  return jsx('button', {
    title: props.title,
    onClick: (e: any) => {
      e.stopPropagation()
      props.onClick()
    },
    className: props.hasNote ? 'dshw-note-dot' : 'dshw-note-add',
    style: {
      // VSCode 式圆角方块小按钮(18x16);hover 行才显影(编辑=gutter 列,diff=整行)
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 4,
      background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
      cursor: 'pointer', padding: 0,
      width: 18, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: props.hasNote ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      fontSize: 13, lineHeight: 1, fontFamily: 'inherit',
    },
    children: props.hasNote ? '•' : '+',
  })
}

/** 宿主 sessions 快照 → 当前会话 cwd(topbar 同款)。 */
function useCurrentCwd(useSessions: unknown): { currentId: string | undefined; cwd: string | undefined } {
  const hook = useSessions as ((sel: (s: any) => unknown) => unknown) | undefined
  const currentId = hook?.((s: any) => s?.current) as string | undefined
  const state = hook?.((s: any) => s)
  const cwd = currentId !== undefined ? (state as any)?.byId?.[String(currentId)]?.cwd : undefined
  return { currentId, cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined }
}

/** cwd 归一(与 file-tabs/topbar 同约定)。 */
function normCwd(p: string | undefined): string | null {
  if (typeof p !== 'string') return null
  const t = p.trim().replace(/\\/g, '/')
  return t === '' ? null : t
}

/** 实测中间对话区矩形(与 topbar.measureCenterCol 同款;独立小实现避免跨模块耦合)。 */
function measureCenterCol(): { left: number; width: number } {
  try {
    const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
    if (col === null) return { left: 0, width: window.innerWidth }
    const r = col.getBoundingClientRect()
    return { left: Math.round(r.left), width: Math.round(r.width) }
  } catch {
    return { left: 0, width: window.innerWidth }
  }
}

/** 文件图标(14px 线性,currentColor;与树内 FileIcon 视觉同族)。 */
function FileGlyph(props: { size?: number }) {
  return jsx('svg', {
    width: props.size ?? 13,
    height: props.size ?? 13,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { flexShrink: 0 },
    children: jsx('path', { d: 'M8 1.5H3.5A1 1 0 0 0 2.5 2.5v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5zM8 1.5V5h3.5' }),
  })
}

// Diff 行配色(半透明底色叠主题底;边线用高不透明度)
const DEL_BG = 'rgba(248, 81, 73, 0.14)'
const ADD_BG = 'rgba(63, 185, 80, 0.13)'

/** 行号集合 → 连续段 [起始行, 长度](状态条渲染用,免逐行 span)。 */
function mergeRowSegs(rows: Iterable<number>): [number, number][] {
  const sorted = [...rows].sort((a, b) => a - b)
  const segs: [number, number][] = []
  for (const r of sorted) {
    const last = segs[segs.length - 1]
    if (last !== undefined && r === last[0] + last[1]) last[1]++
    else segs.push([r, 1])
  }
  return segs
}
const DEL_EDGE = 'rgba(248, 81, 73, 0.75)'
const ADD_EDGE = 'rgba(63, 185, 80, 0.75)'
const MONO_FONT = 'var(--ds-font-family-mono, monospace)'
const LINE_HEIGHT = 20

/** hljs token 色板(one-dark 系)+ 亮色系统主题兜底;幂等注入一次。 */
function ensureEditorStyle(): void {
  try {
    if (document.getElementById('dshw-editor-style') !== null) return
    const tag = document.createElement('style')
    tag.id = 'dshw-editor-style'
    tag.textContent = `
.dshw-code .hljs-comment, .dshw-code .hljs-quote { color: #7f848e; font-style: italic; }
.dshw-code .hljs-keyword, .dshw-code .hljs-selector-tag, .dshw-code .hljs-doctag,
.dshw-code .hljs-formula, .dshw-code .hljs-name { color: #c678dd; }
.dshw-code .hljs-string, .dshw-code .hljs-regexp, .dshw-code .hljs-addition,
.dshw-code .hljs-attribute, .dshw-code .hljs-meta .hljs-string { color: #98c379; }
.dshw-code .hljs-number, .dshw-code .hljs-variable, .dshw-code .hljs-template-variable,
.dshw-code .hljs-selector-class, .dshw-code .hljs-selector-attr, .dshw-code .hljs-selector-pseudo { color: #d19a66; }
.dshw-code .hljs-title, .dshw-code .hljs-section, .dshw-code .hljs-title.function_ { color: #61afef; }
.dshw-code .hljs-title.class_, .dshw-code .hljs-class .hljs-title, .dshw-code .hljs-built_in { color: #e5c07b; }
.dshw-code .hljs-attr, .hljs-symbol, .dshw-code .hljs-bullet, .dshw-code .hljs-link { color: #e06c75; }
.dshw-code .hljs-meta, .dshw-code .hljs-literal { color: #56b6c2; }
.dshw-code .hljs-deletion { color: #e5534b; }
.dshw-code .hljs-emphasis { font-style: italic; }
.dshw-code .hljs-strong { font-weight: 600; }
/* 行评论 gutter:+ 号 hover 行才显影(编辑=gutter 列 hover,diff=整行 hover),有评论行常显圆点 */
.dshw-note-add { opacity: 0; transition: opacity 120ms var(--ds-ease-in-out, ease); }
.dshw-note-gutter:hover .dshw-note-add, .dshw-diffrow:hover .dshw-note-add, .dshw-note-add:focus-visible { opacity: 1; }
@media (prefers-color-scheme: light) {
  .dshw-code .hljs-comment, .dshw-code .hljs-quote { color: #a0a1a7; }
  .dshw-code .hljs-keyword, .dshw-code .hljs-selector-tag, .dshw-code .hljs-doctag,
  .dshw-code .hljs-formula, .dshw-code .hljs-name { color: #a626a4; }
  .dshw-code .hljs-string, .dshw-code .hljs-regexp, .dshw-code .hljs-addition,
  .dshw-code .hljs-attribute, .dshw-code .hljs-meta .hljs-string { color: #50a14f; }
  .dshw-code .hljs-number, .dshw-code .hljs-variable, .dshw-code .hljs-template-variable,
  .dshw-code .hljs-selector-class, .dshw-code .hljs-selector-attr, .dshw-code .hljs-selector-pseudo { color: #986801; }
  .dshw-code .hljs-title, .dshw-code .hljs-section, .dshw-code .hljs-title.function_ { color: #4078f2; }
  .dshw-code .hljs-title.class_, .dshw-code .hljs-class .hljs-title, .dshw-code .hljs-built_in { color: #c18401; }
  .dshw-code .hljs-attr, .dshw-code .hljs-symbol, .dshw-code .hljs-bullet, .dshw-code .hljs-link { color: #e45649; }
  .dshw-code .hljs-meta, .dshw-code .hljs-literal { color: #0184bc; }
  .dshw-code .hljs-deletion { color: #e5534b; }
}
`
    document.head.appendChild(tag)
  } catch {
    // 无 document 等极端环境:高亮退纯文本
  }
}

/** 编辑视图:fs-read 加载 → 行号 gutter + auto-grow textarea(wrap=off,行号天然对齐)。 */
function EditView(props: { tab: FileTab; bridge?: NoteBridge }): any {
  const { tab, bridge } = props
  const [text, setText] = useState<string | null>(null)
  // HEAD 基准文本(改动染色与状态条的对比侧)
  const [baseText, setBaseText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const loadSeq = useRef(0)
  const notes = useLineNotes(tab.cwd, tab.relPath)
  // composer:{start,end} 新增 | {start,end, id, initial} 编辑;undefined 收起
  const [composer, setComposer] = useState<{ start: number; end: number; id?: string; initial?: string } | undefined>(undefined)
  const [composerError, setComposerError] = useState<string | undefined>(undefined)
  // 行评论交互:hover 段/行(行级显 +)、已收起卡片(圆点重入)、正在编辑的段
  const [hoverSeg, setHoverSeg] = useState<number | null>(null)
  const [hoverRow, setHoverRow] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  // 撤回栈:受控 textarea 会破坏浏览器原生 undo,自管栈(500ms 内连续击键合并一帧)
  const undoStack = useRef<{ text: string }[]>([])
  const redoStack = useRef<{ text: string }[]>([])
  const lastEditAt = useRef(0)
  // 右键菜单(视口坐标 + 选区行区间 + 段/选区快照,供剪切粘贴)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; start: number; end: number; segIdx: number; selStart: number; selEnd: number } | undefined>(undefined)

  useEffect(() => {
    const seq = ++loadSeq.current
    setText(null)
    setError(undefined)
    // git-diff 一次拿 HEAD 基准 + 工作区文本:base 驱动改动染色/状态条,current 即编辑内容
    rpc<any>('git-diff', { cwd: tab.cwd, path: tab.relPath })
      .then((body) => {
        if (loadSeq.current !== seq) return
        setBaseText(String(body.base ?? ''))
        setText(body.current ?? '')
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [tab.cwd, tab.relPath])

  // 改动状态(与 HEAD 基准对齐):addRows=当前版新增/修改行(行背景绿);
  // delMarks=状态条标记(删除段映射到当前版的紧邻位置);
  // delBands=删除带(HEAD 独有行,内联插在当前版对应位置,红染——unified 红染)。
  // 编辑中防抖重算,改动分布随输入实时更新。
  const [addRows, setAddRows] = useState<Set<number>>(() => new Set())
  const [delMarks, setDelMarks] = useState<number[]>([])
  const [delBands, setDelBands] = useState<{ cutLine: number; lines: { leftNo: number; text: string }[] }[]>([])
  useEffect(() => {
    const timer = setTimeout(() => {
      const rows = alignLines(baseText, text ?? '')
      const baseLines = baseText.replace(/\r\n?/g, '\n').split('\n')
      const add = new Set<number>()
      const dels: number[] = []
      const bandMap = new Map<number, { leftNo: number; text: string }[]>()
      let lastRight = 0
      for (const r of rows) {
        if (r.type === 'del' && r.left !== null) {
          // HEAD 独有行:插在当前版 lastRight 行之后(cutLine=lastRight+1 前断开)
          const cutLine = lastRight + 1
          let list = bandMap.get(cutLine)
          if (list === undefined) {
            list = []
            bandMap.set(cutLine, list)
          }
          list.push({ leftNo: r.left, text: baseLines[r.left - 1] ?? '' })
          dels.push(lastRight === 0 ? 1 : lastRight)
        } else {
          if (r.type === 'add' && r.right !== null) add.add(r.right)
          if (r.right !== null) lastRight = r.right
        }
      }
      const bands = [...bandMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([cutLine, list]) => ({ cutLine, lines: list }))
      setAddRows(add)
      setDelMarks(dels)
      setDelBands(bands)
    }, 350)
    return () => clearTimeout(timer)
  }, [baseText, text])

  // 右缘改动状态条:fixed 定位贴编辑区右缘(mount/布局变化时测量;滚动不影响 fixed)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [stripRect, setStripRect] = useState<{ top: number; right: number; height: number } | null>(null)
  useEffect(() => {
    if (text === null) return
    const measure = (): void => {
      const el = scrollRef.current
      if (el === null) return
      const r = el.getBoundingClientRect()
      setStripRect({ top: r.top, right: window.innerWidth - r.right, height: r.height })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [text === null])

  const save = async (): Promise<void> => {
    if (text === null || saving) return
    setSaving(true)
    try {
      await rpc<any>('fs-write', { root: tab.cwd, path: tab.relPath, content: text })
      setFileDirty(tab.id, false)
      setSavedAt(Date.now())
    } catch (e) {
      // 保存失败保持脏标记;浮条提示(不顶替编辑区)
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // 保存结果浮条:成功 2s 淡出,失败 4s
  const [savedAt, setSavedAt] = useState(0)
  const [toast, setToast] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (savedAt === 0 && toast === undefined) return
    const timer = setTimeout(() => {
      setSavedAt(0)
      setToast(undefined)
    }, toast !== undefined ? 4000 : 2000)
    return () => clearTimeout(timer)
  }, [savedAt, toast])

  // 逐行高亮 HTML(textarea 的 value 含 CRLF,highlightLines 内部已归一);
  // 必须在条件 return 之前(hooks 顺序不可分叉)
  const hl = useMemo(() => highlightLines(text ?? '', langOf(tab.relPath)), [text, tab.relPath])
  // 删除带(HEAD 独有行)高亮:按 HEAD 文本行号取 HTML
  const delHl = useMemo(() => highlightLines(baseText, langOf(tab.relPath)), [baseText, tab.relPath])

  if (error !== undefined) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 12.5, color: '#f85149', whiteSpace: 'pre-wrap' },
      children: `${t('editor.loadFailed', { error })}`,
    })
  }
  if (text === null) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--dsw-alias-label-dimmed)' },
      children: t('editor.loading'),
    })
  }
  const lines = text.split('\n')
  const totalLines = lines.length
  ensureEditorStyle()
  const codeFont = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: `${LINE_HEIGHT}px`, tabSize: 2 } as const
  // 有评论的行号集合:该行前内嵌卡片行(18/19 行之间 = 19 行卡片插在 19 行前)
  const notedSet = new Set(notes.notes.map((n) => n.startLine))
  const toggleCard = (line: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })
  }
  // 段切分:有评论的行(或正在添加的行)前断开,卡片/composer 内嵌在段间;
  // 删除带(HEAD 独有行红染)同样按插入点断开内联(unified 红染,所见即编辑内容+删除带)
  const cutLines = new Set(notedSet)
  if (composer !== undefined) cutLines.add(composer.start)
  for (const band of delBands) cutLines.add(band.cutLine)
  const segments: { startNo: number; lines: string[] }[] = []
  const cards: { line: number }[] = []
  {
    let cur: { startNo: number; lines: string[] } = { startNo: 1, lines: [] }
    lines.forEach((ln, i) => {
      const lineNo = i + 1
      if (cutLines.has(lineNo)) {
        segments.push(cur)
        cards.push({ line: lineNo })
        cur = { startNo: lineNo, lines: [] }
      }
      cur.lines.push(ln)
    })
    segments.push(cur)
    // 文件尾部删除带(cutLine=行数+1 越过所有真实行):补空段承载
    const eofCut = lines.length + 1
    if (cutLines.has(eofCut)) {
      segments.push({ startNo: eofCut, lines: [] })
      cards.push({ line: eofCut })
    }
  }
  // 段文本变化 → 重组全局文本(卡片行不在文本中)
  const onSegChange = (segIdx: number, value: string, coalesce = true): void => {
    const prev = text ?? ''
    const now = Date.now()
    if (!coalesce || now - lastEditAt.current > 500) {
      undoStack.current.push({ text: prev })
      if (undoStack.current.length > 200) undoStack.current.shift()
      redoStack.current = []
    }
    lastEditAt.current = now
    const seg = segments[segIdx]
    seg.lines = value.split('\n')
    setText(segments.map((sg) => sg.lines.join('\n')).join('\n'))
    setFileDirty(tab.id, true)
  }
  // 撤回/重做:恢复整份文本(段与行评论锚定按新文本重算)
  const undo = (): void => {
    const prev = undoStack.current.pop()
    if (prev === undefined) return
    redoStack.current.push({ text: text ?? '' })
    setText(prev.text)
    setFileDirty(tab.id, true)
  }
  const redo = (): void => {
    const next = redoStack.current.pop()
    if (next === undefined) return
    undoStack.current.push({ text: text ?? '' })
    setText(next.text)
    setFileDirty(tab.id, true)
  }
  // 一个渲染单元:note 列 + 行号列 + 代码区(pre+textarea 段内叠加)
  const renderSegment = (seg: { startNo: number; lines: string[] }, segIdx: number): any => {
    const value = seg.lines.join('\n')
    // 纯挂载段(删除带/评论卡占位,自身无文本行)不渲染,免生额外空隙
    if (seg.lines.length === 0) return null
    return jsxs('div', {
      style: { display: 'flex', minWidth: 'max-content', alignItems: 'flex-start' },
      onContextMenu: (e: any) => {
        const el = (e.target as HTMLElement).tagName === 'TEXTAREA'
          ? (e.target as HTMLTextAreaElement)
          : ((e.target as HTMLElement).closest('.dshw-code')?.querySelector('textarea') ?? null)
        if (el === null) return
        e.preventDefault()
        const v = el.value ?? ''
        const s0 = el.selectionStart ?? 0
        const s1 = el.selectionEnd ?? s0
        const countNL = (t: string): number => (t.match(/\n/g) || []).length
        const startLine = seg.startNo + countNL(v.slice(0, s0))
        const endLine = seg.startNo + countNL(v.slice(0, s1))
        setCtxMenu({ x: e.clientX, y: e.clientY, start: startLine, end: Math.max(endLine, startLine), segIdx, selStart: s0, selEnd: s1 })
      },
      // 划选文本松开左键 → 自动弹快捷菜单(用户选中即有操作意图);
      // 延后一拍:mouseup 之后浏览器还会派发 click,若立即弹,菜单的
      // window click 关闭监听会把刚弹出的菜单秒关
      onMouseUp: (e: any) => {
        if (e.button !== 0) return
        const el = e.target.tagName === 'TEXTAREA' ? (e.target as HTMLTextAreaElement) : null
        if (el === null) return
        const cx = e.clientX
        const cy = e.clientY
        window.setTimeout(() => {
          const v = el.value ?? ''
          const s0 = el.selectionStart ?? 0
          const s1 = el.selectionEnd ?? s0
          if (s1 <= s0) return
          const countNL = (t: string): number => (t.match(/\n/g) || []).length
          const startLine = seg.startNo + countNL(v.slice(0, s0))
          const endLine = seg.startNo + countNL(v.slice(0, s1))
          setCtxMenu({ x: cx, y: cy, start: startLine, end: Math.max(endLine, startLine), segIdx, selStart: s0, selEnd: s1 })
        }, 0)
      },
      children: [
        jsx('div', {
          className: 'dshw-note-gutter',
          style: { flexShrink: 0, width: 20, padding: '8px 0', display: 'flex', flexDirection: 'column', userSelect: 'none', alignSelf: 'stretch' },
          children: seg.lines.map((_, i) => {
            const lineNo = seg.startNo + i
            const has = notedSet.has(lineNo)
            const hovered = hoverSeg === segIdx && hoverRow === i
            return jsx('span', {
              style: { height: LINE_HEIGHT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%' },
              onMouseEnter: () => {
                setHoverSeg(segIdx)
                setHoverRow(i)
              },
              children: hovered || has
                ? jsx(NoteAddButton, {
                    hasNote: has,
                    title: t('note.addHere', { line: lineNo }),
                    onClick: () => (has ? toggleCard(lineNo) : setComposer({ start: lineNo, end: lineNo })),
                  })
                : null,
            })
          }),
        }),
        jsx('div', {
          style: {
            flexShrink: 0, width: 34, padding: `8px 8px 8px 0`, textAlign: 'right', alignSelf: 'stretch',
            ...codeFont, color: 'var(--dsw-alias-label-dimmed)',
            background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.06))',
            borderRight: '1px solid var(--dsw-alias-border-l1)', userSelect: 'none', fontSize: 11,
          },
          children: seg.lines.map((_, i) => jsx('div', { key: seg.startNo + i, style: { height: LINE_HEIGHT }, children: seg.startNo + i })),
        }),
        // 代码区:pre 高亮常驻(浏览/编辑同一视觉)+ 透明 textarea 叠加(点击即编辑,
        // 高亮/缩进/宽度零跳变);flex:1 让各段等宽(外层 max-content 取最宽段)
        jsxs('div', {
          style: { position: 'relative', flex: 1, minWidth: 420 },
          children: [
            jsx('pre', {
              'aria-hidden': true,
              className: 'dshw-code',
              style: {
                margin: 0,
                padding: 8,
                // content-box 下 minHeight 只管内容区:必须=行数×行高(不含 padding),
                // 否则每段内容被多撑 16px,段间(删除带/评论卡插入处)露出空隙
                minHeight: seg.lines.length * LINE_HEIGHT,
                boxSizing: 'content-box',
                ...codeFont,
                whiteSpace: 'pre',
                color: 'var(--dsw-alias-label-primary)',
                pointerEvents: 'none',
              },
              children: seg.lines.map((codeLine, i) =>
                jsx('div', {
                  key: seg.startNo + i,
                  style: { minHeight: LINE_HEIGHT, background: addRows.has(seg.startNo + i) ? ADD_BG : undefined },
                  dangerouslySetInnerHTML: {
                    __html:
                      hl[seg.startNo - 1 + i] !== undefined
                        ? hl[seg.startNo - 1 + i].html === ''
                          ? '&nbsp;'
                          : hl[seg.startNo - 1 + i].html
                        : '&nbsp;',
                  },
                }),
              ),
            }),
            jsx('textarea', {
              value,
              spellCheck: false,
              wrap: 'off',
              onChange: (e: any) => onSegChange(segIdx, e.target.value),
              onKeyDown: (e: any) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault()
                  void save()
                  return
                }
                // 受控 textarea 原生 undo 不可靠,自管栈接管撤回/重做
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                  e.preventDefault()
                  undo()
                  return
                }
                if ((e.ctrlKey || e.metaKey) && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) {
                  e.preventDefault()
                  redo()
                  return
                }
              },
              style: {
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                padding: 8,
                border: 'none',
                outline: 'none',
                resize: 'none',
                overflow: 'hidden',
                background: 'transparent',
                color: 'transparent',
                caretColor: 'var(--dsw-alias-label-primary)',
                WebkitTextFillColor: 'transparent',
                ...codeFont,
                whiteSpace: 'pre',
              },
            }),
          ],
        }),
      ],
    })
  }
  return jsxs('div', {
    ref: scrollRef,
    style: { flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--dsw-alias-bg-base)', position: 'relative' },
    onKeyDown: (e: any) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    },
    onMouseLeave: () => {
      setHoverSeg(null)
      setHoverRow(null)
    },
    children: [
      jsxs('div', {
        style: { minWidth: 'max-content', minHeight: '100%' },
        children: [
          segments.map((seg, segIdx) =>
            jsxs(Fragment, {
            key: segIdx,
            children: [

              segIdx > 0 &&
              composer?.line !== seg.startNo &&
              (() => {
                const cardLine = cards[segIdx - 1]?.line
                if (cardLine === undefined) return null
                const list = notes.notes.filter((n) => n.startLine === cardLine)
                if (list.length === 0 || collapsed.has(cardLine)) return null
                return jsx('div', {
                  style: { padding: '4px 12px 4px 24px', display: 'flex' },
                  children: jsx(NoteCard, {
                    line: cardLine,
                    notes: list,
                    relPath: tab.relPath,
                    cwd: tab.cwd,
                    bridge,
                    onEdit: (n) => setComposer({ start: n.startLine, end: n.endLine, id: n.id, initial: n.text }),
                    onDelete: (n) => void notes.remove(n.id),
                  }),
                })
              })(),
              // HEAD 删除带(unified 红染):插在 cutLine 段前,红底展示被删的 HEAD 行
              segIdx > 0 && composer?.start !== seg.startNo
                ? (() => {
                    const cut = segments[segIdx].startNo
                    const bandLines = delBands.find((b) => b.cutLine === cut)?.lines
                    if (bandLines === undefined || bandLines.length === 0) return null
                    return jsxs('div', {
                      // 抵消上下编辑段 pre 的 padding 8:红行与相邻行间距=正常行距(行贴行)
                      style: { display: 'flex', minWidth: 'max-content', alignItems: 'flex-start', marginTop: -8, marginBottom: -8 },
                      children: [
                        // 占位列 alignSelf:stretch 撑满带高(空 div 无内容,flex-start 下高度恒 0,灰底/列背景才会可见)
                        jsx('div', { style: { flexShrink: 0, width: 20, alignSelf: 'stretch' } }),
                        // 行号列留白占位(删除行无行号语义,仅保持内容列与编辑区对齐)
                        jsx('div', {
                          style: {
                            flexShrink: 0, width: 34, padding: '0 8px 0 0', textAlign: 'right', alignSelf: 'stretch',
                            ...codeFont, color: 'var(--dsw-alias-label-dimmed)',
                            background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.06))',
                            borderRight: '1px solid var(--dsw-alias-border-l1)', userSelect: 'none', fontSize: 11,
                          },
                        }),
                        jsx('pre', {
                          'aria-hidden': true,
                          style: {
                            // 上下零 padding:红区高度精确=行数×行高(与正常行距一致,无额外边距)
                            margin: 0, padding: '0 8px', minHeight: bandLines.length * LINE_HEIGHT,
                            boxSizing: 'content-box', ...codeFont, whiteSpace: 'pre', flex: 1,
                            color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
                          },
                          children: bandLines.map((ln) =>
                            jsx('div', {
                              key: ln.leftNo,
                              // 行高显式锁死(与编辑行严格一致,防高亮 span/空行撑高)
                              style: { height: LINE_HEIGHT, minHeight: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px`, overflow: 'hidden', background: DEL_BG },
                              dangerouslySetInnerHTML: {
                                __html:
                                  delHl[ln.leftNo - 1] !== undefined
                                    ? delHl[ln.leftNo - 1].html === ''
                                      ? '&nbsp;'
                                      : delHl[ln.leftNo - 1].html
                                    : '&nbsp;',
                              },
                            }),
                          ),
                        }),
                      ],
                    })
                  })()
                : null,
              renderSegment(seg, segIdx),
            ],
          }),
        ),
        ],
      }),
      composer !== undefined
        ? jsx('div', {
            style: { position: 'absolute', top: 8 + (composer.start - 1) * LINE_HEIGHT + LINE_HEIGHT, left: 60, right: 16, zIndex: 6, display: 'flex' },
            children: jsx(NoteComposerRow, {
              start: composer.start,
              end: composer.end,
              initial: composer.initial ?? '',
              error: composerError,
              submitLabel: composer.id !== undefined ? t('m.save') : t('note.add'),
              onSubmit: (value: string) => {
                const act =
                  composer.id !== undefined ? notes.update(composer.id, value) : notes.add(composer.start, composer.end, value)
                act.then(() => setComposer(undefined)).catch((e: unknown) => {
                  setComposer({ ...composer, initial: value })
                  setComposerError(e instanceof Error ? e.message : String(e))
                })
              },
              onCancel: () => setComposer(undefined),
            }),
          })
        : null,
      ctxMenu !== undefined
        ? jsx(NoteContextMenu, {
            x: ctxMenu.x,
            y: ctxMenu.y,
            items: (() => {
              const seg = segments[ctxMenu.segIdx]
              const segText = seg ? seg.lines.join('\n') : ''
              const selText = segText.slice(ctxMenu.selStart, ctxMenu.selEnd)
              const replaceSel = (insert: string): void => {
                const next = segText.slice(0, ctxMenu.selStart) + insert + segText.slice(ctxMenu.selEnd)
                onSegChange(ctxMenu.segIdx, next, false)
              }
              const items: { label: string; icon?: any; onClick: () => void }[] = [
                { label: t('menu.addNote', { lines: ctxMenu.start === ctxMenu.end ? `${ctxMenu.start}` : `${ctxMenu.start}-${ctxMenu.end}` }), icon: jsx(IconNoteAdd, {}), onClick: () => setComposer({ start: ctxMenu.start, end: ctxMenu.end }) },
              ]
              if (ctxMenu.selEnd > ctxMenu.selStart) {
                items.push({ label: t('menu.copy'), icon: jsx(IconCopyText, {}), onClick: () => void copyText(selText) })
                items.push({ label: t('menu.cut'), icon: jsx(IconScissors, {}), onClick: () => { copyText(selText); replaceSel('') } })
              }
              items.push({
                label: t('menu.paste'),
                icon: jsx(IconPaste, {}),
                onClick: () => {
                  void navigator.clipboard
                    .readText()
                    .then((clip) => replaceSel(clip))
                    .catch(() => setToast(t('note.copyFailed')))
                },
              })
              items.push({
                label: t('menu.selectAll'),
                icon: jsx(IconSelectAll, {}),
                onClick: () => {
                  const pre = document.querySelectorAll('div[style*="z-index: 20"] .dshw-code')[ctxMenu.segIdx] as HTMLElement | undefined
                  const ta = pre ? (pre.nextElementSibling as HTMLTextAreaElement | null) : null
                  if (ta) {
                    ta.focus()
                    ta.setSelectionRange(0, ta.value.length)
                  }
                },
              })
              return items
            })(),
            onClose: () => setCtxMenu(undefined),
          })
        : null,
      stripRect !== null && (addRows.size > 0 || delMarks.length > 0)
        ? jsx('div', {
            title: t('editor.changeStripHint'),
            onClick: (e: any) => {
              const el = scrollRef.current
              if (el === null || totalLines === 0) return
              const rect = e.currentTarget.getBoundingClientRect()
              const ratioY = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
              el.scrollTop = ratioY * totalLines * LINE_HEIGHT - el.clientHeight / 3
            },
            style: {
              position: 'fixed',
              top: stripRect.top + 4,
              right: stripRect.right + 2,
              width: 8,
              height: Math.max(stripRect.height - 8, 40),
              borderRadius: 4,
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.12))',
              zIndex: 26,
              cursor: 'pointer',
              overflow: 'hidden',
            },
            children: [
              ...mergeRowSegs(addRows).map(([start, len]) =>
                jsx('span', {
                  key: `a${start}`,
                  style: {
                    position: 'absolute', left: 0, width: '100%',
                    top: `${(start / Math.max(totalLines, 1)) * 100}%`,
                    height: `${(len / Math.max(totalLines, 1)) * 100}%`,
                    minHeight: 2, background: '#3fb950',
                  },
                }),
              ),
              ...mergeRowSegs(delMarks).map(([start, len]) =>
                jsx('span', {
                  key: `d${start}`,
                  style: {
                    position: 'absolute', left: 0, width: '100%',
                    top: `${(start / Math.max(totalLines, 1)) * 100}%`,
                    height: `${Math.max((len / Math.max(totalLines, 1)) * 100, 0.4)}%`,
                    minHeight: 2, background: '#f85149',
                  },
                }),
              ),
            ],
          })
        : null,
    ],
  })
}

/**
 * 图片预览视图(fs-raw 原始流 + 查看器交互):
 * 滚轮以光标为中心缩放 / 左键拖拽平移 / 双击或按钮适应窗口 / 100% 原始尺寸。
 * 透明 PNG 用棋盘底衬;拖拽挂 window 级监听(pointer capture 在宿主环境
 * 静默失效,前科见 diff 拖拽);no-store 响应头 + src 时间戳防外部修改后旧图缓存。
 */
function ImagePreviewView(props: { tab: FileTab }): any {
  const { tab } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [view, setView] = useState<{ scale: number; x: number; y: number }>({ scale: 1, x: 0, y: 0 })
  // src 每次挂载生成一次(TAB 重建才会变)
  const [src] = useState(
    () => `/dsh-coding-workspace/fs-raw?root=${encodeURIComponent(tab.cwd)}&path=${encodeURIComponent(tab.relPath)}&v=${Date.now()}`,
  )

  // 适应窗口:只缩不放(小图放大只会糊),居中
  const fitToWindow = (natW: number, natH: number): void => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const rect = wrap.getBoundingClientRect()
    const availW = Math.max(rect.width - 48, 50)
    const availH = Math.max(rect.height - 48, 50)
    const scale = Math.min(availW / natW, availH / natH, 1)
    setView({ scale, x: (rect.width - natW * scale) / 2, y: (rect.height - natH * scale) / 2 })
  }
  const onLoad = (e: any): void => {
    const w = e.currentTarget.naturalWidth
    const h = e.currentTarget.naturalHeight
    if (w > 0 && h > 0) {
      setNat({ w, h })
      fitToWindow(w, h)
    }
  }
  // 滚轮缩放:必须原生非 passive 监听——React 合成 onWheel 走 passive 注册,
  // preventDefault 失效(报 Unable to preventDefault),缩放会连带页面滚动
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const onWheelRaw = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setView((v) => {
        const scale = Math.min(Math.max(v.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.02), 40)
        const k = scale / v.scale
        return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
      })
    }
    wrap.addEventListener('wheel', onWheelRaw, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheelRaw)
  }, [])
  // 拖拽平移:window 级 move/up(松开在视口外也能收尾)
  const onDragStart = (down: any): void => {
    if (down.button !== 0) return
    down.preventDefault()
    const sx = down.clientX - view.x
    const sy = down.clientY - view.y
    const move = (ev: any): void => setView((v) => ({ ...v, x: ev.clientX - sx, y: ev.clientY - sy }))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const zoomTo = (scale: number): void => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const rect = wrap.getBoundingClientRect()
    setView((v) => {
      const k = scale / v.scale
      return { scale, x: rect.width / 2 - (rect.width / 2 - v.x) * k, y: rect.height / 2 - (rect.height / 2 - v.y) * k }
    })
  }
  if (error !== undefined) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 12.5, color: '#f85149', whiteSpace: 'pre-wrap' },
      children: `${t('editor.loadFailed', { error })}`,
    })
  }
  return jsxs('div', {
    ref: wrapRef,
    style: {
      flex: 1,
      minHeight: 0,
      position: 'relative',
      overflow: 'hidden',
      // 透明底衬棋盘(Photoshop 式)
      backgroundImage:
        'linear-gradient(45deg, rgba(127,127,127,0.12) 25%, transparent 25%, transparent 75%, rgba(127,127,127,0.12) 75%), linear-gradient(45deg, rgba(127,127,127,0.12) 25%, transparent 25%, transparent 75%, rgba(127,127,127,0.12) 75%)',
      backgroundSize: '16px 16px',
      backgroundPosition: '0 0, 8px 8px',
      cursor: 'grab',
      userSelect: 'none',
    },
    onMouseDown: onDragStart,
    onDoubleClick: () => (nat !== null ? fitToWindow(nat.w, nat.h) : undefined),
    children: [
      jsx('img', {
        src,
        alt: tab.relPath,
        draggable: false,
        onLoad,
        onError: () => setError(t('image.loadFailed')),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: '0 0',
          imageRendering: view.scale >= 3 ? 'pixelated' : 'auto',
          cursor: 'grab',
          maxWidth: 'none',
          maxHeight: 'none',
        },
      }),
      // 左下状态浮层:尺寸 + 缩放比
      nat !== null
        ? jsxs('div', {
            style: {
              position: 'absolute',
              left: 10,
              bottom: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '3px 8px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              userSelect: 'none',
            },
            onClick: (e: any) => e.stopPropagation(),
            children: [
              jsx('span', { children: `${nat.w}×${nat.h}` }),
              jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: `${Math.round(view.scale * 100)}%` }),
              jsx('button', {
                title: t('image.fit'),
                onClick: () => fitToWindow(nat.w, nat.h),
                className: 'dshw-iconbtn',
                style: { fontSize: 11, padding: '1px 5px' },
                children: t('image.fit'),
              }),
              jsx('button', {
                title: t('image.actual'),
                onClick: () => zoomTo(1),
                className: 'dshw-iconbtn',
                style: { fontSize: 11, padding: '1px 5px' },
                children: '100%',
              }),
            ],
          })
        : null,
    ],
  })
}

/**
 * 文件 diff 视图(老大定版 v2:单栏 unified + 可编辑):
 * - 工作区文件(无 commit 上下文)= EditView 单栏(可编辑/保存/行评论/右缘状态条),
 *   HEAD 删除行以红色删除带内联插在对应位置(unified 红染),add 行绿染
 * - 历史 commit(commit 上下文)= 只读 unified 对齐(对象库不可改),见 CommitDiffView
 */
function DiffView(props: { tab: FileTab; bridge?: NoteBridge }): any {
  const { tab, bridge } = props
  if (tab.commit !== undefined) return jsx(CommitDiffView, { tab, bridge })
  return jsx(EditView, { tab, bridge })
}

/**
 * 历史 commit diff 视图(unified 单栏,GitHub/IDEA inline 式):
 * [+/- 标记 | 旧行号 | 新行号](sticky 固定)+ 全宽内容色带。
 * 覆盖层宽度受限,单栏把宽度全给内容,对应关系上下相邻天然可读;
 * 右缘缩略状态列保留(点击跳转)。行评论禁用(历史版本行号无工作区语义)。
 */
function CommitDiffView(props: { tab: FileTab; bridge?: NoteBridge }): any {
  const { tab, bridge } = props
  const [rows, setRows] = useState<DiffRow[] | null>(null)
  const [untracked, setUntracked] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const scRef = useRef<HTMLDivElement | null>(null)
  const loadSeq = useRef(0)
  const notesAll = useLineNotes(tab.cwd, tab.relPath)
  // 历史 commit diff:行评论锚定工作区当前版本行号,对历史版本无意义 → 禁用
  const notes = tab.commit !== undefined ? { ...notesAll, notes: [] } : notesAll
  // diff 行高亮:base/current 各自逐行染色,行对齐后按行号取 HTML
  const [hl, setHl] = useState<{ base: { html: string }[]; current: { html: string }[] } | null>(null)
  const [composer, setComposer] = useState<{ line: number; id?: string; initial?: string } | undefined>(undefined)
  const [composerError, setComposerError] = useState<string | undefined>(undefined)
  const [composerAnchor, setComposerAnchor] = useState<number | null>(null)
  // 已收起的卡片(行索引;圆点重入切换)
  const [collapsedCards, setCollapsedCards] = useState<Set<number>>(new Set())
  // 右键评论菜单(含锚定行与选中文本快照——菜单 mousedown 会清 window 选区,须右键时抓取)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; start: number; end: number; anchor?: number; selText?: string } | undefined>(undefined)

  useEffect(() => {
    const seq = ++loadSeq.current
    setRows(null)
    setHl(null)
    setError(undefined)
    // 历史 commit 模式(hash^ vs hash 的两版文本);普通模式 = HEAD vs 工作区
    const req =
      tab.commit !== undefined
        ? rpc<any>('git-commit-diff', { cwd: tab.cwd, hash: tab.commit, path: tab.relPath, from: tab.commitFrom ?? '' })
        : rpc<any>('git-diff', { cwd: tab.cwd, path: tab.relPath })
    req
      .then((body) => {
        if (loadSeq.current !== seq) return
        setUntracked(body.untracked === true)
        const lang = langOf(tab.relPath)
        setRows(alignLines(String(body.base ?? ''), String(body.current ?? '')))
        setHl({
          base: highlightLines(String(body.base ?? ''), lang),
          current: highlightLines(String(body.current ?? ''), lang),
        })
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return
        setError(e instanceof Error ? e.message : String(e))
      })
    // dirty 参与依赖:编辑视图保存后脏标记翻负,自动重拉最新内容;commit 模式随 hash 重拉
  }, [tab.cwd, tab.relPath, tab.dirty, tab.commit])

  const blocks = useMemo(() => (rows === null ? [] : diffBlocks(rows)), [rows])
  const total = rows === null ? 0 : rows.length

  // note → 首个命中行索引(优先右栏/当前版本行号,base-only 回落左栏)
  const noteAnchor = useMemo(() => {
    const map = new Map<string, number>()
    if (rows === null) return map
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      for (const n of notes.notes) {
        if (map.has(n.id)) continue
        if ((row.right !== null && row.right === n.startLine) || (row.right === null && row.left === n.startLine)) {
          map.set(n.id, i)
        }
      }
    }
    return map
  }, [rows, notes.notes])
  const anchorRows = useMemo(() => {
    const byRow = new Map<number, LineNoteRow[]>()
    for (const n of notes.notes) {
      const idx = noteAnchor.get(n.id)
      if (idx === undefined) continue
      const list = byRow.get(idx) ?? []
      list.push(n)
      byRow.set(idx, list)
    }
    return byRow
  }, [notes.notes, noteAnchor])
  const layerTop = (rowIdx: number): number => 4 + rowIdx * LINE_HEIGHT

  // 状态列点击:按点击纵向比例换算行号,滚动容器定位到该行(上移 1/3 屏让上下文可见)
  const onMapClick = (e: any): void => {
    const sc = scRef.current
    if (sc === null || total === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratioY = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
    sc.scrollTop = Math.max(0, Math.round(ratioY * total) * LINE_HEIGHT - sc.clientHeight / 3)
  }

  if (error !== undefined) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 12.5, color: '#f85149', whiteSpace: 'pre-wrap' },
      children: `${t('editor.loadFailed', { error })}`,
    })
  }
  if (rows === null) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--dsw-alias-label-dimmed)' },
      children: t('editor.loading'),
    })
  }
  ensureEditorStyle()
  const changed = rows.some((r) => r.type !== 'eq')
  const codeFont = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: `${LINE_HEIGHT}px`, whiteSpace: 'pre', height: LINE_HEIGHT, display: 'flex', alignItems: 'center' } as const
  // sticky 列的实底:行色半透明叠在面板底色上(多背景预混),横滚时不透出下层行文字
  const stickyBg = (row: DiffRow): string =>
    row.type === 'del'
      ? `${DEL_BG}, var(--dsw-alias-bg-base)`
      : row.type === 'add'
        ? `${ADD_BG}, var(--dsw-alias-bg-base)`
        : 'var(--dsw-alias-bg-base)'
  return jsxs('div', {
    style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)' },
    children: [
      untracked || !changed
        ? jsx('div', {
            style: {
              padding: '5px 12px',
              fontSize: 11.5,
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              flexShrink: 0,
            },
            children: untracked ? t('editor.untrackedHint') : t('editor.noDiff'),
          })
        : null,
      jsxs('div', {
        style: { flex: 1, minHeight: 0, display: 'flex' },
        children: [
          jsx('div', {
            ref: scRef,
            style: { flex: 1, minWidth: 0, overflow: 'auto', position: 'relative' },
            // 划选松开左键 → 自动弹快捷菜单(同编辑视图;延后一拍错开 click 关闭)
            // 历史 commit diff 禁行评论(行号对不上工作区版本)
            onMouseUp: (ev: any) => {
              if (ev.button !== 0 || tab.commit !== undefined) return
              const cx = ev.clientX
              const cy = ev.clientY
              window.setTimeout(() => {
                const sel = window.getSelection()
                if (sel === null || sel.isCollapsed || sel.toString() === '') return
                const rowOf = (node: Node | null): number | null => {
                  const el = (node && node.nodeType === 3 ? node.parentElement : node) as HTMLElement | null
                  const r = el ? (el.closest('[data-line]') as HTMLElement | null) : null
                  return r ? Number(r.getAttribute('data-line')) : null
                }
                const a = rowOf(sel.anchorNode)
                const f = rowOf(sel.focusNode)
                if (a === null || f === null) return
                const start = Math.min(a, f)
                const end = Math.max(a, f)
                // anchor 存行索引(composer 插入定位用);行号 → rows 下标
                const anchorIdx = rows.findIndex((r) => (r.right ?? r.left) === start)
                setCtxMenu({ x: cx, y: cy, start, end, anchor: anchorIdx >= 0 ? anchorIdx : undefined, selText: sel.toString() })
              }, 0)
            },
            children: [
              jsx('div', {
              style: { minWidth: 'max-content', minHeight: '100%', paddingTop: 4 },
              children: rows.flatMap((row, i) => {
                const noted = anchorRows.has(i)
                const cardList = anchorRows.get(i)
                const head: any[] = []
                if (cardList !== undefined && !collapsedCards.has(i)) {
                  head.push(
                    jsx('div', {
                      key: `card-${i}`,
                      style: { padding: '4px 12px 4px 90px', display: 'flex' },
                      children: jsx(NoteCard, {
                        line: cardList[0].line,
                        notes: cardList,
                        relPath: tab.relPath,
                        cwd: tab.cwd,
                        bridge,
                        onEdit: (n) => {
                          setComposer({ start: n.startLine, end: n.endLine, id: n.id, initial: n.text })
                          setComposerAnchor(i)
                        },
                        onDelete: (n) => void notes.remove(n.id),
                      }),
                    }),
                  )
                }
                if (composer !== undefined && composerAnchor === i) {
                  head.push(
                    jsx('div', {
                      key: `cmp-${i}`,
                      style: { padding: '4px 12px 4px 90px', display: 'flex' },
                      children: jsx(NoteComposerRow, {
                        start: composer.start,
                      end: composer.end,
                        initial: composer.initial ?? '',
                        error: composerError,
                        submitLabel: composer.id !== undefined ? t('m.save') : t('note.add'),
                        onSubmit: (value: string) => {
                          const act =
                            composer.id !== undefined ? notes.update(composer.id, value) : notes.add(composer.start, composer.end, value)
                          act.then(() => setComposer(undefined)).catch((e: unknown) => {
                            setComposer({ ...composer, initial: value })
                            setComposerError(e instanceof Error ? e.message : String(e))
                          })
                        },
                        onCancel: () => setComposer(undefined),
                      }),
                    }),
                  )
                }
                return [
                  ...head,
                  jsxs('div', {
                  key: i,
                  className: 'dshw-diffrow',
                  'data-line': row.right ?? row.left ?? undefined,
                  onContextMenu: (ev: any) => {
                    ev.preventDefault()
                    if (tab.commit !== undefined) return
                    const sel = window.getSelection()
                    const rowOf = (node: Node | null): number | null => {
                      const el = (node && node.nodeType === 3 ? node.parentElement : node) as HTMLElement | null
                      const r = el ? (el.closest('[data-line]') as HTMLElement | null) : null
                      return r ? Number(r.getAttribute('data-line')) : null
                    }
                    const a = rowOf(sel?.anchorNode ?? null)
                    const f = rowOf(sel?.focusNode ?? null)
                    let start = row.right ?? row.left ?? i + 1
                    let end = start
                    if (a !== null && f !== null && !sel!.isCollapsed) {
                      start = Math.min(a, f)
                      end = Math.max(a, f)
                    }
                    setCtxMenu({ x: ev.clientX, y: ev.clientY, start, end, anchor: i, selText: sel && !sel.isCollapsed ? sel.toString() : '' })
                  },
                  style: {
                    ...codeFont,
                    minWidth: '100%',
                    width: 'max-content',
                    background: row.type === 'del' ? DEL_BG : row.type === 'add' ? ADD_BG : undefined,
                  },
                  children: [
                    // 行评论 + 号列(sticky 最左)
                    jsx('span', {
                      className: 'dshw-edrow',
                      style: {
                        position: 'sticky', left: 0, width: 20, flexShrink: 0, justifyContent: 'center', alignItems: 'center',
                        background: 'var(--dsw-alias-bg-base)', userSelect: 'none',
                      },
                      children: jsx(NoteAddButton, {
                        hasNote: noted,
                        title: t('note.addHere', { line: row.right ?? row.left ?? i + 1 }),
                        onClick: () => {
                          if (noted) {
                            setCollapsedCards((prev) => {
                              const next = new Set(prev)
                              if (next.has(i)) next.delete(i)
                              else next.add(i)
                              return next
                            })
                          } else {
                            setComposer({ start: row.right ?? row.left ?? i + 1, end: row.right ?? row.left ?? i + 1 })
                            setComposerAnchor(i)
                          }
                        },
                      }),
                    }),
                    // +/- 标记(GitHub 式单字符;eq 行占位对齐)
                    jsx('span', {
                      style: {
                        position: 'sticky', left: 20, width: 22, flexShrink: 0, justifyContent: 'center',
                        background: stickyBg(row),
                        color: row.type === 'del' ? '#e5534b' : row.type === 'add' ? '#57ab5a' : 'transparent',
                        fontWeight: 600, userSelect: 'none',
                      },
                      children: row.type === 'del' ? '-' : row.type === 'add' ? '+' : '.',
                    }),
                    // 旧行号(HEAD)
                    jsx('span', {
                      style: {
                        position: 'sticky', left: 42, width: 38, flexShrink: 0, justifyContent: 'flex-end', paddingRight: 7,
                        background: stickyBg(row), color: 'var(--dsw-alias-label-dimmed)', fontSize: 11, userSelect: 'none',
                        borderRight: '1px solid var(--dsw-alias-border-l1)',
                      },
                      children: row.left ?? '',
                    }),
                    // 新行号(工作区)
                    jsx('span', {
                      style: {
                        position: 'sticky', left: 80, width: 38, flexShrink: 0, justifyContent: 'flex-end', paddingRight: 7,
                        background: stickyBg(row), color: 'var(--dsw-alias-label-dimmed)', fontSize: 11, userSelect: 'none',
                      },
                      children: row.right ?? '',
                    }),
                    // 内容:del 左缘红竖线 / add 左缘绿竖线(IDEA inline 位);
                    // 高亮按行号取自 base/current 的逐行 HTML(行号 1 起 → 数组 -1)
                    jsx('span', {
                      className: 'dshw-code',
                      style: {
                        minWidth: 420, paddingLeft: 10, flex: 1,
                        borderLeft: row.type === 'del' ? `2px solid ${DEL_EDGE}` : row.type === 'add' ? `2px solid ${ADD_EDGE}` : '2px solid transparent',
                      },
                      ...(hl !== null && row.left !== null && hl.base[row.left - 1] !== undefined
                        ? { dangerouslySetInnerHTML: { __html: hl.base[row.left - 1].html } }
                        : hl !== null && row.right !== null && hl.current[row.right - 1] !== undefined
                          ? { dangerouslySetInnerHTML: { __html: hl.current[row.right - 1].html } }
                          : { children: row.text }),
                    }),
                  ],
                }),
                ]
              }),
              }),
            ],
          }),
          ctxMenu !== undefined
            ? jsx(NoteContextMenu, {
                x: ctxMenu.x,
                y: ctxMenu.y,
                items: [
                  { label: t('menu.addNote', { lines: ctxMenu.start === ctxMenu.end ? `${ctxMenu.start}` : `${ctxMenu.start}-${ctxMenu.end}` }), icon: jsx(IconNoteAdd, {}), onClick: () => { setComposer({ start: ctxMenu.start, end: ctxMenu.end }); setComposerAnchor(ctxMenu.anchor ?? null) } },
                  { label: t('menu.copy'), icon: jsx(IconCopyText, {}), onClick: () => void copyText(ctxMenu.selText ?? '') },
                ],
                onClose: () => setCtxMenu(undefined),
              })
            : null,
          // 右缘缩略状态列:行占比色块,点击跳转
          jsx('div', {
            title: t('editor.diffMapTitle'),
            onClick: onMapClick,
            style: {
              flexShrink: 0,
              width: 12,
              cursor: 'pointer',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
              borderLeft: '1px solid var(--dsw-alias-border-l1)',
              position: 'relative',
            },
            children:
              total === 0
                ? null
                : blocks.map((b, k) =>
                    jsx('div', {
                      key: k,
                      style: {
                        position: 'absolute',
                        left: 2,
                        right: 2,
                        top: `${((b.start * LINE_HEIGHT) / (total * LINE_HEIGHT)) * 100}%`,
                        height: `max(2px, ${((b.end - b.start) / total) * 100}%)`,
                        background: b.type === 'del' ? DEL_EDGE : ADD_EDGE,
                        opacity: 0.75,
                        borderRadius: 1,
                      },
                    }),
                  ),
          }),
        ],
      }),
    ],
  })
}

export function EditorOverlay(props: any): any {
  const bridge = props?.dshwBridge as NoteBridge | undefined
  const { cwd, currentId } = useCurrentCwd(props?.useSessions)
  // 分栏建立/恢复需要绑定宿主会话(currentId);ref 供 window 级 DnD 闭包读取
  const currentIdRef = useRef<string | undefined>(undefined)
  currentIdRef.current = currentId
  const snap = useSyncExternalStore(fileTabsSubscribe, fileTabsGetSnapshot, fileTabsGetSnapshot)
  // 文件 TAB 与会话工作区绑定:激活 TAB 不属于当前会话 cwd 时视同会话态(盖层收起)
  let tab = snap.active.kind === 'file' ? snap.tabs.find((tb) => tb.id === snap.active.id) : undefined
  // 分栏激活:tab 取焦点栏成员(session-file=右栏文件;file-file=右栏,恢复态)
  const activeGroup = snap.active.kind === 'split' ? snap.groups.find((g) => g.id === snap.active.id) ?? null : null
  if (tab === undefined && activeGroup !== null) {
    tab = snap.tabs.find((tb) => tb.id === activeGroup.rightTabId)
  }
  if (tab !== undefined && cwd !== undefined && normCwd(tab.cwd) !== normCwd(cwd)) tab = undefined

  // 左右边界实时对齐中间对话区(与 topbar 同款:值比较防 ref 重建循环)
  const [colBox, setColBox] = useState<{ left: number; width: number }>(() => measureCenterCol())
  const roRef = useRef<ResizeObserver | null>(null)
  const applyBox = (): void => {
    const next = measureCenterCol()
    setColBox((prev) => (prev.left === next.left && prev.width === next.width ? prev : next))
  }
  const rootRef = (el: HTMLDivElement | null): void => {
    if (el === null) {
      roRef.current?.disconnect()
      roRef.current = null
      return
    }
    if (roRef.current !== null) return
    const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
    if (col !== null) {
      const ro = new ResizeObserver(applyBox)
      ro.observe(col)
      roRef.current = ro
    }
    applyBox()
  }

  // ── 全局拖放(TAB dragstart 见 topbar):window 级统一处理。
  // dragover 推演落位 → 在目标区域画灰色占位窗体(Windows Snap 式,告知松手后布局);
  // drop 真正落位(文件 openInPane / 会话 attachSessionPane);拖拽结束清预览。
  // 落点在对话区内才收;落点侧 = 拖入 TAB 的去向侧:
  // - 源=文件:纯会话 左右皆建「会话+文件」(文件恒右);单开 F 左/右半=文件+文件;
  //   session-file 左侧是会话栏(文件落左=升级文件+文件);file-file 左半/右半各归各栏
  // - 源=会话:纯会话无效;单开 F 左半=会话+文件(会话左)/右半=文件+会话(会话右);
  //   分栏激活时拖会话到任意侧 = 切换会话(组合保持,会话侧内容切换)
  const dropPane = (snapNow: ReturnType<typeof fileTabsGetSnapshot>, x: number, rect: DOMRect): 'left' | 'right' | null => {
    const isSession = draggingKind === 'session'
    const mid = rect.left + rect.width / 2
    const hitLeft = x < mid
    if (snapNow.active.kind === 'session') {
      return isSession ? null : 'right'
    }
    const actG =
      snapNow.active.kind === 'split'
        ? snapNow.groups.find((g) => g.id === snapNow.active.id) ?? null
        : null
    if (actG === null) {
      // 未分栏(单文件焦点):落点侧即拖入侧,动作各自解释
      return hitLeft ? 'left' : 'right'
    }
    if (actG.kind === 'session-file') {
      // 会话在左:文件只收右侧(文件落左=升级文件+文件);会话源=切换会话(组合保持)
      return isSession ? hitLeft ? 'left' : 'right' : x > rect.right ? 'right' : null
    }
    return hitLeft ? 'left' : 'right'
  }
  useEffect(() => {
    const onDragOver = (e: DragEvent): void => {
      const dt = e.dataTransfer
      if (dt === null || ![...dt.types].includes('text/dshw-tab-id')) return
      e.preventDefault()
      dt.dropEffect = 'move'
      const snapNow = fileTabsGetSnapshot()
      const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
      if (col === null) return
      const rect = col.getBoundingClientRect()
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < TOPBAR_HEIGHT) {
        setSplitPreview(null, '', 'right')
        return
      }
      const pane = dropPane(snapNow, e.clientX, rect)
      const id = draggingTabId
      if (id === '' || pane === null) {
        setSplitPreview(null, '', 'right')
        return
      }
      const shape =
        draggingKind === 'session'
          ? planSessionDrop(snapNow, id)
          : planDrop(snapNow, id, pane, currentIdRef.current ?? '')
      if (shape === undefined) { setSplitPreview(null, '', 'right'); return }
      setSplitPreview(shape, id, pane)
    }
    const onDrop = (e: DragEvent): void => {
      const dt = e.dataTransfer
      if (dt === null) return
      setSplitPreview(null, '', 'right')
      const id = draggingTabId
      if (id === '') return
      const snapNow = fileTabsGetSnapshot()
      const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
      if (col === null) return
      const rect = col.getBoundingClientRect()
      const inCol = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= TOPBAR_HEIGHT
      if (!inCol) return
      e.preventDefault()
      const pane = dropPane(snapNow, e.clientX, rect)
      if (pane === null) return
      if (draggingKind === 'session') {
        attachSessionPane(id)
        // 会话侧 = 宿主 currentId:拖入其它会话时切宿主激活(topbar 接管)
        window.dispatchEvent(new CustomEvent('dshw-coding-workspace:open-session', { detail: id }))
      } else openInPane(id, pane, currentIdRef.current ?? '')
    }
    const onDragEnd = (): void => {
      draggingTabId = ''
      setSplitPreview(null, '', 'right')
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [])

  // ── 分栏两组合:session-file(左会话右文件,margin-right 推窄宿主)/
  // file-file(宿主全盖,overlay 内双栏)。会话只支持放左边(老板定案)。
  // split 为 null = 单文件模式(overlay 全占对话区,split 仅由拖拽/右键显式建立)。
  // 拖拽预览(preview)只画灰色占位窗体(见文末),**不**驱动真实布局渲染——
  // 布局只在 drop 落位后变化,避免拖动过程中对话区跟着抖动。
  // 激活组(多组模型):active.split 指向的组;休眠组不驱动布局渲染
  const split = activeGroup
  const splitOn = split !== null
  const mrRef = useRef(0)
  useEffect(() => {
    const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
    if (col === null) return
    const kind = splitOn && split !== null ? split.kind : null
    const tr = kind === 'session-file' ? Math.max(Math.round((colBox.width + mrRef.current) * (1 - split.ratio)), 240) : 0
    if (tr !== mrRef.current || col.style.marginRight !== (tr !== 0 ? `${tr}px` : '')) {
      mrRef.current = tr
      col.style.marginRight = tr !== 0 ? `${tr}px` : ''
    }
  }, [splitOn, colBox.width, split])
  // 卸载清理:切回纯会话(组件不渲染)也要还原宿主布局
  useEffect(
    () => () => {
      const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
      if (col !== null) {
        col.style.marginLeft = ''
        col.style.marginRight = ''
      }
      mrRef.current = 0
    },
    [],
  )

  // 灰色占位窗体(Windows Snap 式拖拽预览):按 preview 形状算目标区域,
  // 半透明灰块+虚线框告知用户松手后新文件占据的位置;纯会话预览也渲染
  const pv = snap.preview
  const previewRect = (() => {
    if (pv === null) return null
    const w0 = colBox.width + mrRef.current
    const x0 = colBox.left
    const r = pv.shape.ratio
    if (pv.shape.kind === 'session-file') return { left: x0 + w0 * r, width: w0 * (1 - r) }
    return pv.pane === 'left' ? { left: x0, width: w0 * r } : { left: x0 + w0 * r, width: w0 * (1 - r) }
  })()
  const ghost =
    previewRect !== null
      ? jsx('div', {
          style: {
            position: 'fixed',
            left: previewRect.left,
            top: TOPBAR_HEIGHT,
            width: previewRect.width,
            bottom: 0,
            background: 'rgba(127,127,127,0.25)',
            border: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.6))',
            borderRadius: 8,
            zIndex: 28,
            pointerEvents: 'none',
          },
        })
      : null
  // 纯会话态:无预览则不渲染;有预览只画灰块(overlay 主体需要焦点文件,没有)
  if (tab === undefined) return ghost

  // 几何:分栏激活才走组合布局;休眠(split 保留但 active 是 file/session)= 单文件模式
  const kind = splitOn && split !== null ? split.kind : null
  const mRight = split !== null && kind === 'session-file' ? Math.max(Math.round((colBox.width + mrRef.current) * (1 - split.ratio)), 240) : 0
  const paneLeft = kind === 'session-file' ? colBox.left + colBox.width : colBox.left
  const paneW = kind === 'file-file' || kind === null ? colBox.width : mRight

  // 文件+文件的双栏内容(视图组件 key=tab.id 防实例复用串状态)
  const leftTab = split !== null && split.leftTabId !== null ? snap.tabs.find((tb) => tb.id === split.leftTabId) : undefined
  const rightTab = split !== null && split.rightTabId !== null ? snap.tabs.find((tb) => tb.id === split.rightTabId) : undefined
  const viewOf = (tb: FileTab | undefined): any =>
    tb === undefined
      ? null
      : tb.view === 'image'
        ? jsx(ImagePreviewView, { tab: tb, key: tb.id })
        : jsx(DiffView, { tab: tb, bridge, key: tb.id })
  // edit/diff 统一走 DiffView(老大定版:diff 可编辑双栏;旧 edit TAB 自动并入)

  // 分隔条:单栏组合贴宿主侧(absolute ±3px),file-file 在双栏之间(flex 流)。
  // 拖动换算:宿主侧组合按对话区左缘/全宽,file-file 按 overlay 自身矩形。
  const onDividerDown = (e: any): void => {
    if (e.button !== 0) return
    e.preventDefault()
    let base = colBox.left
    let total = colBox.width + (kind === 'session-file' ? mrRef.current : 0)
    if (kind === 'file-file') {
      const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
      base = rect.left
      total = rect.width
    }
    const move = (ev: any): void => setSplitRatio((ev.clientX - base) / total)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
  }
  const resetRatio = (): void => setSplitRatio(0.55)

  const name = tab.relPath.split('/').pop() ?? tab.relPath
  const onClose = (): void => {
    if (tab.dirty && !window.confirm(t('editor.closeDirtyConfirm', { name }))) return
    closeFile(tab.id)
  }
  // 历史 commit diff:头部名带短 hash 标记(区分同文件的不同提交 TAB)
  const commitTag = tab.commit !== undefined ? ` @ ${tab.commit.slice(0, 7)}` : ''
  // 文件+文件:头部显示「左名 | 右名」合并(与合并 TAB 标题一致)
  const headName =
    kind === 'file-file' && leftTab !== undefined && rightTab !== undefined
      ? `${leftTab.relPath.split('/').pop() ?? leftTab.relPath} | ${rightTab.relPath.split('/').pop() ?? rightTab.relPath}`
      : `${name}${commitTag}`

  return jsx('div', {
    ref: rootRef,
    style: {
      position: 'fixed',
      top: TOPBAR_HEIGHT,
      left: paneLeft,
      width: paneW,
      bottom: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--dsw-alias-bg-base)',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      borderLeft: '1px solid var(--dsw-alias-border-l1)',
      zIndex: 20,
    },
    children: jsxs(Fragment, {
      children: [
        // 分隔条:单栏组合贴宿主侧(overlay 外缘 ±3px);file-file 在双栏之间;
        // 单文件模式(未分栏或分栏休眠)无分栏概念,不渲染
        splitOn && split !== null
          ? jsx('div', {
              title: t('editor.dividerHint'),
              onMouseDown: onDividerDown,
              onDoubleClick: resetRatio,
              style: {
                ...(kind === 'file-file'
                  ? { width: 6, flexShrink: 0, cursor: 'col-resize' }
                  : {
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      width: 6,
                      cursor: 'col-resize',
                      zIndex: 25,
                      ...(kind === 'session-file' ? { left: -3 } : { right: -3 }),
                    }),
              },
            })
          : null,
        kind === 'file-file'
          ? jsxs(Fragment, {
              children: [
                // 文件+文件头部(普通流):合并名 + 拆分(关两栏回会话)
                jsxs('div', {
                  style: {
                    height: 36,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 10px',
                    background: 'var(--dsw-alias-bg-base)',
                    borderBottom: '1px solid var(--dsw-alias-border-l1)',
                    flexShrink: 0,
                  },
                  children: [
                    jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' }, children: jsx(FileGlyph, { size: 13 }) }),
                    jsx('span', {
                      title: `${leftTab?.relPath ?? ''} | ${rightTab?.relPath ?? ''}`,
                      style: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' },
                      children: headName,
                    }),
                    jsx('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed)', flexShrink: 0 }, children: t('editor.splitTag') }),
                    jsx('div', { style: { flex: 1 } }),
                    jsx('button', {
                      className: 'dshw-iconbtn',
                      title: t('tab.split'),
                      // 拆分:退出分栏,焦点文件保留单开(另一文件回普通 TAB)
                      onClick: () => exitSplit(),
                      style: { fontSize: 13, lineHeight: 1, display: 'inline-flex', alignItems: 'center' },
                      children: jsx('svg', {
                        width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
                        children: [jsx('rect', { key: 'a', x: 2, y: 2.5, width: 4.6, height: 11, rx: 1 }), jsx('rect', { key: 'b', x: 9.4, y: 2.5, width: 4.6, height: 11, rx: 1 })],
                      }),
                    }),
                  ],
                }),
                // 双栏行:左(ratio)| 分隔条 | 右(余量);拖中间分隔条调 ratio
                jsxs('div', {
                  style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' },
                  children: [
                    jsx('div', {
                      style: { flex: `0 0 ${split.ratio * 100}%`, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' },
                      children: viewOf(leftTab),
                    }),
                    jsx('div', {
                      title: t('editor.dividerHint'),
                      onMouseDown: onDividerDown,
                      onDoubleClick: resetRatio,
                      style: { width: 6, flexShrink: 0, cursor: 'col-resize', background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.06))' },
                    }),
                    jsx('div', {
                      style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' },
                      children: viewOf(rightTab),
                    }),
                  ],
                }),
              ],
            })
          : jsxs(Fragment, {
              children: [
                // 头部:文件名 + (编辑 TAB)脏标记 + 关闭;类型由入口决定,无视图切换
                jsxs('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 36,
                    padding: '0 10px',
                    borderBottom: '1px solid var(--dsw-alias-border-l1)',
                    flexShrink: 0,
                  },
                  children: [
                    jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' }, children: jsx(FileGlyph, { size: 13 }) }),
                    jsx('span', {
                      title: tab.relPath,
                      style: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      children: jsx('span', {
                        children: [
                          jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: tab.relPath.slice(0, tab.relPath.length - name.length) }),
                          jsx('span', { style: { color: 'var(--dsw-alias-label-primary)' }, children: name }),
                        ],
                      }),
                    }),
                    // 脏标记点(仅编辑 TAB 有意义)
                    tab.view === 'edit'
                      ? jsx('span', {
                          title: t('editor.dirtyDot'),
                          style: {
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            flexShrink: 0,
                            background: tab.dirty ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                          },
                        })
                      : null,
                    // diff TAB 提示:只读对比
                    tab.view === 'diff'
                      ? jsx('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed)', flexShrink: 0 }, children: 'Diff' })
                      : null,
                    // 图片 TAB 提示:只读预览
                    tab.view === 'image'
                      ? jsx('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed)', flexShrink: 0 }, children: t('image.tag') })
                      : null,
                    jsx('div', { style: { flex: 1 } }),
                    jsx(
                      'button',
                      {
                        className: 'dshw-iconbtn',
                        title: t('editor.close'),
                        onClick: onClose,
                        style: { fontSize: 14, lineHeight: 1 },
                        children: '✕',
                      },
                    ),
                  ],
                }),
                // key=tab.id:切换文件 TAB 必须重建组件(按位置复用实例时 state/ref 不重置)——
                // image 的 src 是挂载期 state;edit 的 undo/redo 栈是 ref(残留会把 B 文件
                // 撤成 A 的内容);diff 的 composer/收起卡片状态同理跨文件泄漏
                viewOf(tab),
              ],
            }),
        ghost,
      ],
    }),
  })
}
