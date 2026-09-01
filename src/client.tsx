/**
 * dsh-worktree 客户端半区:侧栏「项目」分组视图(P4-M3 乙路线)。
 *
 * 层级:项目(git 主仓)→ 工作区(主工作区带 TAG,worktree 并列)→ 会话。
 * 交互用官方原语库 @deepseek-ai/dsh-client-ui-primitives(shell 种子模块,
 * 发布给所有插件用,非 vendoring);动作全部接客户端 ctx 公开 API:
 * - ctx.sessions.open / fork / binding().session.rename
 * - ctx.workspaces.startSession / rename / delete / archiveSession
 *
 * ⚠️ jsx-runtime:children 必须放 props.children(第三参是 key)。
 */

/** 行 hover 样式:内联 style 写不了伪类,factory 物化时注入一次。 */
function injectStyles(): void {
  if (document.getElementById('dshw-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dshw-style'
  style.textContent = `
    .dshw-row:hover, .dshw-row[data-active] { background: var(--dsw-alias-interactive-bg-hover) !important; }
    .dshw-wsrow:hover, .dshw-grouphdr:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .dshw-row:hover button, .dshw-wsrow:hover button, .dshw-grouphdr:hover button { opacity: 0.9; }
    .dshw-opt { cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 8px 10px; }
    .dshw-opt:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .dshw-opt.disabled { opacity: 0.45; cursor: not-allowed; }
    /* Modal 表单控件:对齐原版 Modal 输入框设计语言(border-l2/透明底/label-primary/14px)
       font-family 必须显式继承——input/textarea/select 默认用 UA 字体,与宿主字体不搭 */
    .dshw-modal { width: min(620px, 100%); }
    .dshw-field {
      box-sizing: border-box;
      height: 34px;
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 10px;
      background: transparent;
      color: var(--dsw-alias-label-primary);
      font-family: inherit;
      font-size: 14px;
      line-height: 20px;
      padding: 0 12px;
      outline: none;
      transition: border-color 0.12s var(--ds-ease-in-out, ease);
    }
    .dshw-field::placeholder { color: var(--dsw-alias-label-dimmed); }
    .dshw-field:focus { border-color: var(--dsw-alias-brand-primary); }
    .dshw-field:disabled { color: var(--dsw-alias-label-dimmed); }
    .dshw-radio { accent-color: var(--dsw-alias-brand-primary); width: 14px; height: 14px; margin: 0; cursor: pointer; font-family: inherit; }
    /* 多行备注:覆盖 .dshw-field 的定高,3 行视觉 */
    textarea.dshw-field { height: auto; min-height: 68px; padding: 8px 12px; resize: none; }
    /* 侧栏行操作按钮:hover 才显现(对齐原版 rowActions 行为) */
    .dshw-row > button, .dshw-wsrow > button, .dshw-grouphdr > button { opacity: 0; transition: opacity 0.12s var(--ds-ease-in-out, ease); }
    .dshw-row:hover > button, .dshw-wsrow:hover > button, .dshw-grouphdr:hover > button, .dshw-row[data-active] > button { opacity: 0.9; }
    /* Menu 原语给 anchor 包 auto 宽 wrapper(span),铺满用 */
    .dshw-anchor-wrap > span { flex: 1; display: flex; min-width: 0; }
    .dshw-anchor-wrap > span > button { width: 100%; }
    /* 分支卡片:工作区下分支+会话的容器(对齐目标稿的卡片层次) */
    .dshw-branchcard {
      background: var(--dsw-alias-bg-multi-select, rgba(127, 127, 127, 0.07));
      border-radius: 10px;
      padding: 2px;
      margin: 1px 6px 2px 30px;
    }
    .dshw-branchcard[data-active] {
      background: var(--dsw-alias-interactive-bg-hover);
      outline: 1px solid var(--dsw-alias-border-l2);
    }
  `
  document.head.appendChild(style)
}
import type { Context } from '@deepseek-ai/cordis'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** DeepSeek 官方鲸鱼 logo(llobehub brand SVG 内联,currentColor 可控色)。 */
function DeepSeekIcon(props: { size?: number }) {
  return jsx('svg', {
    width: props.size ?? 14,
    height: props.size ?? 14,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    fillRule: 'evenodd',
    'aria-label': 'DeepSeek',
    style: { flexShrink: 0 },
    children: jsx('path', { d: 'M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z' }),
  })
}

/** 归档视图开关:宿主暂无 unarchive API,归档会话被禁止设为当前会话(runtime 强制 clear)。
 *  查看可行但「打开」是无效交互,故入口先隐藏;官方补 API 后翻 true 即可。 */
const ARCHIVE_VIEW_ENABLED = false

/** 宿主 sessions.list 快照源(apply 时捕获):running/completed/pendingInteraction
 *  由宿主 mux 帧实时推送(session.handleRunning 中继),useSyncExternalStore 订阅即可,免轮询。 */
let liveSessionsSource: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null = null
/** uSES 要求 subscribe/getSnapshot 引用跨渲染稳定,包一层模块级常量并内部消化未捕获态。 */
const stableSubscribe = (cb: () => void): (() => void) => {
  const src = liveSessionsSource
  return src !== null ? src.subscribe(cb) : () => {}
}
const stableGetSnapshot = (): unknown => liveSessionsSource?.getSnapshot()

/** 会话状态占位(对齐官方侧栏 sessionStatuses 优先级):
 *  等用户交互(审批/计划/提问)= warning 琥珀点 > 运行中 = ongoing 像素矩阵动画 > 完成未读 = 绿色对勾;空闲留空占位。 */
function SessionStatus(props: { running?: boolean; completed?: boolean; pending?: string }) {
  if (props.pending !== undefined) return jsx(Primitives.StateDot, { state: 'warning', size: 10 })
  if (props.running === true) return jsx(Primitives.StateDot, { state: 'ongoing', size: 10 })
  if (props.completed === true) {
    return jsx('span', {
      style: { display: 'inline-flex', flexShrink: 0, color: 'var(--dsw-alias-state-success-primary)', lineHeight: 0 },
      children: jsx(Primitives.IconCheckOutline16, { size: 12 }),
    })
  }
  return null
}

export const name = 'dsh-worktree'

/** slots + sessions/open/fork/binding + workspaces/startSession/rename/delete/archiveSession。 */
export const inject = ['slots', 'sessions', 'workspaces']

interface WorkspaceRow {
  workspaceId: string
  path: string
  title?: string
  sessionIds: string[]
}

interface SessionRow {
  sessionId: string
  cwd?: string
  updatedAt?: number
  running?: boolean
  /** 完成于未选中且未打开(宿主侧栏绿色「完成」提醒);实时值走 sessions.list 快照。 */
  completed?: boolean
  /** 用户交互阻塞中:'approval' | 'plan-review' | 'question'。 */
  pendingInteraction?: string
  blank?: boolean
  projections?: { values?: { title?: string | null } }
}

type RenameTarget = {
  kind: 'session' | 'workspace'
  id: string
  draft: string
  /** workspace 专属:meta 写回所需 */
  path?: string
  icon?: string
  color?: string
}

interface LineageEdge {
  parentPath?: string | null
  branch?: string
}

/** 同源 RPC(与宿主前端形态一致)。 */
async function rpc<T = any>(method: string): Promise<T> {
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {} }),
  })
  const body = await res.json()
  if (!body?.result?.ok) throw new Error(`${method}: ${body?.result?.error?.message ?? res.status}`)
  return body.result.value as T
}

/** 插件自有 HTTP 路由 POST,解析 JSON 响应。 */
async function postJson(url: string, payload: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

/** 分支名 → 目录段:路径非法字符与空白折叠为 -。 */
function sanitizeBranchSegment(branch: string): string {
  return (
    branch
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'worktree'
  )
}

function joinPath(dir: string, segment: string): string {
  return `${dir.replace(/[\\/]+$/, '')}\\${segment}`
}

/** 相对时间:分钟内/小时/天,超过 30 天显示日期。 */
function relTime(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined || ts <= 0) return ''
  const diff = now - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时`
  const day = Math.floor(hour / 24)
  if (day <= 30) return `${day} 天`
  return new Date(ts).toLocaleDateString()
}

/** 路径哈希 → 5 色文件夹调色板(对齐目标稿的彩色工作区图标)。 */
const FOLDER_HUES = ['#4c9fd6', '#d6a24c', '#4cbf8e', '#a98ce0', '#d6689f']
function folderHue(path: string): string {
  let h = 0
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0
  return FOLDER_HUES[Math.abs(h) % FOLDER_HUES.length]
}

/** 工作区可选图标集(id ↔ primitives 渲染)。 */
const WS_ICON_IDS = ['branch', 'folder', 'data', 'code', 'sparkle', 'goal']
function renderWsIcon(id: string): any {
  switch (id) {
    case 'folder': return jsx(Primitives.IconFolderClose16, {})
    case 'data': return jsx(Primitives.IconDataOutline16, {})
    case 'code': return jsx(Primitives.IconCodeOutline16, {})
    case 'sparkle': return jsx(Primitives.IconSparkle16, {})
    case 'goal': return jsx(Primitives.IconGoalOutline16, {})
    default: return jsx(Primitives.IconBranchOutline16, {})
  }
}

/** 工作区图标色板(含默认灰)。 */
const PALETTE = ['#88919c', '#4c9fd6', '#d6a24c', '#4cbf8e', '#a98ce0', '#d6689f', '#e06c75']

/** 名称展示用等宽字体(对齐目标稿;走宿主 code 字体变量,双主题一致)。 */
const monoFont: Record<string, string | number> = { fontFamily: 'var(--ds-font-family-code, inherit)' }

// 新建工作区 Modal 表单样式
// 关键:行内 flex 子项一律 minWidth:0,长值(路径/分支名)才能收缩不撑破 Modal;
// 视觉(边框/底色/圆角/品牌色)全走 .dshw-field 类(injectStyles),这里只管布局。
const fieldLabel: Record<string, string | number> = { fontSize: 12, opacity: 0.65, fontWeight: 600 }
const radioRow: Record<string, string | number> = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, width: '100%' }
const inlineInput: Record<string, string | number> = { minWidth: 0, flex: 1 }
const shrinkNone: Record<string, string | number> = { flexShrink: 0, whiteSpace: 'nowrap' }

/** 新建工作区 Modal 表单体(模块级纯渲染,props 从组件传入)。 */
function buildCreateWsBody(p: {
  createWs: { repoPath: string | null } | null
  repoInfo: { currentBranch: string | null; locals: string[]; remotes: Array<{ name: string; branches: string[] }>; occupiedBranches: string[]; originShort: string } | null
  branchMode: 'new' | 'existing'
  setBranchMode: (m: 'new' | 'existing') => void
  newBranchName: string
  updateNewBranchName: (name: string) => void
  existingBranch: string
  setExistingBranch: (v: string) => void
  baseSpec: string
  setBaseSpec: (v: string) => void
  wsNote: string
  setWsNote: (v: string) => void
  wsTitle: string
  setWsTitle: (v: string) => void
  advancedOpen: boolean
  setAdvancedOpen: (v: boolean) => void
  wsPath: string
  setWsPath: (v: string) => void
  pickDirectory: () => void
  createBusy: boolean
  submitCreateWs: () => void
}) {
  const isRepo = p.createWs?.repoPath !== null
  const repoName =
    p.createWs?.repoPath !== undefined && p.createWs.repoPath !== null
      ? p.createWs.repoPath.replace(/\\/g, '/').split('/').pop() ?? ''
      : ''
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 560 },
    children: [
      // 项目(参考稿:只读行,右侧远程短名)
      isRepo
        ? jsxs('div', {
            key: 'repo',
            style: { display: 'flex', flexDirection: 'column', gap: 4 },
            children: [
              jsx('div', { style: fieldLabel, children: '项目' }),
              jsxs('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 34,
                  padding: '0 12px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 10,
                },
                children: [
                  jsx('span', {
                    key: 'ico',
                    style: { display: 'inline-flex', opacity: 0.75, color: folderHue(p.createWs?.repoPath ?? '') },
                    children: jsx(Primitives.IconFolderClose16, {}),
                  }),
                  jsx('span', { key: 'n', style: { fontSize: 14, color: 'var(--dsw-alias-label-primary)', ...monoFont }, children: repoName }),
                  jsx('span', { key: 'sp', style: { flex: 1 } }),
                  jsx('span', { key: 'o', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', ...monoFont }, children: p.repoInfo?.originShort ?? '' }),
                ],
              }),
            ],
          })
        : null,
      // 分支双 Radio(老大定版):新建分支=名称+源分支;复用=直接选源分支
      isRepo
        ? jsxs('div', {
            key: 'source',
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
            children: [
              jsxs('label', {
                style: radioRow,
                children: [
                  jsx('input', {
                    type: 'radio',
                    name: 'dshw-branch-mode',
                    checked: p.branchMode === 'new',
                    onChange: () => p.setBranchMode('new'),
                    className: 'dshw-radio',
                    style: shrinkNone,
                  }),
                  jsx('span', { style: shrinkNone, children: '新建分支' }),
                ],
              }),
              p.branchMode === 'new'
                ? jsxs('div', {
                    key: 'new-pane',
                    style: { display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 22 },
                    children: [
                      jsx('input', {
                        className: 'dshw-field',
                        value: p.newBranchName,
                        disabled: p.createBusy,
                        placeholder: '新分支名称',
                        onChange: (e: any) => p.updateNewBranchName(e.target.value),
                        style: { width: '100%' },
                      }),
                      jsxs('div', {
                        style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
                        children: [
                          jsx('span', { style: { ...shrinkNone, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }, children: '基于' }),
                          jsx('div', { style: { minWidth: 0, flex: 1, display: 'flex' }, children: jsx(BranchSelect, {
                            value: p.baseSpec,
                            onChange: p.setBaseSpec,
                            repoInfo: p.repoInfo,
                            disabled: p.createBusy || p.repoInfo === null,
                            allowNew: false,
                            emptyLabel: '主仓当前分支(HEAD)',
                          }) }),
                        ],
                      }),
                    ],
                  })
                : null,
              jsxs('label', {
                style: radioRow,
                children: [
                  jsx('input', {
                    type: 'radio',
                    name: 'dshw-branch-mode',
                    checked: p.branchMode === 'existing',
                    onChange: () => p.setBranchMode('existing'),
                    className: 'dshw-radio',
                    style: shrinkNone,
                  }),
                  jsx('span', { style: shrinkNone, children: '复用已有分支' }),
                ],
              }),
              p.branchMode === 'existing'
                ? jsx('div', {
                    key: 'exist-pane',
                    style: { paddingLeft: 22 },
                    children: jsx(BranchSelect, {
                      value: p.existingBranch,
                      onChange: p.setExistingBranch,
                      repoInfo: p.repoInfo,
                      disabled: p.createBusy || p.repoInfo === null,
                      allowNew: false,
                    }),
                  })
                : null,
              p.repoInfo !== null && p.repoInfo.currentBranch !== null
                ? jsx('div', { style: { fontSize: 12, opacity: 0.6 }, children: `主工作区当前分支:${p.repoInfo.currentBranch}` })
                : null,
            ],
          })
        : jsx('div', { key: 'noRepo', style: { fontSize: 12, opacity: 0.6 }, children: '未关联 git 项目:仅注册目录为工作区(不建 worktree)' }),
      // 高级折叠:工作区名称 / 备注 / 路径
      jsxs('div', {
        key: 'advanced',
        style: { display: 'flex', flexDirection: 'column', gap: 10 },
        children: [
          jsxs('div', {
            onClick: () => p.setAdvancedOpen(!p.advancedOpen),
            style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' },
            children: [
              jsx('span', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }, children: '高级' }),
              jsx('span', { style: { opacity: 0.6, fontSize: 12, display: 'inline-block', transition: 'transform 120ms', transform: p.advancedOpen ? 'rotate(-90deg)' : 'none' }, children: '▾' }),
            ],
          }),
          p.advancedOpen
            ? jsxs('div', {
                style: { display: 'flex', flexDirection: 'column', gap: 10 },
                children: [
                  jsxs('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: 4 },
                    children: [
                      jsx('div', { style: fieldLabel, children: '工作区名称' }),
                      jsx('input', {
                        className: 'dshw-field',
                        value: p.wsTitle,
                        disabled: p.createBusy,
                        placeholder: '留空则与分支名一致',
                        onChange: (e: any) => p.setWsTitle(e.target.value),
                        style: { width: '100%' },
                      }),
                    ],
                  }),
                  jsxs('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: 4 },
                    children: [
                      jsx('div', { style: fieldLabel, children: '备注' }),
                      jsx('textarea', {
                        className: 'dshw-field',
                        rows: 3,
                        value: p.wsNote,
                        disabled: p.createBusy,
                        placeholder: '这个工作区用来做什么',
                        onChange: (e: any) => p.setWsNote(e.target.value),
                        style: { width: '100%' },
                      }),
                    ],
                  }),
                  jsxs('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: 4 },
                    children: [
                      jsx('div', { style: fieldLabel, children: '工作区路径' }),
                      jsxs('div', {
                        style: { display: 'flex', gap: 6, minWidth: 0 },
                        children: [
                          jsx('input', {
                            className: 'dshw-field',
                            value: p.wsPath,
                            disabled: p.createBusy,
                            placeholder: isRepo ? '自动生成,可修改' : '输入目录绝对路径',
                            onChange: (e: any) => p.setWsPath(e.target.value),
                            onKeyDown: (e: any) => {
                              if (e.key === 'Enter' && p.wsPath.trim() !== '') p.submitCreateWs()
                            },
                            style: inlineInput,
                          }),
                          jsx(Primitives.Button, {
                            variant: 'outline',
                            disabled: p.createBusy,
                            onClick: () => p.pickDirectory(),
                            style: shrinkNone,
                            children: '选择文件夹',
                          }),
                        ],
                      }),
                      isRepo
                        ? jsx('div', { style: { fontSize: 12, opacity: 0.6 }, children: '默认落在主仓 .worktree/ 下(自动加入 .gitignore)' })
                        : null,
                    ],
                  }),
                ],
              })
            : null,
        ].filter(Boolean),
      }),
    ],
  })
}

function sessionLabel(s: SessionRow | undefined, id: string, overrides?: Record<string, string>): string {
  const override = overrides?.[id]
  if (override !== undefined) return override
  const title = s?.projections?.values?.title
  if (title && title.trim() !== '') return title
  return id.replace(/^session-/, '').slice(0, 8)
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return norm.slice(norm.lastIndexOf('/') + 1) || norm
}

const UNPINNED = '__ungrouped__'

// 字号/行高对齐原版侧栏:.title 14px/20px、sessionRow 高 32、projectRow 高 34
const rowBase: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  lineHeight: '20px',
  borderRadius: 8,
  minHeight: 32,
}

const menuBtnStyle: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'center',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  opacity: 0.55,
  cursor: 'pointer',
  padding: '2px',
  borderRadius: 4,
}

/** 菜单项:icon 原语 + disabled(官方 Menu 原生支持,对齐 ui-workspace 用法)。 */
type MenuItem = { id: string; label: string; danger?: boolean; disabled?: boolean; icon?: any }

/** 行尾三点菜单(官方 Menu 原语,anchor 模式)。 */
function RowMenu(props: { items: MenuItem[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return jsx(Primitives.Menu, {
    open,
    onClose: () => setOpen(false),
    items: props.items,
    onSelect: (id: string) => {
      setOpen(false)
      props.onSelect(id)
    },
    portal: true,
    closeOnPointerLeave: true,
    anchor: jsx('button', {
      type: 'button',
      style: menuBtnStyle,
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation()
        setOpen((v: boolean) => !v)
      },
      children: jsx(Primitives.IconEllipsisOutline16, {}),
    }),
  })
}

/**
 * 分支下拉:官方 Menu 原语(原生侧栏同款弹层,主题一致、自动滚动)。
 * items 用 type:'label' 分组(本地/各 remote)+ type:'separator' 分隔,
 * selectedId 驱动选中勾。替代原生 select——其弹层样式不可控(白底问题实证)。
 */
function BranchSelect(props: {
  value: string
  onChange: (id: string) => void
  repoInfo: { currentBranch: string | null; locals: string[]; remotes: Array<{ name: string; branches: string[] }>; occupiedBranches: string[]; originShort: string } | null
  disabled: boolean
  /** 是否提供「新建分支…」项(复用模式下关闭) */
  allowNew?: boolean
  /** value 为空时 anchor 显示的文案 */
  emptyLabel?: string
}) {
  const [open, setOpen] = useState(false)
  // 已被主仓/任意 worktree 检出的分支:同分支不能进第二个 worktree,禁选并标注
  const occupied = props.repoInfo?.occupiedBranches ?? []
  const mark = (branch: string, label: string, id: string): { id: string; label: string; disabled?: boolean } => {
    const busy = occupied.includes(branch)
    return busy ? { id, label: `${label}(已有工作区)`, disabled: true } : { id, label }
  }
  const remoteMatch = /^remote:(.+):(.+)$/.exec(props.value)
  const valueLabel =
    props.value === ''
      ? (props.emptyLabel ?? null)
      : props.value === '__new__'
        ? '新建分支…'
        : remoteMatch !== null
          ? `${remoteMatch[1]}/${remoteMatch[2]}`
          : props.value.replace(/^local:/, '')
  const items: any[] = []
  if (props.allowNew !== false) items.push({ id: '__new__', label: '新建分支…' })
  if (props.repoInfo !== null && (props.repoInfo.locals.length > 0 || props.repoInfo.remotes.length > 0)) {
    items.push({ type: 'separator', id: 'sep-new' })
  }
  if (props.repoInfo !== null) {
    if (props.repoInfo.locals.length > 0) {
      items.push({ type: 'label', id: 'lbl-local', text: '本地分支' })
      for (const b of props.repoInfo.locals) items.push(mark(b, b, `local:${b}`))
      if (props.repoInfo.remotes.length > 0) items.push({ type: 'separator', id: 'sep-remotes' })
    }
    for (const r of props.repoInfo.remotes) {
      items.push({ type: 'label', id: `lbl-${r.name}`, text: r.name })
      for (const b of r.branches) items.push(mark(b, `${r.name}/${b}`, `remote:${r.name}:${b}`))
    }
  }
  return jsx(
    'div',
    {
      // Menu 会给 anchor 包一层 auto 宽 wrapper,这里外撑 flex 占位、内铺 100%
      className: 'dshw-anchor-wrap',
      style: { minWidth: 0, flex: 1, display: 'flex' },
      children: jsx(Primitives.Menu, {
        open,
        onClose: () => setOpen(false),
        items:
          items.length > 0
            ? items
            : [{ type: 'label', id: 'lbl-loading', text: props.repoInfo === null ? '读取中…' : '暂无分支' }],
        /* emptyLabel 走 anchor 文案 */
        selectedId: props.value === '' ? undefined : props.value,
        onSelect: (id: string) => {
          setOpen(false)
          props.onChange(id)
        },
        portal: true,
        anchor: jsx('button', {
          type: 'button',
          className: 'dshw-field',
          disabled: props.disabled,
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            if (!props.disabled) setOpen((v: boolean) => !v)
          },
          style: {
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            textAlign: 'left',
            cursor: props.disabled ? 'default' : 'pointer',
          },
          children: [
            jsx(
              'span',
              {
                key: 'v',
                style: {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: valueLabel === null ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsw-alias-label-primary)',
                },
                children: valueLabel ?? props.emptyLabel ?? '选择分支',
              },
            ),
            jsx('span', { key: 'a', style: { flexShrink: 0, opacity: 0.6 }, children: '▾' }),
          ],
        }),
      }),
    },
  )
}

/** 主工作区 TAG。 */function MainTag() {
  return jsx(
    'span',
    {
      style: {
        fontSize: 10,
        lineHeight: '14px',
        padding: '0 5px',
        borderRadius: 4,
        border: '1px solid var(--dsw-alias-border-l2)',
        opacity: 0.8,
        flexShrink: 0,
      },
      children: '主要',
    },
  )
}

interface Actions {
  open: (sessionId: string) => void
  startSession: (workspaceId: string) => void
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** mode=focus 走插件 HTTP 路由(机械摘要种子);full 走宿主原生 fork。 */
  forkSession: (sessionId: string, mode: 'full' | 'focus') => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  renameWorkspace: (workspaceId: string, title: string) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  createWorkspace: (path: string) => Promise<void>
  /** 仓库分支清单 + 当前分支 + 已被 worktree 占用的分支(POST /dsh-worktree/repo-info)。 */
  repoInfo: (repoPath: string) => Promise<{ currentBranch: string | null; locals: string[]; remotes: Array<{ name: string; branches: string[] }>; occupiedBranches: string[]; originShort: string }>
  /** 系统目录选择器(宿主 workspaces.pickDirectory;取消返回 null)。 */
  pickDirectory: () => Promise<string | null>
  /** git worktree add 全链路(POST /dsh-worktree/worktree-create)。 */
  createWorktree: (input: { repoPath: string; targetPath: string; mode: 'new' | 'existing'; branchName: string; remote?: string; note?: string; title?: string; baseBranch?: string; baseRemote?: string }) => Promise<void>
  /** 工作区元数据写回:备注/图标/颜色(POST /dsh-worktree/workspace-note)。 */
  setWorkspaceMeta: (targetPath: string, meta: { note?: string; icon?: string; color?: string }) => Promise<void>
  /** 会话摘要批量懒加载(POST /dsh-worktree/session-summaries)。 */
  sessionSummaries: (ids: string[]) => Promise<Record<string, string>>
}

/** 项目分组视图:项目 → 工作区(主 TAG)→ 会话;行内三点菜单。 */
function ProjectTreeBrowser(props: Record<string, any>) {
  const actions: Actions = props
  // 宿主会话列表实时快照:byId[sid] 的 running/completed/pendingInteraction 走 mux 帧推送,
  // 状态占位即时亮灭不等 10s 轮询;快照未就绪(session.list 首拉前)按 RPC 行数据兜底
  const liveSessions = useSyncExternalStore(stableSubscribe, stableGetSnapshot) as
    | { byId?: Record<string, { running?: boolean; completed?: boolean; pendingInteraction?: string }> }
    | undefined
  // 两级折叠:组键 / 工作区键 → 是否展开;默认全展开,localStorage 记忆
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('dshw-expanded') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const isExpanded = (key: string): boolean => expanded[key] !== false
  const toggleExpanded = (key: string): void =>
    setExpanded((prev) => {
      const next = { ...prev, [key]: !(prev[key] !== false) }
      try {
        localStorage.setItem('dshw-expanded', JSON.stringify(next))
      } catch {}
      return next
    })
  const [data, setData] = useState<{
    workspaces: WorkspaceRow[]
    sessions: Record<string, SessionRow>
    byCwdIndex: Map<string, SessionRow[]>
    archivedIds: Set<string>
    currentId?: string
    lineage: any
    error?: string
  } | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  // 投影 title 快照有推送时延:本地覆盖即时生效
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({})
  // 操作反馈条(fork 拒绝等,fork-unavailable 不再静默)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (text: string, tone: 'info' | 'error' = 'info') => {
    setToast({ text, tone })
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }
  // 派生分支 Modal(选聚焦交接 / 全部对话记录)
  const [forkTarget, setForkTarget] = useState<{ sessionId: string; title: string } | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  // 工作区备注 Modal(路径 + 草稿)
  const [noteTarget, setNoteTarget] = useState<{ path: string; draft: string } | null>(null)
  // 归档视图:点击工具行归档 icon 切换
  const [archiveView, setArchiveView] = useState(false)
  // 会话摘要(懒加载:仅展开的工作区拉取),requested 防重复请求
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const summariesRequested = useRef<Set<string>>(new Set())
  // 新建工作区 Modal(项目组头 + 触发;repoPath=null 表示未关联项目,仅注册目录)
  const [createWs, setCreateWs] = useState<{ repoPath: string | null } | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [repoInfo, setRepoInfo] = useState<{ currentBranch: string | null; locals: string[]; remotes: Array<{ name: string; branches: string[] }>; occupiedBranches: string[]; originShort: string } | null>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [existingBranch, setExistingBranch] = useState('')
  // 分支双 Radio:新建分支(名称+源分支)/ 复用已有分支
  const [branchMode, setBranchMode] = useState<'new' | 'existing'>('new')
  // 新建模式的源分支:'' = 主仓 HEAD;local:x / remote:r:x
  const [baseSpec, setBaseSpec] = useState('')
  const [wsNote, setWsNote] = useState('')
  // 参考稿:高级折叠区(工作区名称/备注)
  const [wsTitle, setWsTitle] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(true)
  const [wsPath, setWsPath] = useState('')
  // 用户手动改过路径(输入/选择)后,分支名联动不再覆盖
  const [wsPathTouched, setWsPathTouched] = useState(false)

  const openCreateWs = (repoPath: string | null): void => {
    setCreateWs({ repoPath })
    setExistingBranch('')
    setBranchMode('new')
    setBaseSpec('')
    setNewBranchName('')
    setWsNote('')
    setWsTitle('')
    setWsPath('')
    setWsPathTouched(false)
    setRepoInfo(null)
    if (repoPath !== null) {
      actions
        .repoInfo?.(repoPath)
        .then((info) => {
          setRepoInfo(info)
          const base = info.currentBranch ?? 'main'
          const name = `${sanitizeBranchSegment(base)}-worktree`
          setNewBranchName((prev) => (prev === '' ? name : prev))
          // 初始路径预填:主仓/.worktree/<默认分支名>
          setWsPath((p) => (p === '' ? joinPath(joinPath(repoPath, '.worktree'), name) : p))
        })
        .catch((error: unknown) => {
          showToast(`读取分支失败:${error instanceof Error ? error.message : String(error)}`, 'error')
        })
    }
  }

  // 新建分支模式下,分支名变化联动路径(未手动改过路径时)
  const updateNewBranchName = (name: string): void => {
    setNewBranchName(name)
    if (createWs !== null && createWs.repoPath !== null && !wsPathTouched) {
      setWsPath(joinPath(joinPath(createWs.repoPath, '.worktree'), sanitizeBranchSegment(name)))
    }
  }

  const pickDirectory = (): void => {
    actions
      .pickDirectory?.()
      .then((path) => {
        if (path !== null) {
          setWsPath(path)
          setWsPathTouched(true)
        }
      })
      .catch((error: unknown) => {
        showToast(`打开目录选择器失败:${error instanceof Error ? error.message : String(error)}`, 'error')
      })
  }

  const submitCreateWs = () => {
    if (createWs === null || createBusy) return
    const targetPath = wsPath.trim()
    if (targetPath === '') return
    setCreateBusy(true)
    let work: Promise<void>
    if (createWs.repoPath === null) {
      // 未关联项目:仅注册目录工作区
      work = Promise.resolve(actions.createWorkspace?.(targetPath))
    } else if (branchMode === 'new') {
      // 源分支:local:x → 起点 x;remote:r:x → 起点 r/x;空 = 主仓 HEAD
      const baseMatch = /^(local|remote):(.+):(.+)$/.exec(baseSpec)
      work = Promise.resolve(
        actions.createWorktree?.({
          repoPath: createWs.repoPath,
          targetPath,
          mode: 'new',
          branchName: newBranchName.trim(),
          note: wsNote.trim(),
          title: wsTitle.trim(),
          ...(baseMatch !== null ? { baseBranch: baseMatch[3], baseRemote: baseMatch[1] === 'remote' ? baseMatch[2] : undefined } : {}),
        }),
      )
    } else {
      // existing:'local:<branch>' 或 'remote:<remote>:<branch>'(remote 名可含斜杠,故用 : 分隔)
      const remoteMatch = /^remote:(.+):(.+)$/.exec(existingBranch)
      if (remoteMatch !== null) {
        work = Promise.resolve(
          actions.createWorktree?.({ repoPath: createWs.repoPath, targetPath, mode: 'existing', branchName: remoteMatch[2], remote: remoteMatch[1], note: wsNote.trim(), title: wsTitle.trim() }),
        )
      } else {
        const localName = existingBranch.replace(/^local:/, '')
        if (localName === '') {
          setCreateBusy(false)
          showToast('请选择分支', 'error')
          return
        }
        work = Promise.resolve(
          actions.createWorktree?.({ repoPath: createWs.repoPath, targetPath, mode: 'existing', branchName: localName, note: wsNote.trim(), title: wsTitle.trim() }),
        )
      }
    }
    work
      .then(() => {
        showToast(`工作区已创建:${targetPath}`, 'info')
        setCreateWs(null)
        return load()
      })
      .catch((error: unknown) => {
        showToast(`创建失败:${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      .finally(() => setCreateBusy(false))
  }

  const runFork = (mode: 'full' | 'focus') => {
    if (forkTarget === null || forkBusy) return
    setForkBusy(true)
    actions
      .forkSession?.(forkTarget.sessionId, mode)
      .then(() => {
        showToast(mode === 'focus' ? '已聚焦交接派生新会话' : '已派生新分支(完整记录)', 'info')
        setForkTarget(null)
        return load()
      })
      .catch((error: unknown) => {
        showToast(`派生失败:${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      .finally(() => setForkBusy(false))
  }

  const load = async () => {
    try {
      const [ws, sl] = await Promise.all([rpc<any>('workspace.list'), rpc<any>('session.list')])
      const workspaces: WorkspaceRow[] = ws.items ?? []
      // workspace.list 同时返回 registry-global 归档集合;归档会话不进树
      const archived = new Set<string>(Array.isArray(ws.archivedSessionIds) ? ws.archivedSessionIds : [])
      const lineage = await fetch('/dsh-worktree/lineage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: workspaces.map((w) => w.path) }),
      }).then((r) => r.json())
      const sessions: Record<string, SessionRow> = {}
      let currentId: string | undefined
      for (const it of sl.items ?? []) {
        // 全量保留(归档视图要用);树渲染时再按 archived 集合过滤
        const row = it as SessionRow
        sessions[row.sessionId] = row
        if (row.running) currentId = row.sessionId
      }
      // cwd 归属索引:会话按其 cwd 落到工作区,不依赖 attach 写 sessionIds 的时序
      const byCwd = new Map<string, SessionRow[]>()
      for (const it of sl.items ?? []) {
        const c = (it as SessionRow).cwd?.replace(/\\/g, '/')
        if (!c) continue
        if (!byCwd.has(c)) byCwd.set(c, [])
        byCwd.get(c)!.push(it as SessionRow)
      }
      setData({ workspaces, sessions, byCwdIndex: byCwd, archivedIds: archived, currentId, lineage })
    } catch (error) {
      setData({ workspaces: [], sessions: {}, byCwdIndex: new Map(), archivedIds: new Set(), lineage: null, error: String(error) })
    }
  }
  useEffect(() => {
    void load()
    // 10s 轮询兜底;会话按 cwd 归属,不依赖 attach 时序
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])

  // 展开的工作区 → 批量拉会话摘要(失败静默,行内退回标题展示)
  useEffect(() => {
    if (data === null) return
    const pending: string[] = []
    if (archiveView) {
      for (const sid of data.archivedIds) {
        if (data.sessions[sid] !== undefined && summaries[sid] === undefined && !summariesRequested.current.has(sid)) {
          summariesRequested.current.add(sid)
          pending.push(sid)
        }
      }
    }
    for (const w of data.workspaces) {
      if (!isExpanded(`w-${w.workspaceId}`)) continue
      const wsPath = w.path.replace(/\\/g, '/')
      for (const s of [...(data.byCwdIndex.get(wsPath) ?? []), ...(w.sessionIds ?? []).map((id) => data.sessions[id]).filter(Boolean)]) {
        if (summaries[s.sessionId] === undefined && !summariesRequested.current.has(s.sessionId)) {
          summariesRequested.current.add(s.sessionId)
          pending.push(s.sessionId)
        }
      }
    }
    if (pending.length === 0) return
    actions
      .sessionSummaries?.(pending)
      .then((result) => setSummaries((prev) => ({ ...prev, ...result })))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, expanded, archiveView])

  if (data?.error !== undefined) {
    return jsx('div', { style: { padding: 12, fontSize: 12, color: '#e06c75' }, children: `dsh-worktree: ${data.error}` })
  }
  if (data === null) {
    return jsx('div', { style: { padding: 12, fontSize: 12, opacity: 0.6 }, children: '加载中…' })
  }

  const currentId = data.currentId
  const byId = data.sessions
  const groups = new Map<string, WorkspaceRow[]>()
  const wt = data.lineage?.worktrees ?? {}
  for (const w of data.workspaces) {
    const k = w.path.replace(/\\/g, '/')
    const hit = wt[k] as LineageEdge | undefined
    // 有边即归组:parentPath=null 表示自身是项目根,组键 = 自己的路径
    const key = hit === undefined ? UNPINNED : (hit.parentPath ?? k)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(w)
  }

  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === UNPINNED ? 1 : b === UNPINNED ? -1 : a.localeCompare(b),
  )

  // cwd 归属索引:load 时构建存入 data(摘要懒加载复用)

  /** 会话条目收集器(历史卡片布局的接缝;当前平铺直推)。 */
function cardChildrenPush(arr: any[], el: any): void {
  arr.push(el)
}

  const children: any[] = []
  for (const [parent, ws] of ordered) {
    const isGrouped = parent !== UNPINNED
    const label = isGrouped ? baseName(parent) : '其他工作区'
    // 主工作区:组内 parentPath===null 的(自身即根);多个取第一个
    const mainWs = isGrouped ? ws.find((w) => wt[w.path.replace(/\\/g, '/')]?.parentPath === null) : undefined
    const groupKey = `g-${parent}`
    const groupOpen = isExpanded(groupKey)

    children.push(
      jsx(
        'div',
        {
          key: groupKey,
          onClick: () => toggleExpanded(groupKey),
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '9px 8px 4px',
            cursor: 'pointer',
            color: 'var(--dsw-alias-label-primary)',
            borderRadius: 8,
          },
          className: 'dshw-grouphdr',
          children: [
            jsx(
              'span',
              {
                key: 'label',
                style: { fontSize: 13, lineHeight: '20px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, ...monoFont },
                children: [
                  jsx('span', { key: 'tw', style: { width: 12, display: 'inline-block', textAlign: 'center', opacity: 0.5 }, children: groupOpen ? '▾' : '▸' }),
                  jsx('span', { key: 'ico', style: { display: 'inline-flex', opacity: 0.75 }, children: jsx(Primitives.IconFolderClose16, {}) }),
                  label,
                ],
              },
            ),
            jsx(
              'button',
              {
                key: 'add',
                type: 'button',
                title: `在「${label}」新建工作区`,
                style: { ...menuBtnStyle, fontSize: 14 },
                onClick: (e: React.MouseEvent) => {
                  e.stopPropagation()
                  // 项目组带主仓路径(分支选择上下文);未分组组为 null(仅注册目录)
                  openCreateWs(isGrouped ? parent : null)
                },
                children: '+',
              },
            ),
          ].filter(Boolean),
        },
      ),
    )
    if (!groupOpen) continue

    for (const w of ws) {
      const isRoot = isGrouped && mainWs !== undefined && w.workspaceId === mainWs.workspaceId
      const wsKey = `w-${w.workspaceId}`
      const wsOpen = isExpanded(wsKey)
      const wsPathKey = w.path.replace(/\\/g, '/')
      const wsNoteText = typeof wt[wsPathKey]?.note === 'string' ? (wt[wsPathKey].note as string) : ''
      const wsBranch = typeof wt[wsPathKey]?.branch === 'string' ? (wt[wsPathKey].branch as string) : undefined
      const wsIcon = typeof wt[wsPathKey]?.icon === 'string' ? (wt[wsPathKey].icon as string) : 'branch'
      const wsColor = typeof wt[wsPathKey]?.color === 'string' ? (wt[wsPathKey].color as string) : folderHue(w.path)
      const wsMenu = jsx(RowMenu, {
        key: 'wsmenu',
        items: [
          { id: 'new', label: '新建会话', icon: jsx(Primitives.IconNewChatOutline16, {}) },
          { id: 'rename', label: '重命名工作区', icon: jsx(Primitives.IconEditOutline16, {}) },
          { id: 'note', label: '设置备注', icon: jsx(Primitives.IconListPenOutline16, {}) },
          { id: 'delete', label: '移除工作区记录', danger: true, icon: jsx(Primitives.IconTrashOutline16, {}) },
        ],
        onSelect: (id: string) => {
          if (id === 'new') actions.startSession?.(w.workspaceId)
          if (id === 'rename') {
            setRenameTarget({
              kind: 'workspace',
              id: w.workspaceId,
              draft: w.title ?? baseName(w.path),
              path: w.path,
              icon: wsIcon,
              color: wsColor,
            })
          }
          if (id === 'note') {
            setNoteTarget({ path: w.path, draft: wsNoteText })
          }
          if (id === 'delete') {
            if (window.confirm(`移除工作区记录「${w.title ?? baseName(w.path)}」?(不影响磁盘上的目录)`) === true) {
              void actions.deleteWorkspace?.(w.workspaceId)
            }
          }
        },
      })

      children.push(
        jsx(
          'div',
          {
            key: wsKey,
            className: 'dshw-wsrow',
            onClick: () => toggleExpanded(wsKey),
            // tooltip:标题 + 路径 + 备注(hover 可见)
            title: `${w.title ?? baseName(w.path)}\n${w.path}${wsNoteText !== '' ? `\n备注:${wsNoteText}` : ''}`,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px 6px 22px',
              fontSize: 14,
              lineHeight: '20px',
              minHeight: 32,
              color: 'var(--dsw-alias-label-primary)',
              cursor: 'pointer',
              borderRadius: 8,
            },
            children: [
              jsx('span', {
                key: 'tw',
                style: { width: 12, flexShrink: 0, display: 'inline-block', textAlign: 'center', transition: 'transform 120ms', transform: wsOpen ? 'rotate(90deg)' : 'none', opacity: 0.5 },
                children: '▸',
              }),
              // 工作区=分支层级:分支 icon + 分支名(图标/颜色可定制,默认按路径哈希取色)
              jsx('span', {
                key: 'ico',
                style: { display: 'inline-flex', color: wsColor },
                children: renderWsIcon(wsIcon),
              }),
              jsx(
                'span',
                { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...monoFont }, children: wsBranch ?? w.title ?? baseName(w.path) },
              ),
              isRoot ? jsx(MainTag, { key: 'tag' }) : null,
              jsx('span', { key: 'sp', style: { flex: 1 } }),
              wsMenu,
            ].filter(Boolean),
          },
        ),
      )
      if (!wsOpen) continue

      // cwd 归属优先(sessionIds 兜底),合并去重,最近活动在前
      const wsPath = w.path.replace(/\\/g, '/')
      const merged: SessionRow[] = []
      const seen = new Set<string>()
      for (const s of [...(data.byCwdIndex.get(wsPath) ?? []), ...(w.sessionIds ?? []).map((id) => byId[id]).filter(Boolean)]) {
        if (seen.has(s.sessionId)) continue
        if (data.archivedIds.has(s.sessionId)) continue
        seen.add(s.sessionId)
        merged.push(s)
      }
      merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

      // 会话平铺(最终定稿):状态占位 + DeepSeek icon + 摘要(懒加载)+ 相对时间
      // 缩进:组头 12 → 工作区 22 → 会话 48,状态列先于鲸鱼图标,层级视觉拉开一档
      const sessionIndent = 48
      for (const s of merged) {
        const sid = s.sessionId
        const active = sid === currentId
        const customTitle = sessionLabel(s, sid, titleOverrides)
        const summary = summaries[sid]
        // 实时状态(sessions.list 快照推送)优先,RPC 行(10s 轮询)兜底
        const live = liveSessions?.byId?.[sid]
        const running = (live?.running ?? s.running) === true
        const completed = live?.completed ?? s.completed
        const pending = live?.pendingInteraction ?? s.pendingInteraction
        const statusLabel = pending !== undefined ? '等待确认' : running ? '进行中' : completed === true ? '已完成' : ''
        cardChildrenPush(children, jsx(
          'div',
          {
            key: sid,
            className: 'dshw-row',
            title: customTitle + (summary !== undefined && summary !== '' ? `
${summary}` : '') + (statusLabel !== '' ? `\n● ${statusLabel}` : ''),
            onClick: () => actions.open?.(sid),
            onContextMenu: (e: React.MouseEvent) => {
              // 右键 = 行内三点菜单(复用同一 Menu)
              e.preventDefault()
              const btn = (e.currentTarget as HTMLElement).querySelector('button')
              if (btn) btn.click()
            },
            style: {
              ...rowBase,
              paddingLeft: sessionIndent,
              paddingRight: 6,
              fontWeight: active ? 600 : 400,
            },
            ...(active ? { 'data-active': '' } : {}),
            children: [
              // 状态占位:等确认=琥珀点 / 运行中=官方像素矩阵动画 / 完成未读=绿色对勾;空闲留空保对齐
              jsx('span', {
                key: 'st',
                style: { width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 },
                children: jsx(SessionStatus, { running, completed, pending }),
              }),
              jsx('span', {
                key: 'dsh-ico',
                style: { display: 'inline-flex', flexShrink: 0, color: running ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)', lineHeight: 0 },
                children: jsx(DeepSeekIcon, { size: 14 }),
              }),
              jsx(
                'span',
                {
                  key: 'label',
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, color: 'var(--dsw-alias-label-primary)', ...monoFont },
                  children: summary !== undefined && summary !== '' ? summary : customTitle,
                },
              ),
              jsx('span', {
                key: 'time',
                style: { flexShrink: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginRight: 2 },
                children: relTime(s.updatedAt),
              }),
              jsx(RowMenu, {
                key: 'menu',
                items: [
                  { id: 'open', label: '打开', icon: jsx(Primitives.IconFolderOpen16, {}) },
                  { id: 'rename', label: '重命名', icon: jsx(Primitives.IconEditOutline16, {}) },
                  { id: 'fork', label: '派生分支', icon: jsx(Primitives.IconBranchOutline16, {}) },
                  { id: 'archive', label: '归档', danger: true, icon: jsx(Primitives.IconArchiveOutline20, { size: 16 }) },
                ],
                onSelect: (id: string) => {
                  if (id === 'open') actions.open?.(sid)
                  if (id === 'rename') {
                    setRenameTarget({ kind: 'session', id: sid, draft: titleOverrides[sid] ?? customTitle })
                  }
                  if (id === 'fork') {
                    // 弹 Modal 由用户选交接方式(聚焦交接 / 全部对话记录)
                    setForkTarget({ sessionId: sid, title: customTitle })
                  }
                  if (id === 'archive') {
                    actions.archiveSession?.(sid).then(() => void load()).catch((error: unknown) => {
                      showToast(`归档失败:${error instanceof Error ? error.message : String(error)}`, 'error')
                    })
                  }
                },
              }),
            ].filter(Boolean),
          },
        ))
      }
    }
  }

  const confirmRename = async () => {
    if (renameTarget === null) return
    setRenameBusy(true)
    try {
      const title = renameTarget.draft.trim()
      if (renameTarget.kind === 'session') {
        await actions.renameSession?.(renameTarget.id, title)
        setTitleOverrides((prev) => ({ ...prev, [renameTarget.id]: title }))
      } else {
        await actions.renameWorkspace?.(renameTarget.id, title)
        // 名称旁一并写回图标/颜色(未变化也让后端幂等落盘)
        if (renameTarget.path !== undefined) {
          await actions.setWorkspaceMeta?.(renameTarget.path, { icon: renameTarget.icon ?? '', color: renameTarget.color ?? '' })
        }
      }
      setRenameTarget(null)
      void load()
    } finally {
      setRenameBusy(false)
    }
  }

  // 归档视图:archivedIds ∩ 全量 sessions,按最近活动排序
  const archivedRows = archiveView
    ? [...data.archivedIds]
        .map((sid) => byId[sid])
        .filter((x) => x !== undefined)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    : []

  return jsxs(Fragment, {
    children: [
      // 工具行:归档入口 / 归档视图返回(ARCHIVE_VIEW_ENABLED=false 时整行隐藏)
      archiveView || ARCHIVE_VIEW_ENABLED
        ? jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px 0', minHeight: 26 },
        children: [
          archiveView
            ? jsx(
                'button',
                {
                  key: 'back',
                  type: 'button',
                  onClick: () => setArchiveView(false),
                  style: { ...menuBtnStyle, fontSize: 12, opacity: 0.8 },
                  children: '← 返回',
                },
              )
            : jsx('span', { key: 'sp', style: { flex: 1 } }),
          archiveView ? jsx('span', { key: 't', style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' }, children: `已归档会话 · ${archivedRows.length}` }) : null,
          jsx(
            'button',
            {
              key: 'archive-toggle',
              type: 'button',
              title: archiveView ? '返回工作区视图' : '已归档会话',
              onClick: () => setArchiveView((v) => !v),
              style: { ...menuBtnStyle, color: archiveView ? 'var(--dsw-alias-brand-primary)' : 'inherit' },
              children: jsx(Primitives.IconArchiveOutline20, { size: 16 }),
            },
          ),
        ],
      })
        : null,
      jsx(
        'div',
        {
          style: { padding: '4px 2px', overflowY: 'auto', maxHeight: '100%' },
          children: archiveView
            ? archivedRows.length > 0
              ? archivedRows.map((s0) =>
                  jsx(
                    'div',
                    {
                      key: s0.sessionId,
                      className: 'dshw-row',
                      title: s0.sessionId,
                      onClick: () => actions.open?.(s0.sessionId),
                      style: { ...rowBase, paddingLeft: 12, paddingRight: 6 },
                      children: [
                        jsx('span', {
                          key: 'dsh-ico',
                          style: { display: 'inline-flex', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 0 },
                          children: jsx(DeepSeekIcon, { size: 14 }),
                        }),
                        jsx('span', {
                          key: 'label',
                          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, color: 'var(--dsw-alias-label-primary)', ...monoFont },
                          children: summaries[s0.sessionId] !== undefined && summaries[s0.sessionId] !== '' ? summaries[s0.sessionId] : sessionLabel(s0, s0.sessionId, titleOverrides),
                        }),
                        jsx('span', {
                          key: 'time',
                          style: { flexShrink: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginRight: 2 },
                          children: relTime(s0.updatedAt),
                        }),
                        jsx(RowMenu, {
                          key: 'menu',
                          items: [
                            { id: 'open', label: '打开', icon: jsx(Primitives.IconFolderOpen16, {}) },
                            { id: 'copy', label: '复制会话 ID', icon: jsx(Primitives.IconCopyOutline16, {}) },
                          ],
                          onSelect: (id: string) => {
                            if (id === 'open') actions.open?.(s0.sessionId)
                            if (id === 'copy') {
                              void navigator.clipboard?.writeText(s0.sessionId).then(() => showToast('会话 ID 已复制', 'info'))
                            }
                          },
                        }),
                      ].filter(Boolean),
                    },
                    s0.sessionId,
                  ),
                )
              : [jsx('div', { key: 'empty-archived', style: { padding: 12, fontSize: 12, opacity: 0.6 }, children: '暂无归档会话' })]
            : children.length > 0
              ? children
              : [jsx('div', { key: 'empty', style: { padding: 12, fontSize: 12, opacity: 0.6 }, children: '暂无工作区' })],
        },
      ),
      toast !== null
        ? jsx(
            'div',
            {
              key: 'toast',
              onClick: () => setToast(null),
              style: {
                margin: '6px 8px 8px',
                padding: '6px 10px',
                fontSize: 12,
                lineHeight: '18px',
                borderRadius: 8,
                cursor: 'pointer',
                color: toast.tone === 'error' ? 'var(--dsw-alias-state-error-primary, #e06c75)' : 'var(--dsw-alias-label-secondary)',
                border: '1px solid rgba(127,127,127,0.3)',
              },
              children: toast.text,
            },
          )
        : null,
      jsx(Primitives.Modal, {
        open: renameTarget !== null,
        onClose: () => setRenameTarget(null),
        title: renameTarget?.kind === 'workspace' ? '重命名工作区' : '重命名会话',
        footer: jsxs(Fragment, {
          children: [
            jsx(Primitives.Button, {
              key: 'cancel',
              variant: 'outline',
              disabled: renameBusy,
              onClick: () => setRenameTarget(null),
              children: '取消',
            }),
            jsx(Primitives.Button, {
              key: 'ok',
              variant: 'primary',
              disabled: renameBusy || renameTarget === null || renameTarget.draft.trim() === '',
              onClick: () => void confirmRename(),
              children: '重命名',
            }),
          ],
        }),
        children: jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 10, width: '100%' },
          children: [
            jsx('input', {
              className: 'dshw-field',
              autoFocus: true,
              value: renameTarget?.draft ?? '',
              'aria-label': '名称',
              disabled: renameBusy,
              onChange: (e: any) => setRenameTarget((t) => (t === null ? t : { ...t, draft: e.target.value })),
              onKeyDown: (e: any) => {
                if (e.key === 'Enter' && renameTarget !== null && renameTarget.draft.trim() !== '') void confirmRename()
              },
            }),
            renameTarget?.kind === 'workspace'
              ? jsx('div', {
                  key: 'icons',
                  style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                  children: WS_ICON_IDS.map((iconId) =>
                    jsx(
                      'button',
                      {
                        type: 'button',
                        title: iconId,
                        onClick: () => setRenameTarget((t) => (t === null ? t : { ...t, icon: iconId })),
                        style: {
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 34,
                          height: 34,
                          borderRadius: 8,
                          cursor: 'pointer',
                          border: renameTarget.icon === iconId ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
                          background: 'transparent',
                          color: renameTarget.color ?? 'var(--dsw-alias-label-primary)',
                        },
                        children: renderWsIcon(iconId),
                      },
                      iconId,
                    ),
                  ),
                })
              : null,
            renameTarget?.kind === 'workspace'
              ? jsx('div', {
                  key: 'colors',
                  style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                  children: PALETTE.map((hex) =>
                    jsx(
                      'button',
                      {
                        type: 'button',
                        title: hex,
                        onClick: () => setRenameTarget((t) => (t === null ? t : { ...t, color: hex })),
                        style: {
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          cursor: 'pointer',
                          background: hex,
                          border: renameTarget.color === hex ? '2px solid var(--dsw-alias-label-primary)' : '2px solid transparent',
                          padding: 0,
                        },
                      },
                      hex,
                    ),
                  ),
                })
              : null,
          ],
        }),
      }),
      jsx(
        Primitives.Modal,
        {
          open: forkTarget !== null,
          onClose: () => {
            if (!forkBusy) setForkTarget(null)
          },
          className: 'dshw-modal',
          title: '派生分支',
          footer: jsx(Primitives.Button, {
            variant: 'outline',
            disabled: forkBusy,
            onClick: () => setForkTarget(null),
            children: '取消',
          }),
          children: jsxs('div', {
            children: [
              jsx('div', {
                key: 'desc',
                style: { fontSize: 13, lineHeight: '20px', marginBottom: 10, color: 'var(--dsw-alias-label-secondary)' },
                children: forkTarget === null ? '' : `从「${forkTarget.title}」派生一个新会话,选择交接方式:`,
              }),
              jsx(
                'div',
                {
                  key: 'opt-focus',
                  className: `dshw-opt${forkBusy ? ' disabled' : ''}`,
                  style: { marginBottom: 8 },
                  onClick: () => runFork('focus'),
                  children: [
                    jsx('div', { key: 't', style: { fontSize: 14, fontWeight: 600 }, children: '聚焦交接' }),
                    jsx('div', { key: 'd', style: { fontSize: 12, opacity: 0.7, marginTop: 2 }, children: '以源会话对话要点开场,上下文轻量' }),
                  ],
                },
              ),
              jsx(
                'div',
                {
                  key: 'opt-full',
                  className: `dshw-opt${forkBusy ? ' disabled' : ''}`,
                  onClick: () => runFork('full'),
                  children: [
                    jsx('div', { key: 't', style: { fontSize: 14, fontWeight: 600 }, children: '全部对话记录' }),
                    jsx('div', { key: 'd', style: { fontSize: 12, opacity: 0.7, marginTop: 2 }, children: '完整复制源会话上下文(同原生分支按钮)' }),
                  ],
                },
              ),
            ],
          }),
        },
      ),
      jsx(
        Primitives.Modal,
        {
          open: createWs !== null,
          onClose: () => {
            if (!createBusy) setCreateWs(null)
          },
          className: 'dshw-modal',
          title: '新建工作区',
          footer: jsxs(Fragment, {
            children: [
              jsx(Primitives.Button, {
                key: 'cancel',
                variant: 'outline',
                disabled: createBusy,
                onClick: () => setCreateWs(null),
                children: '取消',
              }),
              jsx(Primitives.Button, {
                key: 'ok',
                variant: 'primary',
                disabled:
                  createBusy ||
                  wsPath.trim() === '' ||
                  (branchMode === 'new' && (newBranchName.trim() === '' || createWs?.repoPath === null)) ||
                  (branchMode === 'existing' && (createWs?.repoPath === null || existingBranch === '')),
                onClick: () => void submitCreateWs(),
                children: '创建',
              }),
            ],
          }),
          children: buildCreateWsBody({
            createWs,
            repoInfo,
            branchMode,
            setBranchMode,
            newBranchName,
            updateNewBranchName,
            existingBranch,
            setExistingBranch,
            baseSpec,
            setBaseSpec,
            wsNote,
            setWsNote,
            wsTitle,
            setWsTitle,
            advancedOpen,
            setAdvancedOpen,
            wsPath,
            setWsPath: (v: string) => {
              setWsPath(v)
              setWsPathTouched(true)
            },
            pickDirectory,
            createBusy,
            submitCreateWs,
          }),
        },
      ),
      jsx(
        Primitives.Modal,
        {
          open: noteTarget !== null,
          onClose: () => setNoteTarget(null),
          title: '设置备注',
          footer: jsxs(Fragment, {
            children: [
              jsx(Primitives.Button, {
                key: 'cancel',
                variant: 'outline',
                onClick: () => setNoteTarget(null),
                children: '取消',
              }),
              jsx(Primitives.Button, {
                key: 'ok',
                variant: 'primary',
                disabled: noteTarget === null,
                onClick: () => {
                  if (noteTarget === null) return
                  const path = noteTarget.path
                  actions
                    .setWorkspaceMeta?.(path, { note: noteTarget.draft.trim() })
                    .then(() => {
                      setNoteTarget(null)
                      return load()
                    })
                    .catch((error: unknown) => {
                      showToast(`备注保存失败:${error instanceof Error ? error.message : String(error)}`, 'error')
                    })
                },
                children: '保存',
              }),
            ],
          }),
          children: jsx('input', {
            className: 'dshw-field',
            autoFocus: true,
            value: noteTarget?.draft ?? '',
            'aria-label': '备注',
            placeholder: '留空清除备注',
            disabled: noteTarget === null,
            onChange: (e: any) => setNoteTarget((t) => (t === null ? t : { ...t, draft: e.target.value })),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter' && noteTarget !== null) {
                actions
                  .setWorkspaceMeta?.(noteTarget.path, { note: noteTarget.draft.trim() })
                  .then(() => {
                    setNoteTarget(null)
                    return load()
                  })
                  .catch((error: unknown) => {
                    showToast(`备注保存失败:${error instanceof Error ? error.message : String(error)}`, 'error')
                  })
              }
            },
          }),
        },
      ),
    ],
  })
}

export function apply(ctx: Context): void {
  injectStyles()
  const c = ctx as any
  // 捕获宿主会话列表快照源:侧栏状态占位(loading/完成对勾)用它实时订阅
  liveSessionsSource = c.sessions?.list ?? null
  const actions: Actions = {
    open: (sessionId) => c.sessions.open(sessionId),
    startSession: (workspaceId) => c.workspaces.startSession(workspaceId),
    renameSession: async (sessionId, title) => {
      const binding = c.sessions.binding(sessionId)?.session
      if (binding === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await binding.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: (sessionId, mode) => {
      // focus:插件 HTTP 路由(服务端机械摘要种子 → agents.create,同 P3 工具链)
      if (mode === 'focus') {
        return fetch('/dsh-worktree/session-fork', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, mode }),
        })
          .then((r) => r.json())
          .then((body: any) => {
            if (!body?.ok) throw new Error(body?.message ?? '聚焦交接失败')
            c.sessions.open(body.childSessionId)
          })
      }
      // full:实测(0.5.9 诊断版)浏览器 ctx.sessions.fork 成功时 resolve 裸字符串
      // childId;失败时可能 resolve envelope/undefined——两种形态都接住,失败显式抛。
      return Promise.resolve(c.sessions.fork({ sessionId, increaseTitle: true })).then((result: any) => {
        const childId =
          typeof result === 'string'
            ? result
            : result?.ok === true
              ? result?.value?.sessionId
              : undefined
        if (childId !== undefined && childId !== null) {
          c.sessions.open(childId)
          return
        }
        throw new Error(result?.error?.message ?? '派生被拒绝(会话可能没有已完成的回合)')
      })
    },
    archiveSession: async (sessionId) => {
      await c.workspaces.archiveSession(sessionId)
    },
    renameWorkspace: async (workspaceId, title) => {
      await c.workspaces.rename(workspaceId, title)
    },
    deleteWorkspace: async (workspaceId) => {
      await c.workspaces.delete(workspaceId)
    },
    createWorkspace: (path) => {
      // 失败可能以 envelope 形式 resolve(workspace-invalid-path),显式转 throw
      return Promise.resolve(c.workspaces.create({ path })).then((result: any) => {
        if (result && typeof result === 'object' && result.ok === false) {
          throw new Error(result.error?.message ?? '创建工作区被拒绝')
        }
      })
    },
    repoInfo: (repoPath) =>
      postJson('/dsh-worktree/repo-info', { repoPath }).then((body: any) => {
        if (!body?.ok) throw new Error(body?.message ?? '读取分支失败')
        return { currentBranch: body.currentBranch ?? null, locals: body.locals ?? [], remotes: body.remotes ?? [], occupiedBranches: body.occupiedBranches ?? [], originShort: body.originShort ?? '' }
      }),
    pickDirectory: () =>
      Promise.resolve(c.workspaces.pickDirectory()).then((path: unknown) => (typeof path === 'string' ? path : null)),
    createWorktree: (input) =>
      postJson('/dsh-worktree/worktree-create', input).then((body: any) => {
        if (!body?.ok) throw new Error(body?.message ?? '创建 worktree 失败')
      }),
    setWorkspaceMeta: (targetPath, meta) =>
      postJson('/dsh-worktree/workspace-note', { targetPath, ...meta }).then((body: any) => {
        if (!body?.ok) throw new Error(body?.message ?? '保存失败')
      }),
    sessionSummaries: (ids) =>
      postJson('/dsh-worktree/session-summaries', { ids }).then((body: any) => {
        if (!body?.ok) throw new Error(body?.message ?? '摘要加载失败')
        return (body.summaries ?? {}) as Record<string, string>
      }),
  }
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        // single slot 按 priority 遮蔽(最小者渲染);-1 压过 ui-workspace 的 0
        priority: -1,
        inject: () => ({ ...actions }),
      },
      ProjectTreeBrowser as any,
    ),
  )
}
