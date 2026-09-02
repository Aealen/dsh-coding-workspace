/**
 * Changes 页 Changelist 分组(纯数据层 + 文件存储):
 *
 * git 没有 changelist 概念(JetBrains 是 IDE 层),插件自存 sidecar JSON:
 * harness home 下 coding-workspace-changelists.json,per-repo(cwd 归一 key)
 * 一份 {lists:[{name, files[]}]};不在任何组里的文件 = 默认组(不落盘)。
 */

/** 一条命名分组:files 为归一(正斜杠)仓库相对路径,文件至多属于一个组。 */
export interface Changelist {
  name: string
  files: string[]
}

export interface ChangelistState {
  lists: Changelist[]
}

export const EMPTY_STATE: ChangelistState = { lists: [] }

/** repo key:反斜杠归一正斜杠(Windows 路径在 HTTP/存储两侧形态一致)。 */
export function changelistKey(path: string): string {
  return path.replace(/\\/g, '/')
}

/** 新建分组;重名(或空名)时返回原状态(引用相等,前端可据此免刷新)。 */
export function createList(state: ChangelistState, name: string): ChangelistState {
  const trimmed = name.trim()
  if (trimmed === '' || state.lists.some((l) => l.name === trimmed)) return state
  return { lists: [...state.lists, { name: trimmed, files: [] }] }
}

/** 删除分组:成员文件回默认组(自然消失于各分组,无需落盘)。 */
export function deleteList(state: ChangelistState, name: string): ChangelistState {
  return { lists: state.lists.filter((l) => l.name !== name) }
}

/** 移动文件到指定组(先从所有组移除,保证单归属);to=null 移回默认组。 */
export function moveFile(state: ChangelistState, file: string, to: string | null): ChangelistState {
  if (to === null) {
    return { lists: state.lists.map((l) => ({ name: l.name, files: l.files.filter((f) => f !== file) })) }
  }
  if (!state.lists.some((l) => l.name === to)) return state // 目标组不存在:原状态
  return {
    lists: state.lists.map((l) =>
      l.name === to
        ? { name: l.name, files: [...l.files.filter((f) => f !== file), file] }
        : { name: l.name, files: l.files.filter((f) => f !== file) },
    ),
  }
}

interface ChangelistFile {
  version: number
  repos: Record<string, ChangelistState>
}

const FILE_VERSION = 1

/** 文件介质:harness home 下 coding-workspace-changelists.json(临时文件 + rename 原子落盘)。 */
export function createFileChangelistStore(homeDir: string): {
  readRepo(key: string): Promise<ChangelistState>
  writeRepo(key: string, state: ChangelistState): Promise<void>
} {
  const file = join(homeDir, 'coding-workspace-changelists.json')
  const readAll = async (): Promise<Record<string, ChangelistState>> => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return {}
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ChangelistFile>
      if (parsed.version !== FILE_VERSION || typeof parsed.repos !== 'object' || parsed.repos === null) return {}
      return parsed.repos
    } catch {
      return {} // 半截/损坏文件按空表处理,不因分组数据丢插件功能
    }
  }
  const writeAll = async (repos: Record<string, ChangelistState>): Promise<void> => {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, repos }, null, 2), 'utf8')
    await rename(tmp, file)
  }
  return {
    async readRepo(key) {
      const repos = await readAll()
      const state = repos[key]
      return state !== undefined && Array.isArray(state.lists) ? state : EMPTY_STATE
    },
    async writeRepo(key, state) {
      const repos = await readAll()
      repos[key] = state
      await writeAll(repos)
    },
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
