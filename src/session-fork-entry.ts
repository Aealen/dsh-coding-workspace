import type { Context } from '@deepseek-ai/cordis'
import { registerSessionFork } from './tools/session-fork.js'
import { registerSessionForkRoute } from './tools/session-fork-route.js'
import { registerSessionSummariesRoute } from './tools/session-summaries-route.js'

export const name = 'dsh-coding-workspace-session-fork'

/**
 * 会话 fork 专职 entry(P3):完整/聚焦交接。
 *
 * 依赖 workspaceRegistry(web 层,挂载侧栏归属)与 agents(agent 组合事务,
 * 新会话可续聊)——headless 等组合本 entry 自动缺席,不拖累同包其他工具。
 * 复刻 Web UI 分支按钮的内核链路:agents.create + workspace.attachSession。
 * webServer 供侧栏「派生分支」Modal 与会话摘要的 HTTP 路由(web 层组合)。
 */
export const inject = ['tools', 'sessions', 'sessionQuery', 'agents', 'workspaceRegistry', 'webServer']

export function apply(ctx: Context): void {
  registerSessionFork(ctx)
  registerSessionForkRoute(ctx)
  registerSessionSummariesRoute(ctx)
}
