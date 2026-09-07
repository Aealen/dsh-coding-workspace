/**
 * 文件编辑 TAB 全局状态(模块级外部 store,无 DOM 依赖,node --test 可直测)。
 *
 * 顶部栏 TAB 行同时承载「会话 TAB」与「文件 TAB」两类页签:会话激活态由宿主
 * currentId 驱动(topbar.tsx),文件 TAB 的清单与激活对象在本 store;两者合成
 * 「当前激活对象 = 会话 | 文件」——文件激活时编辑器覆盖层盖住对话区,点会话
 * TAB 即回落。独立成模块避免 client.tsx ↔ topbar.tsx 循环 import
 * (session-status.ts 同款考量)。
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

/** 激活对象:宿主会话(覆盖层收起)或某个文件 TAB(覆盖层展开)。 */
export type ActiveTab = { kind: 'session' } | { kind: 'file'; id: string }

export interface FileTabsSnapshot {
  tabs: readonly FileTab[]
  active: ActiveTab
}

let seq = 0
let snapshot: FileTabsSnapshot = { tabs: [], active: { kind: 'session' } }
const listeners = new Set<() => void>()

/** cwd/相对路径归一:反斜杠转正斜杠(trim;与 topbar-core.normalizeCwd 同约定)。 */
function normalize(p: string): string {
  return typeof p === 'string' ? p.trim().replace(/\\/g, '/') : ''
}

/** 归一 key:同文件判定(cwd + relPath)。 */
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
 */
export function openFile(opts: { cwd: string; relPath: string; view?: 'edit' | 'diff' }): string {
  const cwd = normalize(opts.cwd)
  const relPath = normalize(opts.relPath)
  if (cwd === '' || relPath === '') return ''
  // 图片扩展名优先:任何入口均走预览(二进制没有编辑/diff 语义)
  const view: FileTab['view'] = isImagePath(relPath) ? 'image' : opts.view === 'diff' ? 'diff' : 'edit'
  const key = tabKey(cwd, relPath)
  const existing = snapshot.tabs.find((tb) => tabKey(tb.cwd, tb.relPath) === key)
  if (existing !== undefined) {
    if (existing.view === view && snapshot.active.kind === 'file' && snapshot.active.id === existing.id) {
      return existing.id // 无变化:保持快照引用
    }
    commit({
      tabs: snapshot.tabs.map((tb) => (tb === existing ? { ...tb, view } : tb)),
      active: { kind: 'file', id: existing.id },
    })
    return existing.id
  }
  const tab: FileTab = { id: `file-${++seq}`, cwd, relPath, view, dirty: false }
  commit({ tabs: [...snapshot.tabs, tab], active: { kind: 'file', id: tab.id } })
  return tab.id
}

/** 关闭 TAB:关闭激活 TAB 时焦点回落会话;id 不存在静默。 */
export function closeFile(id: string): void {
  const tabs = snapshot.tabs.filter((tb) => tb.id !== id)
  if (tabs.length === snapshot.tabs.length) return
  const active: ActiveTab =
    snapshot.active.kind === 'file' && snapshot.active.id === id ? { kind: 'session' } : snapshot.active
  commit({ tabs, active })
}

/** 激活指定文件 TAB(不存在则维持原状)。 */
export function activateFile(id: string): void {
  if (!snapshot.tabs.some((tb) => tb.id === id)) return
  if (snapshot.active.kind === 'file' && snapshot.active.id === id) return
  commit({ ...snapshot, active: { kind: 'file', id } })
}

/** 激活对象切回会话(覆盖层收起);已是会话则保持引用。 */
export function activateSession(): void {
  if (snapshot.active.kind === 'session') return
  commit({ ...snapshot, active: { kind: 'session' } })
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

/** 清空全部 TAB 并回落会话(单测隔离/HMR 重载用)。 */
export function resetFileTabs(): void {
  commit({ tabs: [], active: { kind: 'session' } })
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
