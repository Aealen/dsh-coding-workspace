import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { performFork, type ForkDeps } from '../fork-core.js'
import { createFileLineageStore } from '../lineage.js'
import { runGit } from '../git.js'


const lineageStore = createFileLineageStore()

export function registerProjectFork(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'project_fork',
      description:
        '从一个仓库 fork 出并行开发的 worktree:创建 git worktree(新分支)、注册进 dsh 工作区列表、登记项目血缘(供分组视图归组)。注册或血缘失败不会拆除已建 worktree。',
      parameters: {
        name: { type: 'string', required: true },
        sourceRepoPath: { type: 'string' },
        worktreePath: { type: 'string' },
        baseRef: { type: 'string' },
        title: { type: 'string' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const deps: ForkDeps = {
          async addWorktree(sourceRepoPath, gitArgs) {
            await runGit(sourceRepoPath, gitArgs, exec.signal)
          },
          registerWorkspace: (path, title) =>
            ctx.workspaceRegistry.create(path, title),
          store: lineageStore,
        }

        const sourceRepoPath = args.sourceRepoPath ?? process.cwd()
        const outcome = await performFork(deps, {
          sourceRepoPath,
          name: args.name,
          worktreePath: args.worktreePath,
          baseRef: args.baseRef,
          title: args.title,
        })

        const lines = [
          `✓ worktree 已创建:${outcome.worktreePath} (branch ${outcome.branch})`,
          outcome.workspaceRegistered
            ? '✓ 已注册进 dsh 工作区'
            : `! 未注册进工作区${outcome.registryError ? `:${outcome.registryError}` : '(当前组合无此服务)'}`,
          outcome.lineageRecorded ? '✓ 血缘已登记' : '! 血缘登记失败(不影响本次 fork)',
        ]

        return JSON.stringify({ ...outcome, rendered: lines.join('\n') })
      },
    }),
  )
}
