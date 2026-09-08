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
  exitSplit,
  setFileDirty,
  setSplitRatio,
  openInPane,
  attachSessionPane,
  resolveSplit,
  planDrop,
  planSessionDrop,
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

// ── 多分组模型 ─────────────────────────────────────────────────────────────

test('openFile:默认单文件模式(groups=[]),打开不自动分组', () => {
  resetFileTabs()
  const f = openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  assert.equal(fileTabsGetSnapshot().active.kind, 'file')
  assert.equal(fileTabsGetSnapshot().groups.length, 0)
  openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' })
  assert.equal(fileTabsGetSnapshot().groups.length, 0)
  assert.equal(fileTabsGetSnapshot().active.id, fileTabsGetSnapshot().tabs.find((tb) => tb.relPath === 'b.ts').id)
  assert.notEqual(f, '')
})

test('openFile+pane:纯会话建立 session-file 组(会话恒左文件右)', () => {
  resetFileTabs()
  const f = openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 1)
  assert.equal(snap.groups[0].kind, 'session-file')
  assert.equal(snap.groups[0].rightTabId, f)
  assert.equal(snap.active.kind, 'split')
})

test('openFile+pane:单开 F + 拖入 N = file-file 新组', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'f.ts', view: 'edit' })
  const f = fileTabsGetSnapshot().active.id
  const n = openFile({ cwd: 'C:/repo', relPath: 'n.ts', view: 'edit' }, 'left')
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 1)
  const g = snap.groups[0]
  assert.equal(g.kind, 'file-file')
  assert.equal(g.leftTabId, n)
  assert.equal(g.rightTabId, f)
  assert.equal(snap.active.kind, 'split')
})

test('多组并存:已有休眠组时再建新组,旧组原样保留', () => {
  resetFileTabs()
  // 组1:A|B
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const g1 = fileTabsGetSnapshot().groups[0].id
  // 休眠 + 单开 C + 拖 D 建组2
  activateSession()
  openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'd.ts', view: 'edit' }, 'right')
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 2, '两组并存')
  const g1After = snap.groups.find((g) => g.id === g1)
  assert.ok(g1After, '旧组原样保留')
  assert.equal(snap.active.kind, 'split')
  assert.equal(snap.active.id, snap.groups.find((g) => g.id !== g1).id, '激活新组')
})

test('休眠组成员再组合:从原组摘出建新组,原组剩单成员解散', () => {
  resetFileTabs()
  // 组1:B|F(file-file)
  openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'f.ts', view: 'edit' }, 'right')
  const g1 = fileTabsGetSnapshot().groups[0]
  assert.equal(g1.kind, 'file-file')
  const f = g1.rightTabId
  const b = g1.leftTabId
  // 休眠,单开 F(F 在组1),拖 N 落右
  activateSession()
  activateFile(f)
  const n = openFile({ cwd: 'C:/repo', relPath: 'n.ts', view: 'edit' }, 'right')
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 1, '组1 摘出 F 后剩单成员解散,只剩新组')
  const g = snap.groups[0]
  assert.equal(g.kind, 'file-file')
  assert.equal(g.leftTabId, f)
  assert.equal(g.rightTabId, n)
  // B 回普通 TAB
  assert.ok(snap.tabs.some((tb) => tb.id === b), '原组另一成员回普通 TAB')
  assert.notEqual(n, '')
})

test('激活组内重组:换入右栏(原右栏文件回普通 TAB)', () => {
  resetFileTabs()
  // 先开 C(非成员),再建激活组 A|B
  const c = openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' }, 'right')
  const g0 = fileTabsGetSnapshot().groups[0]
  assert.equal(g0.kind, 'file-file')
  const a = g0.leftTabId
  const b = g0.rightTabId
  // 组激活中拖 C 落右:B 换出回普通 TAB
  openInPane(c, 'right')
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 1)
  assert.equal(snap.groups[0].leftTabId, a)
  assert.equal(snap.groups[0].rightTabId, c)
  assert.ok(snap.tabs.some((tb) => tb.id === b), '被换出成员回普通 TAB')
  assert.equal(snap.active.kind, 'split')
})

test('激活组内重组:file-file 互换两栏', () => {
  resetFileTabs()
  const n = openFile({ cwd: 'C:/repo', relPath: 'n.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const g0 = fileTabsGetSnapshot().groups[0]
  assert.equal(g0.kind, 'file-file')
  assert.equal(g0.leftTabId, n)
  // 左栏成员拖右 = 互换
  openInPane(n, 'right')
  const g1 = fileTabsGetSnapshot().groups[0]
  assert.equal(g1.kind, 'file-file')
  assert.equal(g1.leftTabId, g0.rightTabId)
  assert.equal(g1.rightTabId, g0.leftTabId)
})

test('激活组内重组:session-file 文件落左 = 升级 file-file(会话退出)', () => {
  resetFileTabs()
  const c = openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  activateSession()
  openFile({ cwd: 'C:/repo', relPath: 'r.ts', view: 'edit' }, 'right')
  const g0 = fileTabsGetSnapshot().groups[0]
  assert.equal(g0.kind, 'session-file')
  // 组激活中拖 C 落左:升级 file-file,会话侧退出
  openInPane(c, 'left')
  const g = fileTabsGetSnapshot().groups[0]
  assert.equal(g.kind, 'file-file')
  assert.equal(g.leftTabId, c)
  assert.equal(g.rightTabId, g0.rightTabId)
  assert.equal(fileTabsGetSnapshot().groups.length, 1)
})

test('自拖无效:单开自拖与组内同栏拖放都不产生变化', () => {
  resetFileTabs()
  const f = openFile({ cwd: 'C:/repo', relPath: 'f.ts', view: 'edit' })
  openInPane(f, 'right')
  assert.equal(fileTabsGetSnapshot().groups.length, 0, '单开自拖不建组')
  // 焦点 F + N 落左 = N|F 激活
  openFile({ cwd: 'C:/repo', relPath: 'n.ts', view: 'edit' }, 'left')
  const g0 = fileTabsGetSnapshot().groups[0]
  assert.equal(g0.kind, 'file-file')
  const before = fileTabsGetSnapshot()
  openInPane(g0.leftTabId, 'left')
  assert.equal(fileTabsGetSnapshot(), before, '组内同栏拖放引用不变')
})

test('closeFile:激活组成员被关 → 组解散,激活回落纯会话', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const g = fileTabsGetSnapshot().groups[0]
  const a = g.rightTabId
  closeFile(a)
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 0)
  assert.equal(snap.active.kind, 'session')
  assert.equal(snap.tabs.length, 0)
})

test('closeFile:休眠组成员被关 → 该组解散,激活组不受影响', () => {
  resetFileTabs()
  // 组1:A|B
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const g1 = fileTabsGetSnapshot().groups[0].id
  // 组2:C|D
  activateSession()
  openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'd.ts', view: 'edit' }, 'right')
  const g2 = fileTabsGetSnapshot().groups.find((g) => g.id !== g1)
  // 休眠组2,激活组1
  activateSplit(g1)
  closeFile(g2.rightTabId)
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 1)
  assert.equal(snap.groups[0].id, g1)
  assert.equal(snap.active.kind, 'split')
  assert.equal(snap.active.id, g1)
})

test('activateSplit:多组间切换,点谁激活谁(其余休眠)', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const g1 = fileTabsGetSnapshot().groups[0].id
  activateSession()
  openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'd.ts', view: 'edit' }, 'right')
  const g2 = fileTabsGetSnapshot().groups.find((g) => g.id !== g1).id
  assert.equal(fileTabsGetSnapshot().active.id, g2)
  activateSplit(g1)
  assert.equal(fileTabsGetSnapshot().active.kind, 'split')
  assert.equal(fileTabsGetSnapshot().active.id, g1)
  activateSession()
  activateSplit(g2)
  assert.equal(fileTabsGetSnapshot().active.id, g2)
})

test('activateSession/activateFile:分组休眠保存,不解散', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const gid = fileTabsGetSnapshot().groups[0].id
  activateSession()
  let snap = fileTabsGetSnapshot()
  assert.equal(snap.active.kind, 'session')
  assert.equal(snap.groups.length, 1)
  assert.equal(snap.groups[0].id, gid)
  const f = openFile({ cwd: 'C:/repo', relPath: 'z.ts', view: 'edit' })
  snap = fileTabsGetSnapshot()
  assert.equal(snap.active.kind, 'file')
  assert.equal(snap.groups.length, 1, '单文件视图不清组')
  activateSplit(gid)
  assert.equal(fileTabsGetSnapshot().active.kind, 'split')
})

test('exitSplit():解散激活组,焦点文件(右栏成员)保留单开', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  const b = openFile({ cwd: 'C:/repo', relPath: 'b.ts', view: 'edit' }, 'left')
  const g0 = fileTabsGetSnapshot().groups[0]
  assert.equal(g0.kind, 'file-file')
  assert.equal(g0.leftTabId, b, 'b 落左')
  exitSplit()
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 0)
  assert.equal(snap.active.kind, 'file')
  assert.equal(snap.active.id, g0.rightTabId, '右栏成员(焦点文件)保留单开')
  assert.equal(snap.tabs.length, 2)
})

test('exitSplit(id):解散指定组(休眠组),激活态不动', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const g1 = fileTabsGetSnapshot().groups[0].id
  activateSession()
  openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'd.ts', view: 'edit' }, 'right')
  const g2 = fileTabsGetSnapshot().groups.find((g) => g.id !== g1).id
  exitSplit(g1)
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 1)
  assert.equal(snap.groups[0].id, g2)
  assert.equal(snap.active.id, g2, '激活组不受影响')
})

test('setSplitRatio:只改激活组,各组独立;clamp 0.3~0.75', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' }, 'right')
  const g1 = fileTabsGetSnapshot().groups[0].id
  setSplitRatio(0.4)
  assert.equal(fileTabsGetSnapshot().groups[0].ratio, 0.4)
  activateSession()
  openFile({ cwd: 'C:/repo', relPath: 'c.ts', view: 'edit' })
  openFile({ cwd: 'C:/repo', relPath: 'd.ts', view: 'edit' }, 'right')
  setSplitRatio(0.7)
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.find((g) => g.id === g1).ratio, 0.4, '休眠组比例独立')
  assert.equal(snap.groups.find((g) => g.id !== g1).ratio, 0.7, '激活组更新')
  setSplitRatio(0.1)
  assert.equal(fileTabsGetSnapshot().groups.find((g) => g.id !== g1).ratio, 0.3, '下限 clamp')
  setSplitRatio(Number.NaN)
  assert.equal(fileTabsGetSnapshot().groups.find((g) => g.id !== g1).ratio, 0.55, '非法回落默认')
  const s1 = fileTabsGetSnapshot()
  setSplitRatio(0.55)
  assert.equal(fileTabsGetSnapshot(), s1, '同值保持引用')
})

test('resolveSplit:组内重组矩阵(3 参)', () => {
  resetFileTabs()
  // session-file:落右换右栏
  const sf = { kind: 'session-file', id: 'g', sessionTabId: 'sess', rightTabId: 'R', ratio: 0.5 }
  const s1 = resolveSplit(sf, 'N', 'right')
  assert.equal(s1.kind, 'session-file')
  assert.equal(s1.rightTabId, 'N')
  // 落左升级 file-file
  const s2 = resolveSplit(sf, 'N', 'left')
  assert.equal(s2.kind, 'file-file')
  assert.equal(s2.leftTabId, 'N')
  assert.equal(s2.rightTabId, 'R')
  // file-file:另一栏拖放=互换
  const ff = { kind: 'file-file', id: 'g', leftTabId: 'A', rightTabId: 'B', ratio: 0.5 }
  const f1 = resolveSplit(ff, 'A', 'right')
  assert.equal(f1.leftTabId, 'B')
  assert.equal(f1.rightTabId, 'A')
  // 换入右栏(原右栏换出)
  const f2 = resolveSplit(ff, 'C', 'right')
  assert.equal(f2.leftTabId, 'A')
  assert.equal(f2.rightTabId, 'C')
  // 同栏自拖=原样
  const f3 = resolveSplit(ff, 'A', 'left')
  assert.equal(f3, ff)
})

test('planDrop:纯函数推演(新建/重组/自拖),与 openInPane 一致', () => {
  resetFileTabs()
  // 纯会话:session-file(sessionTabId 透传)
  let snap = fileTabsGetSnapshot()
  const p1 = planDrop(snap, 'x', 'right', 'sess-1')
  assert.equal(p1.kind, 'session-file')
  assert.equal(p1.sessionTabId, 'sess-1')
  assert.equal(p1.rightTabId, 'x')
  // 单开 F:自拖 undefined;拖 N = file-file
  openFile({ cwd: 'C:/repo', relPath: 'f.ts', view: 'edit' })
  snap = fileTabsGetSnapshot()
  const f = snap.active.id
  assert.equal(planDrop(snap, f, 'left'), undefined)
  const p2 = planDrop(snap, 'N', 'left')
  assert.equal(p2.kind, 'file-file')
  assert.equal(p2.leftTabId, 'N')
  assert.equal(p2.rightTabId, f)
  // 激活组:组内重组走 resolveSplit(复用组 id)
  openFile({ cwd: 'C:/repo', relPath: 'n.ts', view: 'edit' }, 'right')
  snap = fileTabsGetSnapshot()
  const gid = snap.active.id
  const p3 = planDrop(snap, 'M', 'right')
  assert.equal(p3.id, gid, '重组复用组 id')
  assert.equal(p3.rightTabId, 'M')
})

test('planSessionDrop:单文件焦点=会话左+焦点右;其余无效', () => {
  resetFileTabs()
  assert.equal(planSessionDrop(fileTabsGetSnapshot(), 'sess-1'), undefined, '纯会话无效')
  openFile({ cwd: 'C:/repo', relPath: 'f.ts', view: 'edit' })
  const p = planSessionDrop(fileTabsGetSnapshot(), 'sess-1')
  assert.ok(p)
  assert.equal(p.kind, 'session-file')
  assert.equal(p.sessionTabId, 'sess-1')
  assert.equal(p.rightTabId, fileTabsGetSnapshot().active.id)
  openFile({ cwd: 'C:/repo', relPath: 'n.ts', view: 'edit' }, 'right')
  assert.equal(planSessionDrop(fileTabsGetSnapshot(), 'sess-2'), undefined, '分组激活无效')
})

test('attachSessionPane:会话进左栏,焦点文件留右;会话侧宿主切换由事件层处理', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'f.ts', view: 'edit' })
  attachSessionPane('sess-9')
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.groups.length, 1)
  assert.equal(snap.groups[0].kind, 'session-file')
  assert.equal(snap.groups[0].sessionTabId, 'sess-9')
  assert.equal(snap.groups[0].rightTabId, snap.tabs[0].id)
  assert.equal(snap.active.kind, 'split')
  // 非文件焦点 no-op
  activateSession()
  const before = fileTabsGetSnapshot()
  attachSessionPane('sess-8')
  assert.equal(fileTabsGetSnapshot(), before)
})

test('setSplitPreview:形状+源相同防抖,落位动作清预览', () => {
  resetFileTabs()
  setSplitPreview({ kind: 'file-file', id: '', leftTabId: 'a', rightTabId: 'b', ratio: 0.55 }, 'a', 'left')
  assert.equal(fileTabsGetSnapshot().preview.shape.kind, 'file-file')
  const s1 = fileTabsGetSnapshot()
  setSplitPreview({ kind: 'file-file', id: 'whatever', leftTabId: 'a', rightTabId: 'b', ratio: 0.55 }, 'a', 'left')
  assert.equal(fileTabsGetSnapshot(), s1, '形状相同(id/ratio 不参与)不重复提交')
  setSplitPreview(null, 'a', 'right')
  assert.equal(fileTabsGetSnapshot().preview, null)
  // openInPane 落位顺带清预览
  setSplitPreview({ kind: 'file-file', id: '', leftTabId: 'a', rightTabId: 'b', ratio: 0.55 }, 'a', 'left')
  const f = openFile({ cwd: 'C:/repo', relPath: 'a.ts', view: 'edit' })
  openInPane(f, 'right')
  assert.equal(fileTabsGetSnapshot().preview, null)
})
