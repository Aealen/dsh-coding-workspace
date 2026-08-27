import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildFocusSeedEvent } from '../focus-seed.js'
import { createFileSessionLineageStore, type SessionLineageEdge } from '../session-lineage.js'

const lineageStore = createFileSessionLineageStore()

/**
 * session_fork:从源会话派生一个新的独立会话。
 *
 * - full:完整交接,直接走内核 SessionStore.fork(与 Web UI 消息按钮同一条
 *   内核路径,deep-cloned 前缀 + parentSessionId 血缘);
 * - focus:聚焦交接,模型先读源会话并总结,本工具把摘要合成首条 user 消息
 *   作为种子(low-level sessions.create),新会话只携带结论不带历史包袱。
 *
 * 两种模式都会在 session-lineage.json 登记父子边。
 */
export function registerSessionFork(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'session_fork',
      description:
        '从指定会话 fork 出一个新会话。mode=full 完整交接(复制全部上下文,同 Web UI 分支按钮);' +
        'mode=focus 聚焦交接(需传 summary,新会话仅以你的摘要作为首条消息,轻量启动)。',
      parameters: {
        sourceSessionId: { type: 'string', required: true },
        mode: { type: 'string' },
        summary: { type: 'string' },
        boundary: { type: 'number' },
        newSessionId: { type: 'string' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        void exec
        const sessions = ctx.sessions
        const mode = args.mode === 'focus' ? 'focus' : 'full'
        if (mode === 'focus' && !args.summary?.trim()) {
          throw new Error('聚焦交接需要 summary:请先用 session_read 读取源会话,提炼摘要后传入。')
        }

        let cwd: string | undefined
        try {
          const snapshot = await ctx.sessionQuery.readSession(args.sourceSessionId as never)
          cwd = (snapshot.session as { cwd?: string }).cwd
        } catch {
          // 源会话读不到 cwd 时回退进程 cwd
        }

        let childId: string
        if (mode === 'full') {
          const child = sessions.fork(args.sourceSessionId as never, args.boundary, args.newSessionId as never)
          childId = child.id
        } else {
          const seed = [buildFocusSeedEvent(args.summary as string, args.sourceSessionId)]
          const child = sessions.create(args.newSessionId as never, {
            seed: seed as never,
            meta: {
              cwd: cwd ?? process.cwd(),
              parentSession: args.sourceSessionId as never,
              seedLength: 1,
            },
          })
          childId = child.id
        }

        const edge: SessionLineageEdge = {
          sourceId: args.sourceSessionId,
          mode,
          cwd,
          createdAt: Date.now(),
        }
        let lineageRecorded = true
        try {
          await lineageStore.writeEdge(childId, edge)
        } catch {
          lineageRecorded = false
        }

        return JSON.stringify({
          childSessionId: childId,
          sourceSessionId: args.sourceSessionId,
          mode,
          cwd: cwd ?? process.cwd(),
          lineageRecorded,
          rendered:
            `✓ 已${mode === 'full' ? '完整' : '聚焦'}交接派生新会话 ${childId}\n` +
            `  源会话 ${args.sourceSessionId} 保持原样;新会话可在侧栏打开继续对话\n` +
            `  ${lineageRecorded ? '✓' : '!'} 血缘${lineageRecorded ? '已登记' : '登记失败(功能不受影响)'}`,
        })
      },
    }),
  )
}
