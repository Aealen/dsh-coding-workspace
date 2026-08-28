/**
 * dsh-worktree 客户端半区(M1:挂载链验证)。
 *
 * 客户端模块与后端半区同为 cordis 插件形态;工厂由 esbuild 包成
 * window.__ModuleLoader__.load({id, factory}) 形态后经 /plugins 路由服务。
 * react 系依赖走 dsh.client.external 向 shell 请求,不在 bundle 内。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-worktree'

/** M1 阶段零服务依赖;M2 起 inject ['slots']。 */
export const inject: string[] = []

export function apply(ctx: Context): void {
  // eslint-disable-next-line no-console
  console.log('[dsh-worktree] client module loaded, ctx keys sample:', Object.keys(ctx).length)
}
