import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fileTabsSubscribe,
  fileTabsGetSnapshot,
  openFile,
  closeFile,
  activateFile,
  activateSession,
  activateSplit,
  setFileDirty,
  setSplitRatio,
  openInPane,
  resolveSplit,
  setSplitPreview,
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

test('setSplitRatio:clamp 0.3~0.75,同值保持引用;无分栏时 no-op', () => {
  resetFileTabs()
  setSplitRatio(0.4)
  assert.equal(fileTabsGetSnapshot().split, null)
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  setSplitRatio(0.4)
  assert.equal(fileTabsGetSnapshot().split.ratio, 0.4)
  setSplitRatio(0.1)
  assert.equal(fileTabsGetSnapshot().split.ratio, 0.3)
  setSplitRatio(0.9)
  assert.equal(fileTabsGetSnapshot().split.ratio, 0.75)
  setSplitRatio(Number.NaN)
  assert.equal(fileTabsGetSnapshot().split.ratio, 0.55)
  const s1 = fileTabsGetSnapshot()
  setSplitRatio(0.55)
  assert.equal(fileTabsGetSnapshot(), s1)
})

test('openFile:默认单文件模式(split=null),打开不自动分栏', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  assert.equal(fileTabsGetSnapshot().active.kind, 'file')
  assert.equal(fileTabsGetSnapshot().split, null)
  openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' })
  assert.equal(fileTabsGetSnapshot().split, null)
  assert.equal(fileTabsGetSnapshot().active.id, fileTabsGetSnapshot().tabs.find((tb) => tb.relPath === 'b.ts').id)
})

test('openFile+pane:纯会话建立分栏(会话恒左文件右)', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  assert.equal(fileTabsGetSnapshot().split.kind, 'session-file')
  assert.equal(fileTabsGetSnapshot().active.kind, 'split')
})

test('openInPane:拖放落位矩阵', () => {
  resetFileTabs()
  // 单开 F 拖自己 = 无效
  const f = openFile({ cwd: 'C:/repo', relPath: 'f.ts', view: 'edit' })
  openInPane(f, 'right')
  assert.equal(fileTabsGetSnapshot().split, null, '自拖不建立分栏')
  // 单开 F 态拖 N 到右 = file-file(N|F)
  const n = openFile({ cwd: 'C:/repo', relPath: 'n.ts', view: 'edit' })
  openInPane(f, 'right')
  const sp = fileTabsGetSnapshot().split
  assert.equal(sp.kind, 'file-file')
  assert.equal(sp.leftTabId, n)
  assert.equal(sp.rightTabId, f)
  // file-file 互换:拖 f 到左
  openInPane(f, 'left')
  assert.equal(fileTabsGetSnapshot().split.kind, 'file-file')
  assert.equal(fileTabsGetSnapshot().split.leftTabId, f)
  assert.equal(fileTabsGetSnapshot().split.rightTabId, n)
})

test('activateSession:点会话 TAB = 切纯会话,分栏休眠保存', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  assert.equal(fileTabsGetSnapshot().active.kind, 'split')
  activateSession()
  assert.equal(fileTabsGetSnapshot().active.kind, 'session')
  assert.notEqual(fileTabsGetSnapshot().split, null, '分栏休眠保存,不解散')
})

test('resolveSplit:落位推演矩阵(与 openInPane 行为一致)', () => {
  resetFileTabs()
  // 纯会话(focus null):恒 session-file(会话恒左文件右)
  const s1 = resolveSplit(null, null, 'x', 'right')
  assert.equal(s1.kind, 'session-file')
  const s2 = resolveSplit(null, null, 'x', 'left')
  assert.equal(s2.kind, 'session-file', '会话恒左,左右落点同组合')
  // 单开 F:自拖 undefined;拖 N 左 = file-file(N|F);右 = (F|N)
  assert.equal(resolveSplit(null, 'F', 'F', 'left'), undefined)
  const s3 = resolveSplit(null, 'F', 'N', 'left')
  assert.equal(s3.kind, 'file-file')
  assert.equal(s3.leftTabId, 'N')
  assert.equal(s3.rightTabId, 'F')
  // session-file 文件落左 = 升级 file-file(会话退出)
  const s4 = resolveSplit({ kind: 'session-file', sessionTabId: 'sess', rightTabId: 'R', ratio: 0.5 }, 'R', 'R', 'left')
  assert.equal(s4.kind, 'file-file')
  assert.equal(s4.leftTabId, 'R')
  // file-file 互换
  const s5 = resolveSplit({ kind: 'file-file', leftTabId: 'A', rightTabId: 'B', ratio: 0.5 }, 'A', 'A', 'right')
  assert.equal(s5.leftTabId, 'B')
  assert.equal(s5.rightTabId, 'A')
})

test('setSplitPreview:形状+源相同防抖,落位动作清预览', () => {
  resetFileTabs()
  setSplitPreview({ kind: 'file-file', leftTabId: 'a', rightTabId: 'b', ratio: 0.55 }, 'a', 'left')
  assert.equal(fileTabsGetSnapshot().preview.shape.kind, 'file-file')
  // 形状相同不重复提交(引用保持)
  const s1 = fileTabsGetSnapshot()
  setSplitPreview({ kind: 'file-file', leftTabId: 'a', rightTabId: 'b', ratio: 0.55 }, 'a', 'left')
  assert.equal(fileTabsGetSnapshot(), s1)
  // 清空
  setSplitPreview(null, 'a', 'right')
  assert.equal(fileTabsGetSnapshot().preview, null)
  // openInPane 落位顺带清预览
  setSplitPreview({ kind: 'file-file', leftTabId: 'a', rightTabId: 'b', ratio: 0.55 }, 'a', 'left')
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  openInPane(fileTabsGetSnapshot().active.id, 'right')
  assert.equal(fileTabsGetSnapshot().preview, null)
})
