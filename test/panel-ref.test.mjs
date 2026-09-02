/**
 * git log 分支查看模式测试:
 *
 * - isSafeRef:查看分支的 ref 名白名单(拒 option 注入与 revision 语法扩展)
 * - parseHashList:exclusives(git log X --not HEAD --pretty=%H)输出解析
 * - 端到端:分叉仓验证 exclusives 恰为「所选分支独有」
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSafeRef, parseHashList } from '../lib/panel-git.js'

test('isSafeRef:合法分支名(中英/斜杠/点/下划线)', () => {
  assert.equal(isSafeRef('main'), true)
  assert.equal(isSafeRef('feature/multi-fileType-support'), true)
  assert.equal(isSafeRef('release'), true)
  assert.equal(isSafeRef('v1.0.2_beta'), true)
  assert.equal(isSafeRef('feature/中文分支'), true)
  assert.equal(isSafeRef('origin/release'), true)
})

test('isSafeRef:拒 option 注入与 revision 语法扩展', () => {
  assert.equal(isSafeRef('-rf'), false)
  assert.equal(isSafeRef('--all'), false)
  assert.equal(isSafeRef('main~3'), false)
  assert.equal(isSafeRef('main^0'), false)
  assert.equal(isSafeRef('main@{yesterday}'), false)
  assert.equal(isSafeRef('a:b'), false)
  assert.equal(isSafeRef('a?b'), false)
  assert.equal(isSafeRef('a*b'), false)
  assert.equal(isSafeRef('a[b]'), false)
  assert.equal(isSafeRef('a b'), false)
  assert.equal(isSafeRef(''), false)
})

test('parseHashList:取 16 进制行,忽略空行与杂讯', () => {
  assert.deepEqual(
    parseHashList('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n\nffeeddccbbaa99887766554433221100ffeeddcc\nnot-a-hash\n'),
    ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', 'ffeeddccbbaa99887766554433221100ffeeddcc'],
  )
  assert.deepEqual(parseHashList(''), [])
})

test('端到端:exclusives = 分叉分支独有 commit(真实仓)', async () => {
  const run = (args, cwd) =>
    new Promise((resolve, reject) => execFile('git', args, { cwd }, (e, o) => (e ? reject(new Error(String(e))) : resolve(o))))
  const repo = await mkdtemp(join(tmpdir(), 'dshw-ref-'))
  try {
    await run(['init', '-b', 'main'], repo)
    await run(['config', 'user.email', 't@t'], repo)
    await run(['config', 'user.name', 't'], repo)
    await writeFile(join(repo, 'a.txt'), '1')
    await run(['add', '.'], repo)
    await run(['commit', '-m', 'base'], repo)
    await run(['branch', 'dev'], repo)
    await writeFile(join(repo, 'b.txt'), '2')
    await run(['add', '.'], repo)
    await run(['commit', '-m', 'main-only'], repo)
    await run(['switch', 'dev'], repo)
    await writeFile(join(repo, 'c.txt'), '3')
    await run(['add', '.'], repo)
    await run(['commit', '-m', 'dev-only-1'], repo)
    await writeFile(join(repo, 'd.txt'), '4')
    await run(['add', '.'], repo)
    await run(['commit', '-m', 'dev-only-2'], repo)

    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim()
    assert.equal(head, 'dev')
    const out = await run(['log', 'main', '--not', 'HEAD', '--pretty=format:%H'], repo)
    const hashes = parseHashList(out)
    assert.equal(hashes.length, 1)
    const subjects = (await run(['log', 'main', '--not', 'HEAD', '--pretty=format:%s'], repo)).trim().split('\n')
    assert.deepEqual(subjects, ['main-only'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
