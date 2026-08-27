import { execFile } from 'node:child_process'

/**
 * 执行一条 git 子命令，返回标准输出文本。
 *
 * 失败时抛出带 stderr 摘要的错误，便于工具层直接向模型转述原因。
 * 必须遵守传入的 abort signal（dsh 工具取消契约）。
 */
export function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
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
