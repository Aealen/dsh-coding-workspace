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
    .dshw-row:hover { background: rgba(127,127,127,0.18) !important; }
    .dshw-wsrow:hover { background: rgba(127,127,127,0.12); }
    .dshw-row:hover button, .dshw-wsrow:hover button { opacity: 0.9; }
  `
  document.head.appendChild(style)
}
import type { Context } from '@deepseek-ai/cordis'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

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
  running?: boolean
  projections?: { values?: { title?: string | null } }
}

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

function sessionLabel(s: SessionRow | undefined, id: string): string {
  const title = s?.projections?.values?.title
  if (title && title.trim() !== '') return title
  return id.replace(/^session-/, '').slice(0, 8)
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return norm.slice(norm.lastIndexOf('/') + 1) || norm
}

const UNPINNED = '__ungrouped__'

const rowBase: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 13,
  borderRadius: 6,
  minHeight: 26,
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

/** 行尾三点菜单(官方 Menu 原语,anchor 模式)。 */
function RowMenu(props: { items: { id: string; label: string; danger?: boolean }[]; onSelect: (id: string) => void }) {
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
  forkSession: (sessionId: string) => void
  archiveSession: (sessionId: string) => Promise<void>
  renameWorkspace: (workspaceId: string, title: string) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
}

/** 项目分组视图:项目 → 工作区(主 TAG)→ 会话;行内三点菜单。 */
function ProjectTreeBrowser(props: Record<string, any>) {
  const actions: Actions = props
  const [data, setData] = useState<{
    workspaces: WorkspaceRow[]
    sessions: Record<string, SessionRow>
    currentId?: string
    lineage: any
    error?: string
  } | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [ws, sl] = await Promise.all([rpc<any>('workspace.list'), rpc<any>('session.list')])
        const workspaces: WorkspaceRow[] = ws.items ?? []
        const lineage = await fetch('/dsh-worktree/lineage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: workspaces.map((w) => w.path) }),
        }).then((r) => r.json())
        if (!alive) return
        const sessions: Record<string, SessionRow> = {}
        let currentId: string | undefined
        for (const it of sl.items ?? []) {
          sessions[it.sessionId] = it
          if (it.running) currentId = it.sessionId
        }
        setData({ workspaces, sessions, currentId, lineage })
      } catch (error) {
        if (alive) setData({ workspaces: [], sessions: {}, lineage: null, error: String(error) })
      }
    }
    void load()
    const timer = setInterval(load, 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
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

  const children: any[] = []
  for (const [parent, ws] of ordered) {
    const isGrouped = parent !== UNPINNED
    const label = isGrouped ? baseName(parent) : '其他工作区'
    // 主工作区:组内 parentPath===null 的(自身即根);多个取第一个
    const mainWs = isGrouped ? ws.find((w) => wt[w.path.replace(/\\/g, '/')]?.parentPath === null) : undefined
    const totalSessions = ws.reduce((acc, w) => acc + (w.sessionIds?.length ?? 0), 0)

    children.push(
      jsx(
        'div',
        {
          key: `g-${parent}`,
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 10px 3px',
          },
          children: [
            jsx(
              'span',
              {
                key: 'label',
                style: { fontSize: 11, fontWeight: 700, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 0.4 },
                children: `▸ ${label} · ${totalSessions}`,
              },
            ),
            isGrouped && mainWs !== undefined
              ? jsx(
                  'button',
                  {
                    key: 'add',
                    type: 'button',
                    title: `在 ${label} 新建会话`,
                    style: { ...menuBtnStyle, fontSize: 14 },
                    onClick: () => actions.startSession?.(mainWs.workspaceId),
                    children: '+',
                  },
                )
              : null,
          ].filter(Boolean),
        },
      ),
    )

    for (const w of ws) {
      const isRoot = isGrouped && mainWs !== undefined && w.workspaceId === mainWs.workspaceId
      if (!isRoot) {
        children.push(
          jsx(
            'div',
            {
              key: `w-${w.workspaceId}`,
              style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px 1px 16px', fontSize: 12, opacity: 0.8 },
              children: [
                jsx('span', { key: 'ico', style: { opacity: 0.7 }, children: jsx(Primitives.IconBranchOutline16, {}) }),
                jsx(
                  'span',
                  { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: w.title ?? baseName(w.path) },
                ),
              ],
            },
          ),
        )
      } else {
        children.push(
          jsxs(
            'div',
            {
              key: `w-${w.workspaceId}`,
              style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px 1px 10px', fontSize: 12, fontWeight: 600 },
              children: [
                jsx('span', { key: 'ico', style: { opacity: 0.7 }, children: jsx(Primitives.IconFolderClose16, {}) }),
                jsx(
                  'span',
                  { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: w.title ?? baseName(w.path) },
                ),
                jsx(MainTag, {}),
              ],
            },
          ),
        )
      }

      for (const sid of w.sessionIds ?? []) {
        const s = byId[sid]
        if (s === undefined) continue
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
                paddingLeft: isRoot ? 26 : 34,
                background: active ? 'rgba(127,127,127,0.25)' : undefined,
                fontWeight: active ? 600 : 400,
              },
              children: [
                jsx(
                  'span',
                  {
                    key: 'label',
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
                    children: sessionLabel(s, sid),
                  },
                ),
                s?.running
                  ? jsx('span', { key: 'dot', style: { fontSize: 10, color: '#98c379' }, children: '●' })
                  : null,
                jsx(RowMenu, {
                  key: 'menu',
                  items: [
                    { id: 'open', label: '打开' },
                    { id: 'rename', label: '重命名' },
                    { id: 'fork', label: '派生分支' },
                    { id: 'archive', label: '归档', danger: true },
                  ],
                  onSelect: (id: string) => {
                    if (id === 'open') actions.open?.(sid)
                    if (id === 'rename') {
                      const title = window.prompt('重命名会话', sessionLabel(s, sid))
                      if (title && title.trim() !== '') void actions.renameSession?.(sid, title.trim())
                    }
                    if (id === 'fork') actions.forkSession?.(sid)
                    if (id === 'archive') void actions.archiveSession?.(sid)
                  },
                }),
              ].filter(Boolean),
            },
          ),
        )
      }

      // 工作区级菜单(主/子工作区都有):重命名 / 删除(删除仅非主工作区显示 danger)
      if (w.sessionIds.length > 0 || !isRoot) {
        children.push(
          jsx(
            'div',
            {
              key: `ws-menu-${w.workspaceId}`,
              style: { display: 'flex', justifyContent: 'flex-end', padding: '0 10px 2px', marginTop: -4 },
            },
            jsx(RowMenu, {
              items: [
                { id: 'rename', label: '重命名工作区' },
                { id: 'delete', label: '移除工作区记录', danger: true },
              ],
              onSelect: (id: string) => {
                if (id === 'rename') {
                  const title = window.prompt('重命名工作区', w.title ?? baseName(w.path))
                  if (title && title.trim() !== '') void actions.renameWorkspace?.(w.workspaceId, title.trim())
                }
                if (id === 'delete') {
                  if (window.confirm(`移除工作区记录「${w.title ?? baseName(w.path)}」?(不影响磁盘上的目录)`) === true) {
                    void actions.deleteWorkspace?.(w.workspaceId)
                  }
                }
              },
            }),
          ),
        )
      }
    }
  }

  return jsx(
    'div',
    {
      style: { padding: '4px 2px', overflowY: 'auto', maxHeight: '100%' },
      children:
        children.length > 0
          ? children
          : [jsx('div', { key: 'empty', style: { padding: 12, fontSize: 12, opacity: 0.6 }, children: '暂无工作区' })],
    },
  )
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
    forkSession: (sessionId) => {
      c.sessions
        .fork({ sessionId, increaseTitle: true })
        .then((child: any) => c.sessions.open(typeof child === 'string' ? child : child?.sessionId ?? child?.id))
        .catch(() => {})
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
