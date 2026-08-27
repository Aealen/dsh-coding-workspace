import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseWorktreeList, runGit } from '../git.js'

/** worktree_list：枚举仓库的全部 worktree 及其状态。 */
export function registerWorktreeList(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'worktree_list',
      description:
        '列出指定仓库（默认当前工作目录）的所有 git worktree，含路径、分支、HEAD、锁定/可修剪状态。',
      parameters: {
        repoPath: { type: 'string' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const repoPath = args.repoPath ?? process.cwd()
        const output = await runGit(repoPath, ['worktree', 'list', '--porcelain'], exec.signal)
        const entries = parseWorktreeList(output)

        const lines = entries.map((entry) => {
          const state = entry.bare
            ? 'bare'
            : entry.detached
              ? `detached @ ${(entry.head ?? '').slice(0, 7)}`
              : `branch ${entry.branch}`
          const flags = [
            entry.lockedReason !== undefined ? `locked(${entry.lockedReason})` : undefined,
            entry.prunableReason !== undefined ? `prunable(${entry.prunableReason})` : undefined,
          ].filter(Boolean)
          return `- ${entry.path}  [${state}]${flags.length > 0 ? `  ${flags.join(' ')}` : ''}`
        })

        return JSON.stringify({ count: entries.length, entries, rendered: lines.join('\n') })
      },
    }),
  )
}
