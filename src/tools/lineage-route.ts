import type { Context } from '@deepseek-ai/cordis'
import { createFileSessionLineageStore } from '../session-lineage.js'
import { createFileLineageStore, inferLineage, lineageKey } from '../lineage.js'

const sessionLineageStore = createFileSessionLineageStore()
const worktreeLineageStore = createFileLineageStore()

/**
 * 血缘 HTTP 路由:为前端分组视图提供数据源(浏览器读不到 harness home 的文件)。
 *
 * POST /dsh-worktree/lineage  body: { paths: string[] }(工作区绝对路径清单)
 * 响应 worktrees 表双轨合成:
 * 1. 登记表(project_fork 写入的 plugin 边);
 * 2. 现场推断:对每个路径跑 git gitdir 反推(inferLineage),覆盖手工
 *    `git worktree add` 的工作区——只入响应不落盘,零副作用。
 */
export function registerLineageRoute(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/lineage',
        handler: async (req, res) => {
          const [sessions, registered, reqBody] = await Promise.all([
            sessionLineageStore.readAll(),
            worktreeLineageStore.readAll(),
            readBody(req),
          ])
          const worktrees: Record<string, unknown> = { ...registered }

          const paths: string[] = Array.isArray(reqBody?.paths) ? reqBody.paths : []
          for (const rawPath of paths) {
            if (typeof rawPath !== 'string' || rawPath === '') continue
            const key = lineageKey(rawPath)
            if (worktrees[key] !== undefined) continue
            const edge = await inferLineage(rawPath).catch(() => undefined)
            if (edge?.parentPath !== undefined && edge.parentPath !== null) {
              worktrees[key] = edge
            } else if (edge !== undefined) {
              // 自身即主仓:入表(parentPath=null)让前端能渲染项目根
              worktrees[key] = edge
            }
          }

          const body = JSON.stringify({ version: 1, sessions, worktrees })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(body)
        },
      }),
    'dsh-worktree: lineage route',
  )
}

/** 读取请求体 JSON;失败返回空对象。 */
function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}
