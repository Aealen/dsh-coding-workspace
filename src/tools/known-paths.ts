/**
 * cwd 准入(共享):血缘 edges + workspace registry(运行时探测)双源白名单。
 * panel-routes 与 ai-routes 两个 entry 共用同一 store 实例与判定逻辑。
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createFileLineageStore, lineageKey } from '../lineage.js'

/** 血缘存储单例(读多写少,原子落盘;与 worktree 生命周期域共享)。 */
export const worktreeLineageStore = createFileLineageStore()

/** 构造 cwd 准入判别器:命中血缘或注册表任一即放行,返回 resolve 后绝对路径。 */
export function createKnownPaths(ctx: Context): {
  knownPaths: () => Promise<Set<string>>
  assertKnown: (rawCwd: string) => Promise<string>
} {
  const knownPaths = async (): Promise<Set<string>> => {
    const edges = await worktreeLineageStore.readAll().then((e) => Object.keys(e))
    // 插件侧 workspaceRegistry 类型面只有 create/resolveByPath/delete;运行时对象是
    // 宿主 WorkspaceManager,带同步 list()。⚠️ 用 ctx.get() 探测而非 ctx.workspaceRegistry
    // 属性访问:cordis 对本 entry inject 未声明的服务,属性访问直接抛「without inject」
    // (ai-entry 只声明 llm/agentDefaultModel/webServer,属访问必炸 → registry 全空 →
    // 纯 registry 工作区全部误判越界)。ctx.get() 无 inject 检查,官方实现同款用法。
    let registryPaths: string[] = []
    try {
      const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
      const registry =
        typeof getter === 'function' ? getter.call(ctx, 'workspaceRegistry') : (ctx as unknown as { workspaceRegistry?: unknown }).workspaceRegistry
      const manager = registry as { list?: () => Iterable<{ path?: unknown }> } | undefined
      registryPaths = [...(manager?.list?.() ?? [])]
        .map((w) => w?.path)
        .filter((p): p is string => typeof p === 'string')
    } catch {
      registryPaths = []
    }
    const set = new Set<string>()
    for (const p of [...edges, ...registryPaths]) {
      set.add(lineageKey(p).toLowerCase())
      // 血缘 key 是 POSIX 化原串;再补一层 resolve 小写,吸收大小写/短路径差异
      set.add(resolve(p).toLowerCase())
    }
    return set
  }

  const assertKnown = async (rawCwd: string): Promise<string> => {
    const resolved = resolve(rawCwd)
    const known = await knownPaths()
    const key = lineageKey(resolved).toLowerCase()
    if (!known.has(key) && !known.has(resolved.toLowerCase())) {
      throw new Error('目标路径不在已知工作区集合内(血缘或注册表均未命中),拒绝访问')
    }
    return resolved
  }

  return { knownPaths, assertKnown }
}
