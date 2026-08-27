import type { Context } from '@deepseek-ai/cordis'
import { registerSessionList, registerSessionRead } from './tools/session.js'
import { registerSessionFork } from './tools/session-fork.js'

export const name = 'dsh-worktree-session'

/**
 * 会话域 entry:跨会话读 + 会话 fork(P3)。依赖 sessionQuery 与 sessions
 * (SessionStore,base 组合自带),web/headless 均可用。声明式注入——cordis
 * 对未声明服务的属性访问一律抛「cannot get property ... without inject」,
 * 惰性读取是死路(亲验)。
 */
export const inject = ['tools', 'sessionQuery', 'sessions']

export function apply(ctx: Context): void {
  registerSessionList(ctx)
  registerSessionRead(ctx)
  registerSessionFork(ctx)
}
