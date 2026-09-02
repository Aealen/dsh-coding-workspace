import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { currentBranch, listBranches, parseWorktreeList, runGit } from '../git.js'
import { createFileLineageStore, inferLineage, lineageKey, type LineageEdge } from '../lineage.js'

const worktreeLineageStore = createFileLineageStore()

/**
 * 新建工作区 HTTP 路由组(侧栏「新建工作区」Modal 的后端):
 *
 * - POST /dsh-coding-workspace/repo-info      {repoPath} → 分支清单(本地/各 remote)+ 当前分支
 * - POST /dsh-coding-workspace/worktree-create {...} → git worktree add 全链路 + 注册 + 血缘
 * - POST /dsh-coding-workspace/workspace-note {targetPath, note} → 备注写回血缘边
 *
 * 路径策略(老大定版):worktree 默认落 <主仓>/.worktree/<分支净化名>,
 * 创建时自动把 `.worktree/` 追加进主仓 .gitignore(已存在则跳过)。
 */
export function registerWorkspaceCreateRoutes(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/repo-info',
        handler: async (req, res) => {
          const body = await readBody(req)
          const repoPath = typeof body?.repoPath === 'string' ? body.repoPath : ''
          if (repoPath === '') return json(res, 400, { ok: false, message: '缺少 repoPath' })
          try {
            const [inventory, branch, worktrees, originUrl] = await Promise.all([
              listBranches(repoPath),
              currentBranch(repoPath),
              runGit(repoPath, ['worktree', 'list', '--porcelain']).then((out) => parseWorktreeList(out)),
              runGit(repoPath, ['remote', 'get-url', 'origin']).then((u) => u.trim()).catch(() => ''),
            ])
            // 参考稿项目行右侧展示 owner/repo 短名
            const shortMatch = /[:\/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(originUrl)
            const originShort = originUrl === '' ? '' : (shortMatch !== null ? shortMatch[1] : originUrl)
            // 已被检出的分支(主仓 + 任意 worktree):同分支不能进多个 worktree,下拉禁选
            const occupiedBranches = [...new Set(worktrees.filter((w) => w.branch !== undefined).map((w) => w.branch as string))]
            json(res, 200, { ok: true, currentBranch: branch ?? null, locals: inventory.locals, remotes: inventory.remotes, occupiedBranches, originShort })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: repo-info route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/worktree-create',
        handler: async (req, res) => {
          const body = await readBody(req)
          const repoPath = typeof body?.repoPath === 'string' ? body.repoPath : ''
          const targetPath = typeof body?.targetPath === 'string' ? body.targetPath.trim() : ''
          const mode = body?.mode === 'existing' ? 'existing' : 'new'
          const branchName = typeof body?.branchName === 'string' ? body.branchName.trim() : ''
          const remote = typeof body?.remote === 'string' ? body.remote.trim() : ''
          const note = typeof body?.note === 'string' ? body.note.trim() : ''
          const title = typeof body?.title === 'string' ? body.title.trim() : ''
          // 图标/颜色:不传(undefined)= 默认(branch + 路径哈希色,渲染端兜底)
          const icon = typeof body?.icon === 'string' && body.icon.trim() !== '' ? body.icon.trim() : undefined
          const color = typeof body?.color === 'string' && body.color.trim() !== '' ? body.color.trim() : undefined
          // 新建模式的起点分支:缺省 = 主仓 HEAD;baseRemote 给定时起点为 remote 分支
          const baseBranch = typeof body?.baseBranch === 'string' ? body.baseBranch.trim() : ''
          const baseRemote = typeof body?.baseRemote === 'string' ? body.baseRemote.trim() : ''

          if (targetPath === '') return json(res, 400, { ok: false, message: '缺少目标路径 targetPath' })
          if (branchName === '') return json(res, 400, { ok: false, message: '缺少分支名 branchName' })

          // 组装 git worktree add 参数:
          // - new:     -b <branchName>(起点=主仓 HEAD,未选分支即"跟随主仓当前分支"派生)
          // - existing 本地分支:直接检出该分支(已被其他 worktree 占用时 git 会拒绝)
          // - existing remote 分支(remote 给定):-b <branchName> <remote>/<branch>,
          //   本地建同名跟踪分支;若本地同名分支已存在,git 报错如实转述
          const startPoint =
            baseBranch !== '' ? (baseRemote !== '' ? `${baseRemote}/${baseBranch}` : baseBranch) : ''
          const args =
            mode === 'new'
              ? ['worktree', 'add', '-b', branchName, targetPath, ...(startPoint !== '' ? [startPoint] : [])]
              : remote !== ''
                ? ['worktree', 'add', '-b', branchName, targetPath, `${remote}/${branchName}`]
                : ['worktree', 'add', targetPath, branchName]

          try {
            await runGit(repoPath, args)
          } catch (error) {
            // remote 分支且本地同名分支已存在:-b 会被 git 拒绝;此时直接检出
            // 本地同名分支(选 origin/x 的意图就是要在 x 上干活)
            const message = error instanceof Error ? error.message : String(error)
            if (remote !== '' && /already exists/i.test(message)) {
              try {
                await runGit(repoPath, ['worktree', 'add', targetPath, branchName])
              } catch (retryError) {
                json(res, 400, { ok: false, message: retryError instanceof Error ? retryError.message : String(retryError) })
                return
              }
            } else {
              json(res, 400, { ok: false, message })
              return
            }
          }

          // 路径落在 <主仓>/.worktree/ 下时,确保主仓 .gitignore 忽略该目录
          try {
            await ensureGitignoreEntry(repoPath, '.worktree/', targetPath)
          } catch {
            // .gitignore 追加失败不阻塞创建(手动加即可)
          }

          let workspaceId: string | undefined
          try {
            const created = await ctx.workspaceRegistry.create(targetPath, title !== '' ? title : undefined)
            const id = (created as { id?: string } | undefined)?.id
            if (typeof id === 'string' && id !== '') workspaceId = id
          } catch {
            // 注册失败不阻塞:血缘兜底 + cwd 归属仍可用
          }

          const edge: LineageEdge = {
            parentPath: repoPath,
            branch: branchName,
            origin: 'plugin',
            createdAt: Date.now(),
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            ...(note !== '' ? { note } : {}),
            ...(icon !== undefined ? { icon } : {}),
            ...(color !== undefined ? { color } : {}),
          }
          await worktreeLineageStore.writeEdge(lineageKey(targetPath), edge)

          json(res, 200, { ok: true, path: targetPath, branch: branchName, workspaceId: workspaceId ?? null })
        },
      }),
    'dsh-coding-workspace: worktree-create route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/workspace-note',
        handler: async (req, res) => {
          const body = await readBody(req)
          const targetPath = typeof body?.targetPath === 'string' ? body.targetPath : ''
          // 三可选字段:空串=清除该字段;未提供(undefined)=保持不动
          const note = typeof body?.note === 'string' ? body.note.trim() : undefined
          const icon = typeof body?.icon === 'string' ? body.icon.trim() : undefined
          const color = typeof body?.color === 'string' ? body.color.trim() : undefined
          if (targetPath === '') return json(res, 400, { ok: false, message: '缺少 targetPath' })
          if (note === undefined && icon === undefined && color === undefined) {
            return json(res, 400, { ok: false, message: '缺少要写入的字段(note/icon/color)' })
          }

          const key = lineageKey(targetPath)
          const edges = await worktreeLineageStore.readAll()
          const existing = edges[key]
          const base: LineageEdge =
            existing ??
            (await fallbackEdge(targetPath, typeof note === 'string' ? note : undefined))
          const next: LineageEdge = { ...base }
          if (note !== undefined) {
            if (note === '') delete next.note
            else next.note = note
          }
          if (icon !== undefined) {
            if (icon === '') delete next.icon
            else next.icon = icon
          }
          if (color !== undefined) {
            if (color === '') delete next.color
            else next.color = color
          }
          await worktreeLineageStore.writeEdge(key, next)
          json(res, 200, { ok: true, note: next.note ?? null, icon: next.icon ?? null, color: next.color ?? null })
        },
      }),
    'dsh-coding-workspace: workspace-note route',
  )
}

/** git worktree add:仓库目录不存在等情况下给出可读错误(错误由 runGit 抛出)。 */

/**
 * 无登记边时的兜底:现场 git gitdir 反推;主仓自身(parentPath=null)也合法。
 * 失败则按独立工作区登记(parentPath=null),保证备注总有落点。
 */
async function fallbackEdge(targetPath: string, note?: string): Promise<LineageEdge> {
  const inferred = await inferLineage(targetPath).catch(() => undefined)
  if (inferred !== undefined) return { ...inferred, origin: 'plugin', createdAt: Date.now(), ...(note !== undefined ? { note } : {}) }
  return { parentPath: null, origin: 'plugin', createdAt: Date.now(), ...(note !== undefined ? { note } : {}) }
}

/** 目标路径位于 <repoPath>/.worktree/ 下时,把 `.worktree/` 追加进主仓 .gitignore。 */
async function ensureGitignoreEntry(repoPath: string, entry: string, targetPath: string): Promise<void> {
  const wtRoot = resolve(repoPath, '.worktree') + sep
  if (!resolve(targetPath).toLowerCase().startsWith(wtRoot.toLowerCase())) return

  const gitignore = join(repoPath, '.gitignore')
  let content = ''
  try {
    content = await readFile(gitignore, 'utf8')
  } catch {
    content = ''
  }
  const already = content.split(/\r?\n/).some((line) => line.trim() === entry)
  if (already) return
  const needsNewline = content !== '' && !content.endsWith('\n')
  await writeFile(gitignore, `${content}${needsNewline ? '\n' : ''}${entry}\n`, 'utf8')
}

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 读取请求体 JSON;失败返回空对象。 */
function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}
