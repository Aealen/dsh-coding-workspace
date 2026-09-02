import type { Context } from '@deepseek-ai/cordis'
import { registerProjectFork } from './tools/fork.js'
import { registerWorktreeRemove } from './tools/remove.js'
import { registerLineageRoute } from './tools/lineage-route.js'
import { registerWorkspaceCreateRoutes } from './tools/workspace-create-route.js'
import { registerPanelRoutes } from './tools/panel-routes.js'

export const name = 'dsh-coding-workspace-fork'

/**
 * 工作区生命周期域 entry:project_fork + worktree_remove(带工作区注销/血缘清理)
 * + 侧栏新建工作区路由组(分支清单/建 worktree/备注)+ 右栏工作区面板路由组
 * (文件树/git 状态/git log/写操作白名单)。
 * 依赖 workspaceRegistry(web 层服务);headless 等未提供该服务的组合里
 * 本 entry 自动缺席(pending),不拖累同包其他 entry 的工具挂载。
 */
export const inject = ['tools', 'workspaceRegistry', 'webServer']

export function apply(ctx: Context): void {
  registerProjectFork(ctx)
  registerWorktreeRemove(ctx)
  registerLineageRoute(ctx)
  registerWorkspaceCreateRoutes(ctx)
  registerPanelRoutes(ctx)
}
