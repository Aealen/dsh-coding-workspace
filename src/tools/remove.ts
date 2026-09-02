import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createFileLineageStore, getOrInferEdge, lineageKey } from '../lineage.js'
import { parseWorktreeList, runGit } from '../git.js'

const lineageStore = createFileLineageStore()

/**
 * worktree_remove:删除 worktree 并做三重收尾(工作区注销/血缘清理/可选删分支)。
 *
 * 放在 dsh-coding-workspace-fork entry(依赖 workspaceRegistry),与 project_fork 同域。
 *
 * 时序关键:**先经 resolveByPath 拿工作区 id(内部 realpath,要求目录存活),
 * 再删目录**。目录已死的历史残留走血缘 edge 里记录的 workspaceId 兜底注销
 * (0.1.4 起 fork 会把 id 写进血缘);git 层「not a working tree」时降级为
 * purge-only,只清注册与血缘,不报错。
 */
export function registerWorktreeRemove(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'worktree_remove',
      description:
        '删除指定的 git worktree,并同步注销 dsh 工作区(侧栏移除)与清理血缘登记。工作树不干净时需 force=true;' +
        '目录已不存在的残留注册也会被 purge-only 清理。分支默认保留,传 deleteBranch=true 安全删除(git branch -d)。',
      parameters: {
        path: { type: 'string', required: true },
        repoPath: { type: 'string' },
        force: { type: 'boolean' },
        deleteBranch: { type: 'boolean' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const repoPath = args.repoPath ?? process.cwd()
        const key = lineageKey(args.path)

        // 1) 前置侦察:分支名 + 血缘 edge(含 fork 时登记的 workspaceId)
        let branch: string | undefined
        let existsAsWorktree = true
        try {
          const listing = await runGit(repoPath, ['worktree', 'list', '--porcelain'], exec.signal)
          const entry = parseWorktreeList(listing).find(
            (e) => lineageKey(e.path) === key || lineageKey(e.path).endsWith(`/${key.split('/').pop()}`),
          )
          branch = entry?.branch
          existsAsWorktree = entry !== undefined
        } catch {
          // 枚举失败不阻塞;按存在处理,让 git 给出准确错误
        }
        const edge = await getOrInferEdge(lineageStore, args.path, branch).catch(() => undefined)

        // 2) 工作区 id:活目录走 resolveByPath;死目录用血缘里登记的 id 兜底
        let workspaceId: string | undefined = edge?.workspaceId
        if (!workspaceId) {
          try {
            const ws = await ctx.workspaceRegistry.resolveByPath(args.path)
            workspaceId = ws?.id
          } catch {
            // 死目录且血缘无 id:注销只能留给 purge-only 提示
          }
        }

        // 3) git 删除(已不存在时降级 purge-only)
        let purgedOnly = false
        if (existsAsWorktree) {
          const gitArgs = ['worktree', 'remove']
          if (args.force === true) gitArgs.push('--force')
          gitArgs.push(args.path)
          try {
            await runGit(repoPath, gitArgs, exec.signal)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/dirty|modified|untracked/i.test(message)) {
              throw new Error(`worktree '${args.path}' 存在未提交内容。如确认丢弃请传 force=true。原始错误：${message}`)
            }
            if (/not a working tree|does not exist/i.test(message)) {
              purgedOnly = true // 目录先死(手删/他因),只清注册残留
            } else {
              throw error
            }
          }
        } else {
          purgedOnly = true
        }

        // 4) 工作区注销(有 id 即可,不依赖目录)
        let workspaceRemoved: boolean | undefined
        let workspaceError: string | undefined
        if (workspaceId) {
          try {
            workspaceRemoved = await ctx.workspaceRegistry.delete(workspaceId)
          } catch (error) {
            workspaceError = error instanceof Error ? error.message : String(error)
          }
        }

        // 5) 血缘清理
        let lineageRemoved = false
        try {
          lineageRemoved = await lineageStore.deleteEdge(key)
        } catch {
          // 悬空边不致命
        }

        // 6) 可选分支删除
        let branchDeleted: boolean | undefined
        let branchError: string | undefined
        if (args.deleteBranch === true && branch) {
          try {
            await runGit(repoPath, ['branch', '-d', branch], exec.signal)
            branchDeleted = true
          } catch (error) {
            branchDeleted = false
            branchError = error instanceof Error ? error.message : String(error)
          }
        }

        const lines = [
          purgedOnly ? 'ℹ 目录已不存在,执行残留清理(purge-only)' : '✓ worktree 已删除',
          `${workspaceRemoved ? '✓' : '!'} 工作区${workspaceRemoved ? '已注销(侧栏同步移除)' : `注销${workspaceError ? `失败:${workspaceError}` : '未执行(无 id),可能需停机手动清'}`}`,
          `${lineageRemoved ? '✓' : '!'} 血缘${lineageRemoved ? '已清理' : '无记录'}`,
        ]
        if (args.deleteBranch === true) {
          lines.push(
            branchDeleted
              ? `✓ 分支 ${branch} 已删除`
              : `! 分支 ${branch ?? '?'} 未删除${branchError ? `:${branchError}` : ''}`,
          )
        }

        return JSON.stringify({
          removed: !purgedOnly,
          purgedOnly,
          worktreePath: args.path,
          branch,
          workspaceId,
          workspaceRemoved,
          workspaceError,
          lineageRemoved,
          branchDeleted,
          branchError,
          rendered: lines.join('\n'),
        })
      },
    }),
  )
}
