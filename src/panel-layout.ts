/**
 * 面板停靠布局纯函数(无 DOM 依赖,node --test 可直测)。
 *
 * 面板从 shell.overlay 内的 absolute 浮层改为 fixed 停靠 + CSS 变量推挤:
 * 展开时写 `--dsh-worktree-panel-width`,宿主 #root 以 margin-right 让位
 * (VSCode 式停靠,方案参考 dsh-better-sidebar 的 layout.css)。本模块只放
 * 纯计算;DOM 副作用(探测 better-sidebar、写变量、注入 style)在 panel.tsx。
 */

/** 面板宽度边界(px)。 */
export const MIN_PANEL_WIDTH = 280
export const MAX_PANEL_WIDTH = 560
export const DEFAULT_PANEL_WIDTH = 360

/** 视口宽度低于该值时不推挤(窄屏退回纯浮层,面板 maxWidth 兜底)。 */
export const PUSH_MIN_VIEWPORT = 720

/**
 * 夹紧面板宽度到可用区间。上限同时受视口约束(两侧各留 16px),
 * 视口过窄时上限不低于 MIN(保证面板仍可交互)。
 * @param value 期望宽度;非法值回落默认宽
 * @param viewportWidth 视口宽度;缺省按足够宽处理
 */
export function clampPanelWidth(value: number | undefined, viewportWidth?: number): number {
  const byViewport =
    typeof viewportWidth === 'number' && Number.isFinite(viewportWidth)
      ? Math.max(viewportWidth - 32, MIN_PANEL_WIDTH)
      : MAX_PANEL_WIDTH
  const max = Math.min(MAX_PANEL_WIDTH, byViewport)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(DEFAULT_PANEL_WIDTH, max)
  }
  return Math.min(Math.max(Math.round(value), MIN_PANEL_WIDTH), max)
}

/**
 * 解析 localStorage 里的宽度字符串;非法(非正数/非数字)返回 null。
 * 与 DOM 解耦以便单测。
 */
export function parseStoredWidth(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}
