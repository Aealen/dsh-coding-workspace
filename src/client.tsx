/**
 * dsh-worktree 客户端半区:侧栏「项目」分组视图(P4-M3 乙路线)。
 *
 * 层级:项目(git 主仓)→ 工作区(主工作区带 TAG,worktree 并列)→ 会话。
 * 交互用官方原语库 @deepseek-ai/dsh-client-ui-primitives(shell 种子模块,
 * 发布给所有插件用,非 vendoring);动作全部接客户端 ctx 公开 API:
 * - ctx.sessions.open / fork / binding().session.rename
 * - ctx.workspaces.startSession / rename / delete / archiveSession
 *
 * ⚠️ jsx-runtime:children 必须放 props.children(第三参是 key)。
 */

/** 行 hover 样式:内联 style 写不了伪类,factory 物化时注入一次。 */
function injectStyles(): void {
  if (document.getElementById('dshw-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dshw-style'
  style.textContent = `
    .dshw-row:hover, .dshw-row[data-active] { background: var(--dsw-alias-interactive-bg-hover) !important; }
    .dshw-wsrow:hover, .dshw-grouphdr:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .dshw-row:hover button, .dshw-wsrow:hover button, .dshw-grouphdr:hover button { opacity: 0.9; }
    .dshw-opt { cursor: pointer; border: 1px solid rgba(127,127,127,0.35); border-radius: 8px; padding: 8px 10px; }
    .dshw-opt:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .dshw-opt.disabled { opacity: 0.45; cursor: not-allowed; }
  `
  document.head.appendChild(style)
}
import type { Context } from '@deepseek-ai/cordis'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

export const name = 'dsh-worktree'

/** slots + sessions/open/fork/binding + workspaces/startSession/rename/delete/archiveSession。 */
export const inject = ['slots', 'sessions', 'workspaces']

interface WorkspaceRow {
  workspaceId: string
  path: string
  title?: string
  sessionIds: string[]
}

interface SessionRow {
  sessionId: string
  cwd?: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
  projections?: { values?: { title?: string | null } }
}

type RenameTarget = { kind: 'session' | 'workspace'; id: string; draft: string }

interface LineageEdge {
  parentPath?: string | null
}

/** 同源 RPC(与宿主前端形态一致)。 */
async function rpc<T = any>(method: string): Promise<T> {
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {} }),
  })
  const body = await res.json()
  if (!body?.result?.ok) throw new Error(`${method}: ${body?.result?.error?.message ?? res.status}`)
  return body.result.value as T
}

function sessionLabel(s: SessionRow | undefined, id: string, overrides?: Record<string, string>): string {
  const override = overrides?.[id]
  if (override !== undefined) return override
  const title = s?.projections?.values?.title
  if (title && title.trim() !== '') return title
  return id.replace(/^session-/, '').slice(0, 8)
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return norm.slice(norm.lastIndexOf('/') + 1) || norm
}

const UNPINNED = '__ungrouped__'

// 字号/行高对齐原版侧栏:.title 14px/20px、sessionRow 高 32、projectRow 高 34
const rowBase: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  lineHeight: '20px',
  borderRadius: 8,
  minHeight: 32,
}

const menuBtnStyle: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'center',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  opacity: 0.55,
  cursor: 'pointer',
  padding: '2px',
  borderRadius: 4,
}

/** 菜单项:icon 原语 + disabled(官方 Menu 原生支持,对齐 ui-workspace 用法)。 */
type MenuItem = { id: string; label: string; danger?: boolean; disabled?: boolean; icon?: any }

/** 行尾三点菜单(官方 Menu 原语,anchor 模式)。 */
function RowMenu(props: { items: MenuItem[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return jsx(Primitives.Menu, {
    open,
    onClose: () => setOpen(false),
    items: props.items,
    onSelect: (id: string) => {
      setOpen(false)
      props.onSelect(id)
    },
    portal: true,
    closeOnPointerLeave: true,
    anchor: jsx('button', {
      type: 'button',
      style: menuBtnStyle,
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation()
        setOpen((v: boolean) => !v)
      },
      children: jsx(Primitives.IconEllipsisOutline16, {}),
    }),
  })
}

/** 主工作区 TAG。 */
function MainTag() {
  return jsx(
    'span',
    {
      style: {
        fontSize: 10,
        lineHeight: '14px',
        padding: '0 5px',
        borderRadius: 4,
        border: '1px solid rgba(127,127,127,0.5)',
        opacity: 0.8,
        flexShrink: 0,
      },
      children: '主',
    },
  )
}

interface Actions {
  open: (sessionId: string) => void
  startSession: (workspaceId: string) => void
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** mode=focus 走插件 HTTP 路由(机械摘要种子);full 走宿主原生 fork。 */
  forkSession: (sessionId: string, mode: 'full' | 'focus') => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  renameWorkspace: (workspaceId: string, title: string) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  createWorkspace: (path: string) => Promise<void>
}

/** 项目分组视图:项目 → 工作区(主 TAG)→ 会话;行内三点菜单。 */
function ProjectTreeBrowser(props: Record<string, any>) {
  const actions: Actions = props
  // 两级折叠:组键 / 工作区键 → 是否展开;默认全展开,localStorage 记忆
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('dshw-expanded') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const isExpanded = (key: string): boolean => expanded[key] !== false
  const toggleExpanded = (key: string): void =>
    setExpanded((prev) => {
      const next = { ...prev, [key]: !(prev[key] !== false) }
      try {
        localStorage.setItem('dshw-expanded', JSON.stringify(next))
      } catch {}
      return next
    })
  const [data, setData] = useState<{
    workspaces: WorkspaceRow[]
    sessions: Record<string, SessionRow>
    currentId?: string
    lineage: any
    error?: string
  } | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  // 投影 title 快照有推送时延:本地覆盖即时生效
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({})
  // 操作反馈条(fork 拒绝等,fork-unavailable 不再静默)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (text: string, tone: 'info' | 'error' = 'info') => {
    setToast({ text, tone })
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }
  // 派生分支 Modal(选聚焦交接 / 全部对话记录)
  const [forkTarget, setForkTarget] = useState<{ sessionId: string; title: string } | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  // 新建工作区 Modal(项目组头 + 触发)
  const [createWsOpen, setCreateWsOpen] = useState(false)
  const [createWsPath, setCreateWsPath] = useState('')
  const [createWsBusy, setCreateWsBusy] = useState(false)

  const runFork = (mode: 'full' | 'focus') => {
    if (forkTarget === null || forkBusy) return
    setForkBusy(true)
    actions
      .forkSession?.(forkTarget.sessionId, mode)
      .then(() => {
        showToast(mode === 'focus' ? '已聚焦交接派生新会话' : '已派生新分支(完整记录)', 'info')
        setForkTarget(null)
        return load()
      })
      .catch((error: unknown) => {
        showToast(`派生失败:${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      .finally(() => setForkBusy(false))
  }

  const submitCreateWs = () => {
    const path = createWsPath.trim()
    if (path === '' || createWsBusy) return
    setCreateWsBusy(true)
    actions
      .createWorkspace?.(path)
      .then(() => {
        showToast(`工作区已创建:${path}`, 'info')
        setCreateWsOpen(false)
        setCreateWsPath('')
        return load()
      })
      .catch((error: unknown) => {
        showToast(`创建失败:${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      .finally(() => setCreateWsBusy(false))
  }

  const load = async () => {
    try {
      const [ws, sl] = await Promise.all([rpc<any>('workspace.list'), rpc<any>('session.list')])
      const workspaces: WorkspaceRow[] = ws.items ?? []
      // workspace.list 同时返回 registry-global 归档集合;归档会话不进树
      const archived = new Set<string>(Array.isArray(ws.archivedSessionIds) ? ws.archivedSessionIds : [])
      const lineage = await fetch('/dsh-worktree/lineage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: workspaces.map((w) => w.path) }),
      }).then((r) => r.json())
      const sessions: Record<string, SessionRow> = {}
      let currentId: string | undefined
      for (const it of sl.items ?? []) {
        if (archived.has(it.sessionId)) continue
        sessions[it.sessionId] = it
        if (it.running) currentId = it.sessionId
      }
      setData({ workspaces, sessions, currentId, lineage })
    } catch (error) {
      setData({ workspaces: [], sessions: {}, lineage: null, error: String(error) })
    }
  }
  useEffect(() => {
    void load()
    // 10s 轮询兜底;会话按 cwd 归属,不依赖 attach 时序
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])

  if (data?.error !== undefined) {
    return jsx('div', { style: { padding: 12, fontSize: 12, color: '#e06c75' }, children: `dsh-worktree: ${data.error}` })
  }
  if (data === null) {
    return jsx('div', { style: { padding: 12, fontSize: 12, opacity: 0.6 }, children: '加载中…' })
  }

  const currentId = data.currentId
  const byId = data.sessions
  const groups = new Map<string, WorkspaceRow[]>()
  const wt = data.lineage?.worktrees ?? {}
  for (const w of data.workspaces) {
    const k = w.path.replace(/\\/g, '/')
    const hit = wt[k] as LineageEdge | undefined
    // 有边即归组:parentPath=null 表示自身是项目根,组键 = 自己的路径
    const key = hit === undefined ? UNPINNED : (hit.parentPath ?? k)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(w)
  }

  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === UNPINNED ? 1 : b === UNPINNED ? -1 : a.localeCompare(b),
  )

  // cwd 归属索引:会话按其 cwd 落到工作区,不依赖 attach 写 sessionIds 的时序
  const byCwd = new Map<string, SessionRow[]>()
  for (const it of Object.values(data.sessions)) {
    const c = it.cwd?.replace(/\\/g, '/')
    if (!c) continue
    if (!byCwd.has(c)) byCwd.set(c, [])
    byCwd.get(c)!.push(it)
  }

  const children: any[] = []
  for (const [parent, ws] of ordered) {
    const isGrouped = parent !== UNPINNED
    const label = isGrouped ? baseName(parent) : '其他工作区'
    // 主工作区:组内 parentPath===null 的(自身即根);多个取第一个
    const mainWs = isGrouped ? ws.find((w) => wt[w.path.replace(/\\/g, '/')]?.parentPath === null) : undefined
    const totalSessions = ws.reduce((acc, w) => acc + (w.sessionIds?.length ?? 0), 0)
    const groupKey = `g-${parent}`
    const groupOpen = isExpanded(groupKey)

    children.push(
      jsx(
        'div',
        {
          key: groupKey,
          onClick: () => toggleExpanded(groupKey),
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 10px 3px',
            cursor: 'pointer',
            color: 'var(--dsw-alias-label-tertiary)',
            borderRadius: 8,
          },
          className: 'dshw-grouphdr',
          children: [
            jsx(
              'span',
              {
                key: 'label',
                style: { fontSize: 12, lineHeight: '20px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, display: 'inline-flex', alignItems: 'center' },
                children: [
                  jsx('span', { key: 'tw', style: { width: 14, display: 'inline-block', textAlign: 'center' }, children: groupOpen ? '▾' : '▸' }),
                  `${label} · ${totalSessions}`,
                ],
              },
            ),
            jsx(
              'button',
              {
                key: 'add',
                type: 'button',
                title: `在「${label}」新建工作区`,
                style: { ...menuBtnStyle, fontSize: 14 },
                onClick: (e: React.MouseEvent) => {
                  e.stopPropagation()
                  setCreateWsOpen(true)
                },
                children: '+',
              },
            ),
          ].filter(Boolean),
        },
      ),
    )
    if (!groupOpen) continue

    for (const w of ws) {
      const isRoot = isGrouped && mainWs !== undefined && w.workspaceId === mainWs.workspaceId
      const wsKey = `w-${w.workspaceId}`
      const wsOpen = isExpanded(wsKey)
      const wsMenu = jsx(RowMenu, {
        key: 'wsmenu',
        items: [
          { id: 'new', label: '新建会话', icon: jsx(Primitives.IconNewChatOutline16, {}) },
          { id: 'rename', label: '重命名工作区', icon: jsx(Primitives.IconEditOutline16, {}) },
          { id: 'delete', label: '移除工作区记录', danger: true, icon: jsx(Primitives.IconTrashOutline16, {}) },
        ],
        onSelect: (id: string) => {
          if (id === 'new') actions.startSession?.(w.workspaceId)
          if (id === 'rename') {
            setRenameTarget({ kind: 'workspace', id: w.workspaceId, draft: w.title ?? baseName(w.path) })
          }
          if (id === 'delete') {
            if (window.confirm(`移除工作区记录「${w.title ?? baseName(w.path)}」?(不影响磁盘上的目录)`) === true) {
              void actions.deleteWorkspace?.(w.workspaceId)
            }
          }
        },
      })

      children.push(
        jsx(
          'div',
          {
            key: wsKey,
            className: 'dshw-wsrow',
            onClick: () => toggleExpanded(wsKey),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 10px',
              fontSize: 14,
              lineHeight: '20px',
              minHeight: 34,
              opacity: isRoot ? 1 : 0.85,
              fontWeight: isRoot ? 600 : 400,
              color: 'var(--dsw-alias-label-primary)',
              cursor: 'pointer',
              borderRadius: 8,
            },
            children: [
              jsx('span', {
                key: 'tw',
                style: { width: 14, flexShrink: 0, display: 'inline-block', textAlign: 'center', transition: 'transform 120ms', transform: wsOpen ? 'rotate(90deg)' : 'none', opacity: 0.6 },
                children: '▸',
              }),
              // 老大定版:主/派生工作区统一文件夹图标,不再用分支图标区分
              jsx('span', { key: 'ico', style: { opacity: 0.7 }, children: jsx(Primitives.IconFolderClose16, {}) }),
              jsx(
                'span',
                { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: w.title ?? baseName(w.path) },
              ),
              isRoot ? jsx(MainTag, { key: 'tag' }) : null,
              jsx('span', { key: 'sp', style: { flex: 1 } }),
              wsMenu,
            ].filter(Boolean),
          },
        ),
      )
      if (!wsOpen) continue

      // cwd 归属优先(sessionIds 兜底),合并去重,最近活动在前
      const wsPath = w.path.replace(/\\/g, '/')
      const merged: SessionRow[] = []
      const seen = new Set<string>()
      for (const s of [...(byCwd.get(wsPath) ?? []), ...(w.sessionIds ?? []).map((id) => byId[id]).filter(Boolean)]) {
        if (seen.has(s.sessionId)) continue
        seen.add(s.sessionId)
        merged.push(s)
      }
      merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

      for (const s of merged) {
        const sid = s.sessionId
        const active = sid === currentId
        children.push(
          jsx(
            'div',
            {
              key: sid,
              className: 'dshw-row',
              title: sid,
              onClick: () => actions.open?.(sid),
              onContextMenu: (e: React.MouseEvent) => {
                // 右键 = 行内三点菜单(复用同一 Menu)
                e.preventDefault()
                const btn = (e.currentTarget as HTMLElement).querySelector('button')
                if (btn) btn.click()
              },
              style: {
                ...rowBase,
                paddingLeft: 30,
                fontWeight: active ? 600 : 400,
              },
              ...(active ? { 'data-active': '' } : {}),
              children: [
                jsx(
                  'span',
                  {
                    key: 'label',
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
                    children: sessionLabel(s, sid, titleOverrides),
                  },
                ),
                s?.running
                  ? jsx('span', { key: 'dot', style: { fontSize: 10, color: '#98c379' }, children: '●' })
                  : null,
                jsx(RowMenu, {
                  key: 'menu',
                  items: [
                    { id: 'open', label: '打开', icon: jsx(Primitives.IconFolderOpen16, {}) },
                    { id: 'rename', label: '重命名', icon: jsx(Primitives.IconEditOutline16, {}) },
                    { id: 'fork', label: '派生分支', icon: jsx(Primitives.IconBranchOutline16, {}) },
                    { id: 'archive', label: '归档', danger: true, icon: jsx(Primitives.IconArchiveOutline20, { size: 16 }) },
                  ],
                  onSelect: (id: string) => {
                    if (id === 'open') actions.open?.(sid)
                    if (id === 'rename') {
                      setRenameTarget({ kind: 'session', id: sid, draft: titleOverrides[sid] ?? sessionLabel(s, sid) })
                    }
                    if (id === 'fork') {
                      // 弹 Modal 由用户选交接方式(聚焦交接 / 全部对话记录)
                      setForkTarget({ sessionId: sid, title: sessionLabel(s, sid, titleOverrides) })
                    }
                    if (id === 'archive') {
                      actions.archiveSession?.(sid).then(() => void load()).catch((error: unknown) => {
                        showToast(`归档失败:${error instanceof Error ? error.message : String(error)}`, 'error')
                      })
                    }
                  },
                }),
              ].filter(Boolean),
            },
          ),
        )
      }
    }
  }

  const confirmRename = async () => {
    if (renameTarget === null) return
    setRenameBusy(true)
    try {
      const title = renameTarget.draft.trim()
      if (renameTarget.kind === 'session') {
        await actions.renameSession?.(renameTarget.id, title)
        setTitleOverrides((prev) => ({ ...prev, [renameTarget.id]: title }))
      } else {
        await actions.renameWorkspace?.(renameTarget.id, title)
      }
      setRenameTarget(null)
      void load()
    } finally {
      setRenameBusy(false)
    }
  }

  return jsxs(Fragment, {
    children: [
      jsx(
        'div',
        {
          style: { padding: '4px 2px', overflowY: 'auto', maxHeight: '100%' },
          children:
            children.length > 0
              ? children
              : [jsx('div', { key: 'empty', style: { padding: 12, fontSize: 12, opacity: 0.6 }, children: '暂无工作区' })],
        },
      ),
      toast !== null
        ? jsx(
            'div',
            {
              key: 'toast',
              onClick: () => setToast(null),
              style: {
                margin: '6px 8px 8px',
                padding: '6px 10px',
                fontSize: 12,
                lineHeight: '18px',
                borderRadius: 8,
                cursor: 'pointer',
                color: toast.tone === 'error' ? 'var(--dsw-alias-state-error-primary, #e06c75)' : 'var(--dsw-alias-label-secondary)',
                border: '1px solid rgba(127,127,127,0.3)',
              },
              children: toast.text,
            },
          )
        : null,
      jsx(Primitives.Modal, {
        open: renameTarget !== null,
        onClose: () => setRenameTarget(null),
        title: renameTarget?.kind === 'workspace' ? '重命名工作区' : '重命名会话',
        footer: jsxs(Fragment, {
          children: [
            jsx(Primitives.Button, {
              key: 'cancel',
              variant: 'outline',
              disabled: renameBusy,
              onClick: () => setRenameTarget(null),
              children: '取消',
            }),
            jsx(Primitives.Button, {
              key: 'ok',
              variant: 'primary',
              disabled: renameBusy || renameTarget === null || renameTarget.draft.trim() === '',
              onClick: () => void confirmRename(),
              children: '重命名',
            }),
          ],
        }),
        children: jsx('input', {
          autoFocus: true,
          value: renameTarget?.draft ?? '',
          'aria-label': '名称',
          disabled: renameBusy,
          onChange: (e: any) => setRenameTarget((t) => (t === null ? t : { ...t, draft: e.target.value })),
          onKeyDown: (e: any) => {
            if (e.key === 'Enter' && renameTarget !== null && renameTarget.draft.trim() !== '') void confirmRename()
          },
          style: {
            width: '100%',
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid rgba(127,127,127,0.45)',
            background: 'transparent',
            color: 'inherit',
            fontSize: 14,
          },
        }),
      }),
      jsx(
        Primitives.Modal,
        {
          open: forkTarget !== null,
          onClose: () => {
            if (!forkBusy) setForkTarget(null)
          },
          title: '派生分支',
          footer: jsx(Primitives.Button, {
            variant: 'outline',
            disabled: forkBusy,
            onClick: () => setForkTarget(null),
            children: '取消',
          }),
          children: jsxs('div', {
            children: [
              jsx('div', {
                key: 'desc',
                style: { fontSize: 13, lineHeight: '20px', marginBottom: 10, color: 'var(--dsw-alias-label-secondary)' },
                children: forkTarget === null ? '' : `从「${forkTarget.title}」派生一个新会话,选择交接方式:`,
              }),
              jsx(
                'div',
                {
                  key: 'opt-focus',
                  className: `dshw-opt${forkBusy ? ' disabled' : ''}`,
                  style: { marginBottom: 8 },
                  onClick: () => runFork('focus'),
                  children: [
                    jsx('div', { key: 't', style: { fontSize: 14, fontWeight: 600 }, children: '聚焦交接' }),
                    jsx('div', { key: 'd', style: { fontSize: 12, opacity: 0.7, marginTop: 2 }, children: '以源会话对话要点开场,上下文轻量' }),
                  ],
                },
              ),
              jsx(
                'div',
                {
                  key: 'opt-full',
                  className: `dshw-opt${forkBusy ? ' disabled' : ''}`,
                  onClick: () => runFork('full'),
                  children: [
                    jsx('div', { key: 't', style: { fontSize: 14, fontWeight: 600 }, children: '全部对话记录' }),
                    jsx('div', { key: 'd', style: { fontSize: 12, opacity: 0.7, marginTop: 2 }, children: '完整复制源会话上下文(同原生分支按钮)' }),
                  ],
                },
              ),
            ],
          }),
        },
      ),
      jsx(
        Primitives.Modal,
        {
          open: createWsOpen,
          onClose: () => {
            if (!createWsBusy) setCreateWsOpen(false)
          },
          title: '新建工作区',
          footer: jsxs(Fragment, {
            children: [
              jsx(Primitives.Button, {
                key: 'cancel',
                variant: 'outline',
                disabled: createWsBusy,
                onClick: () => setCreateWsOpen(false),
                children: '取消',
              }),
              jsx(Primitives.Button, {
                key: 'ok',
                variant: 'primary',
                disabled: createWsBusy || createWsPath.trim() === '',
                onClick: () => void submitCreateWs(),
                children: '创建',
              }),
            ],
          }),
          children: jsx('input', {
            autoFocus: true,
            value: createWsPath,
            'aria-label': '工作区路径',
            placeholder: '输入目录绝对路径,如 C:\\Projects\\my-app',
            disabled: createWsBusy,
            onChange: (e: any) => setCreateWsPath(e.target.value),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter' && createWsPath.trim() !== '') void submitCreateWs()
            },
            style: {
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid rgba(127,127,127,0.45)',
              background: 'transparent',
              color: 'inherit',
              fontSize: 14,
            },
          }),
        },
      ),
    ],
  })
}

export function apply(ctx: Context): void {
  injectStyles()
  const c = ctx as any
  const actions: Actions = {
    open: (sessionId) => c.sessions.open(sessionId),
    startSession: (workspaceId) => c.workspaces.startSession(workspaceId),
    renameSession: async (sessionId, title) => {
      const binding = c.sessions.binding(sessionId)?.session
      if (binding === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await binding.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: (sessionId, mode) => {
      // focus:插件 HTTP 路由(服务端机械摘要种子 → agents.create,同 P3 工具链)
      if (mode === 'focus') {
        return fetch('/dsh-worktree/session-fork', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, mode }),
        })
          .then((r) => r.json())
          .then((body: any) => {
            if (!body?.ok) throw new Error(body?.message ?? '聚焦交接失败')
            c.sessions.open(body.childSessionId)
          })
      }
      // full:实测(0.5.9 诊断版)浏览器 ctx.sessions.fork 成功时 resolve 裸字符串
      // childId;失败时可能 resolve envelope/undefined——两种形态都接住,失败显式抛。
      return Promise.resolve(c.sessions.fork({ sessionId, increaseTitle: true })).then((result: any) => {
        const childId =
          typeof result === 'string'
            ? result
            : result?.ok === true
              ? result?.value?.sessionId
              : undefined
        if (childId !== undefined && childId !== null) {
          c.sessions.open(childId)
          return
        }
        throw new Error(result?.error?.message ?? '派生被拒绝(会话可能没有已完成的回合)')
      })
    },
    archiveSession: async (sessionId) => {
      await c.workspaces.archiveSession(sessionId)
    },
    renameWorkspace: async (workspaceId, title) => {
      await c.workspaces.rename(workspaceId, title)
    },
    deleteWorkspace: async (workspaceId) => {
      await c.workspaces.delete(workspaceId)
    },
    createWorkspace: (path) => {
      // 失败可能以 envelope 形式 resolve(workspace-invalid-path),显式转 throw
      return Promise.resolve(c.workspaces.create({ path })).then((result: any) => {
        if (result && typeof result === 'object' && result.ok === false) {
          throw new Error(result.error?.message ?? '创建工作区被拒绝')
        }
      })
    },
  }
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        // single slot 按 priority 遮蔽(最小者渲染);-1 压过 ui-workspace 的 0
        priority: -1,
        inject: () => ({ ...actions }),
      },
      ProjectTreeBrowser as any,
    ),
  )
}
