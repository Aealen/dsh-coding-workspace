/**
 * dshw-editor:可编辑文件 tab,挂官方右侧栏。
 *
 * 入口:资源管理器双击文件、Git Changes 点文件(工作区 HEAD↔当前 inline diff 同视图)。
 * 只读预览走官方 documentpreview(聊天文件链接、官方 files 树),两者互不抢占地址。
 *
 * 能力(全部保留):行号 gutter、语法高亮、Ctrl+S 保存(fs-write 原子写)、
 * 自管撤回重做、HEAD 基准的内联删除带/新增染色、右缘改动状态条、行评论 Note for AI。
 * 分栏由官方 dock 提供(split pane);不再自带 TAB 分组。
 *
 * 地址:第二段 base64url(JSON{cwd,relPath}),同文件同地址 → tab 自动去重。
 */
import { jsx } from 'react/jsx-runtime'
import { EditView } from './file-editor.js'
import type { FileTab } from './file-tabs.js'
import { getPanelBridge } from './panel.js'

/** 资源地址前缀(patterns 注册用同一常量)。 */
export const EDITOR_ADDRESS_PATTERN = 'dsh-resource://dshw-file/**'
const EDITOR_SCHEME = 'dsh-resource://dshw-file/'

/** 编辑器目标:工作区根 + 相对路径。 */
export interface EditorTarget {
  cwd: string
  relPath: string
}

function encodeSegment(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeSegment(segment: string): string | undefined {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/** 目标 → 资源地址(tab 唯一身份,同文件去重)。 */
export function editorAddress(target: EditorTarget): string {
  return `${EDITOR_SCHEME}${encodeSegment(JSON.stringify(target))}`
}

/** 资源地址 → 目标;非法返回 undefined。 */
export function parseEditorAddress(address: string): EditorTarget | undefined {
  if (!address.startsWith(EDITOR_SCHEME)) return undefined
  const raw = decodeSegment(address.slice(EDITOR_SCHEME.length).split(/[?#]/)[0] ?? '')
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<EditorTarget>
    if (typeof parsed.cwd !== 'string' || typeof parsed.relPath !== 'string') return undefined
    if (parsed.cwd === '' || parsed.relPath === '') return undefined
    return { cwd: parsed.cwd, relPath: parsed.relPath }
  } catch {
    return undefined
  }
}

/**
 * 打开编辑器 tab(供资源管理器 / Git Changes 调用);打开通道由 client apply 注入。
 * @param options.preferNewPane 先尝试官方 split 出新分栏(两格上限/宽度规则由宿主判断),
 *   做不到时落回活跃 pane —— 对应原「在右/左栏打开」的分栏诉求。
 */
export function openEditor(target: EditorTarget, options?: { preferNewPane?: boolean }): void {
  try {
    getResourceOpener()?.(editorAddress(target), options)
  } catch {
    // 无会话面/服务缺席:静默
  }
}

/** 打开通道(diff-tab 与 editor-tab 共用 client 注入的 ctx.sidebarRight.openResource)。 */
let opener: ((address: string, options?: { preferNewPane?: boolean }) => void) | undefined

export function setEditorResourceOpener(
  fn: ((address: string, options?: { preferNewPane?: boolean }) => void) | undefined,
): void {
  opener = fn
}

function getResourceOpener(): ((address: string, options?: { preferNewPane?: boolean }) => void) | undefined {
  return opener
}

/** 官方 pane.tab 正文:解析地址 → 复用 EditView(可编辑 + inline diff + 行评论)。 */
export function EditorBody(props: any): any {
  const useTabInfo = props.useTabInfo as (() => any) | undefined
  const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
  const address =
    (typeof info?.tab?.navigation?.address === 'string' ? info.tab.navigation.address : undefined) ??
    (typeof info?.tab?.contentId === 'string' ? info.tab.contentId : '')
  const target = parseEditorAddress(address)
  if (target === undefined) {
    return jsx('div', {
      style: { padding: 24, fontSize: 12, opacity: 0.6 },
      children: '文件地址无法解析',
    })
  }
  // EditView 只用 cwd/relPath/id 三字段;dirty 由 file-tabs store 自管(setFileDirty
  // 对未知 id 静默),右栏 tab 的脏标记不进 TAB 标题(官方 chip 不感知插件状态)。
  const pseudoTab: FileTab = {
    id: `editor-${address}`,
    cwd: target.cwd,
    relPath: target.relPath,
    view: 'edit',
    dirty: false,
  }
  return jsx('div', {
    style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)' },
    children: jsx(EditView, { tab: pseudoTab, bridge: getPanelBridge() }),
  })
}
