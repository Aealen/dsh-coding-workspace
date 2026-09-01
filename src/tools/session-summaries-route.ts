import type { Context } from '@deepseek-ai/cordis'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'

/**
 * 会话摘要 HTTP 路由:侧栏会话行的「最后对话内容」展示。
 *
 * POST /dsh-worktree/session-summaries  body: { ids: string[] }
 * 返回 { summaries: Record<sessionId, tail> }——每个会话最后一条有文本的
 * 事件的尾部 80 字符(官方 extractSessionEventText 过滤结构噪音)。
 * 前端对展开的工作区懒加载,避免全量读日志。
 */
export function registerSessionSummariesRoute(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/session-summaries',
        handler: async (req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', async () => {
            let ids: string[] = []
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              if (Array.isArray(parsed?.ids)) ids = parsed.ids.filter((x: unknown) => typeof x === 'string')
            } catch {
              // 非法 body 按空处理
            }
            ids = ids.slice(0, 60)

            const summaries: Record<string, string> = {}
            for (const id of ids) {
              try {
                const snapshot = await ctx.sessionQuery.readSession(id as never)
                const events = snapshot.events as never[]
                for (let i = events.length - 1; i >= 0; i--) {
                  const text = extractSessionEventText(events[i]).trim()
                  if (text !== '') {
                    summaries[id] = text.replace(/\s+/g, ' ').slice(-80)
                    break
                  }
                }
                // 无文本(空白/纯 seed 派生会话):不写入,前端退回显示会话名
              } catch (error) {
                // 单个会话读取失败:错误随响应带回,便于定位
                summaries[id] = `[摘要失败] ${error instanceof Error ? error.message : String(error)}`.slice(0, 80)
              }
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, summaries }))
          })
        },
      }),
    'dsh-worktree: session-summaries route',
  )
}
