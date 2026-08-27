import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileLineageStore,
  createMemoryLineageStore,
  getOrInferEdge,
  inferLineage,
  lineageKey,
  parseGitdirFile,
} from '../lib/lineage.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-lineage-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('parseGitdirFile: POSIX 布局', () => {
  assert.equal(parseGitdirFile('gitdir: /repo/main/.git/worktrees/feature-x'), '/repo/main')
})

test('parseGitdirFile: Windows 反斜杠归一为 POSIX', () => {
  assert.equal(
    parseGitdirFile('gitdir: C:\\repo\\main\\.git\\worktrees\\feature-x'),
    'C:/repo/main',
  )
})

test('parseGitdirFile: 容忍 \\r\\n 行尾与尾随空白', () => {
  assert.equal(parseGitdirFile('gitdir: /r/m/.git/worktrees/a\r\n'), '/r/m')
})

test('parseGitdirFile: 非 gitdir 内容不可判定(undefined)', () => {
  assert.equal(parseGitdirFile('hello world'), undefined)
  assert.equal(parseGitdirFile(''), undefined)
})

async function writeDotGit(root, content) {
  if (content === null) {
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
  } else {
    await writeFile(join(root, '.git'), content)
  }
}

test('inferLineage: 主仓(.git 是目录)→ parentPath=null', async () => {
  await withTempDir(async (dir) => {
    await writeDotGit(dir, null)
    const edge = await inferLineage(dir, 'main')
    assert.equal(edge.parentPath, null)
    assert.equal(edge.origin, 'inferred')
    assert.equal(edge.branch, 'main')
  })
})

test('inferLineage: worktree(.git 是文件)→ 反推主仓', async () => {
  await withTempDir(async (dir) => {
    const parent = join(dir, 'main-repo').replace(/\\/g, '/')
    await writeDotGit(dir, `gitdir: ${parent}/.git/worktrees/my-task\n`)
    const edge = await inferLineage(dir, 'my-task')
    assert.equal(edge.parentPath, parent)
    assert.equal(edge.branch, 'my-task')
  })
})

test('inferLineage: 无 .git → undefined', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await inferLineage(dir), undefined)
  })
})

test('createFileLineageStore: 写读往返 + key 正斜杠化', async () => {
  await withTempDir(async (home) => {
    const store = createFileLineageStore(home)
    const edge = { parentPath: '/p', branch: 'b', origin: 'plugin', createdAt: 1 }
    await store.writeEdge(lineageKey('C:\\repos\\wt'), edge)
    const all = await store.readAll()
    assert.deepEqual(all['C:/repos/wt'], edge)
    // 新 store 实例重开同一文件,验证持久化
    const reopened = await createFileLineageStore(home).readAll()
    assert.deepEqual(reopened['C:/repos/wt'], edge)
  })
})

test('createFileLineageStore: 损坏或版本不符按空表处理', async () => {
  await withTempDir(async (home) => {
    await writeFile(join(home, 'worktree-lineage.json'), '{ not json !!!')
    assert.deepEqual(await createFileLineageStore(home).readAll(), {})
    await writeFile(
      join(home, 'worktree-lineage.json'),
      JSON.stringify({ version: 999, edges: { x: {} } }),
    )
    assert.deepEqual(await createFileLineageStore(home).readAll(), {})
  })
})

test('getOrInferEdge: 表命中直接返回且不再探测磁盘', async () => {
  const store = createMemoryLineageStore({
    'C:/w': { parentPath: '/known', branch: 'x', origin: 'plugin', createdAt: 5 },
  })
  const edge = await getOrInferEdge(store, 'C:\\w', 'ignored')
  assert.equal(edge.parentPath, '/known')
})

test('getOrInferEdge: 未命中走推断并回写 inferred 边', async () => {
  await withTempDir(async (parentDir) => {
    const parent = join(parentDir, 'main').replace(/\\/g, '/')
    const wt = join(parentDir, 'wt')
    await mkdir(wt)
    await writeFile(join(wt, '.git'), `gitdir: ${parent}/.git/worktrees/t1\n`)
    const store = createMemoryLineageStore()
    const edge = await getOrInferEdge(store, wt, 't1')
    assert.equal(edge.parentPath, parent)
    // 回写生效:第二次直接命中
    const all = await store.readAll()
    assert.equal(all[lineageKey(wt)].origin, 'inferred')
  })
})
