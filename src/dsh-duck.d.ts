/**
 * dsh 宿主服务的最小鸭子类型(插件侧不引未发布的宿主包)。
 * 集中一处 declare module,避免多处声明同名 Context 成员产生 TS 合并冲突。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Agent 组合事务(dsh-agent):创建 session+agent 一体,UI 可续聊。 */
    agents: {
      create(options: {
        sessionId: string
        seed?: readonly unknown[]
        meta?: {
          cwd?: string
          parentSession?: string
          seedLength?: number
          agentPreset?: string
        }
      }): Promise<unknown>
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
  }
}

export {}
