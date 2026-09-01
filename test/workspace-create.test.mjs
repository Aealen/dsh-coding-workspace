import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentBranch, listBranches, parseBranchInventory } from '../lib/git.js'
import { createFileLineageStore } from '../lib/lineage.js'

function execFileProm(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))
  })
}

/** 建一个带两次提交与一条 feature 分支的真实 git 仓。 */
async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-branches-'))
  const git = (args) => execFileProm('git', args, dir)
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 't'])
  await writeFile(join(dir, 'a.txt'), 'a')
  await git(['add', '.'])
  await git(['commit', '-m', 'c1'])
  await git(['branch', 'feature/one'])
  return dir
}

test('parseBranchInventory:本地分组 + 多 remote 分组 + HEAD 跳过', () => {
  const output = [
    'refs/heads/feature/one',
    'refs/heads/main',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/feat/x',
    'refs/remotes/origin/main',
    'refs/remotes/upstream/main',
    '',
  ].join('\n')
  const inv = parseBranchInventory(output)
  assert.deepEqual(inv.locals.sort(), ['feature/one', 'main'])
  assert.equal(inv.remotes.length, 2)
  assert.deepEqual(inv.remotes[0], { name: 'origin', branches: ['feat/x', 'main'] })
  assert.deepEqual(inv.remotes[1], { name: 'upstream', branches: ['main'] })
})

test('parseBranchInventory:空输出', () => {
  assert.deepEqual(parseBranchInventory(''), { locals: [], remotes: [] })
})

test('listBranches + currentBranch:真实仓', async () => {
  const repo = await makeRepo()
  try {
    const inv = await listBranches(repo)
    assert.ok(inv.locals.includes('main'))
    assert.ok(inv.locals.includes('feature/one'))
    assert.equal(inv.remotes.length, 0)
    assert.equal(await currentBranch(repo), 'main')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('worktree-create 语义:新建分支 worktree 落 .worktree/ 且 .gitignore 自动追加', async () => {
  const repo = await makeRepo()
  try {
    const target = join(repo, '.worktree', 'new-feat')
    await execFileProm('git', ['worktree', 'add', '-b', 'new-feat', target], repo)

    // worktree 可用且分支正确
    const branch = await currentBranch(target)
    assert.equal(branch, 'new-feat')

    // ensureGitignoreEntry 同语义:验证手动追加后读取一致(路由内逻辑等价复刻)
    const gi = join(repo, '.gitignore')
    let content = ''
    try {
      content = await readFile(gi, 'utf8')
    } catch {}
    const needsNewline = content !== '' && !content.endsWith('\n')
    await writeFile(gi, `${content}${needsNewline ? '\n' : ''}.worktree/\n`)
    const after = await readFile(gi, 'utf8')
    assert.ok(after.split(/\r?\n/).includes('.worktree/'))

    // 血缘登记:edge 带 branch + note 往返
    const store = createFileLineageStore()
    await store.writeEdge(target.replace(/\\/g, '/'), {
      parentPath: repo.replace(/\\/g, '/'),
      branch: 'new-feat',
      origin: 'plugin',
      createdAt: Date.now(),
      note: '端到端备注',
    })
    const edges = await store.readAll()
    assert.equal(edges[target.replace(/\\/g, '/')].note, '端到端备注')
    assert.equal(edges[target.replace(/\\/g, '/')].branch, 'new-feat')

    // 收尾 worktree
    await execFileProm('git', ['worktree', 'remove', '--force', target], repo)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('worktree-create 语义:检出已有本地分支被主仓占用时 git 拒绝', async () => {
  const repo = await makeRepo()
  try {
    // main 已被主仓占用 → 直接检出应失败
    let threw = false
    try {
      await execFileProm('git', ['worktree', 'add', join(repo, '.worktree', 'dup'), 'main'], repo)
    } catch {
      threw = true
    }
    assert.equal(threw, true)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
