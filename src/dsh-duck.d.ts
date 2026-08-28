/**
 * dsh 宿主服务的最小鸭子类型(插件侧不引未发布的宿主包)。
 * 集中一处 declare module,避免多处声明同名 Context 成员产生 TS 合并冲突。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** cordis 效果注册(fn 返回值或其 disposer 在 fiber 卸载时回收)。 */
    effect(fn: () => unknown, label?: string): unknown
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
  }
}

export {}
