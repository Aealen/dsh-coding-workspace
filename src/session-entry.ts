import type { Context } from '@deepseek-ai/cordis'
import { registerSessionList, registerSessionRead } from './tools/session.js'

export const name = 'dsh-worktree-session'

/**
 * session 工具独立 entry:依赖 sessionQuery(base 组合自带 session-query 行,
 * web/headless 均可用)。声明式注入——cordis 对未声明服务的属性访问一律抛
 * 「cannot get property ... without inject」,惰性读取是死路(亲验)。
 */
export const inject = ['tools', 'sessionQuery']

export function apply(ctx: Context): void {
  registerSessionList(ctx)
  registerSessionRead(ctx)
}
