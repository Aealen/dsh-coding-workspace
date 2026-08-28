/**
 * dsh-worktree 客户端半区:侧栏「项目」分组视图(P4-M3)。
 *
 * 占据 sidebar.workspaces single slot(priority 遮蔽 ui-workspace)。
 * 数据走同源 RPC(workspace.list / session.list)+ 本插件血缘路由,
 * 30s 轮询兜底(原生投影不实时推送,事件驱动留 M4)。
 *
 * ⚠️ jsx-runtime 契约:jsx(type, props, key) 第三参是 key——children
 * 必须放 props.children,放第三参会整树静默变空(真机踩坑实证)。
 */
import type { Context } from '@deepseek-ai/cordis'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

export const name = 'dsh-worktree'

/** slots + sessions/open + workspaces/startSession(与 ui-workspace 同款声明)。 */
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

/** 同源 RPC 调用(形态与宿主前端一致)。 */
async function rpc<T = any>(method: string): Promise<T> {
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload: {},
    }),
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

/** 项目分组视图:一级 = git 主仓项目,二级 = worktree 工作区,行内 = 会话。 */
function ProjectTreeBrowser(props: Record<string, any>) {
  const open: ((sessionId: string) => void) | undefined = props.open
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
        const [ws, sl] = await Promise.all([
          rpc<any>('workspace.list'),
          rpc<any>('session.list'),
        ])
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
    const hit = wt[k]
    // 有边即归组:parentPath=null 表示自身是项目根,组键 = 自己的路径
    const key = hit === undefined ? UNPINNED : (hit.parentPath ?? k)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(w)
  }

  const children: any[] = []
  // 有血缘归组的项目在前,未分组兜底在最后
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === UNPINNED ? 1 : b === UNPINNED ? -1 : a.localeCompare(b),
  )
  for (const [parent, ws] of ordered) {
    const label = parent === UNPINNED ? '其他工作区' : baseName(parent)
    children.push(
      jsx(
        'div',
        {
          key: `g-${parent}`,
          style: {
            padding: '8px 10px 3px',
            fontSize: 11,
            fontWeight: 700,
            opacity: 0.65,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          },
          children: `▸ ${label}`,
        },
      ),
    )
    for (const w of ws) {
      const isProjectRoot = parent !== UNPINNED && w.path.replace(/\\/g, '/') === parent
      if (!isProjectRoot) {
        children.push(
          jsx(
            'div',
            {
              key: `w-${w.workspaceId}`,
              style: { padding: '3px 10px 1px 18px', fontSize: 12, opacity: 0.75 },
              children: `⎇ ${w.title ?? baseName(w.path)}`,
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
              title: sid,
              onClick: () => open?.(sid),
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px 4px 30px',
                cursor: 'pointer',
                fontSize: 13,
                borderRadius: 6,
                background: active ? 'rgba(127,127,127,0.25)' : undefined,
                fontWeight: active ? 600 : 400,
              },
              children: [
                jsx(
                  'span',
                  {
                    key: 'label',
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    children: sessionLabel(s, sid),
                  },
                ),
                jsx(
                  'span',
                  { key: 'dot', style: { opacity: 0.6, fontSize: 11, color: '#98c379' }, children: s?.running ? '●' : '' },
                ),
              ],
            },
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
  // 会话切换走客户端运行时 ctx(与 ui-workspace 的 open 实现同源)
  const open = (sessionId: string) => (ctx as any).sessions.open(sessionId)
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        // single slot 按 priority 遮蔽(最小者渲染);-1 压过 ui-workspace 的 0
        priority: -1,
        // inject face:返回合并进组件 props 的动作(ui-workspace 的 browserInjected 同款)
        inject: () => ({ open }),
      },
      ProjectTreeBrowser as any,
    ),
  )
}
