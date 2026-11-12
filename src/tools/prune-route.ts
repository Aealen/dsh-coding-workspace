import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import { existsSync } from 'node:fs'
import { connectionRejection } from './route-guard.js'
import { createFileLineageStore, lineageKey } from '../lineage.js'

const worktreeLineageStore = createFileLineageStore()

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

interface PruneTarget {
  key: string
  path: string
  workspaceId?: string
}

/**
 * worktree 对账清理路由:外部 IDE / 手动删除 worktree 后,注册表与血缘里的
 * 记录不会自己消失(自动同步链路只增不减),侧栏会一直挂着僵尸组头。
 *
 * POST /dsh-coding-workspace/worktree-prune  三种模式:
 * 1. 探测(默认) body { paths }:对每个注册路径做磁盘存在性检查,返回其中
 *    「目录已消失且登记过血缘边」的项。只读,不落数据;无血缘边的手动导入
 *    工作区不参与(用户自己导入的目录由用户自己移除)。
 * 2. 清理 body { remove: true, targets }:逐个注销 dsh 工作区 + 摘血缘边。
 *    目录已死,两步都不依赖目录存活(与 worktree_remove 工具的 purge-only
 *    同语义);workspaceId 由客户端从快照带上来,血缘 edge 里登记的 id 兜底。
 * 3. 会话转移 body { attach: [{ sessionId, targetPath }] }:清理前把会话
 *    挂到存活的目标工作区(宿主 resolveByPath().attachSession,官方归属表;
 *    会话数据与 cwd 不动,只改侧栏归属)。
 */
export function registerPruneRoute(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/worktree-prune',
        handler: async (req, res) => {
          const rej = connectionRejection(ctx, req)
          if (rej !== null) {
            res.writeHead(rej, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('unauthorized')
            return
          }
          const body = await readBody(req)

          // 会话转移模式
          if (Array.isArray(body?.attach)) {
            const jobs: Array<{ sessionId?: unknown; targetPath?: unknown }> = body.attach
            let attached = 0
            const errors: string[] = []
            for (const j of jobs) {
              if (j === null || typeof j !== 'object') continue
              if (typeof j.sessionId !== 'string' || typeof j.targetPath !== 'string' || j.targetPath === '') continue
              try {
                const ws = await ctx.workspaceRegistry.resolveByPath(j.targetPath)
                if (ws === undefined || typeof ws.attachSession !== 'function') {
                  errors.push(`${j.targetPath}: 目标工作区未注册`)
                  continue
                }
                await ws.attachSession(j.sessionId)
                attached += 1
              } catch (error) {
                errors.push(`${j.targetPath}: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ attached, errors }))
            return
          }

          // 清理模式
          if (body?.remove === true) {
            const targets: PruneTarget[] = Array.isArray(body.targets) ? body.targets : []
            let removed = 0
            const errors: string[] = []
            for (const t of targets) {
              if (t === null || typeof t !== 'object' || typeof t.path !== 'string') continue
              // key 缺省(手动移除入口)按路径现算,与血缘登记键同构
              const key = typeof t.key === 'string' && t.key !== '' ? t.key : lineageKey(t.path)
              let wsOk = true
              // 快照 id 优先;缺 id 时血缘 edge 里 fork 登记的 id 兜底
              let wsId = typeof t.workspaceId === 'string' && t.workspaceId !== '' ? t.workspaceId : undefined
              if (wsId === undefined) {
                const edge = (await worktreeLineageStore.readAll())[key] as { workspaceId?: unknown } | undefined
                if (typeof edge?.workspaceId === 'string' && edge.workspaceId !== '') wsId = edge.workspaceId
              }
              if (wsId !== undefined) {
                try {
                  wsOk = (await ctx.workspaceRegistry.delete(wsId)) !== false
                } catch (error) {
                  wsOk = false
                  errors.push(`${t.path}: ${error instanceof Error ? error.message : String(error)}`)
                }
              }
              try {
                await worktreeLineageStore.deleteEdge(key)
              } catch {
                // 悬空边不致命(下次探测仍会报,直到 registry 一致)
              }
              if (wsOk) removed += 1
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ removed, errors }))
            return
          }

          // 探测模式(只读)。existsSync 对断开的网络盘返回 false 存在误判可能,
          // 但此时目录同样不可达,摘除语义仍然成立
          const paths: string[] = Array.isArray(body?.paths) ? body.paths : []
          const edges = await worktreeLineageStore.readAll()
          const gone: Array<{ key: string; path: string }> = []
          for (const p of paths) {
            if (typeof p !== 'string' || p === '' || existsSync(p)) continue
            const key = lineageKey(p)
            if (edges[key] === undefined) continue
            gone.push({ key, path: p })
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ gone }))
        },
      }),
  )
}
