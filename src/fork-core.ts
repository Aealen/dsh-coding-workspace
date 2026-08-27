import type { LineageEdge, LineageStore } from './lineage.js'
import { lineageKey } from './lineage.js'

/** project_fork 的宿主能力面:全部收窄为接口,单测用内存桩替换。 */
export interface ForkDeps {
  /** 等价于 `git worktree add ...`(由 src/git.ts 的 runGit 组装)。 */
  addWorktree(sourceRepoPath: string, gitArgs: string[]): Promise<void>
  /** 等价于 ctx.workspaceRegistry.create;注册失败不应使 fork 整体失败。返回值若带 id 将记入血缘。 */
  registerWorkspace?: (path: string, title?: string) => Promise<unknown>
  store: LineageStore
}

export interface ForkRequest {
  sourceRepoPath: string
  /** 新分支名 / 目录尾段 */
  name: string
  /** 新 worktree 目录;缺省 = sourceRepoPath 兄弟目录同名 */
  worktreePath?: string
  baseRef?: string
  /** workspace 显示标题;缺省用 name */
  title?: string
}

export interface ForkOutcome {
  worktreePath: string
  branch: string
  createdNewBranch: boolean
  workspaceRegistered: boolean
  /** 注册成功时的工作区 id(remove 据此注销,不依赖目录存活) */
  workspaceId?: string
  registryError?: string
  lineageRecorded: boolean
}

/**
 * fork 项目流水线:建 worktree → 注册 workspace(半失败容忍)→ 登记血缘(容错)。
 * 回滚语义:worktree 创建成功后任何后续失败都不拆除(git 数据无损),
 * 结果体里如实报告各步状态,由模型/用户决定去留。
 */
export async function performFork(deps: ForkDeps, req: ForkRequest): Promise<ForkOutcome> {
  const sourcePosix = req.sourceRepoPath.replace(/\\/g, '/')
  const worktreePath =
    req.worktreePath ?? `${sourcePosix.replace(/\/[^/]+$/, '')}/${req.name}`
  const branch = req.name
  const gitArgs = ['worktree', 'add', '-b', branch, worktreePath]
  if (req.baseRef !== undefined) gitArgs.push(req.baseRef)

  await deps.addWorktree(req.sourceRepoPath, gitArgs)

  let workspaceRegistered = false
  let workspaceId: string | undefined
  let registryError: string | undefined
  try {
    if (deps.registerWorkspace) {
      const created = await deps.registerWorkspace(worktreePath, req.title ?? req.name)
      workspaceRegistered = true
      const id = (created as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') workspaceId = id
    }
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error)
  }

  let lineageRecorded = false
  try {
    // 主仓自己若还没登记过,顺手补一条 parent=null 的边,让分组视图两轨一致
    const all = await deps.store.readAll()
    const now = Date.now()
    if (!all[lineageKey(sourcePosix)]) {
      const rootEdge: LineageEdge = { parentPath: null, branch: '', origin: 'inferred', createdAt: now }
      await deps.store.writeEdge(lineageKey(sourcePosix), rootEdge)
    }
    await deps.store.writeEdge(lineageKey(worktreePath), {
      parentPath: sourcePosix,
      branch,
      origin: 'plugin',
      createdAt: now,
      workspaceId,
    })
    lineageRecorded = true
  } catch {
    // 血缘是增强数据,落盘失败不否定 fork 本身
  }

  return {
    worktreePath,
    branch,
    createdNewBranch: true,
    workspaceRegistered,
    workspaceId,
    registryError,
    lineageRecorded,
  }
}
