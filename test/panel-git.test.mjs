/**
 * parseTreeColoring 单测:`git status --porcelain=v1 --untracked-files=all
 * --ignored=matching` 输出 → 资源管理器染色映射(文件 + 目录聚合)。
 * 覆盖:四类状态、删除跳过、新增后修改仍算新增、rename 取新名、目录聚合优先级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTreeColoring, TREE_COLOR_PRIORITY } from '../lib/panel-git.js'

test('parseTreeColoring:四类状态分类', () => {
  const out = [
    ' M src/mod.ts',      // 工作区修改
    'M  src/staged.ts',    // 仅暂存修改
    'A  src/added.ts',     // 暂存新增
    'AM src/added-mod.ts', // 新增后又改 → 仍算新增
    '?? dist/new.js',      // 未跟踪
    '!! .env.local',       // 忽略
    'R  old.ts -> new.ts', // 改名 → 取新名按修改
    'D  gone.ts',          // 删除 → 跳过(树中不存在)
    ' D gone2.ts',         // 工作区删除 → 跳过
  ].join('\n')
  const { files, dirs } = parseTreeColoring(out)
  assert.equal(files['src/mod.ts'], 'M')
  assert.equal(files['src/staged.ts'], 'M')
  assert.equal(files['src/added.ts'], 'A')
  assert.equal(files['src/added-mod.ts'], 'A', '新增后又改仍算新增')
  assert.equal(files['dist/new.js'], '?')
  assert.equal(files['.env.local'], '!')
  assert.equal(files['new.ts'], 'M', 'rename 取新名')
  assert.equal(files['old.ts'], undefined, 'rename 旧名不染')
  assert.equal(files['gone.ts'], undefined, '删除跳过')
  assert.equal(files['gone2.ts'], undefined)
})

test('parseTreeColoring:目录聚合继承子孙最高优先级', () => {
  const out = [
    '?? a/b/untracked.txt', // ?(最高)
    ' M a/b/mod.ts',        // M
    'A  c/added.ts',        // A
    '!! d/ignored.log',     // !(最低)
  ].join('\n')
  const { dirs } = parseTreeColoring(out)
  assert.equal(dirs['a'], '?')
  assert.equal(dirs['a/b'], '?', '目录取子孙最高优先级(未跟踪 > 修改)')
  assert.equal(dirs['c'], 'A')
  assert.equal(dirs['d'], '!')
  assert.equal(dirs['nope'], undefined)
})

test('parseTreeColoring:空输出与短行容错', () => {
  const empty = parseTreeColoring('')
  assert.deepEqual(empty.files, {})
  assert.deepEqual(empty.dirs, {})
  const { files } = parseTreeColoring('\n\n  \n')
  assert.deepEqual(files, {})
})

test('TREE_COLOR_PRIORITY:未跟踪 > 修改 > 新增 > 忽略', () => {
  assert.deepEqual(TREE_COLOR_PRIORITY, ['?', 'M', 'A', '!'])
})
