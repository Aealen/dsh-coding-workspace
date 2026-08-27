import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'

/** 一条 worktree 与其父项目的血缘边。 */
export interface LineageEdge {
  /** git 主仓(commondir 所有者)路径;null 表示该路径自身即主仓。 */
  parentPath: string | null
  /** 该 worktree 当前检出的分支;detached 时为 undefined。 */
  branch?: string
  /** plugin = project_fork 显式登记;inferred = git gitdir 反推兜底。 */
  origin: 'plugin' | 'inferred'
  /** fork 时登记的 dsh 工作区 id;remove 据此注销,目录已死也能走通。 */
  workspaceId?: string
  /** 登记时间(epoch ms)。 */
  createdAt: number
}

/**
 * 血缘存储的最小接口:收窄为读写两式,便于测试用内存实现替换。
 * 介质当前是 harness home 下的单个 JSON 文件(原子写);
 * 未来若迁官方 ctx.storage 的 KV form,仅替换此接口的实现。
 */
export interface LineageStore {
  readAll(): Promise<Record<string, LineageEdge>>
  writeEdge(key: string, edge: LineageEdge): Promise<void>
  /** 删除一条边;返回是否确实存在过。 */
  deleteEdge(key: string): Promise<boolean>
}

export const LINEAGE_FILE_VERSION = 1

/** 路径规范化:统一 POSIX 分隔符作为血缘 key(Windows 反斜杠归一)。 */
export function lineageKey(path: string): string {
  return path.replace(/\\/g, '/')
}

interface LineageFile {
  version: number
  edges: Record<string, LineageEdge>
}

/** 默认文件介质:harness home 下的 worktree-lineage.json,临时文件 + rename 原子落盘。 */
export function createFileLineageStore(homeDir: string = defaultDshHome()): LineageStore {
  const file = join(homeDir, 'worktree-lineage.json')
  return {
    async readAll() {
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        return {} // 首次使用或尚未落盘:空表即合法状态
      }
      try {
        const parsed = JSON.parse(raw) as Partial<LineageFile>
        if (parsed.version !== LINEAGE_FILE_VERSION || typeof parsed.edges !== 'object' || parsed.edges === null) {
          return {}
        }
        return parsed.edges
      } catch {
        return {} // 半截/损坏文件按空表处理,不因血缘数据丢失插件功能
      }
    },
    async writeEdge(key, edge) {
      const current = await this.readAll()
      current[key] = edge
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: LINEAGE_FILE_VERSION, edges: current }, null, 2), 'utf8')
      await rename(tmp, file)
    },
    async deleteEdge(key) {
      const current = await this.readAll()
      if (!(key in current)) return false
      delete current[key]
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: LINEAGE_FILE_VERSION, edges: current }, null, 2), 'utf8')
      await rename(tmp, file)
      return true
    },
  }
}

/**
 * 解析 worktree 根下 `.git` 文件的内容,反推主仓路径。
 *
 * - `.git` 为目录 → 自身即主仓,返回 null;
 * - `.git` 为文件且形如 `gitdir: <主仓>/.git/worktrees/<名>` → 返回主仓路径;
 * - 其余情况(裸仓、异常内容、无 .git)→ 返回 undefined 表示无法判定。
 */
export function parseGitdirFile(gitPathContent: string): string | null | undefined {
  const content = gitPathContent.replace(/\r$/, '').trim()
  if (!content.startsWith('gitdir:')) return undefined
  const gitdir = content.slice('gitdir:'.length).trim().replace(/\\/g, '/')
  // 主仓的 worktree 挂载点固定为 <主仓>/.git/worktrees/<名>(git 布局约定)
  const match = /(^.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitdir)
  return match ? match[1] : undefined
}

/** 内存存储:测试与「禁用持久化」场景用。 */
export function createMemoryLineageStore(initial: Record<string, LineageEdge> = {}): LineageStore {
  const edges: Record<string, LineageEdge> = { ...initial }
  return {
    async readAll() {
      return { ...edges }
    },
    async writeEdge(key, edge) {
      edges[key] = edge
    },
    async deleteEdge(key) {
      return delete edges[key]
    },
  }
}

/**
 * 兜底推断单条血缘:`.git` 为目录即主仓(parentPath=null);
 * 为 worktree 文件则反推主仓;无法判定时返回 undefined。
 */
export async function inferLineage(worktreePath: string, branch?: string): Promise<LineageEdge | undefined> {
  const dotGit = join(worktreePath, '.git')
  let st
  try {
    st = await stat(dotGit)
  } catch {
    return undefined
  }
  if (st.isDirectory()) {
    return { parentPath: null, branch, origin: 'inferred', createdAt: Date.now() }
  }
  const raw = await readFile(dotGit, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  const parent = parseGitdirFile(raw)
  if (parent === undefined || parent === null) {
    // parseGitdirFile 只对可判定形态返回非 undefined;裸文件内容异常视为不可判
    return parent === null
      ? { parentPath: null, branch, origin: 'inferred', createdAt: Date.now() }
      : undefined
  }
  return { parentPath: parent, branch, origin: 'inferred', createdAt: Date.now() }
}

/**
 * 取一条血缘:登记表命中直接返回;未命中走 git 反推并把结果
 * 以 inferred 边写回(下次不再反推);彻底不可判定返回 undefined。
 */
export async function getOrInferEdge(
  store: LineageStore,
  worktreePath: string,
  branch?: string,
): Promise<LineageEdge | undefined> {
  const key = lineageKey(worktreePath)
  const known = (await store.readAll())[key]
  if (known) return known
  const inferred = await inferLineage(worktreePath, branch)
  if (inferred) await store.writeEdge(key, inferred)
  return inferred
}
