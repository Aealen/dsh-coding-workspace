/**
 * 面板 Git 数据解析层(纯函数,与 HTTP 路由解耦便于单测):
 *
 * - porcelain v1 状态解析(staged/unstaged/untracked 三组 + 分支头)
 * - `git log` 行协议解析(pretty \0/\x1f 字段切分,末段 %P 完整 parents 供前端拓扑布局)
 * - `git show --name-status` 变更文件解析
 * - hash 白名单校验与目录穿越防护
 */
import { resolve, sep } from 'node:path'

/** porcelain 条目:X=暂存区状态,Y=工作区状态(?? = untracked)。 */
export interface StatusFileEntry {
  x: string
  y: string
  /** 显示路径(rename 取新路径);含原路径时 from 为旧路径。 */
  path: string
  from?: string
}

export interface StatusHeader {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
}

export interface StatusBreakdown {
  overview: StatusHeader
  staged: StatusFileEntry[]
  unstaged: StatusFileEntry[]
  untracked: StatusFileEntry[]
}

/**
 * 解析 `git status -b --porcelain=v1` 的头行:
 * - `## main...origin/main [ahead 1, behind 2]`
 * - `## main`(无 upstream)
 * - `## HEAD (no branch)`(detached)
 * - `## No commits yet on main`(init 仓,取末词为分支)
 */
export function parseStatusHeader(line: string | undefined): StatusHeader {
  const base: StatusHeader = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false }
  if (line === undefined || !line.startsWith('## ')) return base
  const body = line.slice(3).trim()
  if (body === '') return base
  if (/^HEAD \(no branch\)/.test(body)) return { ...base, detached: true }
  const aheadMatch = /\[ahead (\d+)(?:, behind (\d+))?\]/.exec(body)
  const behindOnlyMatch = /\[behind (\d+)\]/.exec(body)
  const ahead = aheadMatch !== null ? Number(aheadMatch[1]) : 0
  const behind = aheadMatch?.[2] !== undefined ? Number(aheadMatch[2]) : behindOnlyMatch !== null ? Number(behindOnlyMatch[1]) : 0
  const tracking = body.replace(/\s*\[.*\]\s*$/, '')
  const dot = tracking.indexOf('...')
  if (tracking.startsWith('No commits yet on ')) {
    return { branch: tracking.slice('No commits yet on '.length), upstream: null, ahead, behind, detached: false }
  }
  if (dot === -1) return { branch: tracking, upstream: null, ahead, behind, detached: false }
  return { branch: tracking.slice(0, dot), upstream: tracking.slice(dot + 3), ahead, behind, detached: false }
}

/** 去掉 porcelain 路径的外层引号(git 对含特殊字符路径加引号)。 */
function unquotePath(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1)
  return p
}

/** 解析条目路径:rename 行 `R  old -> new`(带引号形式 `"a b" -> "c d"`)。 */
function parseEntryPath(rest: string): { path: string; from?: string } {
  const quoted = /^"(.*)"\s*->\s*"(.*)"$/.exec(rest)
  if (quoted !== null) return { from: quoted[1], path: quoted[2] }
  const arrow = rest.indexOf(' -> ')
  if (arrow !== -1) return { from: unquotePath(rest.slice(0, arrow)), path: unquotePath(rest.slice(arrow + 4)) }
  return { path: unquotePath(rest) }
}

/**
 * 解析 `git status -b --porcelain=v1` 全量输出。
 * 分组规则:X 列非空非 ? 进 staged,Y 列非空非 ? 进 unstaged;`??` 进 untracked。
 */
export function parseStatusPorcelain(output: string): StatusBreakdown {
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== '')
  const overview = parseStatusHeader(lines[0])
  const staged: StatusFileEntry[] = []
  const unstaged: StatusFileEntry[] = []
  const untracked: StatusFileEntry[] = []
  for (const line of lines.slice(1)) {
    if (line.length < 4) continue
    const x = line[0] as string
    const y = line[1] as string
    const { path, from } = parseEntryPath(line.slice(3))
    if (x === '?' && y === '?') {
      untracked.push({ x, y, path })
      continue
    }
    if (x !== ' ' && x !== '?') staged.push({ x, y, path, ...(from !== undefined ? { from } : {}) })
    if (y !== ' ' && y !== '?') unstaged.push({ x, y, path, ...(from !== undefined ? { from } : {}) })
  }
  return { overview, staged, unstaged, untracked }
}

// ---------------------------------------------------------------------------
// git log --graph(行协议:每行首段为 graph ASCII,commit 行以 \0 起字段区)
// ---------------------------------------------------------------------------

export interface LogRefs {
  kind: 'head' | 'local' | 'remote' | 'tag'
  name: string
}

export interface LogCommit {
  hash: string
  /** 完整 parent hash 列表(pretty %P,空格分隔;root commit 为空数组)。 */
  parents: string[]
  short: string
  author: string
  /** 相对时间(git --date=relative,如「3 hours ago」)。 */
  relDate: string
  subject: string
  refs: LogRefs[]
}

/** 解析 %d 装饰字段:` (HEAD -> main, origin/main, tag: v1)` → 结构化 refs。 */
export function parseRefsField(decorate: string): LogRefs[] {
  const body = decorate.trim().replace(/^\(/, '').replace(/\)$/, '').trim()
  if (body === '') return []
  const refs: LogRefs[] = []
  for (const part of body.split(',')) {
    const item = part.trim()
    if (item === '') continue
    const head = /^HEAD ->\s*(.+)$/.exec(item)
    if (head !== null) {
      refs.push({ kind: 'head', name: head[1].trim() })
      continue
    }
    const tag = /^tag:\s*(.+)$/.exec(item)
    if (tag !== null) {
      refs.push({ kind: 'tag', name: tag[1].trim() })
      continue
    }
    refs.push({ kind: item.startsWith('origin/') || /^[^/]+\//.test(item) ? 'remote' : 'local', name: item })
  }
  return refs
}

/**
 * 解析 `git log --date-order --pretty=format:%x00%H%x1f...%x1f%P` 输出。
 * 行协议:行内出现 \0 → commit 行(graph = \0 前的前缀(现为空),字段 = \0 后按 \x1f 切,
 * 末段为 parents(空格分隔完整 hash));否则为纯过渡行(旧协议兼容,忽略)。
 */
export function parseLogGraph(output: string): LogCommit[] {
  const commits: LogCommit[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue
    const nul = line.indexOf('\0')
    if (nul === -1) continue
    const fields = line.slice(nul + 1).split('\x1f')
    commits.push({
      hash: fields[0] ?? '',
      parents: (fields[6] ?? '').split(' ').filter((p) => p !== ''),
      short: fields[1] ?? '',
      author: fields[2] ?? '',
      relDate: fields[3] ?? '',
      subject: fields[4] ?? '',
      refs: parseRefsField(fields[5] ?? ''),
    })
  }
  return commits
}

// ---------------------------------------------------------------------------
// 拓扑图布局:实现在 panel-graph.ts(纯函数零依赖,客户端 bundle 直引)
// ---------------------------------------------------------------------------

export { buildGraphLayout } from './panel-graph.js'
export type { GraphEdge, GraphLayout, GraphRowLayout } from './panel-graph.js'

// ---------------------------------------------------------------------------
// git show --name-status
// ---------------------------------------------------------------------------

export interface ChangedFile {
  /** M/A/D/R/C/T/U 首字母。 */
  status: string
  path: string
  from?: string
}

/**
 * 解析 `git show --name-status --format=...` 的文件区:
 * `M\tpath` / `R100\told\tnew`(\t 分隔,rename 两段)。
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const cols = line.split('\t')
    if (cols.length < 2) continue
    const status = (cols[0] as string).replace(/[0-9]+$/, '')
    if (cols.length >= 3) files.push({ status, from: cols[1] as string, path: cols[2] as string })
    else files.push({ status, path: cols[1] as string })
  }
  return files
}

// ---------------------------------------------------------------------------
// 安全校验
// ---------------------------------------------------------------------------

/** hash/ref 白名单:16 进制 7–64 位(SHA-1 短/全长 + SHA-256 仓)。 */
export function isValidHash(value: string): boolean {
  return /^[0-9a-fA-F]{7,64}$/.test(value)
}

/**
 * 查看分支的 ref 名白名单:拒 option 注入(`-` 开头)与 revision 语法扩展
 * (`~ ^ : ? * [ ] @{`、空白)——参数数组无 shell 注入,但 git 会解释 rev 语法
 * (如 `main@{yesterday}`、`main~3`),必须整体挡掉。
 */
export function isSafeRef(value: string): boolean {
  if (value === '' || value.startsWith('-')) return false
  return !/[\s~^:?*[\x00-\x1f\\]/.test(value) && !value.includes('@{')
}

/** 解析每行一个完整 hash 的输出(exclusives);非 16 进制行忽略。 */
export function parseHashList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => isValidHash(l) && l.length >= 40)
}

/** 仓库内相对路径白名单:非空、不以 - 开头(防 option 注入)、不含反斜杠归一后越出仓库的 `..` 段。 */
export function isSafeRepoPath(value: string): boolean {
  if (value === '' || value.startsWith('-')) return false
  const normalized = value.replace(/\\/g, '/')
  if (normalized.includes('\0')) return false
  return normalized.split('/').every((seg) => seg !== '..')
}

/**
 * 目录穿越防护:resolve(dir) 必须等于 root 或落在 root 内。
 * Windows 大小写不敏感,统一小写比较;返回 resolve 后的绝对路径,越界返回 null。
 */
export function resolveWithin(root: string, dir: string | undefined): string | null {
  const base = resolve(root)
  const target = resolve(base, dir === undefined || dir === '' ? '.' : dir)
  const sepLower = sep.toLowerCase()
  const b = base.toLowerCase() + sepLower
  const t = target.toLowerCase()
  if (t === base.toLowerCase() || t.startsWith(b)) return target
  return null
}
