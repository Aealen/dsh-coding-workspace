import { readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { runGit } from '../git.js'
import { createFileLineageStore, lineageKey } from '../lineage.js'
import {
  isSafeRepoPath,
  isValidHash,
  parseLogGraph,
  parseNameStatus,
  parseStatusPorcelain,
  resolveWithin,
  type ChangedFile,
  type LogCommit,
} from '../panel-git.js'

const worktreeLineageStore = createFileLineageStore()

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
 * - POST /dsh-worktree/fs-list      {root, dir}   → 目录清单(懒展开,噪音目录已滤)
 * - POST /dsh-worktree/git-overview {cwd}         → 分支/upstream/ahead/behind/isRepo
 * - POST /dsh-worktree/git-status   {cwd}         → staged/unstaged/untracked 三组
 * - POST /dsh-worktree/git-log      {cwd,mode,skip,limit} → graph 行协议 commits
 * - POST /dsh-worktree/git-show     {cwd,hash}    → commit 元信息 + 变更文件
 * - POST /dsh-worktree/git-action   {cwd,action,…}→ 写操作唯一入口(白名单)
 *
 * 安全边界:cwd/root 必须命中已知工作区集合(血缘 edges + workspace registry);
 * fs-list 的 dir resolve 后必须落在 root 内;hash 走格式白名单;
 * 写操作仅 stage/unstage/commit/fetch/pull/push 六种,execFile 数组参数无 shell。
 */
export function registerPanelRoutes(ctx: Context): void {
  /** 已知工作区路径集合(小写归一),作为所有路由的 cwd 准入。 */
  const knownPaths = async (): Promise<Set<string>> => {
    const edges = await worktreeLineageStore.readAll().then((e) => Object.keys(e))
    // 插件侧 workspaceRegistry 类型面只有 create/resolveByPath/delete;运行时对象是
    // 宿主 WorkspaceManager,带同步 list()。运行时探测,缺席(非 web 组合)时为空。
    let registryPaths: string[] = []
    try {
      const manager = ctx.workspaceRegistry as unknown as { list?: () => Iterable<{ path?: unknown }> } | undefined
      registryPaths = [...(manager?.list?.() ?? [])]
        .map((w) => w?.path)
        .filter((p): p is string => typeof p === 'string')
    } catch {
      registryPaths = []
    }
    const set = new Set<string>()
    for (const p of [...edges, ...registryPaths]) {
      set.add(lineageKey(p).toLowerCase())
      // 血缘 key 是 POSIX 化原串;再补一层 resolve 小写,吸收大小写/短路径差异
      set.add(resolve(p).toLowerCase())
    }
    return set
  }

  const assertKnown = async (rawCwd: string): Promise<string> => {
    const resolved = resolve(rawCwd)
    const known = await knownPaths()
    const key = lineageKey(resolved).toLowerCase()
    if (!known.has(key) && !known.has(resolved.toLowerCase())) {
      throw new Error('目标路径不在已知工作区集合内(血缘或注册表均未命中),拒绝访问')
    }
    return resolved
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/fs-list',
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
    'dsh-worktree: fs-list route',
  )

  // git-overview 与 git-status 同源:`git status -b --porcelain=v1` 一次拿全
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/git-overview',
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
    'dsh-worktree: git-overview route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/git-status',
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
    'dsh-worktree: git-status route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/git-log',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          const mode = body?.mode === 'all' ? 'all' : 'head'
          const skip = clampInt(body?.skip, 0, 100_000, 0)
          const limit = clampInt(body?.limit, 1, 100, 50)
          if (cwd === '') return json(res, 400, { ok: false, message: '缺少 cwd' })
          try {
            const repo = await assertKnown(cwd)
            const out = await runGit(repo, [
              'log',
              '--graph',
              '--date-order',
              '--date=relative',
              ...(mode === 'all' ? ['--all'] : []),
              `--skip=${skip}`,
              `-n`,
              String(limit),
              '--pretty=format:%x00%H%x1f%h%x1f%an%x1f%ar\x1f%s\x1f%d',
            ])
            const commits: LogCommit[] = parseLogGraph(out)
            json(res, 200, { ok: true, commits })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-worktree: git-log route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/git-show',
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
    'dsh-worktree: git-show route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-worktree/git-action',
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
    'dsh-worktree: git-action route',
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
      return runGit(repo, ['commit', '-m', message])
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
