import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'

/** 纯展示用的会话头摘要。 */
interface SessionBrief {
  id: string
  cwd?: string
  live: boolean
  persisted: boolean
  title?: string
}

export function registerSessionList(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'session_list',
      description:
        '列出 harness 中最近的会话(含历史持久化会话),可按工作目录过滤。用于并行开发的上下文侦察。',
      parameters: {
        limit: { type: 'number' },
        cwdContains: { type: 'string' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const query = ctx.sessionQuery
        const records = await query.listSessions(exec.signal)
        const needle = args.cwdContains?.toLowerCase()
        let filtered = needle
          ? records.filter((r) => (r.header as { cwd?: string }).cwd?.toLowerCase().includes(needle))
          : records

        const total = filtered.length
        // newest-first 由服务保证;截取一页后再折叠标题,避免全量 N+1
        const page = filtered.slice(0, Math.max(1, args.limit ?? 20))
        const briefs: SessionBrief[] = await Promise.all(
          page.map(async (r) => {
            const header = r.header as { id: string; cwd?: string }
            let title: string | undefined
            try {
              title = (await query.readTitle(header.id, exec.signal))?.title
            } catch {
              // 标题缺失不影响列表主体
            }
            return {
              id: header.id,
              cwd: header.cwd,
              live: r.live,
              persisted: r.persisted,
              title,
            }
          }),
        )

        const lines = briefs.map((b) => {
          const state = [b.live ? 'live' : '', b.persisted ? 'persisted' : ''].filter(Boolean).join('/')
          return `- ${b.title ?? '(untitled)'}  ${b.id}  [${state}]  cwd=${b.cwd ?? '?'}`
        })

        return JSON.stringify({ total, shown: briefs.length, sessions: briefs, rendered: lines.join('\n') })
      },
    }),
  )
}

export function registerSessionRead(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'session_read',
      description:
        '读取一个会话的对话内容(full=全部;tail=末尾事件窗口,默认)。只读操作,不会唤醒该会话。',
      parameters: {
        sessionId: { type: 'string', required: true },
        mode: { type: 'string' },
        maxChars: { type: 'number' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        void exec
        const query = ctx.sessionQuery
        const mode = args.mode === 'full' ? 'full' : 'tail'
        const maxChars = Math.max(500, args.maxChars ?? 12000)

        const snapshot = await query.readSession(args.sessionId as never)
        const events = snapshot.events as Array<{ type: string; time: number; seq: number }>

        // 官方提取器对结构事件返回空串,天然过滤噪音
        const textBlobs: string[] = []
        for (const event of snapshot.events as never[]) {
          const text = extractSessionEventText(event)
          if (text.trim() !== '') textBlobs.push(text)
        }

        const windowed =
          mode === 'tail' && textBlobs.length > 20 ? textBlobs.slice(-20) : textBlobs
        let text = windowed.join('\n---\n')
        let truncated = false
        if (text.length > maxChars) {
          truncated = true
          text = mode === 'tail' ? text.slice(-maxChars) : `${text.slice(0, maxChars)}\n…(截断)`
        }

        const header = snapshot.session as { id?: string; cwd?: string }
        return JSON.stringify({
          sessionId: header.id ?? args.sessionId,
          cwd: header.cwd,
          eventCount: events.length,
          textBlockCount: textBlobs.length,
          truncated,
          mode,
          rendered: text,
        })
      },
    }),
  )
}
