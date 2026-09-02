import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { runGit } from '../git.js'
import { changelistKey, createFileChangelistStore, createList, deleteList, moveFile } from '../changelist.js'
import { createKnownPaths } from './known-paths.js'
import {
  isSafeRef,
  isSafeRepoPath,
  isValidHash,
  parseHashList,
  parseLogGraph,
  parseNameStatus,
  parseStatusPorcelain,
  resolveWithin,
  type ChangedFile,
  type LogCommit,
} from '../panel-git.js'


/** 资源管理器单条目。 */
interface FsEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size?: number
  mtime?: number
}

/**
 * 侧栏右栏(工作区面板)HTTP 路由组:
 *
 * - POST /dsh-coding-workspace/fs-list      {root, dir}   → 目录清单(懒展开,噪音目录已滤)
 * - POST /dsh-coding-workspace/git-overview {cwd}         → 分支/upstream/ahead/behind/isRepo
 * - POST /dsh-coding-workspace/git-status   {cwd}         → staged/unstaged/untracked 三组
 * - POST /dsh-coding-workspace/git-log      {cwd,mode,skip,limit} → graph 行协议 commits
 * - POST /dsh-coding-workspace/git-show     {cwd,hash}    → commit 元信息 + 变更文件
 * - POST /dsh-coding-workspace/git-action   {cwd,action,…}→ 写操作唯一入口(白名单)
 *
 * 安全边界:cwd/root 必须命中已知工作区集合(血缘 edges + workspace registry);
 * fs-list 的 dir resolve 后必须落在 root 内;hash 走格式白名单;
 * 写操作仅 stage/unstage/commit/fetch/pull/push 六种,execFile 数组参数无 shell。
 */
export function registerPanelRoutes(ctx: Context): void {
  const { assertKnown } = createKnownPaths(ctx)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/fs-list',
        handler: async (req, res) => {
          const body = await readBody(req)
          const root = typeof body?.root === 'string' ? body.root : ''
          if (root === '') return json(res, 400, { ok: false, message: '缺少 root' })
          try {
            const rootResolved = await assertKnown(root)
            const dir = typeof body?.dir === 'string' ? body.dir : ''
            const target = resolveWithin(rootResolved, dir === '' ? undefined : dir)
            if (target === null) return json(res, 400, { ok: false, message: '目录越界:dir 必须落在工作区内' })
            const dirents = await readdir(target, { withFileTypes: true })
            const NOISE = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.worktree'])
            const visible = dirents.filter((d) => !NOISE.has(d.name))
            const truncated = visible.length > 500
            const slice = truncated ? visible.slice(0, 500) : visible
            const entries: FsEntry[] = await Promise.all(
              slice.map(async (d): Promise<FsEntry> => {
                const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file'
                // 链接不 stat 目标(防环);普通文件并发 stat 取大小/修改时间,失败忽略
                if (type !== 'file') return { name: d.name, type }
                try {
                  const st = await lstat(join(target, d.name))
                  return { name: d.name, type, size: st.size, mtime: st.mtimeMs }
                } catch {
                  return { name: d.name, type }
                }
              }),
            )
            entries.sort((a, b) => {
              if (a.type === 'dir' && b.type !== 'dir') return -1
              if (a.type !== 'dir' && b.type === 'dir') return 1
              return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
            })
            json(res, 200, { ok: true, entries, truncated })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: fs-list route',
  )

  // git-overview 与 git-status 同源:`git status -b --porcelain=v1` 一次拿全
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/git-overview',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          if (cwd === '') return json(res, 400, { ok: false, message: '缺少 cwd' })
          try {
            const repo = await assertKnown(cwd)
            const out = await runGit(repo, ['status', '-b', '--porcelain=v1'])
            const { overview } = parseStatusPorcelain(out)
            json(res, 200, { ok: true, isRepo: true, ...overview })
          } catch (error) {
            // 非 git 仓/路径无效:isRepo=false 属合法状态,不算服务端错误
            json(res, 200, { ok: true, isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, detached: false })
          }
        },
      }),
    'dsh-coding-workspace: git-overview route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/git-status',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          if (cwd === '') return json(res, 400, { ok: false, message: '缺少 cwd' })
          try {
            const repo = await assertKnown(cwd)
            const out = await runGit(repo, ['status', '-b', '--porcelain=v1'])
            json(res, 200, { ok: true, ...parseStatusPorcelain(out) })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: git-status route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/git-log',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          const mode = body?.mode === 'all' ? 'all' : 'head'
          const skip = clampInt(body?.skip, 0, 100_000, 0)
          const limit = clampInt(body?.limit, 1, 100, 50)
          // 分支查看模式:branch 给定时直接 log 该 ref(白名单校验,防 rev 语法扩展)
          const branch = typeof body?.branch === 'string' ? body.branch.trim() : ''
          if (cwd === '') return json(res, 400, { ok: false, message: '缺少 cwd' })
          if (branch !== '' && !isSafeRef(branch)) return json(res, 400, { ok: false, message: '非法分支名' })
          try {
            const repo = await assertKnown(cwd)
            const out = await runGit(repo, [
              'log',
              '--date-order',
              '--date=relative',
              ...(branch !== '' ? [branch] : mode === 'all' ? ['--all'] : []),
              `--skip=${skip}`,
              `-n`,
              String(limit),
              // 末段 %P = 完整 parent hash(空格分隔;小写 %p 是缩写,匹配不上 %H,
              // 会退化成每 commit 开新 lane 的梯形图):前端 buildGraphLayout 自建 lane
              // 拓扑(IDEA 风格),不再用 --graph ASCII(半步字符模型,几何天生断裂)
              '--pretty=format:%x00%H%x1f%h%x1f%an%x1f%ar\x1f%s\x1f%d\x1f%P',
            ])
            const commits: LogCommit[] = parseLogGraph(out)
            // 分支查看模式的高亮数据:该分支「当前分支没有」的 commit(独有集)。
            // 渲染时不在独有集里的行 = 当前分支已有 → 高亮(IDEA 同款粗略 diff)。
            let exclusives: string[] = []
            if (branch !== '') {
              const head = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
                .then((s) => s.trim())
                .catch(() => '')
              if (head !== '' && head !== branch) {
                exclusives = parseHashList(
                  await runGit(repo, ['log', branch, '--not', 'HEAD', '--pretty=format:%H']).catch(() => ''),
                )
              }
            }
            json(res, 200, { ok: true, commits, exclusives })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: git-log route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/git-show',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          const hash = typeof body?.hash === 'string' ? body.hash : ''
          if (cwd === '' || hash === '') return json(res, 400, { ok: false, message: '缺少 cwd 或 hash' })
          if (!isValidHash(hash)) return json(res, 400, { ok: false, message: 'hash 格式非法' })
          try {
            const repo = await assertKnown(cwd)
            const metaOut = await runGit(repo, [
              'show',
              '--no-patch',
              '--date=iso',
              '--pretty=format:%x00%H%x1f%an\x1f%ad\x1f%B',
              hash,
            ])
            const nul = metaOut.indexOf('\0')
            const fields = nul === -1 ? [] : metaOut.slice(nul + 1).split('\x1f')
            const filesOut = await runGit(repo, ['show', '--name-status', '--format=', hash])
            const files: ChangedFile[] = parseNameStatus(filesOut)
            json(res, 200, {
              ok: true,
              hash: fields[0] ?? hash,
              author: fields[1] ?? '',
              date: fields[2] ?? '',
              message: (fields[3] ?? '').replace(/\n+$/, ''),
              files,
            })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: git-show route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/git-action',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          const action = typeof body?.action === 'string' ? body.action : ''
          if (cwd === '' || action === '') return json(res, 400, { ok: false, message: '缺少 cwd 或 action' })
          try {
            const repo = await assertKnown(cwd)
            const output = await runAction(repo, body, action)
            json(res, 200, { ok: true, output })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: git-action route',
  )

  // Changelist 分组(git 无此概念,插件 sidecar JSON 持久化,per-cwd 归一 key)
  const changelistStore = createFileChangelistStore(defaultDshHome())
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/git-changelist',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          const action = typeof body?.action === 'string' ? body.action : ''
          if (cwd === '' || action === '') return json(res, 400, { ok: false, message: '缺少 cwd 或 action' })
          try {
            const repo = await assertKnown(cwd)
            const key = changelistKey(repo)
            let state = await changelistStore.readRepo(key)
            switch (action) {
              case 'list':
                break
              case 'create': {
                const name = typeof body?.name === 'string' ? body.name : ''
                const next = createList(state, name)
                if (next === state) throw new Error('分组名为空或已存在')
                state = next
                await changelistStore.writeRepo(key, state)
                break
              }
              case 'delete': {
                const name = typeof body?.name === 'string' ? body.name : ''
                state = deleteList(state, name)
                await changelistStore.writeRepo(key, state)
                break
              }
              case 'move': {
                // 单文件(file)或批量(files,拖拽多选);逐个移动保持单归属
                const raw = Array.isArray(body?.files) ? (body.files as unknown[]) : [body?.file]
                const files = raw.filter((p): p is string => typeof p === 'string' && p !== '' && isSafeRepoPath(p))
                if (files.length === 0) throw new Error('文件路径非法')
                const to = typeof body?.to === 'string' && body.to !== '' ? body.to : null
                for (const file of files) state = moveFile(state, file, to)
                await changelistStore.writeRepo(key, state)
                break
              }
              default:
                throw new Error(`未知操作:${action}`)
            }
            json(res, 200, { ok: true, lists: state.lists })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: git-changelist route',
  )
}

/** 写操作白名单:六种,参数逐项校验后拼 git 数组(execFile 无 shell,天然无注入)。 */
async function runAction(repo: string, body: any, action: string): Promise<string> {
  switch (action) {
    case 'stage': {
      const path = requireString(body?.path)
      if (!isSafeRepoPath(path)) throw new Error('文件路径非法')
      return runGit(repo, ['add', '--', path])
    }
    case 'unstage': {
      const path = requireString(body?.path)
      if (!isSafeRepoPath(path)) throw new Error('文件路径非法')
      return runGit(repo, ['restore', '--staged', '--', path])
    }
    case 'commit': {
      const message = typeof body?.message === 'string' ? body.message.trim() : ''
      if (message === '') throw new Error('提交信息不能为空')
      // 部分提交(Changes 页勾选):paths 给定时走 git 原生 partial commit——
      // `commit -- <paths>` 只取所选路径的工作区/暂存态,其余 staged 内容保留不进提交。
      // untracked 不在 pathspec 范围,必须先 add(幂等,对已暂存文件无副作用)。
      const paths = Array.isArray(body?.paths)
        ? (body.paths as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '' && isSafeRepoPath(p))
        : []
      if (paths.length === 0) return runGit(repo, ['commit', '-m', message])
      if (paths.length > 500) throw new Error('所选文件过多(上限 500)')
      await runGit(repo, ['add', '--', ...paths])
      return runGit(repo, ['commit', '-m', message, '--', ...paths])
    }
    case 'fetch':
      return runGit(repo, ['fetch', '--prune'])
    case 'pull':
      // 仅 fast-forward:冲突/分叉如实报错,不进 merge 泥潭
      return runGit(repo, ['pull', '--ff-only'])
    case 'push': {
      // 无 upstream 时自动 -u origin <branch>;有 upstream 直接 push
      const head = parseStatusPorcelain(await runGit(repo, ['status', '-b', '--porcelain=v1'])).overview
      if (head.upstream === null && head.branch !== null && !head.detached) {
        return runGit(repo, ['push', '-u', 'origin', head.branch])
      }
      return runGit(repo, ['push'])
    }
    default:
      throw new Error(`未知操作:${action}`)
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('参数缺失:需要非空字符串')
  return value
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, n))
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
