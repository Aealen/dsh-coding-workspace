import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildFocusSeedEvents } from '../focus-seed.js'
import { createFileSessionLineageStore, type SessionLineageEdge } from '../session-lineage.js'

const lineageStore = createFileSessionLineageStore()

/** 读宿主当前默认模型(agentDefaultModel);服务缺席时 undefined。 */
export function readDefaultModel(ctx: Context): { provider: string; model: string; reasoningEffort?: string } | undefined {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.()
    if (sel === undefined || sel === null || typeof sel.provider !== 'string' || typeof sel.model !== 'string') return undefined
    return {
      provider: sel.provider,
      model: sel.model,
      ...(typeof sel.reasoningEffort === 'string' ? { reasoningEffort: sel.reasoningEffort } : {}),
    }
  } catch {
    return undefined
  }
}

/** 最小事件形状:只关心寻界所需字段。 */
interface BareEvent {
  type: string
  seq: number
}

/**
 * 完整交接切点换算(对齐 0.2.x 宿主 fork 的边界语义):
 * atSeq 给定 → 第一个 seq≥atSeq 的 turn/end;缺省/越界 → 最后一个 turn/end;
 * 找不到 → null(调用方报 fork-unavailable)。
 *
 * 切点从 turn/end 之后**向后扩展到下一个历史起点之前**。0.2.x 引入 inbox 后,
 * turn/end 之后合法地可能紧跟 `user/message`(排队的下一条提示)或
 * `agent/inbox/spliced`——这些属于**下一轮**的输入,若被切进 seed,子会话首屏
 * 会出现一条永远没有回应的用户消息。官方边界函数在以下三类事件处停下:
 * read-boundary 之外的 `turn/start`、surfaceOp=append 的 `user/message`、
 * `agent/inbox/spliced`。
 */
const NEXT_TURN_EVENT_TYPES: ReadonlySet<string> = new Set(['turn/start', 'user/message', 'agent/inbox/spliced'])

export function resolveForkCut(events: readonly BareEvent[], atSeq?: number): { cut: number } | null {
  const lastSeq = events.at(-1)?.seq ?? -1
  const boundary =
    (atSeq !== undefined ? events.find((e) => e.type === 'turn/end' && e.seq >= atSeq) : undefined) ??
    (atSeq === undefined || atSeq > lastSeq ? events.findLast((e) => e.type === 'turn/end') : undefined)
  if (boundary === undefined) return null
  let cut = boundary.seq + 1
  while (cut < events.length && !NEXT_TURN_EVENT_TYPES.has(events[cut]?.type ?? '')) cut++
  return { cut }
}

/**
 * session_fork:从源会话派生一个新的独立会话(带 agent,侧栏可见可续聊)。
 *
 * - full:完整交接。复刻 Web UI 分支按钮的内核链路:换算完成 turn 切点 →
 *   ctx.agents.create(seed = 前缀深拷贝,meta.parentSession 血缘)→ 挂 workspace。
 * - focus:聚焦交接。模型先用 session_read 读源会话并提炼摘要,本工具把摘要
 *   合成为首条 user 消息种子走同一 agents.create 通道,轻量启动。
 *
 * 两种模式都会在 session-lineage.json 登记父子边。
 */
export function registerSessionFork(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'session_fork',
      description:
        '从指定会话派生一个可继续对话的新会话。mode=full 完整交接(复制全部上下文,同 Web UI 分支按钮);' +
        'mode=focus 聚焦交接(需传 summary,新会话仅以你的摘要作为首条消息,轻量启动)。' +
        '源会话回合进行中时 full 会自动锚定到最后一个完成回合。',
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
        const agents = ctx.agents
        const mode = args.mode === 'focus' ? 'focus' : 'full'
        if (mode === 'focus' && !args.summary?.trim()) {
          throw new Error('聚焦交接需要 summary:请先用 session_read 读取源会话,提炼摘要后传入。')
        }

        // 读源:两种模式都要 cwd(继承 + workspace 反查);full 还要切点换算
        let sourceCwd: string | undefined
        let cutSeed: readonly unknown[] | undefined
        const snapshot = await ctx.sessionQuery.readSession(args.sourceSessionId as never)
        sourceCwd = (snapshot.session as { cwd?: string }).cwd
        if (mode === 'full') {
          const events = snapshot.events as BareEvent[]
          const resolved = resolveForkCut(events, args.boundary)
          if (resolved === null) {
            throw new Error(`源会话 "${args.sourceSessionId}" 还没有任何完成的回合,无法完整交接;可改用 focus 模式。`)
          }
          cutSeed = (snapshot.events as unknown[]).slice(0, resolved.cut)
        }

        // workspace 挂载点:源会话所在工作区(cwd 反查),尽力而为
        let workspace: Awaited<ReturnType<typeof ctx.workspaceRegistry.resolveByPath>> | undefined
        try {
          workspace = await ctx.workspaceRegistry.resolveByPath(sourceCwd ?? process.cwd())
        } catch {
          // cwd 不可解析/服务缺席:挂载跳过,结果体如实报告
        }

        const childId = args.newSessionId ?? `session-${crypto.randomUUID()}`
        const seed =
          mode === 'full'
            ? cutSeed
            : buildFocusSeedEvents(args.summary as string, args.sourceSessionId)
        // agent 组合事务:session + agent 一体创建(UI 可直接续聊)。
        // 0.2.x 三处必填/必对齐:
        // - agentOptions:agent-loop 的 preStep 在无 provider/model 时直接 throw,
        //   不回退 agentDefaultModel(只有宿主 resume 路径会补)→ 缺了就是
        //   「fork 出来能看不能聊」;
        // - isSeeded + inheritedEventCount:带 seed 的会话必须显式标记播种,
        //   否则继承日志被当自身历史、end-seed 收尾标记错位;
        // - 不再写 meta.parentSession(0.2.x 该字段被 subagent 血缘征用,普通
        //   派生会话写了会被当成某会话的子代理);父子关系只记插件自己的 lineage。
        const selection = readDefaultModel(ctx)
        await agents.create({
          sessionId: childId,
          seed,
          isSeeded: true,
          inheritedEventCount: seed?.length ?? 0,
          ...(selection === undefined ? {} : { agentOptions: selection }),
          meta: {
            ...(sourceCwd !== undefined ? { cwd: sourceCwd } : {}),
          },
        })

        // workspace 挂载(侧栏归属)
        let attached = false
        let attachError: string | undefined
        if (workspace) {
          try {
            await workspace.attachSession(childId)
            attached = true
          } catch (error) {
            attachError = error instanceof Error ? error.message : String(error)
          }
        }

        const edge: SessionLineageEdge = {
          sourceId: args.sourceSessionId,
          mode,
          cwd: sourceCwd,
          createdAt: Date.now(),
        }
        let lineageRecorded = true
        try {
          await lineageStore.writeEdge(childId, edge)
        } catch {
          lineageRecorded = false
        }

        const lines = [
          `✓ 已${mode === 'full' ? '完整' : '聚焦'}交接派生新会话 ${childId}`,
          `  源会话 ${args.sourceSessionId} 保持原样,新会话可在侧栏打开继续对话`,
          attached
            ? '  ✓ 已挂载到源工作区(侧栏即时可见)'
            : `  ! 未挂载工作区${attachError ? `:${attachError}` : '(未找到源所在工作区)'}`,
          `  ${lineageRecorded ? '✓' : '!'} 血缘${lineageRecorded ? '已登记' : '登记失败(功能不受影响)'}`,
        ]

        return JSON.stringify({
          childSessionId: childId,
          sourceSessionId: args.sourceSessionId,
          mode,
          cwd: sourceCwd,
          attached,
          attachError,
          lineageRecorded,
          rendered: lines.join('\n'),
        })
      },
    }),
  )
}
