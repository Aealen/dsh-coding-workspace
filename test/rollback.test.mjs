/**
 * rollback 命令组合回归:panel-routes runAction('rollback') 的 git 语义直测。
 * HEAD 有文件 → checkout HEAD -- path 覆盖 index+工作区;
 * HEAD 无文件(新增/未跟踪)→ cat-file -e 探测失败 → 清 index + 删工作区文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 建临时 git 仓并落一个基线提交。 */
async function initRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-rollback-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  await writeFile(join(dir, 'a.txt'), 'base')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  return dir
}

test('rollback:已跟踪文件修改后 checkout HEAD 还原内容', async () => {
  const dir = await initRepo()
  try {
    await writeFile(join(dir, 'a.txt'), 'dirty')
    // 探测 HEAD 存在(panel-routes 同款命令拼法)
    execFileSync('git', ['cat-file', '-e', 'HEAD:a.txt'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'HEAD', '--', 'a.txt'], { cwd: dir, stdio: 'ignore' })
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'base')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollback:未跟踪文件走删除分支(cat-file -e 失败)', async () => {
  const dir = await initRepo()
  try {
    await writeFile(join(dir, 'b.txt'), 'new')
    const inHead = await new Promise((resolveP) => {
      try {
        execFileSync('git', ['cat-file', '-e', 'HEAD:b.txt'], { cwd: dir, stdio: 'ignore' })
        resolveP(true)
      } catch {
        resolveP(false)
      }
    })
    assert.equal(inHead, false)
    // HEAD 无 → rm --cached 对 untracked 会失败(路由里 catch 忽略)+ fs 删除
    try {
      execFileSync('git', ['rm', '-f', '--cached', '--', 'b.txt'], { cwd: dir, stdio: 'ignore' })
    } catch {}
    await rm(join(dir, 'b.txt'), { force: true })
    await assert.rejects(access(join(dir, 'b.txt')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
