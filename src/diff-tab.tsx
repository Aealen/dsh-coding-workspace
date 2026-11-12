/**
 * dshw-diff:历史 commit 的文件 diff 视图(只读),挂官方右侧栏。
 *
 * 入口:Git Logs 里点某个 commit 的变更文件(hash^ vs hash 双版对齐)。
 * 普通「工作区 vs HEAD」的文件 diff 走 dshw-editor(可编辑 + 内联 diff),
 * 不复用本视图——两者的可编辑性语义不同。
 *
 * 地址编码:资源地址第二段用 base64url(JSON),避免 Windows 盘符、空格、
 * 中文路径在 glob 匹配与 URI 解析上的歧义;地址只作 tab 身份与内容去重,
 * 实际数据仍由插件自有 HTTP 路由(git-commit-diff)读取。
 */
import { jsx } from 'react/jsx-runtime'
import { CommitDiffView } from './file-editor.js'
import type { FileTab } from './file-tabs.js'

/** 资源地址前缀(patterns 注册用同一常量)。 */
export const DIFF_ADDRESS_PATTERN = 'dsh-resource://dshw-diff/**'
const DIFF_SCHEME = 'dsh-resource://dshw-diff/'

/** commit diff 目标(Git Logs 的变更文件行)。 */
export interface CommitDiffTarget {
  /** 工作区根(绝对路径,分隔符随意,消费端归一)。 */
  cwd: string
  /** 文件路径(Git 输出的相对路径;改名时取新名)。 */
  path: string
  /** commit 全 hash。 */
  hash: string
  /** 改名场景的旧路径(取基准版本用)。 */
  from?: string
}

/** UTF-8 安全的 base64url 编码(地址段用,免转义)。 */
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

/** 目标 → 资源地址(dshw-diff tab 的唯一身份)。 */
export function commitDiffAddress(target: CommitDiffTarget): string {
  return `${DIFF_SCHEME}${encodeSegment(JSON.stringify(target))}`
}

/** 资源地址 → 目标;非法返回 undefined(不抛,正文退回空态)。 */
export function parseCommitDiffAddress(address: string): CommitDiffTarget | undefined {
  if (!address.startsWith(DIFF_SCHEME)) return undefined
  const raw = decodeSegment(address.slice(DIFF_SCHEME.length).split(/[?#]/)[0] ?? '')
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<CommitDiffTarget>
    if (typeof parsed.cwd !== 'string' || typeof parsed.path !== 'string' || typeof parsed.hash !== 'string') return undefined
    return {
      cwd: parsed.cwd,
      path: parsed.path,
      hash: parsed.hash,
      ...(typeof parsed.from === 'string' ? { from: parsed.from } : {}),
    }
  } catch {
    return undefined
  }
}

/** 打开资源的通道(client apply 时注入 ctx.sidebarRight.openResource);
 *  服务缺席(旧宿主/headless)时为空,调用降级为静默。 */
let resourceOpener: ((address: string) => void) | undefined

/** client apply 注入打开通道。 */
export function setResourceOpener(fn: ((address: string) => void) | undefined): void {
  resourceOpener = fn
}

/** 打开 commit diff tab(供 Git Logs 调用;同一 commit+文件自动去重聚焦)。 */
export function openCommitDiff(target: CommitDiffTarget): void {
  const address = commitDiffAddress(target)
  try {
    resourceOpener?.(address)
  } catch {
    // 无会话面/服务缺席:静默(入口不因打开失败崩)
  }
}

/** 官方 pane.tab 正文:解析地址 → 复用 CommitDiffView 渲染(只读)。 */
export function DiffBody(props: any): any {
  const useTabInfo = props.useTabInfo as (() => any) | undefined
  let info: any = undefined
  try {
    info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
  } catch {
    // dock 尚未提交该 tab(useTabInfo 对未提交 tab 直接 throw);slot 渲染层对
    // keyed 条目捕获后走 abdicate=true(注销整个 tab 类型)——吞掉异常退占位,
    // 等 tab 提交后的下一次渲染自然恢复。
    return jsx('div', { style: { padding: 24, opacity: 0.5, fontSize: 12 }, children: '…' })
  }
  const address =
    (typeof info?.tab?.navigation?.address === 'string' ? info.tab.navigation.address : undefined) ??
    (typeof info?.tab?.contentId === 'string' ? info.tab.contentId : '')
  const target = parseCommitDiffAddress(address)
  if (target === undefined) {
    return jsx('div', {
      style: { padding: 24, fontSize: 12, opacity: 0.6 },
      children: 'diff 地址无法解析',
    })
  }
  // CommitDiffView 只读 FileTab 的 cwd/relPath/commit/commitFrom 四个字段
  const pseudoTab: FileTab = {
    id: `diff-${target.hash}`,
    cwd: target.cwd,
    relPath: target.path,
    view: 'diff',
    dirty: false,
    commit: target.hash,
    ...(target.from !== undefined ? { commitFrom: target.from } : {}),
  }
  return jsx('div', {
    style: { height: '100%', minHeight: 0, overflow: 'auto', background: 'var(--dsw-alias-bg-base)' },
    children: jsx(CommitDiffView, { tab: pseudoTab }),
  })
}
