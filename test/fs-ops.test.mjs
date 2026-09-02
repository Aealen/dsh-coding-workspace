/**
 * fs-ops 单测:资源管理器写操作的纯函数校验 + 临时目录 fs 动作实测。
 * 覆盖:重命名新名白名单(Windows 保留名/非法字符)、绝对路径拼接、
 * 同目录重命名与查重、递归删除、删除不存在项静默。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { validateNewName, joinAbs, renameEntry, deleteEntry } from '../lib/fs-ops.js'

test('validateNewName:合法名原样通过', () => {
  assert.equal(validateNewName('a.txt'), 'a.txt')
  assert.equal(validateNewName('新建 文件夹'), '新建 文件夹')
  assert.equal(validateNewName('.gitignore'), '.gitignore')
  assert.equal(validateNewName('v1.2.3'), 'v1.2.3')
})

test('validateNewName:空/越界段/特殊字符拒绝', () => {
  for (const bad of ['', '   ', 'a/b', 'a\\b', '.', '..', 'a:b', 'a*b', 'a?b', '"q"', 'a<b>', 'a|b', ' a', 'a ', 'a\x01b']) {
    assert.equal(validateNewName(bad), null, `应拒绝:${JSON.stringify(bad)}`)
  }
})

test('validateNewName:Windows 保留名拒绝(含带扩展名形式)', () => {
  for (const bad of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt4', 'CON.txt', 'nul.md']) {
    assert.equal(validateNewName(bad), null, `应拒绝:${bad}`)
  }
})

test('joinAbs:root + POSIX 相对路径按平台拼接', () => {
  const root = sep === '\\' ? 'C:\\work\\repo' : '/work/repo'
  const out = joinAbs(root, 'src/lib/a.ts')
  if (sep === '\\') assert.equal(out, 'C:\\work\\repo\\src\\lib\\a.ts')
  else assert.equal(out, '/work/repo/src/lib/a.ts')
  // 空段防御:双斜杠不产生空段
  const out2 = joinAbs(root, 'src//b.ts')
  assert.ok(!out2.includes(sep + sep), `不应出现连续分隔符:${out2}`)
})

test('renameEntry:同目录重命名成功,旧路径消失', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-fsops-'))
  try {
    await writeFile(join(dir, 'old.txt'), 'x')
    await renameEntry(dir, 'old.txt', 'new.txt')
    await assert.rejects(access(join(dir, 'old.txt')))
    await access(join(dir, 'new.txt'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renameEntry:目标已存在抛错且原文件未动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-fsops-'))
  try {
    await writeFile(join(dir, 'a.txt'), 'A')
    await writeFile(join(dir, 'b.txt'), 'B')
    await assert.rejects(renameEntry(dir, 'a.txt', 'b.txt'))
    assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'a.txt'), 'utf8'), 'A')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteEntry:文件与目录树删除;不存在项静默', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-fsops-'))
  try {
    await writeFile(join(dir, 'f.txt'), 'x')
    await mkdir(join(dir, 'sub', 'deep'), { recursive: true })
    await writeFile(join(dir, 'sub', 'deep', 'g.txt'), 'y')
    await deleteEntry(join(dir, 'f.txt'), false)
    await deleteEntry(join(dir, 'sub'), true)
    await assert.rejects(access(join(dir, 'f.txt')))
    await assert.rejects(access(join(dir, 'sub')))
    // force:重复删除不抛
    await deleteEntry(join(dir, 'f.txt'), false)
    await deleteEntry(join(dir, 'sub'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
