/**
 * git log 拓扑图布局纯函数测试(IDEA 风格渲染的数据层):
 *
 * - parseLogGraph 新协议:pretty 末段 %p(parents,空格分隔)→ commits[].parents
 * - buildGraphLayout:lane 分配 + 边集 + 颜色生命周期
 *   (线性单 lane / 分叉并入 / merge 双 parent / lane 复用 / 截断收尾行)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraphLayout, parseLogGraph } from '../lib/panel-git.js'

// ------------------------------------------------------- parseLogGraph ----

test('parseLogGraph:%p parents 末段解析(单/双/无)', () => {
  const out = [
    '\0h1\x1fa1b2c3d\x1f张三\x1f3 hours ago\x1fmerge: 合并\x1f (HEAD -> main)\x1fp1 p2',
    '\0p1\x1f9f8e7d6\x1f李四\x1fyesterday\x1ffeat: 功能\x1f (origin/dev, dev)\x1fp3',
    '\0p3\x1f4d5c6b7\x1f张三\x1f2 days ago\x1finit\x1f\x1f',
  ].join('\r\n')
  const commits = parseLogGraph(out)
  assert.equal(commits.length, 3)
  assert.deepEqual(commits[0].parents, ['p1', 'p2'])
  assert.deepEqual(commits[1].parents, ['p3'])
  assert.deepEqual(commits[2].parents, [])
  // 旧字段不受影响
  assert.equal(commits[0].refs[0].name, 'main')
  assert.equal(commits[1].refs[0].kind, 'remote')
  assert.equal(commits[2].subject, 'init')
})

// ---------------------------------------------------- buildGraphLayout ----

test('buildGraphLayout:线性提交单 lane 直线', () => {
  const layout = buildGraphLayout([
    { hash: 'a', parents: ['b'] },
    { hash: 'b', parents: ['c'] },
    { hash: 'c', parents: [] },
  ])
  assert.equal(layout.laneCount, 1)
  assert.deepEqual(
    layout.rows.map((r) => ({ lane: r.lane, color: r.color })),
    [
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
    ],
  )
  // 前两行边:lane0 直行;末行 root 已释放,无尾行
  assert.deepEqual(layout.rows[0].edges, [{ from: 0, to: 0, color: 0 }])
  assert.deepEqual(layout.rows[1].edges, [{ from: 0, to: 0, color: 0 }])
  assert.deepEqual(layout.rows[2].edges, [])
  assert.equal(layout.rows.length, 3)
})

test('buildGraphLayout:分叉并入,merge 弧线与 lane 颜色生命周期', () => {
  // 拓扑:A = merge(B, C);B、C 都汇入 D
  const layout = buildGraphLayout([
    { hash: 'A', parents: ['B', 'C'] },
    { hash: 'B', parents: ['D'] },
    { hash: 'C', parents: ['D'] },
    { hash: 'D', parents: [] },
  ])
  assert.equal(layout.laneCount, 2)
  // 行 0:A 占 lane0,first parent B 继承 lane0(直线),C 开新 lane1(弧线,源色)
  assert.equal(layout.rows[0].lane, 0)
  assert.deepEqual(layout.rows[0].edges, [
    { from: 0, to: 0, color: 0 },
    { from: 0, to: 1, color: 0 },
  ])
  // 行 1:B 在 lane0,lane1 穿行;D 继承 lane0
  assert.equal(layout.rows[1].lane, 0)
  assert.deepEqual(layout.rows[1].edges, [
    { from: 0, to: 0, color: 0 },
    { from: 1, to: 1, color: 1 },
  ])
  // 行 2:C 在 lane1,并入已存在的 lane0(D),弧线用源色;lane1 释放
  assert.equal(layout.rows[2].lane, 1)
  assert.deepEqual(layout.rows[2].edges, [
    { from: 0, to: 0, color: 0 },
    { from: 1, to: 0, color: 1 },
  ])
  // 行 3:D 占 lane0,root 释放,无尾行
  assert.equal(layout.rows[3].lane, 0)
  assert.deepEqual(layout.rows[3].edges, [])
  assert.equal(layout.rows.length, 4)
})

test('buildGraphLayout:merge 双 parent 各开新 lane', () => {
  const layout = buildGraphLayout([{ hash: 'A', parents: ['X', 'B'] }, { hash: 'B', parents: [] }, { hash: 'X', parents: [] }])
  assert.equal(layout.laneCount, 2)
  // A 在 lane0;X 继承 lane0,B 开 lane1
  assert.deepEqual(layout.rows[0].edges, [
    { from: 0, to: 0, color: 0 },
    { from: 0, to: 1, color: 0 },
  ])
  assert.equal(layout.rows[1].lane, 1)
  assert.equal(layout.rows[2].lane, 0)
})

test('buildGraphLayout:释放后的 lane 槽位可复用', () => {
  const layout = buildGraphLayout([
    { hash: 'a', parents: ['b'] },
    { hash: 'b', parents: [] },
    { hash: 'c', parents: [] },
  ])
  // c 无匹配 lane,复用已释放的 lane0,新颜色
  assert.equal(layout.rows[2].lane, 0)
  assert.equal(layout.rows[2].color, 1)
  assert.equal(layout.laneCount, 1)
})

test('buildGraphLayout:列表截断时尾部补收尾行延续 active lane', () => {
  const layout = buildGraphLayout([
    { hash: 'a', parents: ['b'] },
    { hash: 'b', parents: ['c'] }, // c 不在列表(limit 截断)
  ])
  // 尾行:无 commit 点,仅延续 lane0
  const tail = layout.rows[layout.rows.length - 1]
  assert.equal(tail.lane, null)
  assert.deepEqual(tail.edges, [{ from: 0, to: 0, color: 0 }])
})

test('buildGraphLayout:空列表', () => {
  assert.deepEqual(buildGraphLayout([]), { laneCount: 1, rows: [] })
})

test('端到端:真实仓 %P 完整 parents 与 %H 互相匹配(防 %p 缩写回归)', async () => {
  const { execFile } = await import('node:child_process')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const run = (cmd, args, cwd) => new Promise((resolve, reject) => execFile(cmd, args, { cwd }, (e, o) => (e ? reject(e) : resolve(o))))
  const repo = await mkdtemp(join(tmpdir(), 'dshw-graph-'))
  try {
    await run('git', ['init', '-b', 'main'], repo)
    await run('git', ['config', 'user.email', 't@t'], repo)
    await run('git', ['config', 'user.name', 't'], repo)
    const fsp = await import('node:fs/promises')
    await fsp.writeFile(join(repo, 'a.txt'), '1')
    await run('git', ['add', '.'], repo)
    await run('git', ['commit', '-m', 'base'], repo)
    await run('git', ['branch', 'dev'], repo)
    await fsp.writeFile(join(repo, 'b.txt'), '2')
    await run('git', ['add', '.'], repo)
    await run('git', ['commit', '-m', 'side'], repo)
    await run('git', ['switch', 'dev'], repo)
    await fsp.writeFile(join(repo, 'c.txt'), '3')
    await run('git', ['add', '.'], repo)
    await run('git', ['commit', '-m', 'dev1'], repo)
    await run('git', ['switch', 'main'], repo)
    await run('git', ['merge', '--no-ff', 'dev', '-m', 'merge'], repo)

    const out = await run('git', ['log', '--date-order', '--all', '-n', '10', '--pretty=format:%x00%H%x1f%h%x1f%an%x1f%ar\x1f%s\x1f%d\x1f%P'], repo)
    const commits = parseLogGraph(out)
    const byHash = new Map(commits.map((c) => [c.hash, c]))
    // 每个 parent 都必须能在 commits 里按完整 hash 找到(%p 缩写会导致找不到 → 梯形图回归)
    for (const c of commits) {
      for (const p of c.parents) {
        assert.ok(byHash.has(p), `parent ${p} 不在 commit 集合内(疑似缩写 hash)`)
      }
    }
    const merge = commits.find((c) => c.subject === 'merge')
    assert.equal(merge.parents.length, 2)
    const layout = buildGraphLayout(commits)
    assert.equal(layout.laneCount, 2)
    assert.ok(layout.rows.every((r) => r.lane !== null))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
