/**
 * dsh-worktree 客户端半区:侧栏「项目」分组视图(P4-M3)。
 *
 * 占据 sidebar.workspaces single slot(与 ui-workspace 同姿势:
 * ctx.slots.inject + ctx.slots.register),组件 props face 由外壳注入
 * 全局钩子(useSessions/useWorkspaces/startSession/open)。
 *
 * 数据三源合成项目树:
 * - workspaces(工作区列表,含 sessionIds 归属)
 * - sessions(会话摘要)
 * - /dsh-worktree/lineage(本插件后端路由:worktree ←→ git 主仓血缘)
 */
import type { Context } from '@deepseek-ai/cordis'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

export const name = 'dsh-worktree'

/** slots:侧栏 slot 注册表(客户端运行时服务)。 */
export const inject = ['slots']

interface WorkspaceRow {
  workspaceId: string
  path: string
  title?: string
  sessionIds: string[]
}

interface SessionRow {
  sessionId: string
  title?: string | null
  updatedAt?: number
  running?: boolean
  cwd?: string
  projections?: { values?: { title?: string | null } }
}

function sessionLabel(s: SessionRow | undefined, id: string): string {
  const title = s?.projections?.values?.title ?? s?.title
  if (title && title.trim() !== '') return title
  return id.replace(/^session-/, '').slice(0, 8)
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return norm.slice(norm.lastIndexOf('/') + 1) || norm
}

/** 项目分组视图:一级 = git 主仓项目,二级 = worktree 工作区,行内 = 会话。 */
function ProjectTreeBrowser(props: Record<string, any>) {
  const { useSessions, useWorkspaces, open } = props
  const list = useSessions?.((s: any) => s) ?? {}
  const workspacesState = useWorkspaces?.((s: any) => s) ?? {}
  const [lineage, setLineage] = useState<any>(null)

  useEffect(() => {
    let alive = true
    fetch('/dsh-worktree/lineage')
      .then((r) => r.json())
      .then((d) => {
        if (alive) setLineage(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const workspaces: WorkspaceRow[] = workspacesState?.workspaces ?? workspacesState ?? []
  const byId: Record<string, SessionRow> = list?.byId ?? {}
  const currentId: string | undefined = list?.current?.id ?? list?.current

  // 分组:血缘 worktrees[path].parentPath 归组;无血缘条目的进「未分组」
  const groups = new Map<string, WorkspaceRow[]>()
  const wt = lineage?.worktrees ?? {}
  for (const w of workspaces) {
    const key = wt[w.path.replace(/\\/g, '/')]?.parentPath ?? '__ungrouped__'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(w)
  }

  const rowStyle: Record<string, string | number> = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '3px 10px 3px 22px',
    cursor: 'pointer',
    fontSize: 13,
    borderRadius: 6,
  }

  const children: any[] = []
  for (const [parent, ws] of groups) {
    const label = parent === '__ungrouped__' ? '其他工作区' : baseName(parent)
    children.push(
      jsx(
        'div',
        {
          key: `g-${parent}`,
          style: {
            padding: '6px 10px 2px',
            fontSize: 11,
            fontWeight: 700,
            opacity: 0.65,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          },
        },
        `▸ ${label}`,
      ),
    )
    for (const w of ws) {
      const isProjectRoot = parent !== '__ungrouped__' && w.path.replace(/\\/g, '/') === parent
      if (!isProjectRoot) {
        children.push(
          jsx(
            'div',
            {
              key: `w-${w.workspaceId}`,
              style: { padding: '2px 10px 2px 16px', fontSize: 12, opacity: 0.8 },
            },
            `⎇ ${w.title ?? baseName(w.path)}`,
          ),
        )
      }
      for (const sid of w.sessionIds ?? []) {
        const s = byId[sid]
        if (s === undefined) continue
        const active = sid === currentId
        children.push(
          jsxs(
            'div',
            {
              style: {
                ...rowStyle,
                background: active ? 'rgba(127,127,127,0.25)' : undefined,
                fontWeight: active ? 600 : 400,
              },
              title: sid,
              onClick: () => open?.(sid),
            },
            jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionLabel(s, sid)),
            jsx('span', { style: { opacity: 0.5, fontSize: 11 } }, s?.running ? '●' : ''),
          ),
        )
      }
    }
  }

  return jsx(
    'div',
    { style: { padding: '4px 2px', overflowY: 'auto', maxHeight: '100%' } },
    children.length > 0 ? children : jsx(Fragment, null, 'dsh-worktree: 暂无工作区数据'),
  )
}

export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        // single slot 按 priority 遮蔽(最小者渲染);-1 压过 ui-workspace 的 0
        priority: -1,
      },
      ProjectTreeBrowser as any,
    ),
  )
}
