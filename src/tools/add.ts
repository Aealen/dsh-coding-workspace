import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runGit } from '../git.js'

/**
 * worktree_add：基于源仓库创建新 worktree。
 *
 * - createBranch=true（默认）：以 baseRef 为起点新建分支并检出到新 worktree；
 * - createBranch=false：检出已存在的分支 branch 到新 worktree。
 */
export function registerWorktreeAdd(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'worktree_add',
      description:
        '从仓库创建新的 git worktree。默认新建分支并检出；也可检出已有分支。返回新 worktree 路径。',
      parameters: {
        path: { type: 'string', required: true },
        branch: { type: 'string', required: true },
        repoPath: { type: 'string' },
        createBranch: { type: 'boolean' },
        baseRef: { type: 'string' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const repoPath = args.repoPath ?? process.cwd()
        const gitArgs = ['worktree', 'add']
        if (args.createBranch !== false) {
          gitArgs.push('-b', args.branch)
        }
        gitArgs.push(args.path)
        if (args.createBranch !== false && args.baseRef !== undefined) {
          gitArgs.push(args.baseRef)
        } else if (args.createBranch === false) {
          gitArgs.push(args.branch)
        }

        await runGit(repoPath, gitArgs, exec.signal)

        // 读取刚创建条目的实际落盘路径（git 会规范化路径）。
        const listing = await runGit(repoPath, ['worktree', 'list', '--porcelain'], exec.signal)
        const normalized = args.path.replace(/\\/g, '/')
        const created = listing
          .split('\n')
          .find((line) => line.startsWith('worktree ') && line.slice('worktree '.length).replace(/\\/g, '/').endsWith(normalized))

        return JSON.stringify({
          created: true,
          worktreePath: created ? created.slice('worktree '.length) : args.path,
          branch: args.branch,
          createdNewBranch: args.createBranch !== false,
          baseRef: args.baseRef,
        })
      },
    }),
  )
}
