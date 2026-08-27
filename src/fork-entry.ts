import type { Context } from '@deepseek-ai/cordis'
import { registerProjectFork } from './tools/fork.js'
import { registerWorktreeRemove } from './tools/remove.js'

export const name = 'dsh-worktree-fork'

/**
 * 工作区生命周期域 entry:project_fork + worktree_remove(带工作区注销/血缘清理)。
 * 依赖 workspaceRegistry(web 层服务);headless 等未提供该服务的组合里
 * 本 entry 自动缺席(pending),不拖累同包其他 entry 的工具挂载。
 */
export const inject = ['tools', 'workspaceRegistry']

export function apply(ctx: Context): void {
  registerProjectFork(ctx)
  registerWorktreeRemove(ctx)
}
