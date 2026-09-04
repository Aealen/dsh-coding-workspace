import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { t } from './i18n.js'
import {
  fileTabsSubscribe,
  fileTabsGetSnapshot,
  closeFile,
  setFileDirty,
  type FileTab,
} from './file-tabs.js'
import { alignLines, diffBlocks, type DiffRow } from './panel-diff.js'
import { langOf, highlightLines } from './highlight-hljs.js'
import { TOPBAR_HEIGHT } from './topbar-core.js'

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
  line: number
  text: string
  createdAt: number
}

/** 某文件行评论的状态与动作(编辑/ diff 两视图共用)。 */
function useLineNotes(cwd: string, relPath: string): {
  notes: LineNoteRow[]
  reload: () => void
  add: (line: number, text: string) => Promise<void>
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
    add: (line, text) => mutate({ action: 'add', line, text }),
    update: (id, text) => mutate({ action: 'update', id, text }),
    remove: (id) => mutate({ action: 'delete', id }),
  }
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
    if (sessions === null) {
      Promise.all([apiRpc<any>('workspace.list'), apiRpc<any>('session.list')])
        .then(([ws, sl]) => {
          const archived = new Set(Array.isArray(ws?.archivedSessionIds) ? ws.archivedSessionIds : [])
          const norm = (p: unknown): string => (typeof p === 'string' ? p.trim().replace(/\\/g, '/') : '')
          setSessions(
            (sl?.items ?? []).filter(
              (it: any) => it?.origin !== 'subagent' && !archived.has(it.sessionId) && norm(it?.cwd) === norm(cwd),
            ),
          )
        })
        .catch(() => setSessions([]))
    }
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
      const block = `File: ${relPath}\n  Line: ${n.line}\n  User comment: "${n.text}"`
      const sep = draft === '' || draft.endsWith('\n') ? '' : '\n'
      facade.actions.setDraft(`${draft}${sep}${block}\n`)
      setToast(t('note.sent', { name }))
      setPicking(null)
    } catch (e) {
      setToast(t('note.sendFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }
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
      jsx('div', { style: { fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 }, children: t('note.cardTitle', { line }) }),
      notes.map((n) =>
        jsxs('div', { style: { marginTop: 2 }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6 }, children: [
            jsx('div', { style: { flex: 1, fontSize: 12.5, lineHeight: '19px', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-primary)' }, children: n.text }),
            jsx('span', { style: { display: 'inline-flex', flexShrink: 0, paddingTop: 2 }, children: [
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
                            },
                            children: title(x.sessionId),
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
function NoteComposerRow(props: { line: number; initial: string; submitLabel: string; error?: string; onSubmit: (text: string) => void; onCancel: () => void }): any {
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
        jsx('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-dimmed)' }, children: t('note.title', { line: props.line }) }),
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
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const loadSeq = useRef(0)
  const notes = useLineNotes(tab.cwd, tab.relPath)
  // composer:{line} 新增 | {line, id, initial} 编辑;undefined 收起
  const [composer, setComposer] = useState<{ line: number; id?: string; initial?: string } | undefined>(undefined)
  const [composerError, setComposerError] = useState<string | undefined>(undefined)
  // 行评论交互:hover 段/行(行级显 +)、已收起卡片(圆点重入)、正在编辑的段
  const [hoverSeg, setHoverSeg] = useState<number | null>(null)
  const [hoverRow, setHoverRow] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  useEffect(() => {
    const seq = ++loadSeq.current
    setText(null)
    setError(undefined)
    rpc<any>('fs-read', { root: tab.cwd, path: tab.relPath })
      .then((body) => {
        if (loadSeq.current !== seq) return
        setText(body.content ?? '')
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [tab.cwd, tab.relPath])

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
  ensureEditorStyle()
  const codeFont = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: `${LINE_HEIGHT}px`, tabSize: 2 } as const
  // 有评论的行号集合:该行前内嵌卡片行(18/19 行之间 = 19 行卡片插在 19 行前)
  const notedSet = new Set(notes.notes.map((n) => n.line))
  const toggleCard = (line: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })
  }
  // 段切分:有评论的行(或正在添加的行)前断开,卡片/composer 内嵌在段间
  const cutLines = new Set(notedSet)
  if (composer !== undefined) cutLines.add(composer.line)
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
  }
  // 段文本变化 → 重组全局文本(卡片行不在文本中)
  const onSegChange = (segIdx: number, value: string): void => {
    const seg = segments[segIdx]
    seg.lines = value.split('\n')
    setText(segments.map((sg) => sg.lines.join('\n')).join('\n'))
    setFileDirty(tab.id, true)
  }
  // 一个渲染单元:note 列 + 行号列 + 代码区(pre+textarea 段内叠加)
  const renderSegment = (seg: { startNo: number; lines: string[] }, segIdx: number): any => {
    const value = seg.lines.join('\n')
    return jsxs('div', {
      style: { display: 'flex', minWidth: 'max-content', alignItems: 'flex-start' },
      children: [
        jsx('div', {
          className: 'dshw-note-gutter',
          style: { flexShrink: 0, width: 20, padding: '8px 0', display: 'flex', flexDirection: 'column', userSelect: 'none' },
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
                    onClick: () => (has ? toggleCard(lineNo) : setComposer({ line: lineNo })),
                  })
                : null,
            })
          }),
        }),
        jsx('div', {
          style: {
            flexShrink: 0, width: 34, padding: `8px 8px 8px 0`, textAlign: 'right',
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
                minHeight: seg.lines.length * LINE_HEIGHT + 16,
                boxSizing: 'content-box',
                ...codeFont,
                whiteSpace: 'pre',
                color: 'var(--dsw-alias-label-primary)',
                pointerEvents: 'none',
              },
              children: seg.lines.map((codeLine, i) =>
                jsx('div', {
                  key: seg.startNo + i,
                  style: { minHeight: LINE_HEIGHT },
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
              // 段前内嵌:composer(新增/编辑)+ 该行评论卡片(未收起时)
              composer !== undefined && composer.line === seg.startNo
                ? jsx('div', {
                    style: { padding: '4px 12px 4px 24px', display: 'flex' },
                    children: jsx(NoteComposerRow, {
                      line: composer.line,
                      initial: composer.initial ?? '',
                      error: composerError,
                      submitLabel: composer.id !== undefined ? t('m.save') : t('note.add'),
                      onSubmit: (value: string) => {
                        const act =
                          composer.id !== undefined ? notes.update(composer.id, value) : notes.add(composer.line, value)
                        act.then(() => setComposer(undefined)).catch((e: unknown) => {
                          setComposer({ ...composer, initial: value })
                          setComposerError(e instanceof Error ? e.message : String(e))
                        })
                      },
                      onCancel: () => setComposer(undefined),
                    }),
                  })
                : null,
              segIdx > 0 &&
              composer?.line !== seg.startNo &&
              (() => {
                const cardLine = cards[segIdx - 1]?.line
                if (cardLine === undefined) return null
                const list = notes.notes.filter((n) => n.line === cardLine)
                if (list.length === 0 || collapsed.has(cardLine)) return null
                return jsx('div', {
                  style: { padding: '4px 12px 4px 24px', display: 'flex' },
                  children: jsx(NoteCard, {
                    line: cardLine,
                    notes: list,
                    relPath: tab.relPath,
                    cwd: tab.cwd,
                    bridge,
                    onEdit: (n) => setComposer({ line: cardLine, id: n.id, initial: n.text }),
                    onDelete: (n) => void notes.remove(n.id),
                  }),
                })
              })(),
              renderSegment(seg, segIdx),
            ],
          }),
        ),
        ],
      }),
    ],
  })
}

/**
 * 分栏 Diff 视图(unified 单栏,GitHub/IDEA inline 式):
 * [+/- 标记 | 旧行号 | 新行号](sticky 固定)+ 全宽内容色带。
 * 覆盖层宽度受限,单栏把宽度全给内容,对应关系上下相邻天然可读;
 * 右缘缩略状态列保留(点击跳转)。行评论与编辑视图共用(锚定当前版本行号)。
 */
function DiffView(props: { tab: FileTab; bridge?: NoteBridge }): any {
  const { tab, bridge } = props
  const [rows, setRows] = useState<DiffRow[] | null>(null)
  const [untracked, setUntracked] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const scRef = useRef<HTMLDivElement | null>(null)
  const loadSeq = useRef(0)
  const notes = useLineNotes(tab.cwd, tab.relPath)
  // diff 行高亮:base/current 各自逐行染色,行对齐后按行号取 HTML
  const [hl, setHl] = useState<{ base: { html: string }[]; current: { html: string }[] } | null>(null)
  const [composer, setComposer] = useState<{ line: number; id?: string; initial?: string } | undefined>(undefined)
  const [composerError, setComposerError] = useState<string | undefined>(undefined)
  const [composerAnchor, setComposerAnchor] = useState<number | null>(null)
  // 已收起的卡片(行索引;圆点重入切换)
  const [collapsedCards, setCollapsedCards] = useState<Set<number>>(new Set())

  useEffect(() => {
    const seq = ++loadSeq.current
    setRows(null)
    setHl(null)
    setError(undefined)
    rpc<any>('git-diff', { cwd: tab.cwd, path: tab.relPath })
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
    // dirty 参与依赖:编辑视图保存后脏标记翻负,自动重拉最新内容
  }, [tab.cwd, tab.relPath, tab.dirty])

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
        if ((row.right !== null && row.right === n.line) || (row.right === null && row.left === n.line)) {
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
                          setComposer({ line: n.line, id: n.id, initial: n.text })
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
                        line: composer.line,
                        initial: composer.initial ?? '',
                        error: composerError,
                        submitLabel: composer.id !== undefined ? t('m.save') : t('note.add'),
                        onSubmit: (value: string) => {
                          const act =
                            composer.id !== undefined ? notes.update(composer.id, value) : notes.add(composer.line, value)
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
                            setComposer({ line: row.right ?? row.left ?? i + 1 })
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
  const { cwd } = useCurrentCwd(props?.useSessions)
  const snap = useSyncExternalStore(fileTabsSubscribe, fileTabsGetSnapshot, fileTabsGetSnapshot)
  // 文件 TAB 与会话工作区绑定:激活 TAB 不属于当前会话 cwd 时视同会话态(盖层收起)
  let tab = snap.active.kind === 'file' ? snap.tabs.find((tb) => tb.id === snap.active.id) : undefined
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

  if (tab === undefined) return null

  const name = tab.relPath.split('/').pop() ?? tab.relPath
  const onClose = (): void => {
    if (tab.dirty && !window.confirm(t('editor.closeDirtyConfirm', { name }))) return
    closeFile(tab.id)
  }

  return jsx('div', {
    ref: rootRef,
    style: {
      position: 'fixed',
      top: TOPBAR_HEIGHT,
      left: colBox.left,
      width: colBox.width,
      bottom: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--dsw-alias-bg-base)',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      zIndex: 20,
    },
    children: jsxs(Fragment, {
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
        tab.view === 'edit' ? jsx(EditView, { tab, bridge }) : jsx(DiffView, { tab, bridge }),
      ],
    }),
  })
}
