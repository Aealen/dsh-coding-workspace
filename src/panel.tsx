/**
 * dsh-worktree 侧栏右栏:工作区面板(资源管理器 + Git)。
 *
 * 挂载:shell.overlay(ui-layout AppFrame 声明的 list slot,additive 零冲突;
 * 层 pointer-events:none,面板根 opt-in auto)。entry props 官方标准 kit 白送
 * useSessions/useWorkspaces(root scope ObservableSnapshot selector hooks)。
 *
 * 停靠:面板 fixed 贴视口右缘,展开时写 CSS 变量 --dsh-worktree-panel-width,
 * 注入样式让宿主 #root 以 margin-right 让位(VSCode 式真停靠,不盖会话内容;
 * 方案参考 dsh-better-sidebar layout.css)。窄屏 / 检测到 better-sidebar
 * (双方都推 #root 会打架)时自动退回纯浮层。收起态右上角悬浮钮(boss 定版)。
 *
 * 结构:SidePanel(显隐把手 + 拖宽 + TAB 栏 + 概览条)
 *   ├─ ExplorerTab  文件树懒展开(只读)
 *   └─ GitTab
 *        ├─ ChangesView   staged/unstaged/untracked + stage/unstage + commit
 *        └─ LogsView      git graph ASCII → SVG 彩色 lane + 行内展开详情
 *
 * UI 对齐 IDEA Git Log:状态徽标分色、目录淡/文件名亮、graph lane 循环色板。
 * ⚠️ jsx-runtime:children 必须放 props.children(第三参是 key)。
 */
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DEFAULT_PANEL_WIDTH,
  PUSH_MIN_VIEWPORT,
  clampPanelWidth,
  parseStoredWidth,
} from './panel-layout.js'

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
  const body = await postJson('/dsh-worktree/git-action', { cwd, action, ...extra })
  if (!body?.ok) throw new Error(body?.message ?? `${action} 失败`)
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

function IconClose(p: IconProps) {
  return svgIcon(p.size, p.style, jsx('path', { d: 'M4 4l8 8M12 4l-8 8' }))
}

/** 右栏面板 icon(矩形右侧竖线分栏,与宿主侧栏 toggle 同语义、镜像朝右)。 */
function IconPanelRight(p: IconProps) {
  return svgIcon(
    p.size,
    p.style,
    jsxs(Fragment, {
      children: [jsx('rect', { x: '2', y: '3.5', width: '12', height: '9', rx: '1.5' }), jsx('path', { d: 'M11.5 3.5v9' })],
    }),
  )
}

function IconChevron(props: { open?: boolean; size?: number }) {
  return svgIcon(props.size, { transform: props.open ? 'rotate(90deg)' : undefined }, jsx('path', { d: 'M6 3.5L10.5 8L6 12.5' }))
}

function IconFile(p: IconProps) {
  return svgIcon(p.size, p.style, jsx('path', { d: 'M9 1.8H4.2a.7.7 0 0 0-.7.7v11a.7.7 0 0 0 .7.7h7.6a.7.7 0 0 0 .7-.7V5.3L9 1.8zM9 1.8v3.5h3.5' }))
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
// graph ASCII → SVG(IDEA 彩色 lane;git 已画好拓扑,这里只做几何映射)
// ---------------------------------------------------------------------------

const LANE_PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#a371f7', '#db6d28', '#f85149', '#39c5cf', '#e3b341']

function laneColor(i: number): string {
  return LANE_PALETTE[i % LANE_PALETTE.length]
}

const GRAPH_ROW_H = 22
const GRAPH_LANE_W = 12

/** 一个 commit 的 graph 行块:多行 ASCII 各转线段/圆点。 */
function GraphCell(props: { lines: string[] }) {
  const { lines } = props
  const width = Math.max(1, ...lines.map((l) => l.length)) * GRAPH_LANE_W
  const height = lines.length * GRAPH_ROW_H
  const shapes: unknown[] = []
  lines.forEach((line, row) => {
    const yTop = row * GRAPH_ROW_H
    const yMid = yTop + GRAPH_ROW_H / 2
    const yBottom = yTop + GRAPH_ROW_H
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]
      if (ch === ' ') continue
      const x = col * GRAPH_LANE_W + GRAPH_LANE_W / 2
      const color = laneColor(col)
      if (ch === '*') {
        shapes.push(jsx('circle', { cx: x, cy: yMid, r: 4, fill: color, stroke: 'var(--dsw-alias-bg-base)', 'stroke-width': 1.2 }, `c${row}-${col}`))
      } else if (ch === '|' || ch === '_') {
        shapes.push(
          jsx('line', { x1: x, y1: yTop, x2: x, y2: yBottom, stroke: color, 'stroke-width': 1.8 }, `l${row}-${col}`),
        )
      } else if (ch === '\\') {
        shapes.push(
          jsx('line', { x1: x - GRAPH_LANE_W / 2, y1: yTop, x2: x + GRAPH_LANE_W / 2, y2: yBottom, stroke: color, 'stroke-width': 1.8 }, `b${row}-${col}`),
        )
      } else if (ch === '/') {
        shapes.push(
          jsx('line', { x1: x + GRAPH_LANE_W / 2, y1: yTop, x2: x - GRAPH_LANE_W / 2, y2: yBottom, stroke: color, 'stroke-width': 1.8 }, `f${row}-${col}`),
        )
      } else if (ch === '.') {
        shapes.push(jsx('circle', { cx: x, cy: yBottom, r: 1.4, fill: color }, `d${row}-${col}`))
      }
    }
  })
  return jsx(
    'svg',
    { width, height, viewBox: `0 0 ${width} ${height}`, style: { flexShrink: 0, display: 'block', overflow: 'visible' }, children: shapes },
  )
}

// ---------------------------------------------------------------------------
// SidePanel:显隐把手 + 拖宽 + 骨架(停靠推挤)
// ---------------------------------------------------------------------------

const PANEL_KEY = 'dsh-worktree.side-panel'
const PANEL_WIDTH_KEY = 'dsh-worktree.side-panel-width'

function readOpenState(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === 'open'
  } catch {
    return false
  }
}

function readStoredWidth(): number {
  try {
    return parseStoredWidth(localStorage.getItem(PANEL_WIDTH_KEY)) ?? DEFAULT_PANEL_WIDTH
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
const PUSH_STYLE_ID = 'dsh-worktree-panel-style'

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
  margin-right: var(--dsh-worktree-panel-width, 0px);
  width: calc(100% - var(--dsh-worktree-panel-width, 0px));
  transition:
    margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out),
    width var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
body[data-dshw-dragging] #root { transition: none; }
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
  const cwd = useCurrentCwd(props.useSessions)
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  ensurePushStyle()

  // 停靠联动:展开且可推挤 → 写变量让 #root 让位;收起/浮层/卸载一律归零还原。
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--dsh-worktree-panel-width', open && pushMode ? `${width}px` : '0px')
    return () => root.style.setProperty('--dsh-worktree-panel-width', '0px')
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
    // 右上角悬浮展开按钮(boss 定版:右缘把手太突兀;位置取 header 之下、
    // 会话工具行右侧的空域,避开 Session log;实底防消息文字穿透)
    return jsx('button', {
      className: 'dshw-topbtn',
      title: '展开工作区面板(dsh-worktree)',
      onClick: () => toggle(true),
      style: {
        position: 'absolute',
        top: 96,
        right: 16,
        width: 30,
        height: 30,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        pointerEvents: 'auto',
        zIndex: 21,
      },
      children: jsx(IconPanelRight, { size: 15 }),
    })
  }

  return jsx('div', {
    style: {
      // 停靠:fixed 贴视口右缘;宽度由推挤变量同步(浮层模式 maxWidth 兜底)
      position: 'fixed',
      top: 0,
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
          title: '拖动调宽 · 双击复位',
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
            TabButton({ label: '资源管理器', active: tab === 'explorer', onClick: () => setTab('explorer') }),
            TabButton({ label: 'Git', active: tab === 'git', onClick: () => setTab('git') }),
            jsx('div', { style: { flex: 1 } }),
            jsx('button', {
              className: 'dshw-iconbtn',
              title: '收起面板',
              onClick: () => toggle(false),
              children: jsx(IconClose, { size: 13 }),
            }),
          ],
        }),
        cwd === undefined
          ? EmptyState({ text: '当前没有活动工作区\n打开一个会话后这里显示其工作区' })
          : jsxs(Fragment, {
              children: [tab === 'explorer' ? jsx(ExplorerTab, { cwd, key: `exp-${cwd}` }) : jsx(GitTab, { cwd, key: `git-${cwd}` })],
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

function ExplorerTab(props: { cwd: string }): any {
  const [levels, setLevels] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [reload, setReload] = useState(0)
  const requested = useRef<Record<string, boolean>>({})

  useEffect(() => {
    requested.current = {}
    setLevels({})
    setExpanded({})
    setError(undefined)
  }, [props.cwd, reload])

  useEffect(() => {
    const load = async (dir: string): Promise<void> => {
      if (requested.current[dir] === true) return
      requested.current[dir] = true
      try {
        const body = await postJson('/dsh-worktree/fs-list', { root: props.cwd, dir })
        if (!body?.ok) throw new Error(body?.message ?? '读取目录失败')
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
        right: jsx('button', { className: 'dshw-iconbtn', title: '刷新', onClick: () => setReload((n) => n + 1), children: jsx(IconRefresh, { size: 13 }) }),
      }),
      error !== undefined
        ? jsx('div', { style: { padding: '8px 12px', fontSize: 12, color: '#f85149' }, children: error })
        : jsx('div', {
            style: { flex: 1, overflow: 'auto', padding: '4px 4px 12px' },
            children: top.map((e) => TreeNode({ entry: e, dir: '', level: 0, levels, expanded, onToggle: toggleDir })),
          }),
    ],
  })
}

function TreeNode(props: {
  entry: FsEntry
  dir: string
  level: number
  levels: Record<string, FsEntry[]>
  expanded: Record<string, boolean>
  onToggle: (dir: string) => void
}): any {
  const { entry, dir, level } = props
  const childDir = dir === '' ? entry.name : `${dir}/${entry.name}`
  const isDir = entry.type === 'dir'
  const isOpen = isDir && props.expanded[childDir] === true
  const tip = entry.type === 'file' ? `${fmtSize(entry.size)}${entry.mtime !== undefined ? ` · ${new Date(entry.mtime).toLocaleString()}` : ''}` : childDir
  return jsxs(Fragment, {
    children: [
      jsx('div', {
        className: 'dshw-frow',
        title: tip,
        onClick: isDir ? () => props.onToggle(childDir) : undefined,
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
          cursor: isDir ? 'pointer' : 'default',
          minWidth: 0,
        },
        children: isDir
          ? jsxs(Fragment, {
              children: [
                jsx(IconChevron, { open: isOpen, size: 11, style: { color: 'var(--dsw-alias-label-dimmed)' } }),
                jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' }, children: isOpen ? jsx(PrimitivesFolderOpen, {}) : jsx(PrimitivesFolderClose, {}) }),
                jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry.name }),
              ],
            })
          : jsxs(Fragment, {
              children: [
                jsx('span', { style: { width: 11, flexShrink: 0 } }),
                jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-dimmed)' }, children: jsx(IconFile, { size: 13 }) }),
                jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry.name }),
              ],
            }),
      }),
      isOpen && (props.levels[childDir] ?? []).map((child) => TreeNode({ ...props, entry: child, dir: childDir, level: level + 1 })),
    ],
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
    postJson('/dsh-worktree/git-overview', { cwd: props.cwd })
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
      showToast(action === 'fetch' ? 'fetch 完成' : action === 'pull' ? 'pull 完成' : 'push 完成')
      refreshAll()
    } catch (e) {
      showToast(`${action} 失败:${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusy(undefined)
    }
  }

  if (overview !== undefined && !overview.isRepo) {
    return EmptyState({ text: '当前工作区不是 git 仓库' })
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
          MiniBtn({ label: 'Fetch', busy: busy === 'fetch', onClick: () => void sync('fetch') }),
          MiniBtn({ label: 'Pull', busy: busy === 'pull', onClick: () => void sync('pull') }),
          MiniBtn({ label: 'Push', busy: busy === 'push', onClick: () => void sync('push') }),
        ],
      }),
      // 子 TAB
      jsxs('div', {
        style: { display: 'flex', gap: 2, padding: '6px 8px 0 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0 },
        children: [
          TabButton({ label: 'Changes', active: subTab === 'changes', onClick: () => setSubTab('changes') }),
          TabButton({ label: 'Logs', active: subTab === 'logs', onClick: () => setSubTab('logs') }),
          jsx('div', { style: { flex: 1 } }),
          jsx('button', { className: 'dshw-iconbtn', title: '刷新', onClick: refreshAll, children: jsx(IconRefresh, { size: 13 }) }),
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
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let alive = true
    postJson('/dsh-worktree/git-status', { cwd: props.cwd })
      .then((body: any) => {
        if (alive && body?.ok) setGroups({ staged: body.staged ?? [], unstaged: body.unstaged ?? [], untracked: body.untracked ?? [] })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [props.cwd, props.reload])

  const act = async (action: 'stage' | 'unstage', path: string): Promise<void> => {
    try {
      await panelAction(props.cwd, action, { path })
      // 重新拉状态(复用 reload 计数会全刷新,这里手动重拉一次即可)
      const body = await postJson('/dsh-worktree/git-status', { cwd: props.cwd })
      if (body?.ok) setGroups({ staged: body.staged ?? [], unstaged: body.unstaged ?? [], untracked: body.untracked ?? [] })
    } catch (e) {
      props.showToast(`${action === 'stage' ? '暂存' : '取消暂存'}失败:${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const commit = async (): Promise<void> => {
    if (committing || (groups?.staged.length ?? 0) === 0 || message.trim() === '') return
    setCommitting(true)
    try {
      await panelAction(props.cwd, 'commit', { message: message.trim() })
      setMessage('')
      props.showToast('已提交')
      const body = await postJson('/dsh-worktree/git-status', { cwd: props.cwd })
      if (body?.ok) setGroups({ staged: body.staged ?? [], unstaged: body.unstaged ?? [], untracked: body.untracked ?? [] })
    } catch (e) {
      props.showToast(`提交失败:${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setCommitting(false)
    }
  }

  if (groups === undefined) return jsx('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }, children: '加载中…' })
  if (groups.staged.length + groups.unstaged.length + groups.untracked.length === 0) {
    return EmptyState({ text: '工作区干净,没有待提交的修改' })
  }

  const stagedCount = groups.staged.length

  return jsxs('div', {
    style: { flex: 1, overflow: 'auto', padding: '4px 4px 12px', display: 'flex', flexDirection: 'column' },
    children: [
      FileGroup({
        title: '暂存的更改',
        count: groups.staged.length,
        collapsed: collapsed['s'] === true,
        onToggle: () => setCollapsed((p) => ({ ...p, s: !p['s'] })),
        entries: groups.staged,
        action: { icon: '−', title: '取消暂存', onAct: (p) => void act('unstage', p) },
      }),
      FileGroup({
        title: '未暂存的更改',
        count: groups.unstaged.length,
        collapsed: collapsed['u'] === true,
        onToggle: () => setCollapsed((p) => ({ ...p, u: !p['u'] })),
        entries: groups.unstaged,
        action: { icon: '+', title: '暂存', onAct: (p) => void act('stage', p) },
      }),
      FileGroup({
        title: '未跟踪',
        count: groups.untracked.length,
        collapsed: collapsed['t'] === true,
        onToggle: () => setCollapsed((p) => ({ ...p, t: !p['t'] })),
        entries: groups.untracked,
        action: { icon: '+', title: '暂存', onAct: (p) => void act('stage', p) },
      }),
      // 提交区(吸底)
      jsxs('div', {
        style: { marginTop: 'auto', padding: '8px 8px 0', display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          jsx('textarea', {
            className: 'dshw-commit-msg',
            placeholder: stagedCount === 0 ? '先暂存文件,再填写提交信息…' : '提交信息(Ctrl+Enter 提交)',
            value: message,
            onChange: (e: any) => setMessage(e.target.value),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commit()
            },
            rows: 2,
          }),
          jsx('button', {
            className: 'dshw-minibtn dshw-commit-btn',
            disabled: committing || stagedCount === 0 || message.trim() === '',
            onClick: () => void commit(),
            children: committing ? '提交中…' : `提交${stagedCount > 0 ? `(${stagedCount})` : ''}`,
          }),
        ],
      }),
    ],
  })
}

function FileGroup(props: {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  entries: StatusEntry[]
  action: { icon: string; title: string; onAct: (path: string) => void }
}): any {
  if (props.count === 0) return null
  return jsxs(Fragment, {
    children: [
      jsx('div', {
        className: 'dshw-frow',
        onClick: props.onToggle,
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
        children: jsxs(Fragment, {
          children: [
            jsx(IconChevron, { open: !props.collapsed, size: 11 }),
            jsx('span', { children: props.title }),
            jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: `(${props.count})` }),
          ],
        }),
      }),
      !props.collapsed &&
        props.entries.map((e) => {
          const status = props.title === '暂存的更改' ? e.x : props.title === '未跟踪' ? '?' : e.y
          const { dir, name } = splitPath(e.path)
          return jsxs('div', {
            className: 'dshw-frow',
            title: e.from !== undefined ? `${e.from} → ${e.path}` : e.path,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 27,
              padding: '0 8px 0 22px',
              borderRadius: 6,
              fontSize: 12.5,
              minWidth: 0,
            },
            children: [
              jsx(StatusBadge, { status }),
              jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }, children: jsx('span', { children: [jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: dir }), jsx('span', { style: { color: 'var(--dsw-alias-label-primary)' }, children: name })] }) }),
              jsx('div', { style: { flex: 1 } }),
              jsx('button', {
                className: 'dshw-iconbtn',
                title: props.action.title,
                onClick: () => props.action.onAct(e.path),
                children: props.action.icon,
              }),
            ],
          })
        }),
    ],
  })
}

// ---------------------------------------------------------------------------
// LogsView:graph + commit 列表 + 行内展开详情
// ---------------------------------------------------------------------------

interface LogCommitView {
  graphLines: string[]
  hash: string
  short: string
  author: string
  relDate: string
  subject: string
  refs: { kind: 'head' | 'local' | 'remote' | 'tag'; name: string }[]
}

function LogsView(props: { cwd: string; reload: number }): any {
  const [mode, setMode] = useState<'head' | 'all'>('head')
  const [commits, setCommits] = useState<LogCommitView[] | undefined>(undefined)
  const [skip, setSkip] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [expandedHash, setExpandedHash] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setLoading(true)
    postJson('/dsh-worktree/git-log', { cwd: props.cwd, mode, skip: 0, limit: 50 })
      .then((body: any) => {
        if (!alive) return
        if (body?.ok) {
          setCommits(body.commits ?? [])
          setSkip(body.commits?.length ?? 0)
          setHasMore((body.commits?.length ?? 0) >= 50)
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [props.cwd, mode, props.reload])

  const loadMore = async (): Promise<void> => {
    if (loading || !hasMore) return
    setLoading(true)
    try {
      const body = await postJson('/dsh-worktree/git-log', { cwd: props.cwd, mode, skip, limit: 50 })
      if (body?.ok) {
        const next: LogCommitView[] = body.commits ?? []
        setCommits((prev) => [...(prev ?? []), ...next])
        setSkip((n) => n + next.length)
        setHasMore(next.length >= 50)
      }
    } catch {
      // 追加失败静默:已有列表保留
    } finally {
      setLoading(false)
    }
  }

  if (commits === undefined) return jsx('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }, children: '加载中…' })
  if (commits.length === 0) return EmptyState({ text: '没有提交记录' })

  return jsxs('div', {
    style: { flex: 1, overflow: 'auto', padding: '4px 4px 12px' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 6px' },
        children: [
          ModePill({ label: '当前分支', active: mode === 'head', onClick: () => setMode('head') }),
          ModePill({ label: '全部分支', active: mode === 'all', onClick: () => setMode('all') }),
        ],
      }),
      commits.map((c) =>
        jsx(CommitRow, {
          commit: c,
          expanded: expandedHash === c.hash,
          onToggle: () => setExpandedHash((h: string | undefined) => (h === c.hash ? undefined : c.hash)),
          cwd: props.cwd,
        }, c.hash),
      ),
      hasMore
        ? jsx('div', { style: { display: 'flex', justifyContent: 'center', padding: '8px 0 4px' }, children: MiniBtn({ label: '加载更多', busy: loading, onClick: () => void loadMore() }) })
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

function CommitRow(props: { commit: LogCommitView; expanded: boolean; onToggle: () => void; cwd: string }): any {
  const { commit } = props
  const rows = Math.max(1, commit.graphLines.length)
  const [detail, setDetail] = useState<{ message: string; author: string; date: string; files: { status: string; path: string; from?: string }[] } | undefined>(undefined)

  useEffect(() => {
    if (!props.expanded || detail !== undefined) return
    let alive = true
    postJson('/dsh-worktree/git-show', { cwd: props.cwd, hash: commit.hash })
      .then((body: any) => {
        if (alive && body?.ok) setDetail({ message: body.message ?? '', author: body.author ?? '', date: body.date ?? '', files: body.files ?? [] })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [props.expanded, detail, commit.hash, props.cwd])

  return jsxs('div', {
    children: [
      jsx('div', {
        className: 'dshw-frow',
        onClick: props.onToggle,
        style: {
          display: 'flex',
          alignItems: 'stretch',
          gap: 8,
          padding: '1px 8px 1px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          minHeight: GRAPH_ROW_H * rows,
          background: props.expanded ? 'var(--dsw-alias-interactive-bg-hover)' : undefined,
        },
        children: jsxs(Fragment, {
          children: [
            jsx(GraphCell, { lines: commit.graphLines }),
            jsxs('div', {
              style: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '2px 0' },
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
          ],
        }),
      }),
      props.expanded
        ? jsx('div', {
            style: {
              margin: '0 8px 4px 26px',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.06))',
              fontSize: 12,
            },
            children: detail === undefined
              ? jsx('div', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: '加载详情…' })
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
