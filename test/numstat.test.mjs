/**
 * parseNumstat 单测:`git diff --numstat` 输出 → path → {add, del}。
 * 覆盖:常规行、二进制(- -)跳过、rename 花括号取新名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumstat } from '../lib/panel-git.js'

test('parseNumstat:常规增删行', () => {
  const m = parseNumstat('18\t1\tsrc/tools/panel-routes.ts\n131\t10\tsrc/panel.tsx\n')
  assert.deepEqual(m.get('src/tools/panel-routes.ts'), { add: 18, del: 1 })
  assert.deepEqual(m.get('src/panel.tsx'), { add: 131, del: 10 })
})

test('parseNumstat:二进制行跳过;空输入空表', () => {
  assert.equal(parseNumstat('-\t-\timg/logo.png\n').has('img/logo.png'), false)
  assert.equal(parseNumstat('').size, 0)
})

test('parseNumstat:rename 花括号取新名', () => {
  const m = parseNumstat('5\t2\tsrc/{old.ts => new.ts}\n')
  assert.ok(m.has('src/new.ts'), `应含新名,实际 keys: ${[...m.keys()].join(',')}`)
  assert.deepEqual(m.get('src/new.ts'), { add: 5, del: 2 })
})

test('parseNumstat:含空格/中文路径', () => {
  const m = parseNumstat('1\t0\tdocs/中文 说明.md\n')
  assert.deepEqual(m.get('docs/中文 说明.md'), { add: 1, del: 0 })
})
