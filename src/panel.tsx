/**
 * dsh-coding-workspace 侧栏右栏:工作区面板(资源管理器 + Git)。
 *
 * 挂载:shell.overlay(ui-layout AppFrame 声明的 list slot,additive 零冲突;
 * 层 pointer-events:none,面板根 opt-in auto)。entry props 官方标准 kit 白送
 * useSessions/useWorkspaces(root scope ObservableSnapshot selector hooks)。
 *
 * 停靠:面板 fixed 贴视口右缘,展开时写 CSS 变量 --dsh-coding-workspace-panel-width,
 * 注入样式让宿主 #root 以 margin-right 让位(VSCode 式真停靠,不盖会话内容;
 * 方案参考 dsh-better-sidebar layout.css)。窄屏 / 检测到 better-sidebar
 * (双方都推 #root 会打架)时自动退回纯浮层。收起态右上角悬浮钮(boss 定版)。
 *
 * 结构:SidePanel(显隐把手 + 拖宽 + TAB 栏 + 概览条)
 *   ├─ ExplorerTab  文件树懒展开(只读)
 *   └─ GitTab
 *        ├─ ChangesView   staged/unstaged/untracked + stage/unstage + commit
 *        └─ LogsView      parents 拓扑 → lane 布局 → 整列 SVG(IDEA 风格)+ 行内展开详情
 *
 * UI 对齐 IDEA Git Log:状态徽标分色、目录淡/文件名亮、graph lane 循环色板。
 * ⚠️ jsx-runtime:children 必须放 props.children(第三参是 key)。
 */
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { buildGraphLayout, type GraphLayout } from './panel-graph.js'
import { t } from './i18n.js'
import {
  DEFAULT_PANEL_WIDTH,
  PUSH_MIN_VIEWPORT,
  clampPanelWidth,
  parseStoredWidth,
} from './panel-layout.js'
import { TOPBAR_HEIGHT } from './topbar-core.js'

// ---------------------------------------------------------------------------
// 基建:HTTP 帮手 / 格式化
// ---------------------------------------------------------------------------

/** 插件自有 HTTP 路由 POST,解析 JSON 响应;ok=false 抛错。 */
async function postJson(url: string, payload: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

async function panelAction(cwd: string, action: string, extra?: Record<string, unknown>): Promise<string> {
  const body = await postJson('/dsh-coding-workspace/git-action', { cwd, action, ...extra })
  if (!body?.ok) throw new Error(body?.message ?? t('git.actionFailed', { action }))
  return typeof body.output === 'string' ? body.output : ''
}

function fmtSize(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 目录/文件路径拆 dirname + basename(POSIX 化后处理)。 */
function splitPath(p: string): { dir: string; name: string } {
  const norm = p.replace(/\\/g, '/')
  const cut = norm.lastIndexOf('/')
  if (cut === -1) return { dir: '', name: norm }
  return { dir: norm.slice(0, cut + 1), name: norm.slice(cut + 1) }
}

// ---------------------------------------------------------------------------
// 图标(14px stroke 风自绘,与侧栏自绘 SVG 同语言)
// ---------------------------------------------------------------------------

type IconProps = { size?: number; style?: Record<string, unknown> }

function svgIcon(size: number | undefined, style: Record<string, unknown> | undefined, children: unknown) {
  return jsx('svg', {
    width: size ?? 14,
    height: size ?? 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style: { flexShrink: 0, ...style },
    children,
  })
}

function IconBranch(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [
        jsx('circle', { cx: '5', cy: '3.5', r: '1.7' }),
        jsx('circle', { cx: '5', cy: '12.5', r: '1.7' }),
        jsx('circle', { cx: '11.5', cy: '5.5', r: '1.7' }),
        jsx('path', { d: 'M5 5.2v5.6M11.5 7.2c0 2-1.8 3-4.3 3.2' }),
      ],
    }),
  )
}

function IconRefresh(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [jsx('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9' }), jsx('path', { d: 'M13.7 1.8v2.6h-2.6' })],
    }),
  )
}

/** 右栏面板 icon:宿主侧栏「收起侧边栏」同款(官方 ui-sidebar panelIcon,
 * fill evenodd 实心型)水平镜像 — 竖条朝左,与左栏按钮(竖条朝右)左右对称。 */
function IconPanelRight(p: IconProps) {
  return jsx('svg', {
    width: p.size ?? 14,
    height: p.size ?? 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    style: { transform: 'scaleX(-1)', ...p.style },
    children: jsx('path', {
      fillRule: 'evenodd',
      clipRule: 'evenodd',
      fill: 'currentColor',
      d: 'M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM5.54303 1.88715V14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715ZM4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873V1.91166Z',
    }),
  })
}

function IconChevron(props: { open?: boolean; size?: number }) {
  return svgIcon(props.size, { transform: props.open ? 'rotate(90deg)' : undefined }, jsx('path', { d: 'M6 3.5L10.5 8L6 12.5' }))
}

function IconFile(p: IconProps) {
  return svgIcon(p.size, p.style, jsx('path', { d: 'M9 1.8H4.2a.7.7 0 0 0-.7.7v11a.7.7 0 0 0 .7.7h7.6a.7.7 0 0 0 .7-.7V5.3L9 1.8zM9 1.8v3.5h3.5' }))
}

/** 分组视图选择(眼睛)。 */
function IconEye(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [jsx('path', { d: 'M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8s-2.4 4.4-6.4 4.4S1.6 8 1.6 8z' }), jsx('circle', { cx: '8', cy: '8', r: '1.9' })],
    }),
  )
}

/** 新建 Changelist 分组(列表 + 加号)。 */
function IconListPlus(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [jsx('path', { d: 'M6.5 3H3.2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3.3M9.5 3h3.3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9.5' }), jsx('path', { d: 'M8 1.8v12.4' })],
    }),
  )
}

/** Fetch(远端 → 本地:托盘 + 下箭头)。 */
function IconFetch(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [jsx('path', { d: 'M2.5 10.5v2a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-2' }), jsx('path', { d: 'M8 1.8v7.4M5.2 6.6 8 9.4l2.8-2.8' })],
    }),
  )
}

/** Pull(拉取:下箭头 + 接收弧)。 */
function IconPull(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [jsx('path', { d: 'M8 2v8.2M4.6 7.2 8 10.6l3.4-3.4' }), jsx('path', { d: 'M2.5 13.5h11' })],
    }),
  )
}

/** Push(推送:上箭头 + 发送弧)。 */
function IconPush(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [jsx('path', { d: 'M8 10.6V2.4M4.6 5.4 8 2l3.4 3.4' }), jsx('path', { d: 'M2.5 13.5h11' })],
    }),
  )
}

// ---------------------------------------------------------------------------
// 状态徽标(IDEA 风:M 黄 / A 绿 / D 红 / R·C 蓝 / U 橙 / ? 灰)
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  M: '#d29922',
  A: '#3fb950',
  D: '#f85149',
  R: '#58a6ff',
  C: '#58a6ff',
  T: '#a371f7',
  U: '#db6d28',
  '?': '#8b949e',
}

function StatusBadge(props: { status: string }) {
  const color = STATUS_COLORS[props.status] ?? '#8b949e'
  return jsx('span', {
    style: {
      flexShrink: 0,
      width: 15,
      height: 15,
      borderRadius: 4,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--ds-font-family-mono, monospace)',
      fontSize: 10,
      lineHeight: 1,
      color,
      background: `color-mix(in srgb, ${color} 18%, transparent)`,
    },
    children: props.status,
  })
}

/** refs 徽标(HEAD 检出/本地/远端/tag),mono 10px。 */
function RefBadge(props: { kind: 'head' | 'local' | 'remote' | 'tag'; name: string }) {
  const color =
    props.kind === 'head'
      ? 'var(--dsw-alias-brand-primary)'
      : props.kind === 'tag'
        ? '#a371f7'
        : props.kind === 'remote'
          ? 'var(--dsw-alias-label-dimmed)'
          : 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))'
  return jsx('span', {
    style: {
      flexShrink: 0,
      maxWidth: 130,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontFamily: 'var(--ds-font-family-mono, monospace)',
      fontSize: 10,
      lineHeight: '16px',
      padding: '0 5px',
      borderRadius: 4,
      color,
      border: '1px solid color-mix(in srgb, currentColor 35%, transparent)',
    },
    children: props.kind === 'head' ? `◉ ${props.name}` : props.name,
  })
}

// ---------------------------------------------------------------------------
// graph 渲染(IDEA 风格):后端给 parents,panel-graph.ts 建 lane 拓扑,
// 这里整列一张 SVG:固定 lane 网格 + 竖线/贝塞尔弧线 + 点盖线,跨行绝对连续。
// ---------------------------------------------------------------------------

const LANE_PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#a371f7', '#db6d28', '#f85149', '#39c5cf', '#e3b341']

const GRAPH_ROW_H = 40
const GRAPH_LANE_W = 13

/** 整列画布:layout.rows 每行的 edges 画在 [mid_i, mid_{i+1}] 通道内,点后画盖线。
 * rowYs = 每行 commit 行的实测中心 y(详情展开会把后续行推下去,固定 index*40 会错位);
 * 缺项(未测到)退回固定行高。 */
function GraphCanvas(props: { layout: GraphLayout; rowYs: number[] }): any {
  const { layout, rowYs } = props
  const width = Math.max(1, layout.laneCount) * GRAPH_LANE_W + 4
  const fixedY = (row: number): number => row * GRAPH_ROW_H + GRAPH_ROW_H / 2
  const midY = (row: number): number => rowYs[row] ?? fixedY(row)
  const height = rowYs.length > 0 ? midY(layout.rows.length - 1) + GRAPH_ROW_H / 2 + 4 : Math.max(1, layout.rows.length) * GRAPH_ROW_H
  const laneX = (lane: number): number => lane * GRAPH_LANE_W + GRAPH_LANE_W / 2 + 2
  const lines: unknown[] = []
  const dots: unknown[] = []
  layout.rows.forEach((row, i) => {
    const y0 = midY(i)
    const y1 = i + 1 < layout.rows.length ? midY(i + 1) : y0 + GRAPH_ROW_H / 2
    for (let k = 0; k < row.edges.length; k++) {
      const e = row.edges[k]!
      const x0 = laneX(e.from)
      const x1 = laneX(e.to)
      const color = LANE_PALETTE[e.color % LANE_PALETTE.length]!
      if (e.from === e.to) {
        lines.push(jsx('line', { x1: x0, y1: y0, x2: x0, y2: y1, stroke: color, 'stroke-width': 1.8 }, `l${i}-${k}`))
      } else {
        // S 曲线:端点切线垂直,与上下行的直线无缝拼接;弯曲量随行距伸缩
        const bend = Math.min(GRAPH_ROW_H * 0.42, Math.abs(y1 - y0) * 0.42)
        lines.push(
          jsx(
            'path',
            { d: `M ${x0} ${y0} C ${x0} ${y0 + bend}, ${x1} ${y1 - bend}, ${x1} ${y1}`, fill: 'none', stroke: color, 'stroke-width': 1.8 },
            `p${i}-${k}`,
          ),
        )
      }
    }
    if (row.lane !== null) {
      dots.push(
        jsx(
          'circle',
          { cx: laneX(row.lane), cy: y0, r: 4.5, fill: LANE_PALETTE[row.color % LANE_PALETTE.length], stroke: 'var(--dsw-alias-bg-base)', 'stroke-width': 1.5 },
          `c${i}`,
        ),
      )
    }
  })
  return jsx(
    'svg',
    {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' },
      children: [...lines, ...dots],
    },
  )
}

// ---------------------------------------------------------------------------
// SidePanel:显隐把手 + 拖宽 + 骨架(停靠推挤)
// ---------------------------------------------------------------------------

const PANEL_KEY = 'dsh-coding-workspace.side-panel'
const PANEL_WIDTH_KEY = 'dsh-coding-workspace.side-panel-width'
/** 改名前(dsh-worktree)的旧 key:只读迁移,不再写入。 */
const LEGACY_PANEL_KEY = 'dsh-worktree.side-panel'
const LEGACY_PANEL_WIDTH_KEY = 'dsh-worktree.side-panel-width'

function readOpenState(): boolean {
  try {
    const value = localStorage.getItem(PANEL_KEY) ?? localStorage.getItem(LEGACY_PANEL_KEY)
    return value === 'open'
  } catch {
    return false
  }
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY) ?? localStorage.getItem(LEGACY_PANEL_WIDTH_KEY)
    return parseStoredWidth(raw) ?? DEFAULT_PANEL_WIDTH
  } catch {
    return DEFAULT_PANEL_WIDTH
  }
}

/** 推挤模式判定:宽屏 且 未装 better-sidebar(双方都写 #root margin 会叠加打架)。 */
function computePushMode(): boolean {
  try {
    if (window.innerWidth < PUSH_MIN_VIEWPORT) return false
    return document.querySelector('[data-dsh-better-sidebar]') === null
  } catch {
    return false
  }
}

/** 注入停靠推挤样式(幂等;变量值由组件联动读写)。 */
const PUSH_STYLE_ID = 'dsh-coding-workspace-panel-style'

function ensurePushStyle(): void {
  try {
    if (document.getElementById(PUSH_STYLE_ID) !== null) return
    const tag = document.createElement('style')
    tag.id = PUSH_STYLE_ID
    // margin-right 与 width 同变量同步过渡:宿主 #root 收窄量 == 面板占位。
    // width 用 calc 而非裸 margin(Desktop shell #root width:100% 时 margin 会
    // 溢出视口,dsh-better-sidebar #208 同款坑)。拖拽期间 body 属性禁过渡。
    tag.textContent = `
#root {
  margin-right: var(--dsh-coding-workspace-panel-width, 0px);
  width: calc(100% - var(--dsh-coding-workspace-panel-width, 0px));
  transition:
    margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out),
    width var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
body[data-dshw-dragging] #root { transition: none; }
/* 面板收起时顶部展开钮占据会话 header 右上角(与左栏按钮同排);
   把 header 右 padding 从 28 推到 78,右对齐的 Session log 胶囊左移让位,
   避免叠压(dsh-better-sidebar 收起簇同款手法)。展开态靠推挤变量让位,无需。 */
body:not([data-dshw-panel-open]) [data-slot="conversation.session.header"] > header {
  padding-right: 78px;
}
`
    document.head.appendChild(tag)
  } catch {
    // 无 document 等极端环境:面板仍以浮层形态可用
  }
}

/** 宿主 sessions 快照 → 当前会话 cwd(useSessions 为官方标准 kit selector hook)。 */
function useCurrentCwd(useSessions: unknown): string | undefined {
  const hook = useSessions as ((sel: (s: any) => unknown) => unknown) | undefined
  const current = hook?.((s: any) => s?.current)
  const state = hook?.((s: any) => s)
  const cwd = current !== undefined ? (state as any)?.byId?.[String(current)]?.cwd : undefined
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

export function SidePanel(props: any): any {
  const [open, setOpen] = useState(readOpenState)
  const [tab, setTab] = useState<'explorer' | 'git'>('git')
  const [width, setWidth] = useState(readStoredWidth)
  const [pushMode, setPushMode] = useState(computePushMode)
  const useSessions = props.useSessions as ((sel: (s: any) => unknown) => unknown) | undefined
  const currentSessionId = useSessions?.((s: any) => s?.current) as string | undefined
  const cwd = useCurrentCwd(props.useSessions)
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  ensurePushStyle()

  // 停靠联动:展开且可推挤 → 写变量让 #root 让位;收起/浮层/卸载一律归零还原。
  // body 属性驱动收起态的 header padding 让位(见 ensurePushStyle 注入规则)。
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--dsh-coding-workspace-panel-width', open && pushMode ? `${width}px` : '0px')
    if (open) document.body.dataset.dshwPanelOpen = '1'
    else delete document.body.dataset.dshwPanelOpen
    return () => {
      root.style.setProperty('--dsh-coding-workspace-panel-width', '0px')
      delete document.body.dataset.dshwPanelOpen
    }
  }, [open, width, pushMode])

  // 宽度记忆(首次挂载同值回写,无害)
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width))
    } catch {
      // 存储不可用:仅本次会话内生效
    }
  }, [width])

  // 窄屏切换时重判推挤;better-sidebar 的挂载检测在展开动作里兜底(见 toggle)
  useEffect(() => {
    const recompute = (): void => setPushMode(computePushMode())
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [])

  const toggle = (next: boolean): void => {
    // 展开瞬间重判:better-sidebar 可能在本插件挂载后才出现
    setPushMode(computePushMode())
    setOpen(next)
    try {
      localStorage.setItem(PANEL_KEY, next ? 'open' : 'closed')
    } catch {
      // 无痕模式等存储不可用:仅本次会话内生效
    }
  }

  const onDragStart = (e: any): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // capture 不可用:move 仍会冒泡到 handle
    }
    document.body.dataset.dshwDragging = '1'
  }

  const onDragMove = (e: any): void => {
    const d = dragRef.current
    if (d === null || e.pointerId !== d.pointerId) return
    const next = clampPanelWidth(d.startWidth + (d.startX - e.clientX), window.innerWidth)
    dragRef.current = { ...d, startWidth: next, startX: e.clientX }
    setWidth(next)
  }

  const onDragEnd = (e: any): void => {
    const d = dragRef.current
    if (d === null || e.pointerId !== d.pointerId) return
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 已释放
    }
    delete document.body.dataset.dshwDragging
  }

  if (!open) {
    // 顶部展开钮(boss 定版):贴会话 header 右上角,与左栏按钮同规格
    // (28×28 圆形无边框,label-secondary);Session log 由注入 CSS 推开让位
    return jsx('button', {
      className: 'dshw-topbtn',
      title: t('panel.expand'),
      onClick: () => toggle(true),
      style: {
        position: 'absolute',
        // y 与左栏「收起侧边栏」钮同高(实测其 top=22,即 header 行中心对齐);
        // +顶部栏高度:header 随 #root 推挤下移,钮也要同步让位(topbar 常驻)
        top: 22 + TOPBAR_HEIGHT,
        right: 16,
        width: 28,
        height: 28,
        borderRadius: '50%',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
        pointerEvents: 'auto',
        zIndex: 21,
      },
      children: jsx(IconPanelRight, { size: 16 }),
    })
  }

  return jsx('div', {
    style: {
      // 停靠:fixed 贴视口右缘;宽度由推挤变量同步(浮层模式 maxWidth 兜底);
      // top 让位常驻顶部栏(变量桥见 topbar.tsx,这里直接用同一常量)
      position: 'fixed',
      top: TOPBAR_HEIGHT,
      right: 0,
      bottom: 0,
      width,
      maxWidth: pushMode ? undefined : '80vw',
      pointerEvents: 'auto',
      background: 'var(--dsw-alias-bg-base)',
      borderLeft: '1px solid var(--dsw-alias-border-l1)',
      boxShadow: '-8px 0 24px rgba(0,0,0,0.16)',
      display: 'flex',
      flexDirection: 'column',
      // 拖宽把手悬出左缘 5px,裁剪交给内层滚动容器(内层均已 overflow:auto)
      overflow: 'visible',
      zIndex: 21,
    },
    children: jsxs(Fragment, {
      children: [
        // 左缘拖宽把手(悬出一半;双击复位)
        jsx('div', {
          title: t('panel.resizeHint'),
          role: 'separator',
          'aria-orientation': 'vertical',
          onPointerDown: onDragStart,
          onPointerMove: onDragMove,
          onPointerUp: onDragEnd,
          onPointerCancel: onDragEnd,
          onDoubleClick: () => setWidth(DEFAULT_PANEL_WIDTH),
          style: {
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: -5,
            width: 10,
            cursor: 'col-resize',
            touchAction: 'none',
            zIndex: 1,
          },
        }),
        // TAB 栏
        jsxs('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '6px 8px 0 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            flexShrink: 0,
          },
          children: [
            TabButton({ label: t('tab.explorer'), active: tab === 'explorer', onClick: () => setTab('explorer') }),
            TabButton({ label: 'Git', active: tab === 'git', onClick: () => setTab('git') }),
            jsx('div', { style: { flex: 1 } }),
            jsx('button', {
              className: 'dshw-iconbtn',
              // 与展开钮同 icon(boss 定版):开关同形,toggle 语义
              title: t('panel.collapse'),
              onClick: () => toggle(false),
              children: jsx(IconPanelRight, { size: 16 }),
            }),
          ],
        }),
        cwd === undefined
          ? EmptyState({ text: t('panel.noWorkspace') })
          : jsxs(Fragment, {
              children: [tab === 'explorer' ? jsx(ExplorerTab, { cwd, bridge: props.dshwBridge, currentSessionId, key: `exp-${cwd}` }) : jsx(GitTab, { cwd, key: `git-${cwd}` })],
            }),
      ],
    }),
  })
}

function TabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return jsx('button', {
    className: 'dshw-tab',
    'data-active': props.active || undefined,
    onClick: props.onClick,
    children: props.label,
  })
}

function EmptyState(props: { text: string }) {
  return jsx('div', {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      color: 'var(--dsw-alias-label-dimmed)',
      fontSize: 12,
      textAlign: 'center',
      whiteSpace: 'pre-line',
      lineHeight: '20px',
    },
    children: props.text,
  })
}

// ---------------------------------------------------------------------------
// ExplorerTab:文件树懒展开
// ---------------------------------------------------------------------------

interface FsEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size?: number
  mtime?: number
}

/** 添加到对话桥:宿主 session scope ctx + conversation input resolver(惰性,拿不到降级)。 */
interface DshwBridge {
  scope: (sessionId: string) => any
  conversationInput: () => any
}

/** 右键菜单定位目标(视口坐标)+ 菜单对应条目。 */
interface ContextMenuAt {
  entry: FsEntry
  dir: string
  x: number
  y: number
}

function ExplorerTab(props: { cwd: string; bridge?: DshwBridge; currentSessionId?: string }): any {
  const [levels, setLevels] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [reload, setReload] = useState(0)
  const [menu, setMenu] = useState<ContextMenuAt | undefined>(undefined)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | undefined>(undefined)
  const [renaming, setRenaming] = useState<{ dir: string; value: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const requested = useRef<Record<string, boolean>>({})
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (text: string, tone: 'info' | 'error' = 'info'): void => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    setToast({ text, tone })
    toastTimer.current = setTimeout(() => setToast(undefined), 3200)
  }

  useEffect(() => {
    requested.current = {}
    setLevels({})
    setExpanded({})
    setError(undefined)
    setMenu(undefined)
    setRenaming(undefined)
  }, [props.cwd, reload])

  useEffect(() => {
    const load = async (dir: string): Promise<void> => {
      if (requested.current[dir] === true) return
      requested.current[dir] = true
      try {
        const body = await postJson('/dsh-coding-workspace/fs-list', { root: props.cwd, dir })
        if (!body?.ok) throw new Error(body?.message ?? t('explorer.readFailed'))
        setLevels((prev) => ({ ...prev, [dir]: body.entries ?? [] }))
      } catch (e) {
        requested.current[dir] = false
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load('.')
    for (const dir of Object.keys(expanded)) void load(dir)
  }, [props.cwd, reload, expanded])

  const toggleDir = (dir: string): void => {
    setExpanded((prev) => ({ ...prev, [dir]: !prev[dir] }))
  }

  /** fs-action 统一出口:错误 toast,成功按需刷树。 */
  const fsAct = async (action: string, dir: string, extra?: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      const body = await postJson('/dsh-coding-workspace/fs-action', { root: props.cwd, action, dir, ...extra })
      if (!body?.ok) throw new Error(body?.message ?? t('action.failed'))
      return true
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  /** 剪贴板(相对/绝对路径);非安全上下文降级 toast。 */
  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('copy.done', { label, text }))
    } catch {
      showToast(t('copy.failed'), 'error')
    }
  }

  /** 添加到对话:文件走官方 reference 体系(insertReference → 蓝色引用芯片,提交时按
   * codec 序列化,与手动 @ 引用完全同形);目录官方 onPick 本就落文本(带尾斜杠续打),
   * 同样落文本;引用通道不可用时降级 setDraft 纯文本,再降级复制。 */
  const addToChat = (rel: string, isDir: boolean): void => {
    const sessionId = props.currentSessionId
    const input = props.bridge?.conversationInput?.()
    const actx = sessionId !== undefined ? props.bridge?.scope?.(sessionId) : undefined
    if (actx === undefined || actx === null || input === undefined || input === null) {
      void copyText(`@${rel}`, t('copy.relFallback'))
      return
    }
    try {
      const facade = input.for(actx)
      const snap = facade?.state?.getSnapshot?.()
      const draft: string = snap?.draft ?? ''
      // 官方 formatFileMention 规则:含空白需引号;目录带尾斜杠
      const mention = /\s/.test(rel) ? (isDir ? `@"${rel}/` : `@"${rel}"`) : `@${rel}`
      const name = entryBasename(rel)
      if (!isDir && facade?.insertReference !== undefined && snap !== undefined) {
        // 空区间 + draftRev CAS:机器在草稿末尾 mint 引用 occurrence(与手动 @ 选中同一管线)
        const applied = facade.insertReference(
          { source: 'reference', ref: mention, label: name, appearance: 'file', clipboardText: mention },
          { start: draft.length, end: draft.length, draftRev: snap.draftRev },
        )
        if (applied === true) {
          showToast(t('explorer.addedToChat', { path: rel }))
          return
        }
      }
      const insert = `${mention}${isDir ? '' : ' '}`
      facade.actions.setDraft(draft === '' || draft.endsWith(' ') || draft.endsWith('\n') ? `${draft}${insert}` : `${draft} ${insert}`)
      showToast(t('explorer.addedToChat', { path: rel }))
    } catch (e) {
      showToast(t('explorer.addToChatFailed', { error: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  const onMenuAction = (id: string): void => {
    if (menu === undefined) return
    const { entry, dir } = menu
    setMenu(undefined)
    switch (id) {
      case 'open':
        void fsAct('open', dir).then((ok) => {
          if (ok) showToast(t('explorer.opened', { name: entryBasename(dir) }))
        })
        break
      case 'reveal':
        void fsAct('reveal', dir).then((ok) => {
          if (ok) showToast(t('explorer.located'))
        })
        break
      case 'chat':
        addToChat(dir, menu.entry.type === 'dir')
        break
      case 'copyrel':
        void copyText(dir, t('copy.relativeLabel'))
        break
      case 'copyabs':
        void copyText(joinAbsClient(props.cwd, dir), t('copy.absoluteLabel'))
        break
      case 'rename':
        setRenaming({ dir, value: entry.name })
        break
      case 'delete': {
        const confirmText = entry.type === 'dir' ? t('explorer.deleteDirConfirm', { path: dir }) : t('explorer.deleteFileConfirm', { path: dir })
        if (window.confirm(confirmText)) {
          void fsAct('delete', dir, { confirm: true }).then((ok) => {
            if (ok) setReload((n) => n + 1)
          })
        }
        break
      }
    }
  }

  const confirmRename = (): void => {
    if (renaming === undefined) return
    const { dir, value } = renaming
    setRenaming(undefined)
    if (value === '' || value === entryBasename(dir)) return
    void fsAct('rename', dir, { name: value }).then((ok) => {
      if (ok) setReload((n) => n + 1)
    })
  }

  const top = levels['.'] ?? []

  return jsxs(Fragment, {
    children: [
      jsx(PanelBar, {
        left: jsxs(Fragment, {
          children: [
            jsx(IconBranch, { size: 13, style: { color: 'var(--dsw-alias-brand-primary)' } }),
            jsx('span', {
              style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              children: splitPath(props.cwd).name || props.cwd,
            }),
            jsx('span', { title: props.cwd, style: { color: 'var(--dsw-alias-label-dimmed)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: props.cwd }),
          ],
        }),
        right: jsx('button', { className: 'dshw-iconbtn', title: t('action.refresh'), onClick: () => setReload((n) => n + 1), children: jsx(IconRefresh, { size: 13 }) }),
      }),
      toast !== undefined
        ? jsx('div', {
            style: {
              margin: '0 8px 4px',
              padding: '5px 10px',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: '18px',
              wordBreak: 'break-all',
              color: toast.tone === 'error' ? '#f85149' : 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
            },
            children: toast.text,
          })
        : null,
      renaming !== undefined
        ? jsx('div', {
            // 行内编辑模式提示条(编辑框在原文件名处):占位一条细提示,不打断树形位置感
            style: { padding: '0 12px 4px', fontSize: 11.5, color: 'var(--dsw-alias-label-dimmed)' },
            children: t('explorer.renamingHint', { path: renaming.dir }),
          })
        : null,
      error !== undefined
        ? jsx('div', { style: { padding: '8px 12px', fontSize: 12, color: '#f85149' }, children: error })
        : jsx('div', {
            style: { flex: 1, overflow: 'auto', padding: '4px 4px 12px' },
            onContextMenu: (e: any) => {
              // 空白处右键:不弹条目菜单(仅阻止宿主默认菜单)
              e.preventDefault()
            },
            children: top.map((e) =>
              TreeNode({
                entry: e,
                dir: '',
                level: 0,
                levels,
                expanded,
                onToggle: toggleDir,
                onContext: (entry, dir, x, y) => setMenu({ entry, dir, x, y }),
                renaming,
                onRenameChange: (value) => setRenaming((prev) => (prev === undefined ? prev : { ...prev, value })),
                onRenameConfirm: confirmRename,
                onRenameCancel: () => setRenaming(undefined),
              }),
            ),
          }),
      menu !== undefined
        ? jsx(EntryContextMenu, {
            at: menu,
            onAction: onMenuAction,
            onClose: () => setMenu(undefined),
          })
        : null,
    ],
  })
}

/** 条目名在其相对路径中的最后一段(客户端轻量,不引 node path)。 */
function entryBasename(rel: string): string {
  const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
  return cut === -1 ? rel : rel.slice(cut + 1)
}

/** 客户端绝对路径拼接:root + POSIX 相对;root 为 Windows 形态时输出反斜杠。 */
function joinAbsClient(root: string, rel: string): string {
  const segments = rel.split('/').filter((seg) => seg !== '' && seg !== '.')
  const win = root.includes('\\')
  const sepPath = win ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  return base + sepPath + segments.join(sepPath)
}

function TreeNode(props: {
  entry: FsEntry
  dir: string
  level: number
  levels: Record<string, FsEntry[]>
  expanded: Record<string, boolean>
  onToggle: (dir: string) => void
  onContext: (entry: FsEntry, dir: string, x: number, y: number) => void
  /** 行内重命名:childDir 命中时名字原地变输入框(Enter 确认 / Esc 取消 / blur 确认)。 */
  renaming?: { dir: string; value: string }
  onRenameChange?: (value: string) => void
  onRenameConfirm?: () => void
  onRenameCancel?: () => void
}): any {
  const { entry, dir, level } = props
  const childDir = dir === '' ? entry.name : `${dir}/${entry.name}`
  const isDir = entry.type === 'dir'
  const isOpen = isDir && props.expanded[childDir] === true
  const tip = entry.type === 'file' ? `${fmtSize(entry.size)}${entry.mtime !== undefined ? ` · ${new Date(entry.mtime).toLocaleString()}` : ''}` : childDir
  const editing = props.renaming !== undefined && props.renaming.dir === childDir
  return jsxs(Fragment, {
    children: [
      jsx('div', {
        className: 'dshw-frow',
        title: editing ? undefined : tip,
        onClick: isDir && !editing ? () => props.onToggle(childDir) : undefined,
        onContextMenu: (e: any) => {
          e.preventDefault()
          e.stopPropagation()
          props.onContext(entry, childDir, e.clientX, e.clientY)
        },
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 27,
          paddingLeft: 8 + level * 13,
          paddingRight: 8,
          borderRadius: 6,
          fontSize: 12.5,
          color: 'var(--dsw-alias-label-primary)',
          cursor: isDir && !editing ? 'pointer' : 'default',
          minWidth: 0,
          background: editing ? 'var(--dsw-alias-interactive-bg-hover)' : undefined,
        },
        children: isDir
          ? jsxs(Fragment, {
              children: [
                jsx(IconChevron, { open: isOpen, size: 11, style: { color: 'var(--dsw-alias-label-dimmed)' } }),
                jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' }, children: isOpen ? jsx(PrimitivesFolderOpen, {}) : jsx(PrimitivesFolderClose, {}) }),
                editing ? renameInput(props) : jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry.name }),
              ],
            })
          : jsxs(Fragment, {
              children: [
                jsx('span', { style: { width: 11, flexShrink: 0 } }),
                jsx(FileIcon, { name: entry.name }),
                editing ? renameInput(props) : jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry.name }),
              ],
            }),
      }),
      isOpen && (props.levels[childDir] ?? []).map((child) => TreeNode({ ...props, entry: child, dir: childDir, level: level + 1 })),
    ],
  })
}

/** 行内重命名输入框(受控,状态在 ExplorerTab;Enter 确认 / Esc 取消 / blur 确认)。 */
function renameInput(props: {
  renaming?: { dir: string; value: string }
  onRenameChange?: (value: string) => void
  onRenameConfirm?: () => void
  onRenameCancel?: () => void
}): any {
  if (props.renaming === undefined) return null
  return jsx('input', {
    className: 'dshw-rename-input',
    autoFocus: true,
    value: props.renaming.value,
    onChange: (e: any) => props.onRenameChange?.(e.target.value),
    onKeyDown: (e: any) => {
      if (e.key === 'Enter') props.onRenameConfirm?.()
      if (e.key === 'Escape') props.onRenameCancel?.()
    },
    onBlur: () => props.onRenameConfirm?.(),
    onClick: (e: any) => e.stopPropagation(),
    style: { flex: 1, minWidth: 0, height: 20, padding: '0 4px', fontSize: 12.5, fontFamily: 'inherit' },
  })
}

/** 条目右键菜单:fixed 0 尺寸锚点 + 官方 Menu portal(与行内菜单同视觉);
 * icon 用 14px 线性小图,删除 danger 红字标识风险。 */
function EntryContextMenu(props: { at: ContextMenuAt; onAction: (id: string) => void; onClose: () => void }): any {
  const isFile = props.at.entry.type !== 'dir'
  const width = 186
  const left = Math.min(props.at.x, Math.max(0, window.innerWidth - width - 8))
  const top = Math.min(props.at.y, Math.max(0, window.innerHeight - 7 * 30 - 8))
  const item = (id: string, label: string, icon: any, danger?: boolean): any => ({ id, label, icon, ...(danger ? { danger: true } : {}) })
  const items: any[] = []
  if (isFile) items.push(item('open', t('menu.openWithDefault'), jsx(IconOpenExternal, { size: 14 })))
  items.push(
    item('reveal', t('menu.reveal'), jsx(IconFolderOpen, { size: 14 })),
    item('chat', t('menu.addToChat'), jsx(IconChatAdd, { size: 14 })),
    item('copyrel', t('menu.copyRelative'), jsx(IconCopyPath, { size: 14 })),
    item('copyabs', t('menu.copyAbsolute'), jsx(IconCopyPath, { size: 14, style: { opacity: 0.7 } })),
    item('rename', t('menu.rename'), jsx(IconRename, { size: 14 })),
    item('delete', t('menu.delete'), jsx(IconTrash, { size: 14 }), true),
  )
  return jsx('div', {
    style: { position: 'fixed', left, top, width: 1, height: 1, zIndex: 1 },
    children: jsx(Primitives.Menu, {
      open: true,
      onClose: props.onClose,
      items,
      onSelect: (id: string) => props.onAction(id),
      portal: true,
      anchor: jsx('div', { style: { width: 1, height: 1 } }),
    }),
  })
}

/** Changes 文件右键菜单:放弃更改(风险红)+ 移动到分组(子菜单:各 Changelist + 移回默认)。 */
function ChangesContextMenu(props: {
  at: { entry: StatusEntry; x: number; y: number }
  lists: string[]
  onAction: (id: string) => void
  onClose: () => void
}): any {
  const width = 186
  const left = Math.min(props.at.x, Math.max(0, window.innerWidth - width - 8))
  const top = Math.min(props.at.y, Math.max(0, window.innerHeight - 4 * 30 - 8))
  const sub = props.lists.map((name) => ({ id: `mv:${name}`, label: name }))
  sub.push({ id: 'mv:__default__', label: t('changes.moveToDefault') })
  const items = [
    { id: 'rollback', label: t('changes.rollback'), icon: jsx(IconRollback, { size: 14 }), danger: true },
    { id: 'move', label: t('changes.moveToGroup'), icon: jsx(IconListPlus, { size: 14 }), submenu: sub },
  ]
  return jsx('div', {
    style: { position: 'fixed', left, top, width: 1, height: 1, zIndex: 1 },
    children: jsx(Primitives.Menu, {
      open: true,
      onClose: props.onClose,
      items,
      onSelect: (id: string) => props.onAction(id),
      portal: true,
      anchor: jsx('div', { style: { width: 1, height: 1 } }),
    }),
  })
}

/** 右列 diffstat(ORCA 式):`+18 -1 M`。加行绿、删行红、状态字母用状态色板;无统计只显字母。 */
function DiffStatView(props: { stat?: { add: number; del: number }; letter: string }): any {
  const { stat, letter } = props
  return jsxs('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      flexShrink: 0,
      fontFamily: 'var(--ds-font-family-mono, monospace)',
      fontSize: 11,
      whiteSpace: 'pre',
    },
    children: [
      stat !== undefined ? jsx('span', { style: { color: '#3fb950' }, children: `+${stat.add}` }) : null,
      stat !== undefined ? jsx('span', { style: { color: '#f85149' }, children: `-${stat.del}` }) : null,
      jsx('span', {
        style: {
          width: 14,
          textAlign: 'center',
          color: STATUS_COLORS[letter] ?? '#8b949e',
          fontWeight: 600,
          fontSize: 10.5,
        },
        children: letter,
      }),
    ],
  })
}

/** 回滚:逆时针环形箭头。 */
function IconRollback(p: IconProps) {
  return menuIcon(p.size, p.style, jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M3.2 7.2a5.2 5.2 0 1 1 1.2 4.6' }),
      jsx('path', { d: 'M2.6 3.6v3.6h3.6' }),
    ],
  }))
}

// ── 右键菜单小图(14px 线性,currentColor;danger 项随宿主红色着色)──

function menuIcon(size: number | undefined, style: unknown, children: any): any {
  return jsx('svg', {
    width: size ?? 14,
    height: size ?? 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    xmlns: 'http://www.w3.org/2000/svg',
    style,
    children,
  })
}

/** 默认程序打开:窗口 + 外指箭头。 */
function IconOpenExternal(p: IconProps) {
  return menuIcon(p.size, p.style, jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M13 9.5V12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12V4.5A1.5 1.5 0 0 1 3.5 3H6' }),
      jsx('path', { d: 'M9.5 2.5H13.5V6.5' }),
      jsx('path', { d: 'M13.2 2.8 7.8 8.2' }),
    ],
  }))
}

/** 资源管理器定位:打开态文件夹。 */
function IconFolderOpen(p: IconProps) {
  return menuIcon(p.size, p.style, jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M2 5.5A1.5 1.5 0 0 1 3.5 4h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 7.1' }),
      jsx('path', { d: 'M2 12.2 3.6 7.6A1.2 1.2 0 0 1 4.7 6.8h9.1a1 1 0 0 1 .95 1.3l-1.4 4.2a1.2 1.2 0 0 1-1.14.82H3.1A1.1 1.1 0 0 1 2 12.2z' }),
    ],
  }))
}

/** 添加到对话:气泡 + 加号。 */
function IconChatAdd(p: IconProps) {
  return menuIcon(p.size, p.style, jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M13.5 8A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 5.5 5.5z' }),
      jsx('path', { d: 'M13.2 13.2 8 12.9' }),
      jsx('path', { d: 'M8 5.8v4.4M5.8 8h4.4' }),
    ],
  }))
}

/** 复制路径:双矩形(copy)+ 中点示意路径。 */
function IconCopyPath(p: IconProps) {
  return menuIcon(p.size, p.style, jsxs(Fragment, {
    children: [
      jsx('rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.2' }),
      jsx('path', { d: 'M10.5 3.5h-7A1 1 0 0 0 2.5 4.5v7' }),
      jsx('path', { d: 'M7.6 9.5h4' }),
    ],
  }))
}

/** 重命名:铅笔。 */
function IconRename(p: IconProps) {
  return menuIcon(p.size, p.style, jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M9.8 3.2l3 3L6 13H3v-3l6.8-6.8z' }),
      jsx('path', { d: 'M8.4 4.6l3 3' }),
    ],
  }))
}

/** 删除:垃圾桶。 */
function IconTrash(p: IconProps) {
  return menuIcon(p.size, p.style, jsxs(Fragment, {
    children: [
      jsx('path', { d: 'M3 4.5h10' }),
      jsx('path', { d: 'M6.2 4.5V3.2A1.2 1.2 0 0 1 7.4 2h1.2a1.2 1.2 0 0 1 1.2 1.2v1.3' }),
      jsx('path', { d: 'M4.5 4.5l.6 8.3A1.4 1.4 0 0 0 6.5 14h3a1.4 1.4 0 0 0 1.4-1.2l.6-8.3' }),
      jsx('path', { d: 'M6.8 7.5v3.6M9.2 7.5v3.6' }),
    ],
  }))
}

/** 文件类型徽章:扩展名 → 底色 + 两字符缩写(无命中灰点,目录不用此件)。 */
const FILE_BADGES: Array<[string, string, string]> = [
  ['ts', '#3178c6', 'TS'], ['tsx', '#3178c6', 'TS'], ['mts', '#3178c6', 'TS'], ['cts', '#3178c6', 'TS'],
  ['js', '#b8860b', 'JS'], ['jsx', '#b8860b', 'JS'], ['mjs', '#b8860b', 'JS'], ['cjs', '#b8860b', 'JS'],
  ['json', '#8f8a00', '{}'], ['jsonc', '#8f8a00', '{}'],
  ['md', '#519aba', 'MD'], ['mdx', '#519aba', 'MD'],
  ['py', '#3572A5', 'PY'],
  ['html', '#e34c26', '<>'], ['htm', '#e34c26', '<>'],
  ['css', '#563d7c', 'CS'], ['scss', '#c6538c', 'SC'], ['sass', '#c6538c', 'SC'], ['less', '#2b5e8f', 'LE'],
  ['yml', '#a8552d', 'Y'], ['yaml', '#a8552d', 'Y'], ['toml', '#8a7a52', 'T'],
  ['sh', '#4a7a2a', '$_'], ['bash', '#4a7a2a', '$_'], ['zsh', '#4a7a2a', '$_'],
  ['ps1', '#5391EC', 'PS'], ['bat', '#777d1a', 'BT'], ['cmd', '#777d1a', 'BT'],
  ['go', '#00879c', 'GO'], ['rs', '#b0653a', 'RS'], ['java', '#b07219', 'JV'],
  ['c', '#555555', 'C'], ['h', '#555555', 'C'], ['cpp', '#00599c', 'C+'], ['cc', '#00599c', 'C+'], ['hpp', '#00599c', 'C+'],
  ['cs', '#178600', 'C#'], ['rb', '#701516', 'RB'], ['php', '#4F5D95', 'PP'],
  ['swift', '#e0623d', 'SW'], ['kt', '#7F52FF', 'KT'], ['scala', '#a32222', 'SC'],
  ['vue', '#3f9e76', 'V'], ['svelte', '#c4532f', 'SV'],
  ['sql', '#b56a2b', 'SQ'], ['xml', '#0060ac', 'XM'],
  ['png', '#8250df', 'IM'], ['jpg', '#8250df', 'IM'], ['jpeg', '#8250df', 'IM'], ['gif', '#8250df', 'IM'],
  ['bmp', '#8250df', 'IM'], ['webp', '#8250df', 'IM'], ['svg', '#8250df', 'SV'], ['ico', '#8250df', 'IM'],
  ['zip', '#9a6700', 'AR'], ['rar', '#9a6700', 'AR'], ['7z', '#9a6700', 'AR'], ['tar', '#9a6700', 'AR'],
  ['gz', '#9a6700', 'AR'], ['bz2', '#9a6700', 'AR'], ['xz', '#9a6700', 'AR'],
  ['pdf', '#cc2418', 'PD'],
  ['doc', '#2b579a', 'DO'], ['docx', '#2b579a', 'DO'],
  ['xls', '#217346', 'XL'], ['xlsx', '#217346', 'XL'], ['csv', '#217346', 'C,'],
  ['ppt', '#c04325', 'PT'], ['pptx', '#c04325', 'PT'],
  ['txt', '#6e7781', 'TX'], ['log', '#6e7781', 'TX'], ['ini', '#6e7781', 'CF'], ['cfg', '#6e7781', 'CF'],
  ['conf', '#6e7781', 'CF'], ['env', '#6e7781', 'CF'], ['lock', '#6e7781', 'LO'],
  ['gitignore', '#6e7781', 'GI'], ['dockerignore', '#6e7781', 'GI'], ['editorconfig', '#6e7781', 'EC'],
  ['dockerfile', '#2496ed', 'DK'], ['makefile', '#6e7781', 'MK'], ['license', '#6e7781', 'LI'],
]

function FileIcon(props: { name: string }): any {
  const ext = (props.name.includes('.') ? props.name.split('.').pop()! : props.name).toLowerCase()
  const hit = FILE_BADGES.find(([e]) => e === ext)
  if (hit === undefined) {
    // 无命中:通用文件轮廓(原 IconFile,灰)
    return jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-dimmed)' }, children: jsx(IconFile, { size: 13 }) })
  }
  const [, color, label] = hit
  return jsx('svg', {
    width: 14,
    height: 13,
    viewBox: '0 0 16 15',
    style: { flexShrink: 0 },
    children: jsxs(Fragment, {
      children: [
        jsx('rect', { x: '1', y: '1.5', width: '14', height: '12', rx: '3', fill: color }),
        jsx('text', {
          x: '8',
          y: label.length === 1 ? '10.4' : '10',
          textAnchor: 'middle',
          fontSize: label.length === 1 ? 8.5 : 7.2,
          fontWeight: 700,
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fill: '#ffffff',
          children: label,
        }),
      ],
    }),
  })
}

/** 官方 folder primitives(宿主 external 提供;类型面未声明,运行时直取)。 */
function PrimitivesFolderClose(): any {
  return jsx((Primitives as any).IconFolderClose16 ?? FolderGlyph, { size: 13 })
}

function PrimitivesFolderOpen(): any {
  return jsx((Primitives as any).IconFolderOpen16 ?? FolderGlyph, { size: 13 })
}

function FolderGlyph(): any {
  return jsx('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'currentColor', children: jsx('path', { d: 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 1.8H13A1.5 1.5 0 0 1 14.5 5.3v7.2A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9z' }) })
}

// ---------------------------------------------------------------------------
// 面板通用小件
// ---------------------------------------------------------------------------

/** 面板区块头:左标题右操作,28px。 */
function PanelBar(props: { left: any; right: any }): any {
  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      height: 34,
      padding: '0 8px 0 12px',
      flexShrink: 0,
      fontSize: 12.5,
      color: 'var(--dsw-alias-label-primary)',
      minWidth: 0,
    },
    children: [
      jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }, children: props.left }),
      props.right,
    ],
  })
}

// ---------------------------------------------------------------------------
// GitTab:概览条 + Changes/Logs 子 TAB
// ---------------------------------------------------------------------------

interface Overview {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
}

function GitTab(props: { cwd: string }): any {
  const [overview, setOverview] = useState<Overview | undefined>(undefined)
  const [subTab, setSubTab] = useState<'changes' | 'logs'>('changes')
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | undefined>(undefined)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showToast = (text: string, tone: 'info' | 'error' = 'info'): void => {
    setToast({ text, tone })
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(undefined), 2600)
  }

  useEffect(() => {
    let alive = true
    postJson('/dsh-coding-workspace/git-overview', { cwd: props.cwd })
      .then((body: any) => {
        if (alive) setOverview(body?.ok ? body : { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, detached: false })
      })
      .catch(() => alive && setOverview({ isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, detached: false }))
    return () => {
      alive = false
    }
  }, [props.cwd, reload])

  const refreshAll = (): void => setReload((n) => n + 1)

  const sync = async (action: 'fetch' | 'pull' | 'push'): Promise<void> => {
    if (busy !== undefined) return
    setBusy(action)
    try {
      await panelAction(props.cwd, action)
      showToast(action === 'fetch' ? t('git.fetchDone') : action === 'pull' ? t('git.pullDone') : t('git.pushDone'))
      refreshAll()
    } catch (e) {
      showToast(t('git.actionFailed', { action, error: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setBusy(undefined)
    }
  }

  if (overview !== undefined && !overview.isRepo) {
    return EmptyState({ text: t('state.noRepo') })
  }

  const dirty = (overview?.ahead ?? 0) > 0 || (overview?.behind ?? 0) > 0

  return jsxs(Fragment, {
    children: [
      // 概览条:分支 + ahead/behind + Fetch/Pull/Push
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 34,
          padding: '0 8px 0 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          flexShrink: 0,
          fontSize: 12.5,
          minWidth: 0,
        },
        children: [
          jsx(IconBranch, { size: 13, style: { color: 'var(--dsw-alias-brand-primary)', flexShrink: 0 } }),
          jsx('span', {
            title: overview?.upstream !== null && overview?.upstream !== undefined ? `${overview.branch} → ${overview.upstream}` : (overview?.branch ?? ''),
            style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: overview?.detached === true ? 'HEAD (detached)' : (overview?.branch ?? '…'),
          }),
          dirty
            ? jsxs('span', {
                style: { flexShrink: 0, fontFamily: 'var(--ds-font-family-mono, monospace)', fontSize: 11, color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' },
                children: [
                  overview.ahead > 0 ? `↑${overview.ahead}` : '',
                  overview.behind > 0 ? `↓${overview.behind}` : '',
                ],
              })
            : null,
          jsx('div', { style: { flex: 1 } }),
          jsx('button', { className: 'dshw-iconbtn', title: 'Fetch', disabled: busy === 'fetch', onClick: () => void sync('fetch'), children: jsx(IconFetch, { size: 14 }) }),
          jsx('button', { className: 'dshw-iconbtn', title: 'Pull', disabled: busy === 'pull', onClick: () => void sync('pull'), children: jsx(IconPull, { size: 14 }) }),
          jsx('button', { className: 'dshw-iconbtn', title: 'Push', disabled: busy === 'push', onClick: () => void sync('push'), children: jsx(IconPush, { size: 14 }) }),
        ],
      }),
      // 子 TAB
      jsxs('div', {
        style: { display: 'flex', gap: 2, padding: '6px 8px 0 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0 },
        children: [
          TabButton({ label: 'Changes', active: subTab === 'changes', onClick: () => setSubTab('changes') }),
          TabButton({ label: 'Logs', active: subTab === 'logs', onClick: () => setSubTab('logs') }),
          jsx('div', { style: { flex: 1 } }),
          jsx('button', { className: 'dshw-iconbtn', title: t('action.refresh'), onClick: refreshAll, children: jsx(IconRefresh, { size: 13 }) }),
        ],
      }),
      jsx('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }, children: subTab === 'changes' ? jsx(ChangesView, { cwd: props.cwd, reload, showToast }) : jsx(LogsView, { cwd: props.cwd, reload }) }),
      toast !== undefined
        ? jsx('div', {
            style: {
              margin: 10,
              padding: '7px 11px',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: '18px',
              flexShrink: 0,
              color: toast.tone === 'error' ? '#f85149' : 'var(--dsw-alias-label-primary)',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
              wordBreak: 'break-all',
              maxHeight: 100,
              overflow: 'auto',
            },
            children: toast.text,
          })
        : null,
    ],
  })
}

function MiniBtn(props: { label: string; busy?: boolean; onClick: () => void; disabled?: boolean }): any {
  return jsx('button', {
    className: 'dshw-minibtn',
    onClick: props.onClick,
    disabled: props.busy || props.disabled,
    children: props.busy ? '…' : props.label,
  })
}

// ---------------------------------------------------------------------------
// ChangesView:staged/unstaged/untracked + stage/unstage + commit
// ---------------------------------------------------------------------------

interface StatusEntry {
  x: string
  y: string
  path: string
  from?: string
}

function ChangesView(props: { cwd: string; reload: number; showToast: (text: string, tone?: 'info' | 'error') => void }): any {
  const [groups, setGroups] = useState<{ staged: StatusEntry[]; unstaged: StatusEntry[]; untracked: StatusEntry[] } | undefined>(undefined)
  /** 增删行数(path → {add,del};untracked 由服务端数行)。 */
  const [stats, setStats] = useState<Record<string, { add: number; del: number }>>({})
  const [lists, setLists] = useState<{ name: string; files: string[] }[]>([])
  /** 勾选集(提交范围):新增状态变化后默认全选,用户手动增减。 */
  const [checked, setChecked] = useState<Set<string> | null>(null)
  const [viewMode, setViewMode] = useState<'flat' | 'module' | 'folder'>('flat')
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [creatingList, setCreatingList] = useState(false)
  const [newListName, setNewListName] = useState('')
  /** 文件右键菜单目标(Changes 页:放弃更改 / 移动到分组)。 */
  const [ctxMenu, setCtxMenu] = useState<{ entry: StatusEntry; x: number; y: number } | undefined>(undefined)

  /** 放弃更改确认流(右键菜单与行 hover 按钮共用):确认后 rollback + 刷新。 */
  const requestRollback = (entry: StatusEntry): void => {
    const isNew = entry.x === '?' || entry.y === '?'
    if (!window.confirm(isNew ? t('changes.deleteNewConfirm', { path: entry.path }) : t('changes.rollbackConfirm', { path: entry.path }))) return
    void panelAction(props.cwd, 'rollback', { path: entry.path })
      .then((out) => {
        props.showToast(out)
        return refreshStatus()
      })
      .catch((e) => props.showToast(t('changes.rollbackFailed', { error: e instanceof Error ? e.message : String(e) }), 'error'))
  }

  /** 右键动作分发:放弃更改 / 移动到分组(submenu 编码 id)。 */
  const onCtxAction = (id: string): void => {
    const at = ctxMenu
    setCtxMenu(undefined)
    if (at === undefined) return
    if (id === 'rollback') {
      requestRollback(at.entry)
      return
    }
    if (id.startsWith('mv:')) {
      const to = id.slice(3)
      void listAction('move', { files: [at.entry.path], to: to === '__default__' ? null : to })
    }
  }

  const refreshStatus = async (): Promise<void> => {
    const body = await postJson('/dsh-coding-workspace/git-status', { cwd: props.cwd })
    if (body?.ok) {
      setGroups({ staged: body.staged ?? [], unstaged: body.unstaged ?? [], untracked: body.untracked ?? [] })
      if (body.stats !== undefined && body.stats !== null && typeof body.stats === 'object') setStats(body.stats)
    }
  }

  const refreshLists = async (): Promise<void> => {
    const body = await postJson('/dsh-coding-workspace/git-changelist', { cwd: props.cwd, action: 'list' })
    if (body?.ok) setLists(body.lists ?? [])
  }

  useEffect(() => {
    let alive = true
    postJson('/dsh-coding-workspace/git-status', { cwd: props.cwd })
      .then((body: any) => {
        if (alive && body?.ok) {
          setGroups({ staged: body.staged ?? [], unstaged: body.unstaged ?? [], untracked: body.untracked ?? [] })
          if (body.stats !== undefined && body.stats !== null && typeof body.stats === 'object') setStats(body.stats)
        }
      })
      .catch(() => {})
    void refreshLists()
    return () => {
      alive = false
    }
  }, [props.cwd, props.reload])

  const allPaths: StatusEntry[] = groups !== undefined ? [...groups.staged, ...groups.unstaged, ...groups.untracked] : []
  const checkedSet = checked ?? new Set(allPaths.map((e) => e.path))
  const toggle = (path: string): void => {
    const next = new Set(checkedSet)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChecked(next)
  }
  const toggleMany = (paths: string[], on: boolean): void => {
    const next = new Set(checkedSet)
    for (const p of paths) (on ? next.add(p) : next.delete(p))
    setChecked(next)
  }

  const listAction = async (action: 'create' | 'delete' | 'move', extra: Record<string, unknown>): Promise<void> => {
    try {
      const body = await postJson('/dsh-coding-workspace/git-changelist', { cwd: props.cwd, action, ...extra })
      if (body?.ok) setLists(body.lists ?? [])
      else throw new Error(body?.message ?? t('action.failed'))
    } catch (e) {
      props.showToast(t('changes.groupOpFailed', { error: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  const act = async (action: 'stage' | 'unstage', path: string): Promise<void> => {
    try {
      await panelAction(props.cwd, action, { path })
      await refreshStatus()
    } catch (e) {
      props.showToast(t('git.actionFailed', { action: action === 'stage' ? t('changes.stage') : t('changes.unstage'), error: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  const commit = async (): Promise<void> => {
    const selected = allPaths.filter((e) => checkedSet.has(e.path))
    if (committing || selected.length === 0 || message.trim() === '') return
    setCommitting(true)
    try {
      await panelAction(props.cwd, 'commit', { message: message.trim(), paths: selected.map((e) => e.path) })
      setMessage('')
      setChecked(null)
      props.showToast(t('changes.committed', { count: selected.length }))
      await refreshStatus()
    } catch (e) {
      props.showToast(t('changes.commitFailed', { error: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setCommitting(false)
    }
  }

  /** AI 生成(SSE 流式):delta 实时写入输入框,首行凑齐服务端即断上游。 */
  const genMessage = async (): Promise<void> => {
    if (groups === undefined) return
    const selected = allPaths.filter((e) => checkedSet.has(e.path))
    if (aiBusy || selected.length === 0) {
      if (selected.length === 0) props.showToast(t('changes.selectFirst'), 'error')
      return
    }
    const statusFor = (e: StatusEntry): string => {
      if (groups.staged.some((s) => s.path === e.path)) return e.x
      if (groups.untracked.some((s) => s.path === e.path)) return '??'
      return e.y
    }
    setAiBusy(true)
    setMessage('')
    let finalText = ''
    try {
      const res = await fetch('/dsh-coding-workspace/ai-commit-msg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: props.cwd, files: selected.map((e) => ({ path: e.path, status: statusFor(e) })) }),
      })
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok || !contentType.includes('text/event-stream')) {
        // 非 200/非流式:JSON 错误体
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? t('changes.aiHttpError', { status: res.status }))
      }
      const reader = res.body?.getReader()
      if (reader === undefined) throw new Error(t('changes.aiNoStream'))
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut: number
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (line === undefined) continue
          const payload = JSON.parse(line.slice(6)) as { delta?: string; done?: boolean; message?: string; error?: string }
          if (payload.error !== undefined && payload.error !== '') throw new Error(payload.error)
          if (payload.delta !== undefined && payload.delta !== '') {
            finalText += payload.delta
            setMessage(finalText)
          }
          if (payload.done === true && typeof payload.message === 'string') {
            finalText = payload.message
            setMessage(finalText)
          }
        }
      }
      if (finalText === '') throw new Error(t('changes.aiNoText'))
    } catch (e) {
      props.showToast(t('changes.aiFailed', { error: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setAiBusy(false)
    }
  }

  if (groups === undefined) return jsx('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }, children: t('state.loading') })
  if (allPaths.length === 0) return EmptyState({ text: t('state.clean') })

  const selectedCount = allPaths.filter((e) => checkedSet.has(e.path)).length

  return jsxs('div', {
    style: { flex: 1, overflow: 'auto', padding: '4px 4px 12px', display: 'flex', flexDirection: 'column' },
    children: [
      // 工具行:分组视图选择(眼睛)+ 新建分组(icon)
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 6px', flexShrink: 0 },
        children: [
          jsx(ViewModeMenu, { viewMode, onSelect: setViewMode }),
          jsx('button', {
            className: 'dshw-iconbtn',
            title: t('changes.newGroup'),
            onClick: () => {
              setCreatingList(true)
              setNewListName('')
            },
            children: jsx(IconListPlus, { size: 14 }),
          }),
        ],
      }),
      // 暂存段(索引态,不参与 changelist 分组)
      ChangesGroup({
        title: t('changes.staged'),
        count: groups.staged.length,
        collapsed: collapsed['s'] === true,
        onToggle: () => setCollapsed((p) => ({ ...p, s: !p['s'] })),
        entries: groups.staged,
        checkedSet,
        toggle,
        toggleMany,
        indent: 1,
        stats,
        trailing: (e) => jsx('button', { className: 'dshw-iconbtn', title: t('changes.unstage'), onClick: () => void act('unstage', e.path), children: '−' }),
      }),
      // 更改段:changelist 外层分组 → 视图二次分组(不跨组)
      ...changedSections({
        groups: { unstaged: groups.unstaged, untracked: groups.untracked },
        lists,
        viewMode,
        collapsed,
        onToggle: (k) => setCollapsed((p) => ({ ...p, [k]: !p[k] })),
        checkedSet,
        toggle,
        toggleMany,
        stats,
        onStage: (p) => void act('stage', p),
        onDeleteList: (name) => void listAction('delete', { name }),
        onMove: (files, to) => void listAction('move', { files, to }),
        onContext: (e, x, y) => setCtxMenu({ entry: e, x, y }),
        onRollback: requestRollback,
        showToast: props.showToast,
      }),
      // 右键菜单(Changes 文件:回滚 / 移动到分组)
      ctxMenu !== undefined
        ? jsx(ChangesContextMenu, {
            at: ctxMenu,
            lists: lists.map((l) => l.name),
            onAction: onCtxAction,
            onClose: () => setCtxMenu(undefined),
          })
        : null,
      // 新建分组输入条:放在分组列表区末尾(新建组的落点处),不在面板顶部
      creatingList
        ? jsxs('div', {
            style: { display: 'flex', gap: 6, padding: '4px 8px 6px 22px' },
            children: [
              jsx('input', {
                className: 'dshw-commit-msg',
                style: { flex: 1, height: 26, padding: '0 8px', fontSize: 12 },
                placeholder: t('changes.groupNamePlaceholder'),
                autoFocus: true,
                value: newListName,
                onChange: (e: any) => setNewListName(e.target.value),
                onKeyDown: (e: any) => {
                  if (e.key === 'Enter' && newListName.trim() !== '') {
                    void listAction('create', { name: newListName.trim() })
                    setCreatingList(false)
                  }
                  if (e.key === 'Escape') setCreatingList(false)
                },
              }),
              jsx('button', {
                className: 'dshw-minibtn',
                onClick: () => {
                  if (newListName.trim() !== '') void listAction('create', { name: newListName.trim() })
                  setCreatingList(false)
                },
                children: t('action.confirm'),
              }),
            ],
          })
        : null,
      // 提交区(吸底)
      jsxs('div', {
        style: { marginTop: 'auto', padding: '8px 8px 0', display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          jsx('textarea', {
            className: 'dshw-commit-msg',
            placeholder: selectedCount === 0 ? t('changes.commitPlaceholderEmpty') : t('changes.commitPlaceholder'),
            value: message,
            disabled: aiBusy,
            onChange: (e: any) => setMessage(e.target.value),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commit()
            },
            rows: 6,
          }),
          jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
            jsx('button', {
              className: 'dshw-minibtn',
              disabled: aiBusy || selectedCount === 0,
              onClick: () => void genMessage(),
              children: aiBusy ? t('changes.aiGenerating') : t('changes.aiGenerate'),
            }),
            jsx('div', { style: { flex: 1 } }),
            jsx('button', {
              className: 'dshw-minibtn dshw-commit-btn',
              disabled: committing || selectedCount === 0 || message.trim() === '',
              onClick: () => void commit(),
              children: committing ? t('changes.committing') : t('changes.commitSelected', { count: selectedCount }),
            }),
          ] }),
        ],
      }),
    ],
  })
}

/** 更改段:按 changelist 外层分组(命名组(含空组,可作拖拽目标)+ 默认组),组内按视图二次分组。 */
function changedSections(props: {
  groups: { unstaged: StatusEntry[]; untracked: StatusEntry[] }
  lists: { name: string; files: string[] }[]
  viewMode: 'flat' | 'module' | 'folder'
  collapsed: Record<string, boolean>
  onToggle: (key: string) => void
  checkedSet: Set<string>
  toggle: (path: string) => void
  toggleMany: (paths: string[], on: boolean) => void
  onStage: (path: string) => void
  onDeleteList: (name: string) => void
  onMove: (files: string[], to: string | null) => void
  stats?: Record<string, { add: number; del: number }>
  onContext?: (e: StatusEntry, x: number, y: number) => void
  onRollback?: (e: StatusEntry) => void
  showToast: (text: string, tone?: 'info' | 'error') => void
}): any[] {
  const { groups, lists, viewMode } = props
  const statusOf = (path: string): string => {
    const u = groups.unstaged.find((e) => e.path === path)
    if (u !== undefined) return u.y
    return '?'
  }
  const entryOf = (path: string): StatusEntry =>
    groups.unstaged.find((e) => e.path === path) ?? groups.untracked.find((e) => e.path === path) ?? { x: ' ', y: '?', path }

  const namedKeys = new Set(lists.flatMap((l) => l.files))
  const rest = [...groups.unstaged, ...groups.untracked].filter((e) => !namedKeys.has(e.path))
  const sections: any[] = []
  // 命名组(空组也显示:作为拖拽目标);拖拽落点 = 组头。stale(已提交)文件过滤掉。
  for (const list of lists) {
    const entries = list.files.map(entryOf).filter((e) => namedKeys.has(e.path))
    sections.push(
      ChangesGroup({
        title: list.name,
        count: entries.length,
        collapsed: props.collapsed[`l:${list.name}`] === true,
        onToggle: () => props.onToggle(`l:${list.name}`),
        entries,
        statusOf,
        checkedSet: props.checkedSet,
        toggle: props.toggle,
        toggleMany: props.toggleMany,
        viewMode,
        indent: 1,
        groupPrefix: `l:${list.name}`,
        dropTarget: list.name,
        onDropFiles: (files) => props.onMove(files, list.name),
        stats: props.stats,
        onContext: props.onContext,
        onRollback: props.onRollback,
        showToast: props.showToast,
        // 移动到分组走右键菜单/拖拽,行上不再放 ⋯ 菜单
        trailing: (e) => jsx('button', { className: 'dshw-iconbtn', title: t('changes.stage'), onClick: () => props.onStage(e.path), children: '+' }),
        headerExtra: jsx('button', {
          className: 'dshw-iconbtn',
          title: t('changes.deleteGroup'),
          onClick: () => props.onDeleteList(list.name),
          children: '×',
        }),
      }),
    )
  }
  // 默认组:未在任一命名组的更改
  if (rest.length > 0) {
    sections.push(
      ChangesGroup({
        title: t('changes.changed'),
        count: rest.length,
        collapsed: props.collapsed['d'] === true,
        onToggle: () => props.onToggle('d'),
        entries: rest,
        statusOf,
        checkedSet: props.checkedSet,
        toggle: props.toggle,
        toggleMany: props.toggleMany,
        viewMode,
        indent: 1,
        groupPrefix: 'd',
        dropTarget: null,
        onDropFiles: (files) => props.onMove(files, null),
        stats: props.stats,
        onContext: props.onContext,
        onRollback: props.onRollback,
        showToast: props.showToast,
        // 移动到分组走右键菜单/拖拽,行上不再放 ⋯ 菜单
        trailing: (e) => jsx('button', { className: 'dshw-iconbtn', title: t('changes.stage'), onClick: () => props.onStage(e.path), children: '+' }),
      }),
    )
  }
  return sections
}

/** 二次分组键:flat = 单组(无视图组头);module = 路径首段;folder = 目录全路径。 */
function viewGroupKey(path: string, viewMode: 'flat' | 'module' | 'folder'): string {
  if (viewMode === 'module') {
    const norm = path.replace(/\\/g, '/')
    const cut = norm.indexOf('/')
    return cut === -1 ? t('view.root') : norm.slice(0, cut)
  }
  if (viewMode === 'folder') {
    const { dir } = splitPath(path)
    return dir === '' ? t('view.root') : dir.replace(/\/$/, '')
  }
  return ''
}

/** 组级 checkbox:全选/清空该组;部分选中置 indeterminate。 */
function GroupCheckbox(props: { paths: string[]; checkedSet: Set<string>; onToggle: (on: boolean) => void }): any {
  const ref = useRef<HTMLInputElement | null>(null)
  // ⚠️ 空数组 every() 恒 true:空组(无文件)必须显式置灰禁用,否则显示选中且取消无效
  const empty = props.paths.length === 0
  const all = !empty && props.paths.every((p) => props.checkedSet.has(p))
  const some = props.paths.some((p) => props.checkedSet.has(p))
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = !all && some
  }, [all, some])
  return jsx('input', {
    ref,
    type: 'checkbox',
    checked: all,
    disabled: empty,
    title: empty ? t('changes.groupEmpty') : undefined,
    onChange: () => props.onToggle(!all),
    onClick: (ev: any) => ev.stopPropagation(),
    style: { margin: 0, flexShrink: 0, opacity: empty ? 0.35 : undefined, cursor: empty ? 'default' : undefined },
  })
}

/** 一个改动分组:组头(可折叠/计数/额外钮)→ 视图二次分组(可折叠 + 组级勾选)→ 文件行。 */
function ChangesGroup(props: {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  entries: StatusEntry[]
  checkedSet: Set<string>
  toggle: (path: string) => void
  toggleMany: (paths: string[], on: boolean) => void
  viewMode?: 'flat' | 'module' | 'folder'
  indent?: 1 | 2
  groupPrefix?: string
  dropTarget?: string | null
  onDropFiles?: (files: string[]) => void
  stats?: Record<string, { add: number; del: number }>
  /** 右键(放弃更改)回调:给定则行 hover 显示放弃按钮并接右键菜单。 */
  onContext?: (e: StatusEntry, x: number, y: number) => void
  /** 行 hover 放弃按钮(与右键菜单同一确认流)。 */
  onRollback?: (e: StatusEntry) => void
  statusOf?: (path: string) => string
  trailing?: (e: StatusEntry) => any
  headerExtra?: any
  showToast?: (text: string, tone?: 'info' | 'error') => void
}): any {
  if (props.count === 0 && props.dropTarget === undefined) return null
  const statusOf = props.statusOf ?? ((e: StatusEntry) => (props.title === t('changes.staged') ? e.x : e.y))
  const viewMode = props.viewMode ?? 'flat'
  const indent = props.indent ?? 1
  const entryPadLeft = viewMode === 'flat' ? 22 + indent * 14 : 36 + indent * 14 + 14
  // 二次分组:flat 单组无视图组头;module/folder 按 key 聚合,组序按 key 字母序
  const buckets = new Map<string, StatusEntry[]>()
  for (const e of props.entries) {
    const key = viewGroupKey(e.path, viewMode)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [e])
    else bucket.push(e)
  }
  const subGroups = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base', numeric: true }))
  // 拖拽:落点高亮由 body[data-dshw-drop] 状态类控制(dropTarget 组头)
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'dshw-frow',
        onClick: props.onToggle,
        // Changelist 组头可拖:携带组内勾选(无勾选则整组),落到别的组头 = 并入该组
        draggable: props.dropTarget !== undefined,
        onDragStart: props.dropTarget !== undefined
          ? (e: any) => {
              const checkedInGroup = props.entries.filter((e) => props.checkedSet.has(e.path)).map((e) => e.path)
              const batch = checkedInGroup.length > 0 ? checkedInGroup : props.entries.map((e) => e.path)
              e.dataTransfer.setData('application/x-dshw-files', JSON.stringify(batch))
              e.dataTransfer.effectAllowed = 'move'
            }
          : undefined,
        onDragOver: props.onDropFiles !== undefined
          ? (e: any) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
            }
          : undefined,
        onDragLeave: props.onDropFiles !== undefined
          ? (e: any) => {
              e.currentTarget.style.background = ''
            }
          : undefined,
        onDrop: props.onDropFiles !== undefined
          ? (e: any) => {
              e.preventDefault()
              e.stopPropagation()
              e.currentTarget.style.background = ''
              // 非本面板拖拽源(系统文件/其它应用)静默忽略,不报错
              const raw = e.dataTransfer.getData('application/x-dshw-files')
              if (raw === '') return
              try {
                const files = JSON.parse(raw) as string[]
                if (Array.isArray(files) && files.length > 0) props.onDropFiles!(files)
              } catch {
                /* 数据损坏:静默忽略 */
              }
            }
          : undefined,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          height: 28,
          padding: '0 8px',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
          cursor: 'pointer',
        },
        children: [
          jsx(IconChevron, { open: !props.collapsed, size: 11 }),
          // 组级勾选:全选/清空本组(changelist 组 = 组内全部文件;暂存段同款)
          jsx(GroupCheckbox, {
            paths: props.entries.map((e) => e.path),
            checkedSet: props.checkedSet,
            onToggle: (on) => props.toggleMany(props.entries.map((e) => e.path), on),
          }),
          jsx('span', { children: props.title }),
          jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: `(${props.count})` }),
          jsx('div', { style: { flex: 1 } }),
          props.headerExtra,
        ],
      }),
      !props.collapsed &&
        subGroups.map(([key, entries]) => {
          const viewKey = `${props.groupPrefix ?? props.title}:v:${key}`
          const viewCollapsed = props.collapsed[viewKey] === true
          const padLeft = 8 + indent * 14 + 14
          return jsxs(
            Fragment,
            {
              children: [
                viewMode !== 'flat'
                  ? jsxs('div', {
                      className: 'dshw-frow',
                      onClick: () => props.onToggle(viewKey),
                      // 虚拟组头可拖:携带组内勾选(无勾选则整组),drop 到 changelist 组头即整组移动
                      draggable: true,
                      onDragStart: (ev: any) => {
                        const checkedInGroup = entries.filter((e) => props.checkedSet.has(e.path)).map((e) => e.path)
                        const batch = checkedInGroup.length > 0 ? checkedInGroup : entries.map((e) => e.path)
                        ev.dataTransfer.setData('application/x-dshw-files', JSON.stringify(batch))
                        ev.dataTransfer.effectAllowed = 'move'
                      },
                      style: {
                        height: 24,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        paddingLeft: padLeft,
                        paddingRight: 8,
                        borderRadius: 6,
                        fontSize: 11.5,
                        fontWeight: 500,
                        color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
                        cursor: 'pointer',
                      },
                      children: [
                        jsx(IconChevron, { open: !viewCollapsed, size: 10 }),
                        jsx(GroupCheckbox, {
                          paths: entries.map((e) => e.path),
                          checkedSet: props.checkedSet,
                          onToggle: (on) => props.toggleMany(entries.map((e) => e.path), on),
                        }),
                        jsx('span', {
                          style: {
                            fontFamily: 'var(--ds-font-family-mono, monospace)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                          children: key,
                        }),
                        jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: `(${entries.length})` }),
                      ],
                    })
                  : null,
                !viewCollapsed &&
                  entries.map((e) => {
                    const { dir, name } = splitPath(e.path)
                    const checked = props.checkedSet.has(e.path)
                    const stat = props.stats?.[e.path]
                    const letter = statusOf(e) === '?' ? 'U' : statusOf(e)
                    const isNew = e.x === '?' || e.y === '?' || e.x === 'A'
                    return jsxs('div', {
                      className: 'dshw-frow',
                      draggable: true,
                      title: e.from !== undefined ? `${e.from} → ${e.path}` : e.path,
                      onContextMenu: props.onContext !== undefined
                        ? (ev: any) => {
                            ev.preventDefault()
                            ev.stopPropagation()
                            props.onContext!(e, ev.clientX, ev.clientY)
                          }
                        : undefined,
                      onDragStart: (ev: any) => {
                        // 拖已勾选文件 = 携带全部勾选(批量);拖未勾选 = 仅该文件
                        const batch = checked ? [...props.checkedSet] : [e.path]
                        ev.dataTransfer.setData('application/x-dshw-files', JSON.stringify(batch))
                        ev.dataTransfer.effectAllowed = 'move'
                      },
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        height: 27,
                        paddingLeft: entryPadLeft,
                        paddingRight: 8,
                        borderRadius: 6,
                        fontSize: 12.5,
                        minWidth: 0,
                      },
                      children: [
                        jsx('input', {
                          type: 'checkbox',
                          checked,
                          onChange: () => props.toggle(e.path),
                          onClick: (ev: any) => ev.stopPropagation(),
                          style: { margin: 0, flexShrink: 0 },
                        }),
                        jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }, children: jsx('span', { children: [jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: dir }), jsx('span', { style: { color: 'var(--dsw-alias-label-primary)' }, children: name })] }) }),
                        jsx('div', { style: { flex: 1 } }),
                        // 右列两态:默认 `+N -N 字母`(ORCA 式 diffstat);hover 换按钮(放弃更改 + trailing)
                        jsx('span', { className: 'dshw-diffstat', children: DiffStatView({ stat, letter }) }),
                        jsxs('span', { className: 'dshw-diffact', children: [
                          props.onRollback !== undefined
                            ? jsx('button', {
                                className: 'dshw-iconbtn',
                                title: isNew ? t('changes.rollbackHintNew') : t('changes.rollbackHintModified'),
                                onClick: (ev: any) => {
                                  ev.stopPropagation()
                                  props.onRollback!(e)
                                },
                                children: isNew ? jsx(IconTrash, { size: 13 }) : jsx(IconRollback, { size: 13 }),
                              })
                            : null,
                          props.trailing !== undefined ? props.trailing(e) : null,
                        ] }),
                      ],
                    })
                  }),
              ],
            },
            viewKey,
          )
        }),
    ],
  })
}

/** 分组视图选择(眼睛 icon → Menu:平铺/模块/文件夹)。 */
function ViewModeMenu(props: { viewMode: 'flat' | 'module' | 'folder'; onSelect: (v: 'flat' | 'module' | 'folder') => void }): any {
  const [open, setOpen] = useState(false)
  return jsx('span', {
    className: 'dshw-anchor-wrap',
    style: { display: 'inline-flex' },
    children: jsx(Primitives.Menu, {
      open,
      onClose: () => setOpen(false),
      items: [
        { id: 'flat', label: t('view.flat') },
        { id: 'module', label: t('view.byModule') },
        { id: 'folder', label: t('view.byFolder') },
      ],
      selectedId: props.viewMode,
      onSelect: (id: string) => {
        setOpen(false)
        props.onSelect(id as 'flat' | 'module' | 'folder')
      },
      portal: true,
      closeOnPointerLeave: true,
      anchor: jsx('button', {
        type: 'button',
        className: 'dshw-iconbtn',
        title: t('view.groupView'),
        onClick: (e: any) => {
          e.stopPropagation()
          setOpen((v: boolean) => !v)
        },
        children: jsx(IconEye, { size: 14 }),
      }),
    }),
  })
}

// ---------------------------------------------------------------------------
// LogsView:graph + commit 列表 + 行内展开详情
// ---------------------------------------------------------------------------

interface LogCommitView {
  hash: string
  parents: string[]
  short: string
  author: string
  relDate: string
  subject: string
  refs: { kind: 'head' | 'local' | 'remote' | 'tag'; name: string }[]
}

/** 日志查看范围:当前分支 / 全部分支 / 指定分支(选中其他分支时高亮「当前分支已有」的 commit)。 */
type LogView = { kind: 'head' } | { kind: 'all' } | { kind: 'branch'; name: string }

interface RepoInfoLite {
  currentBranch: string | null
  locals: string[]
  remotes: { name: string; branches: string[] }[]
}

function LogsView(props: { cwd: string; reload: number }): any {
  const [view, setView] = useState<LogView>({ kind: 'head' })
  const [commits, setCommits] = useState<LogCommitView[] | undefined>(undefined)
  const [repoInfo, setRepoInfo] = useState<RepoInfoLite | null>(null)
  /** 分支查看模式:「所选分支独有」的 commit hash 集(其余行 = 当前分支已有 → 高亮)。 */
  const [exclusives, setExclusives] = useState<Set<string> | null>(null)
  const [skip, setSkip] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [expandedHash, setExpandedHash] = useState<string | undefined>(undefined)

  // 分支清单(repo-info 路由现成数据):下拉菜单懒用,mount 拉一次
  useEffect(() => {
    let alive = true
    postJson('/dsh-coding-workspace/repo-info', { repoPath: props.cwd })
      .then((body: any) => {
        if (alive && body?.ok) setRepoInfo({ currentBranch: body.currentBranch ?? null, locals: body.locals ?? [], remotes: body.remotes ?? [] })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [props.cwd])

  useEffect(() => {
    let alive = true
    setLoading(true)
    postJson('/dsh-coding-workspace/git-log', {
      cwd: props.cwd,
      mode: view.kind === 'all' ? 'all' : 'head',
      ...(view.kind === 'branch' ? { branch: view.name } : {}),
      skip: 0,
      limit: 50,
    })
      .then((body: any) => {
        if (!alive) return
        if (body?.ok) {
          setCommits(body.commits ?? [])
          setSkip(body.commits?.length ?? 0)
          setHasMore((body.commits?.length ?? 0) >= 50)
          // exclusives 字段缺失 = 服务端旧版(未重启):不高亮(null),防全行误高亮
          setExclusives(Array.isArray(body.exclusives) ? (new Set<string>(body.exclusives as string[])) : null)
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [props.cwd, view, props.reload])

  const loadMore = async (): Promise<void> => {
    if (loading || !hasMore) return
    setLoading(true)
    try {
      const body = await postJson('/dsh-coding-workspace/git-log', {
        cwd: props.cwd,
        mode: view.kind === 'all' ? 'all' : 'head',
        ...(view.kind === 'branch' ? { branch: view.name } : {}),
        skip,
        limit: 50,
      })
      if (body?.ok) {
        const next: LogCommitView[] = body.commits ?? []
        setCommits((prev) => [...(prev ?? []), ...next])
        setSkip((n) => n + next.length)
        setHasMore(next.length >= 50)
        if (Array.isArray(body.exclusives)) setExclusives(new Set<string>(body.exclusives as string[]))
        else setExclusives(null)
      }
    } catch {
      // 追加失败静默:已有列表保留
    } finally {
      setLoading(false)
    }
  }

  // 全量重放 lane 拓扑(纯函数,分页追加后重算,成本可忽略;early return 前调,守 Hooks 规则)
  // parents 兜底:服务端尚未重启(旧协议无 %P)时降级为单 lane 直线,不炸 slot
  const layout = useMemo(
    () => buildGraphLayout((commits ?? []).map((c) => ({ hash: c.hash, parents: Array.isArray(c.parents) ? c.parents : [] }))),
    [commits],
  )

  // 拓扑随详情展开拉伸:实测每行 commit 行的中心 y(详情块把后续行推下去,
  // 固定 index*40 会错位)。测量在 layout 后、early return 前挂,守 Hooks 规则。
  const listRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map())
  const [rowYs, setRowYs] = useState<number[]>([])
  const measure = useMemo(() => {
    return (): void => {
      const list = listRef.current
      if (list === null) return
      setRowYs((commits ?? []).map((c) => {
        const el = rowRefs.current.get(c.hash)
        return el !== undefined ? el.offsetTop + GRAPH_ROW_H / 2 : 0
      }))
    }
  }, [commits])
  useLayoutEffect(() => {
    measure()
  }, [measure, expandedHash])
  useEffect(() => {
    // 详情是异步载入(fetch 完成撑高容器),容器 ResizeObserver 兜住所有高度变化
    const list = listRef.current
    if (list === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(list)
    return () => ro.disconnect()
  }, [measure])

  if (commits === undefined) return jsx('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }, children: t('state.loading') })
  if (commits.length === 0) return EmptyState({ text: t('state.noCommits') })

  const graphLeft = layout.laneCount * GRAPH_LANE_W + 10
  const highlight = (hash: string): boolean => view.kind === 'branch' && exclusives !== null && !exclusives.has(hash)

  return jsxs('div', {
    style: { flex: 1, overflow: 'auto', padding: '4px 4px 12px', display: 'flex', flexDirection: 'column' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 6px', flexShrink: 0 },
        children: [
          // ⚠️ BranchMenu 内有 useState:必须 jsx() 挂载为子组件;函数直调会把 hook
          // 并进本组件序列,early return 分支下 hook 数不一致炸 React #310
          jsx(BranchMenu, { repoInfo, view, currentName: repoInfo?.currentBranch ?? null, onSelect: setView }),
          ModePill({ label: t('view.all'), active: view.kind === 'all', onClick: () => setView({ kind: 'all' }) }),
          view.kind === 'branch'
            ? jsx('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: t('logs.highlightHint') })
            : null,
        ],
      }),
      jsxs('div', {
        ref: listRef,
        style: { position: 'relative', flexShrink: 0 },
        children: [
          jsx(GraphCanvas, { layout, rowYs }),
          commits.map((c) =>
            jsx(CommitRow, {
              commit: c,
              graphLeft,
              highlight: highlight(c.hash),
              expanded: expandedHash === c.hash,
              onToggle: () => setExpandedHash((h: string | undefined) => (h === c.hash ? undefined : c.hash)),
              cwd: props.cwd,
              registerRef: (el: HTMLElement | null) => {
                if (el === null) rowRefs.current.delete(c.hash)
                else rowRefs.current.set(c.hash, el)
              },
            }, c.hash),
          ),
        ],
      }),
      hasMore
        ? jsx('div', { style: { display: 'flex', justifyContent: 'center', padding: '8px 0 4px', flexShrink: 0 }, children: MiniBtn({ label: t('logs.loadMore'), busy: loading, onClick: () => void loadMore() }) })
        : null,
    ],
  })
}

function ModePill(props: { label: string; active: boolean; onClick: () => void }): any {
  return jsx('button', {
    className: 'dshw-minibtn',
    'data-active': props.active || undefined,
    onClick: props.onClick,
    children: props.label,
  })
}

/** 分支下拉(官方 Menu 原语,RowMenu/BrowserSelect 同款 anchor 模式;分组:当前/本地/各 remote)。 */
function BranchMenu(props: { repoInfo: RepoInfoLite | null; view: LogView; currentName: string | null; onSelect: (v: LogView) => void }): any {
  const [open, setOpen] = useState(false)
  const items: any[] = [{ id: '__head__', label: `${t('logs.currentBranch')}${props.currentName ? `(${props.currentName})` : ''}` }]
  if (props.repoInfo !== null) {
    if (props.repoInfo.locals.length > 0) {
      items.push({ type: 'separator', id: 'sep-local' }, { type: 'label', id: 'lbl-local', text: t('logs.localBranches') })
      for (const b of props.repoInfo.locals) items.push({ id: b, label: b })
    }
    for (const r of props.repoInfo.remotes) {
      items.push({ type: 'separator', id: `sep-${r.name}` }, { type: 'label', id: `lbl-${r.name}`, text: r.name })
      for (const b of r.branches) items.push({ id: `${r.name}/${b}`, label: `${r.name}/${b}` })
    }
  }
  const anchorLabel =
    props.view.kind === 'all' ? t('logs.allBranches') : props.view.kind === 'branch' ? props.view.name : props.currentName ?? t('logs.currentBranch')
  return jsx('span', {
    className: 'dshw-anchor-wrap',
    style: { display: 'inline-flex', minWidth: 0 },
    children: jsx(Primitives.Menu, {
      open,
      onClose: () => setOpen(false),
      items: items.length > 1 ? items : [{ type: 'label', id: 'lbl-loading', text: t('logs.readingBranches') }],
      selectedId: props.view.kind === 'branch' ? props.view.name : '__head__',
      onSelect: (id: string) => {
        setOpen(false)
        props.onSelect(id === '__head__' ? { kind: 'head' } : { kind: 'branch', name: id })
      },
      portal: true,
      closeOnPointerLeave: true,
      anchor: jsx('button', {
        type: 'button',
        className: 'dshw-minibtn',
        'data-active': props.view.kind === 'branch' || undefined,
        onClick: (e: any) => {
          e.stopPropagation()
          setOpen((v: boolean) => !v)
        },
        style: { maxWidth: 160, display: 'inline-flex', alignItems: 'center', gap: 5 },
        children: [
          jsx('span', { key: 'v', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: anchorLabel }),
          jsx('span', { key: 'a', style: { opacity: 0.6, flexShrink: 0 }, children: '▾' }),
        ],
      }),
    }),
  })
}

function CommitRow(props: { commit: LogCommitView; graphLeft: number; highlight: boolean; expanded: boolean; onToggle: () => void; cwd: string; registerRef?: (el: HTMLElement | null) => void }): any {
  const { commit } = props
  const [detail, setDetail] = useState<{ message: string; author: string; date: string; files: { status: string; path: string; from?: string }[] } | undefined>(undefined)

  useEffect(() => {
    if (!props.expanded || detail !== undefined) return
    let alive = true
    postJson('/dsh-coding-workspace/git-show', { cwd: props.cwd, hash: commit.hash })
      .then((body: any) => {
        if (alive && body?.ok) setDetail({ message: body.message ?? '', author: body.author ?? '', date: body.date ?? '', files: body.files ?? [] })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [props.expanded, detail, commit.hash, props.cwd])

  return jsxs('div', {
    ref: props.registerRef,
    children: [
      jsx('div', {
        className: 'dshw-frow',
        onClick: props.onToggle,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 0',
          borderRadius: 6,
          cursor: 'pointer',
          height: GRAPH_ROW_H,
          background: props.expanded
            ? 'var(--dsw-alias-interactive-bg-hover)'
            : props.highlight
              ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)'
              : undefined,
        },
        children: jsxs('div', {
          style: { marginLeft: props.graphLeft, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1 },
              children: [
                jsxs('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
                  children: [
                    jsx('span', {
                      style: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 },
                      children: commit.subject,
                    }),
                    jsx('div', { style: { flexShrink: 0, display: 'flex', gap: 4, overflow: 'hidden' }, children: commit.refs.slice(0, 3).map((r) => jsx(RefBadge, { kind: r.kind, name: r.name }, r.name)) }),
                  ],
                }),
                jsxs('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--dsw-alias-label-dimmed)', whiteSpace: 'nowrap' },
                  children: [
                    jsx('span', { style: { fontFamily: 'var(--ds-font-family-mono, monospace)', color: 'var(--dsw-alias-brand-primary)' }, children: commit.short }),
                    jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' }, children: commit.author }),
                    jsx('span', { children: commit.relDate }),
                  ],
                }),
              ],
            }),
          }),
      props.expanded
        ? jsx('div', {
            style: {
              margin: `0 8px 4px ${props.graphLeft}px`,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.06))',
              fontSize: 12,
            },
            children: detail === undefined
              ? jsx('div', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: t('logs.loadingDetail') })
              : jsxs(Fragment, {
                  children: [
                    jsx('div', { style: { whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-primary)', lineHeight: '18px', marginBottom: 6 }, children: detail.message }),
                    jsx('div', { style: { fontFamily: 'var(--ds-font-family-mono, monospace)', fontSize: 11, color: 'var(--dsw-alias-label-dimmed)', marginBottom: 6 }, children: `${detail.author} · ${detail.date}` }),
                    jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 }, children: detail.files.map((f) => {
                      const { dir, name } = splitPath(f.path)
                      return jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }, children: [
                        jsx(StatusBadge, { status: f.status }),
                        jsxs('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: dir }), jsx('span', { style: { color: 'var(--dsw-alias-label-primary)' }, children: name })] }),
                      ] }, f.path)
                    }) }),
                  ],
                }),
          })
        : null,
    ],
  })
}
