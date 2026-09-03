import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fileTabsSubscribe,
  fileTabsGetSnapshot,
  openFile,
  closeFile,
  activateFile,
  activateSession,
  setFileDirty,
  findFileTab,
  resetFileTabs,
} from '../lib/file-tabs.js'

/** 订阅计数探针:验证 getSnapshot 引用变化才通知。 */
function withSpy() {
  let n = 0
  const off = fileTabsSubscribe(() => n++)
  return { calls: () => n, off }
}

test('openFile:新开并激活,快照含 TAB 元数据', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'src/a.ts', view: 'edit' })
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.active.kind, 'file')
  const tab = snap.tabs.find((tb) => tb.id === snap.active.id)
  assert.ok(tab)
  assert.equal(tab.cwd, 'C:/repo')
  assert.equal(tab.relPath, 'src/a.ts')
  assert.equal(tab.view, 'edit')
  assert.equal(tab.dirty, false)
})

test('openFile:同文件复用同一 TAB,仅切视图/聚焦', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'src/a.ts', view: 'edit' })
  const first = fileTabsGetSnapshot().active.id
  openFile({ cwd: 'C:/repo', relPath: 'src/a.ts', view: 'diff' })
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.active.id, first, '聚焦已有 TAB')
  assert.equal(snap.tabs.length, 1)
  const tab = snap.tabs[0]
  assert.equal(tab.view, 'diff')
  assert.equal(tab.dirty, false, '复用不重置脏标记以外的状态')
})

test('openFile:cwd 归一(反斜杠等价)+ 相对路径归一', () => {
  resetFileTabs()
  openFile({ cwd: 'C:\\repo', relPath: 'src\\a.ts', view: 'edit' })
  const snap = fileTabsGetSnapshot()
  const tab = snap.tabs[0]
  assert.equal(tab.cwd, 'C:/repo')
  assert.equal(tab.relPath, 'src/a.ts')
  // 同文件不同写法复用
  const before = snap.tabs.length
  openFile({ cwd: 'C:/repo', relPath: 'src/a.ts', view: 'edit' })
  assert.equal(fileTabsGetSnapshot().tabs.length, before)
})

test('openFile:重复打开相同视图不改快照引用(uSES 免抖)', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' })
  const before = fileTabsGetSnapshot()
  openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' })
  assert.equal(fileTabsGetSnapshot(), before)
})

test('closeFile:关闭激活 TAB 焦点回落会话;关闭非激活 TAB 不动焦点', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' })
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.tabs.length, 2)
  const aTab = snap.tabs.find((tb) => tb.relPath === 'a.ts')
  // 激活的是 b;关 a 不动焦点
  closeFile(aTab.id)
  assert.equal(fileTabsGetSnapshot().active.kind, 'file')
  assert.equal(fileTabsGetSnapshot().tabs.length, 1)
  // 关激活的 b → 回会话
  closeFile(fileTabsGetSnapshot().active.id)
  assert.equal(fileTabsGetSnapshot().active.kind, 'session')
  assert.equal(fileTabsGetSnapshot().tabs.length, 0)
})

test('activateFile/activateSession:切换激活对象', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  activateSession()
  assert.equal(fileTabsGetSnapshot().active.kind, 'session')
  const id = openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  assert.equal(fileTabsGetSnapshot().active.kind, 'file')
  activateFile(id)
  assert.equal(fileTabsGetSnapshot().active.kind, 'file')
})

test('setFileDirty:改状态不改身份', () => {
  resetFileTabs()
  const id = openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  setFileDirty(id, true)
  const tab = fileTabsGetSnapshot().tabs[0]
  assert.equal(tab.dirty, true)
  assert.equal(fileTabsGetSnapshot().active.id, id)
})

test('findFileTab:cwd+relPath 定位(归一比较)', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'src/x.ts', view: 'edit' })
  const found = findFileTab('C:\\repo', 'src/x.ts')
  assert.ok(found)
  assert.equal(findFileTab('C:/other', 'src/x.ts'), null)
})

test('订阅:状态变化才通知,无变化不通知', () => {
  resetFileTabs()
  const spy = withSpy()
  const id = openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  const callsAfterOpen = spy.calls()
  openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  assert.equal(spy.calls(), callsAfterOpen, '重复打开同视图不通知')
  setFileDirty(id, true)
  assert.equal(spy.calls(), callsAfterOpen + 1)
  spy.off()
})
