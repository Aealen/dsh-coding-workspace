import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../lib/git.js'
import {
  isSafeRepoPath,
  isValidHash,
  parseLogGraph,
  parseNameStatus,
  parseRefsField,
  parseStatusHeader,
  parseStatusPorcelain,
  resolveWithin,
} from '../lib/panel-git.js'

function execFileProm(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))
  })
}

/** 建一个真实仓:两次提交 + 一处已暂存/未暂存/未跟踪修改 + 一条分支。 */
async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-panel-'))
  const git = (args) => execFileProm('git', args, dir)
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 'tester'])
  await writeFile(join(dir, 'a.txt'), 'one')
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'sub', 'b.txt'), 'bee')
  await git(['add', '.'])
  await git(['commit', '-m', 'c1'])
  await git(['branch', 'feature/one'])
  await writeFile(join(dir, 'a.txt'), 'one\ntwo')
  await writeFile(join(dir, 'staged.txt'), 'staged')
  await git(['add', 'staged.txt'])
  await writeFile(join(dir, 'untracked.txt'), 'u')
  return dir
}

// ---------------------------------------------------------------- status ---

test('parseStatusHeader:tracking + ahead/behind', () => {
  const h = parseStatusHeader('## feature/login...origin/feature/login [ahead 1, behind 2]')
  assert.equal(h.branch, 'feature/login')
  assert.equal(h.upstream, 'origin/feature/login')
  assert.equal(h.ahead, 1)
  assert.equal(h.behind, 2)
  assert.equal(h.detached, false)
})

test('parseStatusHeader:无 upstream / detached / init 仓', () => {
  assert.deepEqual(
    parseStatusHeader('## main'),
    { branch: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
  )
  const d = parseStatusHeader('## HEAD (no branch)')
  assert.equal(d.detached, true)
  assert.equal(parseStatusHeader('## No commits yet on main').branch, 'main')
  assert.equal(parseStatusHeader(undefined).branch, null)
})

test('parseStatusPorcelain:三组拆分 + rename', () => {
  const out = [
    '## feature/x...origin/feature/x [ahead 2]',
    'M  staged.txt',
    'R  old.txt -> new.txt',
    ' M dirty.txt',
    'MM both.txt',
    '?? untracked.txt',
    '?? 未跟踪 目录/',
    '',
  ].join('\n')
  const r = parseStatusPorcelain(out)
  assert.equal(r.overview.ahead, 2)
  // MM = 已暂存且又有未暂存修改:两边都出现(IDEA 同语义)
  assert.deepEqual(r.staged.map((e) => e.path), ['staged.txt', 'new.txt', 'both.txt'])
  assert.deepEqual(r.unstaged.map((e) => e.path), ['dirty.txt', 'both.txt'])
  assert.deepEqual(r.untracked.map((e) => e.path), ['untracked.txt', '未跟踪 目录/'])
  assert.equal(r.staged[1].x, 'R')
  assert.equal(r.staged[1].from, 'old.txt')
})

test('parseStatusPorcelain:带引号路径与空输出', () => {
  const r = parseStatusPorcelain('## main\nR  "a b.txt" -> "c d.txt"')
  assert.equal(r.staged[0].path, 'c d.txt')
  assert.equal(r.staged[0].from, 'a b.txt')
  assert.equal(parseStatusPorcelain('').staged.length, 0)
})

test('parseStatusPorcelain:真实仓端到端', async () => {
  const repo = await makeRepo()
  try {
    const out = await runGit(repo, ['status', '-b', '--porcelain=v1'])
    const r = parseStatusPorcelain(out)
    assert.equal(r.overview.branch, 'main')
    assert.deepEqual(r.staged.map((e) => e.path), ['staged.txt'])
    assert.deepEqual(r.unstaged.map((e) => e.path), ['a.txt'])
    assert.ok(r.untracked.some((e) => e.path === 'untracked.txt'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- log -----

test('parseLogGraph:新协议逐行 commit(无过渡行)', () => {
  const out = [
    '\0h1\x1fa1b2c3d\x1f张三\x1f3 hours ago\x1ffix: 修复\x1f (HEAD -> main)\x1fh2',
    '\0h2\x1f9f8e7d6\x1f李四\x1fyesterday\x1fmerge: 合并\x1f (origin/dev, dev)\x1fh3',
    '\0h3\x1f4d5c6b7\x1f张三\x1f2 days ago\x1finit\x1f\x1f',
  ].join('\r\n')
  const commits = parseLogGraph(out)
  assert.equal(commits.length, 3)
  assert.deepEqual(commits[0].parents, ['h2'])
  assert.deepEqual(commits[1].parents, ['h3'])
  assert.deepEqual(commits[2].parents, [])
  assert.equal(commits[0].refs[0].kind, 'head')
  assert.equal(commits[0].refs[0].name, 'main')
  assert.deepEqual(commits[1].refs.map((r) => r.name), ['origin/dev', 'dev'])
  assert.equal(commits[1].refs[0].kind, 'remote')
  assert.equal(commits[1].refs[1].kind, 'local')
  assert.equal(commits[2].refs.length, 0)
})

test('parseRefsField:tag 与普通分支', () => {
  const refs = parseRefsField(' (tag: v1.0, origin/main, feature)')
  assert.deepEqual(
    refs.map((r) => [r.kind, r.name]),
    [
      ['tag', 'v1.0'],
      ['remote', 'origin/main'],
      ['local', 'feature'],
    ],
  )
  assert.deepEqual(parseRefsField(''), [])
})

test('parseLogGraph:真实仓端到端(%x00 行协议)', async () => {
  const repo = await makeRepo()
  try {
    const out = await runGit(repo, [
      'log', '--date-order', '--date=relative', '-n', '10',
      '--pretty=format:%x00%H%x1f%h%x1f%an%x1f%ar\x1f%s\x1f%d\x1f%p',
    ])
    const commits = parseLogGraph(out)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].subject, 'c1')
    assert.equal(commits[0].author, 'tester')
    assert.deepEqual(commits[0].parents, [])
    assert.ok(/^[0-9a-f]{40}$/.test(commits[0].hash))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('parseNameStatus:rename 两段与普通行', () => {
  const files = parseNameStatus('M\ta.txt\nR100\told.txt\tnew.txt\nD\tdel.txt\n')
  assert.deepEqual(files, [
    { status: 'M', path: 'a.txt' },
    { status: 'R', from: 'old.txt', path: 'new.txt' },
    { status: 'D', path: 'del.txt' },
  ])
})

// ---------------------------------------------------------------- 安全 -----

test('isValidHash 与 isSafeRepoPath 白名单', () => {
  assert.equal(isValidHash('a1b2c3d'), true)
  assert.equal(isValidHash('A1B2C3D4'.repeat(5)), true)
  assert.equal(isValidHash('abc'), false)
  assert.equal(isValidHash('zzzz'), false)
  assert.equal(isValidHash('..'), false)
  assert.equal(isSafeRepoPath('src/a.ts'), true)
  assert.equal(isSafeRepoPath('-rf'), false)
  assert.equal(isSafeRepoPath('a/../b'), false)
  assert.equal(isSafeRepoPath(''), false)
})

test('resolveWithin:越界拒绝、root 本身合法、大小写不敏感', () => {
  const root = 'C:\\repo'
  assert.equal(resolveWithin(root, 'src'), 'C:\\repo\\src')
  assert.equal(resolveWithin(root, undefined), 'C:\\repo')
  assert.equal(resolveWithin(root, ''), 'C:\\repo')
  assert.equal(resolveWithin(root, '../outside'), null)
  assert.equal(resolveWithin(root, 'src/../../x'), null)
  assert.equal(resolveWithin(root, 'SRC/sub'), 'C:\\repo\\SRC\\sub')
  assert.equal(resolveWithin('c:\\repo', 'src'), 'c:\\repo\\src')
})

// ------------------------------------------------------- git-diff 协议 ---

test('git-diff 协议:HEAD 基准 unidiff / staged / untracked 判定(真实仓)', async () => {
  const repo = await makeRepo()
  try {
    // 未暂存修改:diff HEAD 非空且含新增行
    const dirty = await runGit(repo, ['diff', 'HEAD', '--no-color', '--', 'a.txt'])
    assert.ok(dirty.includes('+two'), 'diff HEAD 应含工作区新增行')

    // 已暂存新文件:HEAD 无此文件,diff 为「全 add」
    const staged = await runGit(repo, ['diff', 'HEAD', '--no-color', '--', 'staged.txt'])
    assert.ok(staged.includes('+staged'), 'diff HEAD 应含 staged 新文件全部内容')

    // untracked:diff HEAD 恒空,porcelain 以 ?? 判定
    const untrackedDiff = await runGit(repo, ['diff', 'HEAD', '--no-color', '--', 'untracked.txt'])
    assert.equal(untrackedDiff, '')
    const status = await runGit(repo, ['status', '--porcelain', '--', 'untracked.txt'])
    assert.ok(status.split('\n').some((line) => line.startsWith('??')), 'porcelain 应标 ??')

    // 干净文件:diff 空且非 untracked
    const cleanDiff = await runGit(repo, ['diff', 'HEAD', '--no-color', '--', 'sub/b.txt'])
    assert.equal(cleanDiff, '')
    const cleanStatus = await runGit(repo, ['status', '--porcelain', '--', 'sub/b.txt'])
    assert.equal(cleanStatus.split('\n').some((line) => line.startsWith('??')), false)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
