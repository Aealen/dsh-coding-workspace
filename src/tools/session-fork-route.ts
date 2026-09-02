import type { Context } from '@deepseek-ai/cordis'
import { buildFocusSeedEvents } from '../focus-seed.js'
import { createFileSessionLineageStore, type SessionLineageEdge } from '../session-lineage.js'
import { resolveForkCut } from './session-fork.js'

const lineageStore = createFileSessionLineageStore()

/**
 * 会话派生 HTTP 路由:侧栏「派生分支」Modal 的后端(浏览器到不了 LLM 工具链)。
 *
 * POST /dsh-coding-workspace/session-fork  body: { sessionId, mode: 'full' | 'focus' }
 * - full:复刻 Web UI 分支按钮内核链路(readSession 切点 → agents.create 全量种子)。
 * - focus:聚焦交接。摘要由服务端机械提炼(源会话各回合 user 消息要点),
 *   无 LLM 参与——LLM 提炼走 session_fork 工具(对话式)。
 *
 * 两种模式统一走 agents.create + workspace.attachSession + session-lineage 登记,
 * 与 P3 工具链完全同源,保证派生会话侧栏可见可续聊。
 */
export function registerSessionForkRoute(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/session-fork',
        handler: async (req, res) => {
          const body = await readBody(req)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const mode = body?.mode === 'focus' ? 'focus' : 'full'
          const fail = (code: string, message: string): void => {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, code, message }))
          }
          if (sessionId === '') return fail('missing-session', '缺少 sessionId')

          let sourceCwd: string | undefined
          let seed: readonly unknown[]
          try {
            const snapshot = await ctx.sessionQuery.readSession(sessionId as never)
            sourceCwd = (snapshot.session as { cwd?: string }).cwd
            const events = snapshot.events as Array<{ type: string; seq: number }>
            if (mode === 'full') {
              const resolved = resolveForkCut(events)
              if (resolved === null) {
                return fail('fork-unavailable', `源会话 "${sessionId}" 还没有任何完成的回合,无法完整交接;可改用聚焦交接。`)
              }
              seed = (snapshot.events as unknown[]).slice(0, resolved.cut)
            } else {
              seed = buildFocusSeedEvents(mechanicalSummary(snapshot.events as unknown[]), sessionId)
            }
          } catch (error) {
            return fail('source-unreadable', `读取源会话失败:${error instanceof Error ? error.message : String(error)}`)
          }

          const childId = `session-${crypto.randomUUID()}`
          await ctx.agents.create({
            sessionId: childId,
            seed,
            meta: {
              ...(sourceCwd !== undefined ? { cwd: sourceCwd } : {}),
              parentSession: sessionId,
              seedLength: seed.length,
            },
          })

          let attached = false
          try {
            const workspace = await ctx.workspaceRegistry.resolveByPath(sourceCwd ?? process.cwd())
            if (workspace !== undefined) {
              await workspace.attachSession(childId)
              attached = true
            }
          } catch {
            // 挂载尽力而为:cwd 归属兜底仍会让会话落组
          }

          const edge: SessionLineageEdge = { sourceId: sessionId, mode, cwd: sourceCwd, createdAt: Date.now() }
          try {
            await lineageStore.writeEdge(childId, edge)
          } catch {
            // 血缘登记失败不影响派生
          }

          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, childSessionId: childId, mode, attached }))
        },
      }),
    'dsh-coding-workspace: session-fork route',
  )
}

/**
 * 机械摘要:抽源会话各回合 user 消息文本(每条截 200 字,至多 12 条)。
 * 零 LLM 依赖;要 LLM 提炼请走 session_fork 工具(对话式,summary 由模型给出)。
 */
function mechanicalSummary(events: readonly unknown[]): string {
  const points: string[] = []
  for (const e of events) {
    if (points.length >= 12) break
    const ev = e as { type?: string; data?: { content?: Array<{ type?: string; text?: string }> } }
    if (ev?.type !== 'user/message') continue
    const text = (ev.data?.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join(' ')
      .trim()
    if (text === '') continue
    points.push(`- ${text.slice(0, 200)}`)
  }
  if (points.length === 0) return '(源会话没有可提取的用户消息)'
  return `源会话对话要点(自动提炼):\n${points.join('\n')}`
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
