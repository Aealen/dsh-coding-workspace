import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'

/**
 * 插件路由的鉴权/来源栅栏。
 *
 * 0.2.2 把浏览器信任栅栏(Host/Origin fence)与 browser-session 鉴权集中在
 * `connection` 服务(`admit`/`requestRejection`),而 `webServer.register` 的裸路由
 * **不经过**它——宿主 README 明示"无服务器级鉴权与来源策略"。Desktop 默认只绑
 * loopback 风险可控,但一旦监听非 loopback 或开启远程访问,未鉴权请求就能触达
 * 这些路由(读任意已注册工作区文件、写文件、git push、系统打开/定位)。
 *
 * 在每个插件路由 handler 开头调用:返回 HTTP 状态码(403/401)时直接以该码
 * 结束响应;返回 null(旧宿主无 connection 服务,或请求已通过)则放行。
 */
export function connectionRejection(ctx: Context, req: IncomingMessage): number | null {
  try {
    const conn = (ctx as any).connection as { requestRejection?: (r: IncomingMessage) => number | undefined } | undefined
    if (conn === undefined || typeof conn.requestRejection !== 'function') return null
    const status = conn.requestRejection(req)
    return typeof status === 'number' ? status : null
  } catch {
    return null
  }
}
