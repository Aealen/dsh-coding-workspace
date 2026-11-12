import { jsx } from 'react/jsx-runtime'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 侧栏与顶部栏共享的「会话状态」公共物:
 * - SessionRow:宿主 session.list RPC 行形态;
 * - liveSessionsSource:宿主 sessions.list ObservableSnapshot 捕获口(apply 时注入);
 * - SessionStatus:状态占位组件(running/pending/completed 三态)。
 * 独立成模块避免 client.tsx ↔ topbar.tsx 循环 import(esbuild 单 bundle 内
 * 循环引用虽可用,但拓扑上保持单向更稳)。
 */

export interface SessionRow {
  /** 会话 id。0.2.x 快照行字段名是 `id`;`rowsFromSessionsSnapshot` 会回填 sessionId
   *  (取自 ids 键),两字段消费端等价。旧宿主行本身带 sessionId。 */
  sessionId: string
  id?: string
  cwd?: string
  updatedAt?: number
  running?: boolean
  /** 宿主兜底显示名(无标题时为「cwd 目录名 / 短 id」)。 */
  displayTitle?: string
  /** 完成于未选中且未打开(绿色「完成」提醒)。**0.2.x 不在 list 行上**——
   *  改由 sessionStatus store 的 `completionUnread` 提供(selectSessionStatus)。 */
  completed?: boolean
  /** 用户交互阻塞中:'approval' | 'plan-review' | 'question'。0.2.x 同样来自
   *  sessionStatus store(不在 list 行上)。 */
  pendingInteraction?: string
  /** 子代理会话标记(宿主 header.origin)。 */
  origin?: 'subagent'
  /** 父会话 id。0.2.x 快照行字段名是 parentId(持久化 header 为 parentSession,
   *  宿主内部 summary 为 parentSessionId);0.1.x 用 parentSessionId。 */
  parentSessionId?: string
  parentId?: string
  blank?: boolean
  /** 会话标题(0.2.x 快照行上的权威标题;宿主 DocumentTitle/窗口标题同源)。 */
  title?: string
  /** 投影值集合(0.2.x 行字段名 projectionValues;旧路径 projections.values)。 */
  projectionValues?: { title?: string | null; [k: string]: unknown }
  projections?: { values?: { title?: string | null } }
  /** 宿主保留信息(source → 引用计数)。 */
  retainedBy?: RetainedBy
}

/** 三态补充信息(sessionStatus store 行):running / 等待确认 / 后台完成未读。 */
export interface SessionStatusRow {
  running?: boolean
  pendingInteraction?: string
  /** 后台跑完且当前不在主视图(绿色对勾);打开会话后清除。 */
  completionUnread?: boolean
}

/** 宿主 sessions.list 快照源(apply 时捕获):running/completed/pendingInteraction
 * 由宿主 mux 帧实时推送(session.handleRunning 中继),useSyncExternalStore 订阅即可,免轮询。 */
let liveSessionsSource: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null = null

/** apply 时注入快照源;服务缺席(如 headless)传 null,订阅侧内部消化。 */
export function setLiveSessionsSource(src: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null): void {
  liveSessionsSource = src
}

/** uSES 要求 subscribe/getSnapshot 引用跨渲染稳定,包一层模块级常量并内部消化未捕获态。 */
export const stableSubscribe = (cb: () => void): (() => void) => {
  const src = liveSessionsSource
  return src !== null ? src.subscribe(cb) : () => {}
}
export const stableGetSnapshot = (): unknown => liveSessionsSource?.getSnapshot()

/** 宿主 workspaces.list 快照源(WorkspaceSource,apply 时捕获):items + archivedSessionIds
 * 由宿主投影推送;0.1.2 起逆向 POST /api/workspace.list 已死,轮询改吃此快照。 */
let workspaceSource: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null = null

/** apply 时注入快照源;服务缺席(如 headless)传 null,订阅侧内部消化。 */
export function setWorkspaceSource(src: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null): void {
  workspaceSource = src
}

export const stableWorkspaceSubscribe = (cb: () => void): (() => void) => {
  const src = workspaceSource
  return src !== null ? src.subscribe(cb) : () => {}
}
export const stableWorkspaceGetSnapshot = (): unknown => workspaceSource?.getSnapshot()

/** 宿主 sessions.list 快照行上的宿主保留信息(0.2.x):source → 引用计数。
 *  mainView > 0 即"当前主视图会话"(ui-workspace replaceMain retain 置位)。 */
type RetainedBy = { mainView?: number }

/** 官方"当前主视图会话"判定:0.2.x 起快照的 s.current 字段已删,官方组件
 *  (ui-session isMain / ui-cordis / ui-layout DocumentTitle)统一改用
 *  `(row.retainedBy.mainView ?? 0) > 0`;此处同款,返回原始值保证 uSES selector 稳定。 */
export function selectCurrentSessionId(state: unknown): string | undefined {
  const byId = (state as { byId?: Record<string, SessionRow> })?.byId
  if (byId === undefined) return undefined
  for (const [key, row] of Object.entries(byId)) {
    if ((row?.retainedBy?.mainView ?? 0) > 0) {
      // 0.2.x 行字段是 id(无 sessionId);旧宿主行带 sessionId。byId 的键同值,兜底用它。
      return row.id ?? row.sessionId ?? key
    }
  }
  return undefined
}

/** sessionStatus store(Map<sessionId, 状态>)→ 单会话三态;缺席返回 undefined。 */
export function selectSessionStatus(state: unknown, sessionId: string): SessionStatusRow | undefined {
  const map = state as Map<string, SessionStatusRow> | undefined
  if (map === undefined || typeof (map as Map<string, SessionStatusRow>).get !== 'function') return undefined
  return (map as Map<string, SessionStatusRow>).get(sessionId)
}

/** 宿主 sessions 快照 → 当前会话 + cwd(侧栏/顶部栏/编辑器/面板共用)。 */
export function useSessionCwd(useSessions: unknown): { currentId: string | undefined; cwd: string | undefined } {
  const hook = useSessions as ((sel: (s: any) => unknown) => unknown) | undefined
  const currentId = hook?.(selectCurrentSessionId) as string | undefined
  const state = hook?.((s: any) => s)
  const cwd = currentId !== undefined ? (state as any)?.byId?.[String(currentId)]?.cwd : undefined
  return { currentId, cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined }
}


/** workspaces.list 快照直读(轮询/一次性读场景;未捕获或未就绪返回 undefined)。 */
export function workspaceSnapshot(): { items?: unknown[]; archivedSessionIds?: string[] } | undefined {
  return workspaceSource?.getSnapshot() as { items?: unknown[]; archivedSessionIds?: string[] } | undefined
}

/** sessions.list 快照(ids + byId)→ 全量会话行(0.1.2 起逆向 POST /api/session.list 已死)。
 * 快照行含 running/cwd/origin/projections 等,与旧 RPC 行同构(completed/pendingInteraction 由宿主前端模型附加)。
 * sessionId 以 ids 键为准回填(快照值体上该字段不保证存在,消费端有 .replace 等字符串操作)。 */
export function rowsFromSessionsSnapshot(): SessionRow[] {
  const snap = liveSessionsSource?.getSnapshot() as { ids?: string[]; byId?: Record<string, SessionRow> } | null
  if (snap?.ids === undefined || snap?.byId === undefined) return []
  return snap.ids
    .map((id) => {
      const row = snap.byId![id]
      return row === undefined ? undefined : ({ sessionId: id, ...row } as SessionRow)
    })
    .filter((row): row is SessionRow => row !== undefined)
}

/** DeepSeek 官方鲸鱼 logo(llobehub brand SVG 内联,currentColor 可控色)——侧栏/顶部栏共用。 */
export function DeepSeekIcon(props: { size?: number }) {
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

/** 会话状态占位(对齐官方侧栏 sessionStatuses 优先级):
 * 等用户交互(审批/计划/提问)= warning 琥珀点 > 运行中 = ongoing 像素矩阵动画 > 完成未读 = 绿色对勾;空闲留空占位。 */
export function SessionStatus(props: { running?: boolean; completed?: boolean; pending?: string }) {
  if (props.pending !== undefined) return jsx(Primitives.StateDot, { state: 'warning', size: 10 })
  if (props.running === true) return jsx(Primitives.StateDot, { state: 'ongoing', size: 10 })
  if (props.completed === true) {
    return jsx('span', {
      style: { display: 'inline-flex', flexShrink: 0, color: 'var(--dsw-alias-state-success-primary)', lineHeight: 0 },
      children: jsx(Primitives.IconCheckOutlineMedium, { size: 12 }),
    })
  }
  return null
}
