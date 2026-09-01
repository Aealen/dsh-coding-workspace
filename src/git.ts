import { execFile } from 'node:child_process'
import { join } from 'node:path'

function probe(bin: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolveProbe) => {
    execFile(bin, [...args], { windowsHide: true }, (error, stdout) => resolveProbe(error ? null : stdout))
  })
}

/** 注册表查 Git for Windows 安装目录(HKLM/HKCU 都查;reg.exe 属 System32,通常不在精简之列)。 */
async function gitDirFromRegistry(hive: 'HKLM' | 'HKCU'): Promise<string | null> {
  const out = await probe('reg', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'])
  if (out === null) return null
  const match = /REG_SZ\s+(.+)$/m.exec(out)
  return match === null ? null : match[1].trim()
}

/** where.exe 查 PATH 中的 git(不依赖 node 自身的 PATH 搜索)。 */
async function gitFromWhere(): Promise<string | null> {
  const out = await probe('where.exe', ['git'])
  if (out === null) return null
  const first = out.split(/\r?\n/).find((line) => line.trim() !== '')
  return first === undefined ? null : first.trim()
}

/**
 * 解析 git 绝对路径。关键坑:Windows 上 node spawn「相对命令名 + cwd 选项」
 * 必 ENOENT(PATH 搜索被 cwd 破坏,实测 git --version 带 cwd 即败),
 * 因此这里只接受绝对路径:where.exe → 注册表 GitForWindows → 常见安装位置。
 * 结果模块级缓存。
 */
let gitBinCache: string | undefined
async function resolveGitBin(): Promise<string> {
  if (gitBinCache !== undefined) return gitBinCache
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const candidates: string[] = []
  const whereHit = await gitFromWhere()
  if (whereHit !== null) candidates.push(whereHit)
  for (const hive of ['HKLM', 'HKCU'] as const) {
    const dir = await gitDirFromRegistry(hive)
    if (dir !== null) candidates.push(join(dir, 'cmd', 'git.exe'), join(dir, 'bin', 'git.exe'))
  }
  candidates.push(
    join(programFiles, 'Git', 'cmd', 'git.exe'),
    join(programFiles, 'Git', 'bin', 'git.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
  )
  for (const candidate of candidates) {
    if ((await probe(candidate, ['--version'])) !== null) {
      gitBinCache = candidate
      return candidate
    }
  }
  throw new Error('找不到可执行的 git 绝对路径(探测了 where、注册表 GitForWindows 与常见安装位置);PATH 相对名在 Windows spawn + cwd 下不可用')
}

/**
 * 执行一条 git 子命令，返回标准输出文本。
 *
 * 失败时抛出带 stderr 摘要的错误，便于工具层直接向模型转述原因。
 * 必须遵守传入的 abort signal（dsh 工具取消契约）。
 */
export async function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const bin = await resolveGitBin()
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          const reason = stderr.trim() || error.message
          reject(new Error(`git ${args.join(' ')} 失败：${reason}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

export interface WorktreeEntry {
  /** worktree 根目录绝对路径 */
  path: string
  /** 当前 HEAD 提交短哈希（bare 仓库缺失） */
  head?: string
  /** 分支短名；detached 时为 undefined */
  branch?: string
  /** 是否处于 detached HEAD 状态 */
  detached: boolean
  /** 是否 bare 仓库 */
  bare: boolean
  /** 锁定原因（未锁定为 undefined） */
  lockedReason?: string
  /** 可修剪说明（不可修剪为 undefined） */
  prunableReason?: string
}

/**
 * 解析 `git worktree list --porcelain` 输出。
 * 每个 worktree 条目由 `worktree <path>` 行起始，行间以空行分隔。
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> | undefined

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') {
      if (current) entries.push(finalize(current))
      current = undefined
      continue
    }
    const sep = line.indexOf(' ')
    const key = sep === -1 ? line : line.slice(0, sep)
    const value = sep === -1 ? '' : line.slice(sep + 1)

    switch (key) {
      case 'worktree':
        current = { path: value, detached: false, bare: false }
        break
      case 'HEAD':
        if (current) current.head = value
        break
      case 'branch':
        // refs/heads/main -> main
        if (current) current.branch = value.replace(/^refs\/heads\//, '')
        break
      case 'detached':
        if (current) current.detached = true
        break
      case 'bare':
        if (current) current.bare = true
        break
      case 'locked':
        if (current) current.lockedReason = value || '(no reason given)'
        break
      case 'prunable':
        if (current) current.prunableReason = value || '(no reason given)'
        break
      default:
        break // 未知行跳过，保持前向兼容
    }
  }
  if (current) entries.push(finalize(current))
  return entries
}

function finalize(partial: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: partial.path ?? '',
    head: partial.head,
    branch: partial.branch,
    detached: partial.detached ?? false,
    bare: partial.bare ?? false,
    lockedReason: partial.lockedReason,
    prunableReason: partial.prunableReason,
  }
}

/** 分支清单:本地与各 remote 分组(remote 数量不限,兼容多 origin 场景)。 */
export interface BranchInventory {
  /** 本地分支短名(不含 refs/heads/ 前缀) */
  locals: string[]
  /** 每个 remote 一组;branches 为该 remote 下的分支短名(去掉 remotes/<name>/ 前缀) */
  remotes: Array<{ name: string; branches: string[] }>
}

/**
 * 罗列仓库分支:`git for-each-ref` 一次取全本地与 remote 分支,再按 remote 分组。
 * 纯函数 parseBranchInventory 独立导出,便于单测。
 */
export async function listBranches(repoPath: string, signal?: AbortSignal): Promise<BranchInventory> {
  const output = await runGit(
    repoPath,
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', '--sort=refname'],
    signal,
  )
  return parseBranchInventory(output)
}

/** 解析 for-each-ref refname 行;跳过 remote HEAD 符号引用(remotes/x/HEAD)。 */
export function parseBranchInventory(output: string): BranchInventory {
  const locals: string[] = []
  const remoteBranches = new Map<string, string[]>()
  for (const rawLine of output.split('\n')) {
    const ref = rawLine.trim()
    if (ref === '') continue
    if (ref.startsWith('refs/heads/')) {
      locals.push(ref.slice('refs/heads/'.length))
      continue
    }
    const remoteMatch = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref)
    if (remoteMatch === null) continue // refs/remotes/x(无斜杠尾段,异常形态)跳过
    const [, remoteName, branchName] = remoteMatch
    if (branchName === 'HEAD') continue
    if (!remoteBranches.has(remoteName)) remoteBranches.set(remoteName, [])
    remoteBranches.get(remoteName)!.push(branchName)
  }
  return {
    locals,
    remotes: [...remoteBranches.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, branches]) => ({ name, branches })),
  }
}

/** 仓库当前分支短名;detached HEAD 返回 undefined。 */
export async function currentBranch(repoPath: string, signal?: AbortSignal): Promise<string | undefined> {
  const output = await runGit(repoPath, ['branch', '--show-current'], signal)
  const name = output.trim()
  return name === '' ? undefined : name
}
