/**
 * 文件编辑 TAB 全局状态(模块级外部 store,无 DOM 依赖,node --test 可直测)。
 *
 * 顶部栏 TAB 行同时承载「会话 TAB」「文件 TAB」「合并 TAB(分栏)」三类页签:
 * 会话激活态由宿主 currentId 驱动(topbar.tsx),文件 TAB 的清单与激活对象在本
 * store;分栏(split)是**两个标签合并成的一个整体对象**——它有自己的激活态,
 * 切到分栏外 TAB 时休眠保存(不解散),点合并 TAB 恢复。独立成模块避免
 * client.tsx ↔ topbar.tsx 循环 import(session-status.ts 同款考量)。
 *
 * 消费方式:useSyncExternalStore(fileTabsSubscribe, fileTabsGetSnapshot);
 * 快照不可变,无变化的动作返回原引用(订阅端免抖)。
 */
import { isImagePath } from './image-file.js'

/** 文件 TAB:工作区根 + 相对路径唯一定位一个文件(cwd/relPath 存归一形态)。 */
export interface FileTab {
  id: string
  /** 工作区根(POSIX 斜杠归一)。 */
  cwd: string
  /** 工作区内相对路径(POSIX 斜杠归一)。 */
  relPath: string
  /**
   * TAB 类型(入口 + 扩展名决定,无切换):edit=资源管理器打开(可编辑);
   * diff=Git Changes 打开(只读);image=图片文件(优先级最高,任何入口均预览,
   * 二进制无 diff/编辑语义)。
   */
  view: 'edit' | 'diff' | 'image'
  /** 编辑内容未保存(TAB 标题脏点)。 */
  dirty: boolean
}

/**
 * 激活对象 = 当前中间区域显示什么:
 * - session:纯会话视图(宿主 currentId 驱动内容)
 * - file:单文件视图(覆盖层全占)
 * - split:分栏合并视图(split 对象渲染为合并 TAB)
 * split 非 null 表示存在分栏对象(激活或休眠);active.kind==='split' ⇔ 分栏显示中。
 */
export type ActiveTab = { kind: 'session' } | { kind: 'file'; id: string } | { kind: 'split' }

/**
 * 分栏对象(两个标签合并的整体,会话只支持放左边——老板定案):
 * - session-file:左会话(露出宿主对话区,margin-right 推窄)+ 右文件;
 *   sessionTabId 绑定建立时的会话(恢复分栏时切回它,不跟随 currentId)
 * - file-file:左文件 + 右文件(宿主对话区全盖,overlay 内再分两栏)
 * ratio = 左栏占比 0.3~0.75,持久化 localStorage。
 */
export type SplitState =
  | { kind: 'session-file'; sessionTabId: string; rightTabId: string; ratio: number }
  | { kind: 'file-file'; leftTabId: string; rightTabId: string; ratio: number }

export interface FileTabsSnapshot {
  tabs: readonly FileTab[]
  active: ActiveTab
  /** 分栏对象(激活或休眠);null = 无分栏。 */
  split: SplitState | null
  /**
   * 拖拽预览:dragover 时实时推演的假想分栏形状(灰块占位渲染用,不落定);
   * tabId = 正在拖拽的源 TAB;drop/拖拽结束清空。
   * 形状相同不重复提交(dragover 高频防抖)。
   */
  preview: { shape: SplitState; tabId: string; pane: 'left' | 'right' } | null
}

const SPLIT_KEY = 'dshw.splitRatio'
const SPLIT_DEFAULT = 0.55

function loadSplitRatio(): number {
  try {
    const raw = Number(localStorage.getItem(SPLIT_KEY))
    return Number.isFinite(raw) && raw >= 0.3 && raw <= 0.75 ? raw : SPLIT_DEFAULT
  } catch {
    return SPLIT_DEFAULT
  }
}

let seq = 0
let snapshot: FileTabsSnapshot = { tabs: [], active: { kind: 'session' }, split: null, preview: null }
const listeners = new Set<() => void>()

/** cwd/相对路径归一:反斜杠转正斜杠(trim;与 topbar-core.normalizeCwd 同约定)。 */
function normalize(p: string): string {
  return typeof p === 'string' ? p.trim().replace(/\\/g, '/') : ''
}

/** 归一 key:同文件判定(cwd + relPath)。分隔符用 \u0000 转义文本(路径可含空格)。 */
function tabKey(cwd: string, relPath: string): string {
  return `${normalize(cwd)}\u0000${normalize(relPath)}`
}

function commit(next: FileTabsSnapshot): void {
  if (next === snapshot) return
  snapshot = next
  for (const fn of listeners) fn()
}

/**
 * 打开(或聚焦)文件 TAB:同文件已开则复用并切视图,否则新 TAB 追加并激活。
 * 返回 TAB id。无效入参(空路径)静默忽略返回空串。
 *
 * 点击语义:打开/聚焦该文件的单文件视图,**分栏只休眠保存不解散**。
 * 指定 pane(拖放/右键)时:与当前会话或焦点文件组合建立/调整分栏。
 */
export function openFile(
  opts: { cwd: string; relPath: string; view?: 'edit' | 'diff' },
  pane?: 'left' | 'right',
): string {
  const cwd = normalize(opts.cwd)
  const relPath = normalize(opts.relPath)
  if (cwd === '' || relPath === '') return ''
  // 图片扩展名优先:任何入口均走预览(二进制没有编辑/diff 语义)
  const view: FileTab['view'] = isImagePath(relPath) ? 'image' : opts.view === 'diff' ? 'diff' : 'edit'
  const key = tabKey(cwd, relPath)
  let existing = snapshot.tabs.find((tb) => tabKey(tb.cwd, tb.relPath) === key)
  if (existing === undefined) {
    const tab: FileTab = { id: `file-${++seq}`, cwd, relPath, view, dirty: false }
    commit({ ...snapshot, tabs: [...snapshot.tabs, tab], active: snapshot.active, split: snapshot.split })
    existing = tab
  } else if (existing.view !== view) {
    commit({
      ...snapshot,
      tabs: snapshot.tabs.map((tb) => (tb === existing ? { ...tb, view } : tb)),
    })
  }
  if (pane === undefined) {
    // 单文件视图(分栏休眠保存,不解散;重复单开保持引用免抖)
    if (snapshot.active.kind === 'file' && snapshot.active.id === existing.id) {
      return existing.id
    }
    commit({ ...snapshot, active: { kind: 'file', id: existing.id }, preview: null })
    return existing.id
  }
  // 显式指定栏(拖放/右键):已分栏走栏位矩阵;未分栏则组合建立
  if (snapshot.split !== null) {
    openInPane(existing.id, pane)
    return existing.id
  }
  const ratio = loadSplitRatio()
  const prev = snapshot.active
  if (prev.kind === 'file' && prev.id !== existing.id) {
    // 与单开的 F 并排成文件+文件
    commit({
      ...snapshot,
      split: {
        kind: 'file-file',
        leftTabId: pane === 'left' ? existing.id : prev.id,
        rightTabId: pane === 'left' ? prev.id : existing.id,
        ratio,
      },
      active: { kind: 'split' },
    })
  } else {
    // 纯会话(preview 时 active=session):会话恒左,文件右;会话侧由宿主 currentId 承载
    commit({
      ...snapshot,
      split: { kind: 'session-file', sessionTabId: '', rightTabId: existing.id, ratio },
      active: { kind: 'split' },
    })
  }
  return existing.id
}

/**
 * 落位推演(纯函数,拖拽预览与 openInPane 共用一份矩阵):
 * focusFileId = 当前焦点文件(active.file 的 id / 分栏焦点栏成员;纯会话=null)。
 * 返回落位后的分栏形状;undefined = 无效落位(自己拖到自己的栏),不产生任何变化。
 */
export function resolveSplit(
  cur: SplitState | null,
  focusFileId: string | null,
  tabId: string,
  pane: 'left' | 'right',
): SplitState | null | undefined {
  const ratio = cur?.ratio ?? loadSplitRatio()
  if (cur === null) {
    if (focusFileId === null) {
      // 纯会话:文件恒右(会话恒左);sessionTabId 由调用方补充绑定
      return { kind: 'session-file', sessionTabId: '', rightTabId: tabId, ratio }
    }
    if (focusFileId === tabId) return undefined
    return pane === 'left'
      ? { kind: 'file-file', leftTabId: tabId, rightTabId: focusFileId, ratio }
      : { kind: 'file-file', leftTabId: focusFileId, rightTabId: tabId, ratio }
  }
  if (cur.kind === 'session-file') {
    if (pane === 'right') {
      if (cur.rightTabId === tabId) return cur
      return { ...cur, rightTabId: tabId }
    }
    // 左侧是会话栏:文件落左 = 升级文件+文件(会话退出)
    return { kind: 'file-file', leftTabId: tabId, rightTabId: cur.rightTabId, ratio }
  }
  // file-file:该文件在另一栏 → 互换两栏(VSCode 式移动,同文件永不双栏同显);
  // 否则换入(原栏位文件换出成普通 TAB)
  const inOther = pane === 'left' ? cur.rightTabId === tabId : cur.leftTabId === tabId
  if (inOther) return { ...cur, leftTabId: cur.rightTabId, rightTabId: cur.leftTabId }
  return pane === 'left' ? { ...cur, leftTabId: tabId } : { ...cur, rightTabId: tabId }
}

/** 焦点文件 id:active.file=id;active.split=焦点栏成员;纯会话=null。 */
export function focusFileIdOf(active: ActiveTab, split: SplitState | null): string | null {
  if (active.kind === 'file') return active.id
  if (active.kind === 'split' && split !== null) {
    if (split.kind === 'session-file') return split.rightTabId
    return snapshot.active.kind === 'file' && snapshot.active.id === split.leftTabId ? split.leftTabId : split.rightTabId
  }
  return null
}

/** 形状相同判定(preview 高频提交防抖;ratio 不参与——拖动中由 setSplitRatio 单独走)。 */
function sameShape(a: SplitState | null | undefined, b: SplitState | null | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'session-file' && b.kind === 'session-file') {
    return a.sessionTabId === b.sessionTabId && a.rightTabId === b.rightTabId
  }
  if (a.kind === 'file-file' && b.kind === 'file-file') {
    return a.leftTabId === b.leftTabId && a.rightTabId === b.rightTabId
  }
  return false
}

/** 设置/清空拖拽预览(形状+源+栏位相同不提交)。 */
export function setSplitPreview(shape: SplitState | null, tabId: string, pane: 'left' | 'right'): void {
  const prev = snapshot.preview
  if (shape === null) {
    if (prev === null) return
    commit({ ...snapshot, preview: null })
    return
  }
  if (prev !== null && prev.tabId === tabId && prev.pane === pane && sameShape(prev.shape, shape)) return
  commit({ ...snapshot, preview: { shape, tabId, pane } })
}

/**
 * 把文件 TAB 放进指定栏(拖 TAB 落位/右键指定栏的核心动作):
 * - 未分栏 + 纯会话:会话+文件(文件恒右;sessionTabId 由调用方绑定 currentId)
 * - 未分栏 + 单开文件 F:id===F 忽略;否则 文件+文件(按 pane)
 * - session-file:右换文件;左 = 升级文件+文件(会话退出)
 * - file-file:该文件在另一栏 → 互换两栏;否则换入(原栏位文件换出)
 * 落位后分栏进入激活态。
 */
export function openInPane(tabId: string, pane: 'left' | 'right', sessionTabId = ''): void {
  if (!snapshot.tabs.some((tb) => tb.id === tabId)) return
  const focus = focusFileIdOf(snapshot.active, snapshot.split)
  const next = resolveSplit(snapshot.split, focus, tabId, pane)
  if (next === undefined || next === null) return
  // 纯会话建立 session-file:绑定调用方传入的宿主会话
  if (next.kind === 'session-file' && next.sessionTabId === '' && sessionTabId !== '') {
    next.sessionTabId = sessionTabId
  }
  commit({ ...snapshot, split: next, active: { kind: 'split' }, preview: null })
}

/**
 * 把当前会话放进左栏(会话 TAB 拖放的落位动作;active 必须是文件焦点)。
 * 会话恒左:未分栏 → 会话+文件(sessionTabId=拖入会话);已 session-file → 无操作。
 */
export function attachSessionPane(sessionTabId: string): void {
  if (snapshot.active.kind !== 'file') return
  if (snapshot.split !== null) return
  if (sessionTabId === '') return
  const focus = snapshot.active.id
  commit({
    ...snapshot,
    split: { kind: 'session-file', sessionTabId, rightTabId: focus, ratio: loadSplitRatio() },
    active: { kind: 'split' },
  })
}

/** 激活会话视图:纯会话(分栏休眠保存,点合并 TAB 可恢复)。 */
export function activateSession(): void {
  if (snapshot.active.kind === 'session' && snapshot.split === null) return
  commit({ ...snapshot, active: { kind: 'session' }, preview: null })
}

/** 关闭 TAB:关闭的文件在分栏中被引用时解散分栏;id 不存在静默。 */
export function closeFile(id: string): void {
  const tabs = snapshot.tabs.filter((tb) => tb.id !== id)
  if (tabs.length === snapshot.tabs.length) return
  const cur = snapshot.split
  const inSplit =
    cur !== null &&
    (cur.kind === 'file-file'
      ? cur.leftTabId === id || cur.rightTabId === id
      : cur.sessionTabId === id || cur.rightTabId === id)
  const wasActive = snapshot.active.kind === 'file' && snapshot.active.id === id
  const active: ActiveTab = inSplit || wasActive ? { kind: 'session' } : snapshot.active
  commit({ tabs, active, split: inSplit ? null : snapshot.split, preview: null })
}

/** 激活文件视图:单文件(分栏休眠保存,点合并 TAB 可恢复)。 */
export function activateFile(id: string): void {
  if (!snapshot.tabs.some((tb) => tb.id === id)) return
  if (snapshot.active.kind === 'file' && snapshot.active.id === id) return
  commit({ ...snapshot, active: { kind: 'file', id }, preview: null })
}

/**
 * 激活分栏合并视图(点合并 TAB):恢复两栏布局;session-file 场景把宿主
 * 切回绑定的会话(会话侧内容恢复)。
 */
export function activateSplit(): void {
  const cur = snapshot.split
  if (cur === null) return
  if (snapshot.active.kind === 'split') return
  commit({ ...snapshot, active: { kind: 'split' }, preview: null })
  if (cur.kind === 'session-file' && cur.sessionTabId !== '' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dshw-coding-workspace:open-session', { detail: cur.sessionTabId }))
  }
}

/** 拆分(合并 TAB 的 split 按钮):解散分栏,焦点文件保留单开(另一侧回普通 TAB)。 */
export function exitSplit(): void {
  if (snapshot.split === null) return
  let focus: string | null = null
  if (snapshot.active.kind === 'file') focus = snapshot.active.id
  else if (snapshot.active.kind === 'split' && snapshot.split.kind === 'file-file') focus = snapshot.split.rightTabId
  else if (snapshot.active.kind === 'split' && snapshot.split.kind === 'session-file') focus = snapshot.split.rightTabId
  commit({
    ...snapshot,
    split: null,
    preview: null,
    active: focus !== null ? { kind: 'file', id: focus } : { kind: 'session' },
  })
}

/** 更新脏标记(id 不存在静默)。 */
export function setFileDirty(id: string, dirty: boolean): void {
  const tab = snapshot.tabs.find((tb) => tb.id === id)
  if (tab === undefined || tab.dirty === dirty) return
  commit({ ...snapshot, tabs: snapshot.tabs.map((tb) => (tb === tab ? { ...tb, dirty } : tb)) })
}

/** 按 cwd+relPath 定位 TAB(归一比较),无则 null。 */
export function findFileTab(cwd: string, relPath: string): FileTab | null {
  const key = tabKey(cwd, relPath)
  return snapshot.tabs.find((tb) => tabKey(tb.cwd, tb.relPath) === key) ?? null
}

/** 清空全部 TAB 并回落纯会话(单测隔离/HMR 重载用)。 */
export function resetFileTabs(): void {
  commit({ tabs: [], active: { kind: 'session' }, split: null, preview: null })
}

/** 更新分栏比例(clamp 0.3~0.75,同值保持引用;持久化 localStorage)。 */
export function setSplitRatio(ratio: number): void {
  const cur = snapshot.split
  if (cur === null) return
  const r = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0.3), 0.75) : SPLIT_DEFAULT
  if (cur.ratio === r) return
  commit({ ...snapshot, split: { ...cur, ratio: r } })
  try {
    localStorage.setItem(SPLIT_KEY, String(r))
  } catch {
    /* 隐私模式等:比例只在当前页生效 */
  }
}

/** useSyncExternalStore 订阅口(引用稳定)。 */
export function fileTabsSubscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** useSyncExternalStore 快照口(引用稳定)。 */
export function fileTabsGetSnapshot(): FileTabsSnapshot {
  return snapshot
}
