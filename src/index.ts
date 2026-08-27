import type { Context } from '@deepseek-ai/cordis'
import { registerWorktreeAdd } from './tools/add.js'
import { registerWorktreeList } from './tools/list.js'

export const name = 'dsh-worktree'

/** 所需服务:dsh 工具注册表。其余(sessionQuery 等)在工具内惰性解析,见 tools/session.ts。 */
export const inject = ['tools']

/**
 * 插件入口。
 *
 * - P0:worktree 三件套;
 * - P1:session_list / session_read(跨会话只读);
 * - P2 计划:project_fork(worktree add + workspaceRegistry + 血缘登记,见 src/lineage.ts)。
 */
export function apply(ctx: Context): void {
  registerWorktreeList(ctx)
  registerWorktreeAdd(ctx)
}
