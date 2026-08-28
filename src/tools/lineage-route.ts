import type { Context } from '@deepseek-ai/cordis'
import { createFileSessionLineageStore } from '../session-lineage.js'
import { createFileLineageStore } from '../lineage.js'

const sessionLineageStore = createFileSessionLineageStore()
const worktreeLineageStore = createFileLineageStore()

/**
 * 血缘 HTTP 路由:为前端分组视图提供数据源(浏览器读不到 harness home 的文件)。
 * 挂在 web 域 entry;路由形如 GET /dsh-worktree/lineage,同源无鉴权问题
 * (webserver 本身只绑 loopback)。
 */
export function registerLineageRoute(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/lineage',
        handler: async (_req, res) => {
          const [sessions, worktrees] = await Promise.all([
            sessionLineageStore.readAll(),
            worktreeLineageStore.readAll(),
          ])
          const body = JSON.stringify({ version: 1, sessions, worktrees })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(body)
        },
      }),
    'dsh-worktree: lineage route',
  )
}
