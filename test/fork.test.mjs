import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performFork } from '../lib/fork-core.js'
import { createMemoryLineageStore, lineageKey, parseGitdirFile } from '../lib/lineage.js'
import { runGit } from '../lib/git.js'

const MEM_EDGE_ARGS = (branch, path, extra = []) => ['worktree', 'add', '-b', branch, path, ...extra]

function makeDeps(overrides = {}) {
  const calls = { gitArgs: [], registered: [] }
  return {
    calls,
    deps: {
      async addWorktree(_source, gitArgs) {
        calls.gitArgs.push(gitArgs)
      },
      async registerWorkspace(path, title) {
        calls.registered.push({ path, title })
      },
      store: createMemoryLineageStore(),
      ...overrides,
    },
  }
}

test('performFork: 快乐路径,默认兄弟目录 + 双边血缘', async () => {
  const { deps, calls } = makeDeps()
  const out = await performFork(deps, {
    sourceRepoPath: 'C:/repos/main-proj',
    name: 'task-42',
  })

  assert.equal(out.worktreePath, 'C:/repos/task-42')
  assert.equal(out.branch, 'task-42')
  assert.equal(out.workspaceRegistered, true)
  assert.equal(out.lineageRecorded, true)
  assert.deepEqual(calls.gitArgs[0], MEM_EDGE_ARGS('task-42', 'C:/repos/task-42'))
  assert.deepEqual(calls.registered[0], { path: 'C:/repos/task-42', title: 'task-42' })

  const edges = await deps.store.readAll()
  assert.equal(edges[lineageKey('C:/repos/main-proj')].parentPath, null)
  assert.equal(edges[lineageKey('C:/repos/task-42')].parentPath, 'C:/repos/main-proj')
  assert.equal(edges[lineageKey('C:/repos/task-42')].origin, 'plugin')
})

test('performFork: registry 抛错不拆除 worktree,结果含 registryError', async () => {
  const { deps, calls } = makeDeps({
    async registerWorkspace() {
      throw new Error('registry down')
    },
  })
  const out = await performFork(deps, { sourceRepoPath: '/r/main', name: 'b1' })

  assert.equal(calls.gitArgs.length, 1) // worktree 已建
  assert.equal(out.workspaceRegistered, false)
  assert.match(out.registryError, /registry down/)
  assert.equal(out.lineageRecorded, true)
})

test('performFork: 无 registry 服务时半成功且可读', async () => {
  const { deps } = makeDeps({ registerWorkspace: undefined })
  const out = await performFork(deps, { sourceRepoPath: '/r/main', name: 'b2' })
  assert.equal(out.workspaceRegistered, false)
  assert.equal(out.registryError, undefined)
  assert.equal(out.worktreePath, '/r/b2')
})

test('performFork: baseRef 组装进 git 参数', async () => {
  const { deps, calls } = makeDeps()
  await performFork(deps, { sourceRepoPath: '/r/m', name: 'x', baseRef: 'v1.0' })
  assert.deepEqual(calls.gitArgs[0], MEM_EDGE_ARGS('x', '/r/x', ['v1.0']))
})

test('project_fork 端到端(真实 git):fixture 主仓 fork 出的 worktree 可由 gitdir 反推主仓', async () => {
  await withTemp(async (dir) => {
    const main = join(dir, 'main-repo')
    const c = ['-c', 'user.email=t@t.local', '-c', 'user.name=t']
    await mkdir(main, { recursive: true }) // runGit 以此为 cwd,cwd 必须先存在
    await runGit(main, ['init', '-q'])
    await writeFile(join(main, 'a.txt'), 'hello')
    await runGit(main, [...c, 'add', '.'])
    await runGit(main, [...c, 'commit', '-q', '-m', 'init'])

    // 真链路 fork:runGit 真执行 worktree add
    const wt = join(dir, 'wt-fork').replace(/\\/g, '/')
    await runGit(main, ['worktree', 'add', '-q', '-b', 'feat-x', wt])

    const dotGit = await readFile(join(wt, '.git'), 'utf8')
    assert.equal(parseGitdirFile(dotGit).replace(/\\/g, '/'), main.replace(/\\/g, '/'))

    // 收尾清理,零残留
    await runGit(main, ['worktree', 'remove', wt])
  })
})

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-fork-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
