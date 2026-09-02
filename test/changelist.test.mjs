/**
 * Changes 页面 Changelist 分组与部分提交测试:
 *
 * - changelist 纯函数:建组/删组(文件回落默认)/移动文件(跨组去重)
 * - 文件存储读写(原子 JSON,损坏按空处理)
 * - 部分提交 git 语义:commit -- paths 只取所选路径,其余 staged 保留(真实仓锁行为)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  changelistKey,
  createFileChangelistStore,
  createList,
  deleteList,
  moveFile,
} from '../lib/changelist.js'

// -------------------------------------------------------- 纯函数 ----

test('createList:新建分组,重名拒绝', () => {
  let s = { lists: [] }
  s = createList(s, 'UI 改动')
  s = createList(s, '后端')
  assert.deepEqual(s.lists.map((l) => l.name), ['UI 改动', '后端'])
  const again = createList(s, 'UI 改动')
  assert.equal(again, s) // 重名返回原状态(引用相等 = 未变更)
})

test('moveFile:文件跨组去重,移到 null 回默认', () => {
  let s = createList({ lists: [] }, 'A')
  s = createList(s, 'B')
  s = moveFile(s, 'src/a.ts', 'A')
  assert.deepEqual(s.lists.find((l) => l.name === 'A').files, ['src/a.ts'])
  // 移到 B:A 里消失(文件只属于一个组)
  s = moveFile(s, 'src/a.ts', 'B')
  assert.deepEqual(s.lists.find((l) => l.name === 'A').files, [])
  assert.deepEqual(s.lists.find((l) => l.name === 'B').files, ['src/a.ts'])
  // 移回默认:从所有组消失
  s = moveFile(s, 'src/a.ts', null)
  assert.deepEqual(s.lists.find((l) => l.name === 'B').files, [])
})

test('deleteList:删组后文件回默认(不丢归属记录之外的文件)', () => {
  let s = createList({ lists: [] }, 'A')
  s = moveFile(s, 'a.ts', 'A')
  s = deleteList(s, 'A')
  assert.deepEqual(s.lists, [])
})

// -------------------------------------------------------- 存储 ----

test('文件存储:读写往返,损坏文件按空状态处理', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshw-cl-'))
  try {
    const store = createFileChangelistStore(home)
    assert.deepEqual(await store.readRepo('C:/repo'), { lists: [] })
    await store.writeRepo('C:/repo', createList(moveFile(createList({ lists: [] }, 'X'), 'a.ts', 'X'), 'Y'))
    const state = await store.readRepo('C:/repo')
    assert.deepEqual(state.lists.map((l) => l.name), ['X', 'Y'])
    assert.deepEqual(state.lists.find((l) => l.name === 'X').files, ['a.ts'])

    // 损坏:另一个 repo 读不到垃圾
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(join(home, 'coding-workspace-changelists.json'), '{broken', 'utf8')
    const store2 = createFileChangelistStore(home)
    assert.deepEqual(await store2.readRepo('C:/other'), { lists: [] })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('changelistKey:反斜杠归一为正斜杠', () => {
  assert.equal(changelistKey('C:\\repo\\sub'), 'C:/repo/sub')
})

// ------------------------------------------------- 部分提交语义 ----

test('部分提交:commit -- paths 只取所选,其余 staged 保留(真实仓)', async () => {
  const run = (args, cwd) =>
    new Promise((resolve, reject) => execFile('git', args, { cwd }, (e, o) => (e ? reject(new Error(String(e))) : resolve(o))))
  const repo = await mkdtemp(join(tmpdir(), 'dshw-partial-'))
  try {
    await run(['init', '-b', 'main'], repo)
    await run(['config', 'user.email', 't@t'], repo)
    await run(['config', 'user.name', 't'], repo)
    await writeFile(join(repo, 'f1.txt'), 'base1')
    await writeFile(join(repo, 'f2.txt'), 'base2')
    await run(['add', '.'], repo)
    await run(['commit', '-m', 'base'], repo)

    // f1:仅工作区修改;f2:已暂存;f3:untracked
    await writeFile(join(repo, 'f1.txt'), 'work1')
    await writeFile(join(repo, 'f2.txt'), 'staged2')
    await run(['add', 'f2.txt'], repo)
    await writeFile(join(repo, 'f2.txt'), 'work2')
    await writeFile(join(repo, 'f3.txt'), 'new3')

    // untracked 必须先 add 才能进 partial commit
    await run(['add', 'f3.txt'], repo)
    await run(['commit', '-m', 'partial: f1+f3', '--', 'f1.txt', 'f3.txt'], repo)

    const headF1 = (await run(['show', 'HEAD:f1.txt'], repo)).trim()
    const headF2 = (await run(['show', 'HEAD:f2.txt'], repo)).trim()
    const headF3 = (await run(['show', 'HEAD:f3.txt'], repo)).trim()
    assert.equal(headF1, 'work1') // 工作区态进提交
    assert.equal(headF2, 'base2') // 未选的 f2 不进(哪怕它有 staged 改动)
    assert.equal(headF3, 'new3')
    // f2 的 staged 改动保留
    const staged = await run(['diff', '--cached', '--name-only'], repo)
    assert.deepEqual(staged.trim().split(/\r?\n/), ['f2.txt'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
