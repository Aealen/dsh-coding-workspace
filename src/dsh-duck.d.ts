/**
 * dsh 宿主服务的最小鸭子类型(插件侧不引未发布的宿主包)。
 * 集中一处 declare module,避免多处声明同名 Context 成员产生 TS 合并冲突。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** cordis 效果注册(fn 返回值或其 disposer 在 fiber 卸载时回收)。 */
    effect(fn: () => unknown, label?: string): unknown
    /**
     * Agent 组合事务(dsh-agent):创建 session+agent 一体,UI 可续聊。
     *
     * 0.2.x 关键语义:
     * - `agentOptions` 必须显式带 provider/model(agent-loop 的 preStep 在 selection
     *   缺席时直接 throw,且**不回退** agentDefaultModel——只有宿主 resume 路径会补);
     * - 带 seed 的会话必须 `isSeeded: true` + `inheritedEventCount`,否则继承日志
     *   被当作自身历史、session/end-seed 收尾标记会错位;
     * - meta 只取白名单(cwd/createdAt/parentSession/isSeeded/origin/delegationDepth/
     *   agentPreset),`seedLength` 之类未知键会被静默丢弃(旧版会写进 header)。
     */
    agents: {
      create(options: {
        sessionId: string
        seed?: readonly unknown[]
        /** 继承的源事件条数(与 seed 同步给出)。 */
        inheritedEventCount?: number
        /** 该会话是"播种"而来(从父会话复制历史)。 */
        isSeeded?: boolean
        /** 模型路由(0.2.x 必填,否则 live agent 无 provider/model)。 */
        agentOptions?: { provider: string; model: string; reasoningEffort?: string }
        meta?: {
          cwd?: string
          parentSession?: string
          agentPreset?: string
        }
      }): Promise<unknown>
    }
    /** 宿主 web 服务器(dsh-host-webserver,web 层):命名路由注册。 */
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    }
    /** 工作区注册表(dsh-workspace,web 层)。 */
    workspaceRegistry: {
      create(path: string, title?: string): Promise<unknown>
      resolveByPath(path: string): Promise<
        | {
            id: string
            attachSession(sessionId: string): Promise<void>
          }
        | undefined
      >
      delete(id: string): Promise<boolean>
    }
    /** 宿主 LLM 运行时(dsh-llm):adapter 注册表 + 流式模型调用。 */
    llm: {
      stream(options: {
        provider: string
        model: string
        messages: unknown[]
        system?: string
        maxTokens?: number
        signal?: AbortSignal
      }): AsyncIterable<{
        type: string
        text?: string
        /** finish chunk:终止原因(reason.kind = stop/error/aborted/max-tokens/tool-calls)。 */
        reason?: { kind: string; failure?: { message: string } }
      }>
    }
    /** 默认模型选择(dsh-agent-default-model):读用户当前选中的 provider/model。 */
    agentDefaultModel: {
      currentSelection(): { provider: string; model: string; reasoningEffort?: string }
    }
  }
}

export {}
