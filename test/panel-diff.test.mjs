import test from 'node:test'
import assert from 'node:assert/strict'
import { alignLines, splitLines, MAX_DIFF_ROWS, diffBlocks, pairBlocks } from '../lib/panel-diff.js'

// ----------------------------------------------------------- splitLines ---

test('splitLines:常规拆分,保留末尾空行语义(与 textarea 视觉一致)', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b', ''])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitLines(''), [''])
  assert.deepEqual(splitLines('\n'), ['', ''])
})

test('splitLines:CRLF/CR 归一为 LF(Windows 工作区 vs git blob 行尾差异)', () => {
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b', ''])
  assert.deepEqual(splitLines('a\rb'), ['a', 'b'])
})

test('alignLines:CRLF 左 vs LF 右 → 正常增量对齐(不退化整块替换)', () => {
  // 真机回归:autocrlf 工作区(CRLF)对比 HEAD blob(LF),仅改动的行应出现 del/add
  const left = 'import a\nimport b\nold line\ntail\n'
  const right = 'import a\r\nimport b\r\nnew line 1\r\nnew line 2\r\nold line\r\ntail\r\n'
  const rows = alignLines(left, right)
  const types = rows.map((r) => r.type)
  // 头 2 行 eq,插入 2 行 add,old/tail/尾空行 eq——绝不允许全 del+全 add
  assert.deepEqual(types, ['eq', 'eq', 'add', 'add', 'eq', 'eq', 'eq'])
})

// ------------------------------------------------------------ alignLines ---

test('alignLines:完全相同 → 全 eq,行号一一对应', () => {
  const rows = alignLines('a\nb\nc', 'a\nb\nc')
  assert.equal(rows.length, 3)
  assert.deepEqual(
    rows.map((r) => r.type),
    ['eq', 'eq', 'eq'],
  )
  assert.deepEqual(
    rows.map((r) => [r.left, r.right]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  )
})

test('alignLines:空对空 → 单个空行 eq(空文本=一个空行)', () => {
  assert.deepEqual(
    alignLines('', '').map((r) => r.type),
    ['eq'],
  )
})

test('alignLines:单行修改 → del + add 相邻', () => {
  const rows = alignLines('old', 'new')
  assert.deepEqual(
    rows.map((r) => r.type),
    ['del', 'add'],
  )
  assert.equal(rows[0].text, 'old')
  assert.equal(rows[1].text, 'new')
})

test('alignLines:中间插入 → eq add eq,行号错位正确', () => {
  const rows = alignLines('a\nb', 'a\nx\nb')
  assert.deepEqual(
    rows.map((r) => r.type),
    ['eq', 'add', 'eq'],
  )
  // 插入行左侧无行号,右侧是第 2 行
  assert.equal(rows[1].left, null)
  assert.equal(rows[1].right, 2)
  // 后续 eq 行号错位:b 左 2 右 3
  assert.deepEqual([rows[2].left, rows[2].right], [2, 3])
})

test('alignLines:中间删除 → eq del eq', () => {
  const rows = alignLines('a\nx\nb', 'a\nb')
  assert.deepEqual(
    rows.map((r) => r.type),
    ['eq', 'del', 'eq'],
  )
  assert.equal(rows[1].right, null)
  assert.equal(rows[1].text, 'x')
})

test('alignLines:整块替换(长公共前后缀剥离)', () => {
  const head = Array.from({ length: 100 }, (_, i) => `h${i}`)
  const tail = Array.from({ length: 100 }, (_, i) => `t${i}`)
  const left = [...head, 'old-1', 'old-2', ...tail].join('\n')
  const right = [...head, 'new-1', ...tail].join('\n')
  const rows = alignLines(left, right)
  const types = rows.map((r) => r.type)
  // 头 100 eq(index 0-99)+ del del add + 尾 100 eq
  assert.deepEqual(types.slice(100, 105), ['del', 'del', 'add', 'eq', 'eq'])
  assert.equal(types[0], 'eq')
  assert.equal(types[types.length - 1], 'eq')
  assert.equal(rows.filter((r) => r.type === 'eq').length, 200)
})

test('alignLines:首行删除与末行删除', () => {
  assert.deepEqual(
    alignLines('a\nb', 'b').map((r) => r.type),
    ['del', 'eq'],
  )
  assert.deepEqual(
    alignLines('a\nb', 'a').map((r) => r.type),
    ['eq', 'del'],
  )
})

test('alignLines:一侧为空 → 按空行语义 del/add(与 textarea 视觉一致)', () => {
  // '' = 一个空行,对 'x\ny' 即「删空行、增两行」
  const addRows = alignLines('', 'x\ny')
  assert.deepEqual(
    addRows.map((r) => r.type),
    ['del', 'add', 'add'],
  )
  const delRows = alignLines('x\ny', '')
  assert.deepEqual(
    delRows.map((r) => r.type),
    ['del', 'del', 'add'],
  )
  // 全空两侧:空行 eq
  assert.deepEqual(
    alignLines('', '').map((r) => r.type),
    ['eq'],
  )
})

test('alignLines:中文与空行混合', () => {
  const rows = alignLines('中文一行\n\n尾', '中文一行\n改\n\n尾')
  // 插入「改」后空行与「尾」eq 对齐(前后缀剥离的最自然结果)
  assert.deepEqual(
    rows.map((r) => r.type),
    ['eq', 'add', 'eq', 'eq'],
  )
  assert.equal(rows[0].text, '中文一行')
  assert.equal(rows[2].text, '')
})

test('alignLines:超限降级 → 全 del + 全 add,不炸不截断语义', () => {
  const n = 3000
  const left = Array.from({ length: n }, (_, i) => `L${i}`).join('\n')
  const right = Array.from({ length: n }, (_, i) => `R${i}`).join('\n')
  const rows = alignLines(left, right)
  assert.equal(rows.length, n * 2)
  assert.ok(rows.every((r) => r.type === 'del' || r.type === 'add'))
})

test('alignLines:行对规模超 MAX_DIFF_ROWS 时截断保底', () => {
  const big = Array.from({ length: MAX_DIFF_ROWS + 10 }, (_, i) => `r${i}`).join('\n')
  const rows = alignLines(big, big)
  assert.ok(rows.length <= MAX_DIFF_ROWS)
})

// ------------------------------------------------- diffBlocks/pairBlocks ---

test('diffBlocks:连续 del/add 聚块,行索引半开区间', () => {
  const rows = alignLines('a\nx1\nx2\nb\ny\nc\nz', 'a\nn1\nn2\nn3\nb\nc\nm1\nm2\nz')
  const blocks = diffBlocks(rows)
  // 语义断言:块内行类型一致(块类型即行类型)、相邻块类型不同、区间单调
  for (const b of blocks) {
    for (let i = b.start; i < b.end; i++) assert.equal(rows[i].type, b.type)
  }
  for (let k = 1; k < blocks.length; k++) {
    assert.notEqual(blocks[k].type, blocks[k - 1].type)
    assert.ok(blocks[k].start > blocks[k - 1].start)
  }
  // 全部 del/add 行都被块覆盖
  const covered = blocks.reduce((n, b) => n + (b.end - b.start), 0)
  assert.equal(covered, rows.filter((r) => r.type !== 'eq').length)
})

test('pairBlocks:相邻 del+add 配对;孤块各自成对(对侧缺省)', () => {
  const rows = alignLines('a\no1\no2\nb\nk\n', 'a\nn1\nn2\nn3\nb\nc\n')
  const pairs = pairBlocks(diffBlocks(rows))
  // 换行前 del 对 add;尾部 k→c 是 del+add 或孤块,全部必须被覆盖
  const covered = pairs.every((p) => p.del !== undefined || p.add !== undefined)
  assert.equal(covered, true)
  const withBoth = pairs.filter((p) => p.del !== undefined && p.add !== undefined)
  assert.ok(withBoth.length >= 1, '至少一对 del+add')
})

test('pairBlocks:纯删除与纯插入(无配对对侧)', () => {
  // 左带尾换行(尾空行与右侧空行 eq),中段才是纯删除
  const pureDel = pairBlocks(diffBlocks(alignLines('a\nb\nc\n', '')))
  assert.equal(pureDel.length, 1)
  assert.ok(pureDel[0].del !== undefined && pureDel[0].add === undefined)
  const pureAdd = pairBlocks(diffBlocks(alignLines('', 'a\nb\nc\n')))
  assert.equal(pureAdd.length, 1)
  assert.ok(pureAdd[0].del === undefined && pureAdd[0].add !== undefined)
})
