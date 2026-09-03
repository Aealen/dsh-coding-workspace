/**
 * 顶部栏(Tab 页)纯计算(无 DOM 依赖,node --test 可直测)。
 *
 * 顶部栏展示「当前会话 cwd 对应工作区」下的顶层会话 TAB。本模块只放
 * 过滤/排序/归一纯函数;DOM 与宿主桥(快照订阅、状态点组件)在 topbar.tsx。
 */

/** 会话行的最小形态(宿主 session.list 行的子集,便于单测构造)。 */
export interface TopbarSessionInput {
  sessionId: string
  cwd?: string
  /** 宿主 header.origin:子代理会话不进 TAB(会话级导航只放顶层会话)。 */
  origin?: 'subagent'
  updatedAt?: number
}

/** 顶部栏高度(px):常驻无开关,右栏停靠面板的 top 与收起钮按此让位。 */
export const TOPBAR_HEIGHT = 36

/**
 * 归一会话/工作区 cwd 为正斜杠形态(与侧栏 byCwdIndex 同一约定,不处理大小写)。
 * 空白串返回 null(会话无 cwd 时不参与归属)。
 */
export function normalizeCwd(cwd: string | undefined): string | null {
  if (typeof cwd !== 'string') return null
  const trimmed = cwd.trim().replace(/\\/g, '/')
  return trimmed === '' ? null : trimmed
}

/**
 * 筛出「当前 cwd 工作区」的顶层会话 TAB 数据。
 *
 * - cwd 归一后精确匹配(反斜杠/正斜杠等价);
 * - 排除子代理(origin === 'subagent')与已归档会话;
 * - updatedAt 升序(新会话靠右,对齐浏览器标签习惯),缺失值殿后(稳定排序)。
 * @param rows 宿主 session.list 全量行
 * @param currentCwd 当前会话 cwd(原始形态,内部归一);缺失返回空数组
 * @param archived registry-global 归档会话 id 集合
 */
export function topbarSessions(
  rows: readonly TopbarSessionInput[],
  currentCwd: string | undefined,
  archived: ReadonlySet<string>,
): TopbarSessionInput[] {
  const cwd = normalizeCwd(currentCwd)
  if (cwd === null) return []
  return rows
    .filter((row) => row.origin !== 'subagent' && !archived.has(row.sessionId) && normalizeCwd(row.cwd) === cwd)
    .sort((a, b) => {
      const ta = a.updatedAt ?? Number.POSITIVE_INFINITY
      const tb = b.updatedAt ?? Number.POSITIVE_INFINITY
      return ta === tb ? 0 : ta < tb ? -1 : 1
    })
}

/**
 * 会话 id 归一:剥掉可选的 `session-` 前缀再比较。
 * 宿主 parentSessionId 存在带/不带前缀的变体(子代理行 id 本身无前缀),
 * 记忆教训:匹配前必须归一化,否则计数漏计。
 */
export function normalizeSessionId(id: string | undefined): string {
  return typeof id === 'string' ? id.replace(/^session-/, '') : ''
}

/**
 * 统计某会话的子代理数量(origin === 'subagent' 且 parentSessionId 归一化匹配)。
 * 用于顶部栏 TAB 上的「N 个子代理」徽标;顶层会话自己的 parentSessionId 是
 * fork 血缘(指向源会话),不参与子代理判定。
 */
export function countSubagents(rows: readonly TopbarSessionInput[], sessionId: string): number {
  const self = normalizeSessionId(sessionId)
  if (self === '') return 0
  let count = 0
  for (const row of rows) {
    if (row.origin !== 'subagent') continue
    if (normalizeSessionId((row as { parentSessionId?: string }).parentSessionId) === self) count++
  }
  return count
}
