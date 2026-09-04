import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './i18n.js'
import { SessionStatus, stableGetSnapshot, stableSubscribe, DeepSeekIcon } from './session-status.js'
import { normalizeCwd, topbarSessions, countSubagents, TOPBAR_HEIGHT } from './topbar-core.js'
import {
  fileTabsSubscribe,
  fileTabsGetSnapshot,
  activateSession,
  activateFile,
  closeFile,
} from './file-tabs.js'
import { FileIcon } from './file-icon.js'

/**
 * 顶部栏(会话 TAB 页):常驻贴视口顶,横贯全宽,展示「当前会话 cwd 工作区」的
 * 顶层会话 TAB——点 TAB 切会话(open),"+"新建(startSession;cwd 无 registry
 * 记录时先幂等 createWorkspace 再开,交互不断链)。
 *
 * 挂 shell.overlay(additive list slot,与右栏面板同款)。挤压借鉴右栏 CSS
 * 变量桥:写 `--dsh-coding-workspace-topbar-height`,注入 `#root { margin-top:
 * var(...) }` 把宿主(含侧栏)整体下移;右栏停靠面板 top 与收起钮读同一变量让位。
 * 状态点三态复用宿主 mux 实时快照(useSyncExternalStore),零轮询;会话清单走
 * rpc('session.list')+rpc('workspace.list') 10s 兜底轮询(侧栏同款)。
 */

/** 同源 RPC(与 client.tsx 同形态;内联避免 client↔topbar 循环 import)。 */
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

/** 宿主 sessions 快照 → 当前会话 cwd(与 panel.tsx useCurrentCwd 同源同款)。 */
function useCurrentCwd(useSessions: unknown): { currentId: string | undefined; cwd: string | undefined } {
  const hook = useSessions as ((sel: (s: any) => unknown) => unknown) | undefined
  const currentId = hook?.((s: any) => s?.current) as string | undefined
  const state = hook?.((s: any) => s)
  const cwd = currentId !== undefined ? (state as any)?.byId?.[String(currentId)]?.cwd : undefined
  return { currentId, cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined }
}

/** 推挤样式只注入一次(幂等,HMR 重 apply 不叠标签)。 */
function ensurePushStyle(): void {
  try {
    if (document.getElementById('dshw-topbar-style') !== null) return
    const tag = document.createElement('style')
    tag.id = 'dshw-topbar-style'
    tag.textContent = `
/* 顶部栏只悬在中间对话区上方:让位的仅 centerCol(boss 定版,侧栏/LOGO 不动);
   类名 hash 前缀随宿主版本变,按结构后缀 _centerCol 稳定匹配 */
[class*="_centerCol"] { margin-top: var(--dsh-coding-workspace-topbar-height, 0px); }
/* 会话 TAB(Windows Terminal 风格):圆角块 + 激活浮起 + 分隔线 */
.dshw-tabc {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px;
  border: none; background: transparent; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); font-size: 12.5px;
  font-family: inherit; cursor: pointer;
  max-width: 220px; flex-shrink: 0;
}
.dshw-tabc:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshw-tabc[data-active] {
  background: var(--dsw-alias-bg-multi-select);
  color: var(--dsw-alias-label-primary); font-weight: 500;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
}
/* 归档钮:TAB 行 hover 才显影,红色(boss 定版);限定类名不连坐其他 button */
.dshw-tabc .dshw-tbx {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0;
  border: none; background: transparent; border-radius: 4px;
  color: var(--dsw-alias-state-danger-primary, #e5484d);
  cursor: pointer; flex-shrink: 0;
  opacity: 0; transition: opacity 120ms var(--ds-ease-in-out, ease);
}
.dshw-tabc:hover .dshw-tbx, .dshw-tabc .dshw-tbx:focus-visible { opacity: 1; }
.dshw-tabc .dshw-tbx:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshw-tabsep { width: 1px; height: 14px; background: var(--dsw-alias-border-l1); flex-shrink: 0; opacity: 0.7; margin: 0 3px; }
.dshw-tbnew {
  border: none; background: transparent; color: var(--dsw-alias-label-dimmed);
  width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center;
  justify-content: center; cursor: pointer; padding: 0; font-family: inherit; flex-shrink: 0;
  margin-left: 4px;
}
.dshw-tbnew:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshw-tbnew:disabled { opacity: 0.4; cursor: default; }
`
    document.head.appendChild(tag)
  } catch {
    // 无 document 等极端环境:顶部栏仍以 fixed 形态可用
  }
}

/** 实测中间对话区矩形(topbar 贴其上沿、左右边界对齐);拿不到时回落全宽。 */
function measureCenterCol(): { left: number; width: number } {
  try {
    const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
    if (col === null) return { left: 0, width: window.innerWidth }
    const r = col.getBoundingClientRect()
    return { left: Math.round(r.left), width: Math.round(r.width) }
  } catch {
    return { left: 0, width: window.innerWidth }
  }
}

/** TAB 标题:用户/宿主标题优先,最后短码(与侧栏 sessionLabel 同优先级)。 */
function tabLabel(row: { sessionId: string; projections?: { values?: { title?: string | null } } }): string {
  const title = row.projections?.values?.title
  if (title !== undefined && title !== null && title.trim() !== '') return title
  return row.sessionId.replace(/^session-/, '').slice(0, 8)
}

/** cwd 归一(与 file-tabs/topbar-core 同约定)。 */
function normCwd2(p: string | undefined): string | null {
  if (typeof p !== 'string') return null
  const t = p.trim().replace(/\\/g, '/')
  return t === '' ? null : t
}

const barStyle: Record<string, string | number> = {
  position: 'fixed',
  top: 0,
  // width 来自 centerCol border-box 实测,自身 padding 须含在内(否则恒宽 20px 压到右邻)
  boxSizing: 'border-box',
  height: TOPBAR_HEIGHT,
  display: 'flex',
  alignItems: 'center',
  padding: '0 8px',
  background: 'var(--dsw-alias-bg-base)',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  zIndex: 21,
  overflowX: 'auto',
  overflowY: 'hidden',
  // 滚动条占高会顶掉 borderBottom 视觉,隐藏横向滚动条(TAB 溢出用滚轮/拖拽)
  scrollbarWidth: 'none',
}

export function TopBar(props: any): any {
  const actions = props as {
    open?: (sessionId: string) => void
    startSession?: (workspaceId: string) => void
    createWorkspace?: (path: string) => Promise<void>
    archiveSession?: (sessionId: string) => Promise<void>
  }
  const { currentId, cwd } = useCurrentCwd(props.useSessions)
  const live = useSyncExternalStore(stableSubscribe, stableGetSnapshot) as
    | { byId?: Record<string, { running?: boolean; completed?: boolean; pendingInteraction?: string }> }
    | undefined
  // 文件 TAB(编辑器页签):与会话 TAB 同行混排;激活对象=会话|文件(file-tabs store)
  const fileTabsAll = useSyncExternalStore(fileTabsSubscribe, fileTabsGetSnapshot)
  // 文件 TAB 与会话工作区绑定:只显示当前会话 cwd 的文件页签(跨工作区的隐藏不删除)
  const fileTabs = {
    ...fileTabsAll,
    tabs: fileTabsAll.tabs.filter((tb) => {
      const t = normCwd2(tb.cwd)
      const c = normCwd2(cwd)
      return t !== null && c !== null && t === c
    }),
  }

  const [rows, setRows] = useState<any[]>([])
  const [workspaces, setWorkspaces] = useState<any[]>([])
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | undefined>(undefined)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (text: string, tone: 'info' | 'error' = 'info'): void => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    setToast({ text, tone })
    toastTimer.current = setTimeout(() => setToast(undefined), 3200)
  }

  // 会话清单 + 工作区记录(registry 判 cwd 有无登记):10s 轮询兜底(侧栏同款)
  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const [ws, sl] = await Promise.all([rpc<any>('workspace.list'), rpc<any>('session.list')])
        if (disposed) return
        setWorkspaces(ws.items ?? [])
        setRows(sl.items ?? [])
        setArchivedIds(new Set(Array.isArray(ws.archivedSessionIds) ? ws.archivedSessionIds : []))
      } catch {
        // 首拉前快照未就绪:留空数组,TAB 空态展示,下一拍轮询自愈
      }
    }
    void load()
    const timer = setInterval(load, 10000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  ensurePushStyle()

  // 左右边界实时对齐中间对话区:初始测一次 + RO 跟随(侧栏拖宽/收起/右栏面板推挤都改 centerCol rect)。
  // ⚠️ setState 必须值比较(left/width 不变返回原引用):inline ref callback 每次渲染都会
  // detach/attach,若无条件 setState 即 re-render → ref 重建 → 无限循环(React #185 实锤)。
  const [colBox, setColBox] = useState<{ left: number; width: number }>(() => measureCenterCol())
  const roRef = useRef<ResizeObserver | null>(null)
  const applyBox = (): void => {
    const next = measureCenterCol()
    setColBox((prev) => (prev.left === next.left && prev.width === next.width ? prev : next))
  }
  const barRef = (el: HTMLDivElement | null): void => {
    if (el === null) {
      roRef.current?.disconnect()
      roRef.current = null
      return
    }
    if (roRef.current !== null) return
    const col = document.querySelector<HTMLElement>('[class*="_centerCol"]')
    if (col !== null) {
      const ro = new ResizeObserver(applyBox)
      ro.observe(col)
      roRef.current = ro
    }
    applyBox()
  }

  // 常驻让位:挂载写变量,卸载归零还原(无开关,但 cordis fiber 卸载仍需清理)
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--dsh-coding-workspace-topbar-height', `${TOPBAR_HEIGHT}px`)
    return () => {
      root.style.setProperty('--dsh-coding-workspace-topbar-height', '0px')
    }
  }, [])

  const tabs = topbarSessions(rows, cwd, archivedIds)
  const currentCwdNorm = normalizeCwd(cwd)
  const wsRow = currentCwdNorm === null ? undefined : workspaces.find((w: any) => normalizeCwd(w?.path) === currentCwdNorm)

  // 当前 TAB 滚动跟随:侧栏切会话(currentId 变)或首拉数据就绪(tabs.length 变)时,
  // 把激活 TAB 滚进可视区(手动调 scrollLeft,不用 scrollIntoView——会连带滚动页面祖先)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const sc = scrollerRef.current
    const el = sc?.querySelector('[data-active]') as HTMLElement | null | undefined
    if (sc === null || sc === undefined || el === null || el === undefined) return
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    if (left < sc.scrollLeft) sc.scrollLeft = Math.max(0, left - 8)
    else if (right > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = right - sc.clientWidth + 8
  }, [currentId, tabs.length, fileTabs.active])

  /** "+"新建:cwd 已登记直接 startSession;未登记先幂等登记再查回 id 续开。 */
  const onCreate = (): void => {
    if (busy || cwd === undefined) return
    setBusy(true)
    activateSession() // 新会话要在对话区可见:先把激活对象从文件 TAB 切回会话
    const startIn = (workspaceId: string): Promise<void> =>
      Promise.resolve(actions.startSession?.(workspaceId)).then(() => undefined)
    const work =
      wsRow !== undefined
        ? startIn(wsRow.workspaceId)
        : Promise.resolve(actions.createWorkspace?.(cwd))
            .then(async () => {
              // 重建记录后查回 workspaceId(create 幂等,失败即抛)
              const ws = await rpc<any>('workspace.list')
              const created = (ws.items ?? []).find((w: any) => normalizeCwd(w?.path) === currentCwdNorm)
              if (created === undefined) throw new Error(t('topbar.newFailed'))
              return startIn(created.workspaceId)
            })
    work
      .catch((error: unknown) => {
        showToast(t('topbar.newFailed') + `: ${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      .finally(() => setBusy(false))
  }

  /** TAB 行归档(hover 显影红钮):本地乐观移除,失败 toast(10s 轮询自愈兜底)。 */
  const onArchive = (sid: string): void => {
    setRows((prev) => prev.filter((r: any) => r?.sessionId !== sid))
    Promise.resolve(actions.archiveSession?.(sid)).catch((error: unknown) => {
      showToast(t('topbar.archiveFailed') + `: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  const bar: any[] = []
  if (tabs.length === 0) {
    // 空态:占位文案(不影响 "+" 可用性)
    bar.push(
      jsx(
        'span',
        {
          key: 'empty',
          style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: '0 6px', whiteSpace: 'nowrap' },
          children: t('topbar.empty'),
        },
      ),
    )
  }
  for (let i = 0; i < tabs.length; i++) {
    const s = tabs[i]
    const sid = s.sessionId
    // 激活对象是文件 TAB 时,会话 TAB 一律退激活(编辑器覆盖层盖住对话区)
    const active = fileTabs.active.kind === 'session' && sid === currentId
    const l = live?.byId?.[sid]
    const running = l?.running ?? (s as any).running
    const completed = l?.completed ?? (s as any).completed
    const pending = l?.pendingInteraction ?? (s as any).pendingInteraction
    const preset = (s as any).agentPreset as string | undefined
    const subCount = countSubagents(rows, sid)
    if (i > 0) {
      // 分隔线:TAB 之间细竖线(Windows Terminal 同款),激活块自然断开视觉
      bar.push(jsx('span', { key: `sep-${sid}`, className: 'dshw-tabsep' }))
    }
    bar.push(
      jsx(
        'div',
        {
          key: sid,
          className: 'dshw-tabc',
          role: 'tab',
          'data-active': active ? '' : undefined,
          title: tabLabel(s),
          onClick: () => {
            actions.open?.(sid)
            // 若编辑器覆盖层开着,点会话 TAB 同时收回激活对象(盖层随之下落)
            activateSession()
          },
          // 中键归档(二次确认:归档不可逆,宿主无 unarchive);mousedown 拦掉中键自动滚轮
          onMouseDown: (e: React.MouseEvent) => {
            if (e.button === 1) e.preventDefault()
          },
          onAuxClick: (e: React.MouseEvent) => {
            if (e.button !== 1) return
            e.stopPropagation()
            if (window.confirm(t('topbar.archiveConfirm', { name: tabLabel(s) }))) onArchive(sid)
          },
          children: [
            // 鲸鱼 logo:激活态 brand 色,其余退灰(状态信息由尾部状态点承载)
            jsx('span', {
              key: 'ico',
              style: { display: 'inline-flex', color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-dimmed)' },
              children: jsx(DeepSeekIcon, { size: 13 }),
            }),
            jsx(
              'span',
              {
                key: 'lb',
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                children: tabLabel(s),
              },
            ),
            // 模式胶囊 + 子代理数(会话 header 同源信息:agentPreset/parent 归属统计)
            preset !== undefined || subCount > 0
              ? jsx('span', {
                  key: 'chips',
                  style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
                  children: [
                    preset !== undefined
                      ? jsx('span', {
                          key: 'pr',
                          style: {
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: 'var(--dsw-alias-interactive-bg-hover)',
                            whiteSpace: 'nowrap',
                          },
                          children: preset === 'standard' ? t('topbar.preset.standard') : preset,
                        })
                      : null,
                    subCount > 0 ? jsx('span', { key: 'sub', style: { whiteSpace: 'nowrap' }, children: t('topbar.subagents', { count: subCount }) }) : null,
                  ],
                })
              : null,
            jsx('span', { key: 'st', style: { display: 'inline-flex', flexShrink: 0, width: 10, justifyContent: 'center' }, children: jsx(SessionStatus, { running, completed, pending }) }),
            // 归档钮:hover 显影红色(与关闭钮同位,语义=归档);stopPropagation 不触发切换
            jsx('button', {
              key: 'ax',
              className: 'dshw-tbx',
              title: t('topbar.archive'),
              onClick: (e: React.MouseEvent) => {
                e.stopPropagation()
                onArchive(sid)
              },
              children: jsx(Primitives.IconArchiveOutline20, { size: 13 }),
            }),
          ],
        },
      ),
    )
  }
  // 文件 TAB(编辑器页签):接在会话 TAB 之后,前置分隔线;样式复用 .dshw-tabc,
  // 尾部「关闭」钮(脏文件先确认);激活态由 file-tabs store 驱动(点 TAB 弹出
  // 编辑覆盖层,点会话 TAB 收回,见 EditorOverlay)。
  const fileTabNodes: any[] = []
  if (fileTabs.tabs.length > 0 && tabs.length > 0) {
    fileTabNodes.push(jsx('span', { key: 'sep-files', className: 'dshw-tabsep' }))
  }
  for (const ft of fileTabs.tabs) {
    const fname = ft.relPath.split('/').pop() ?? ft.relPath
    const fActive = fileTabs.active.kind === 'file' && fileTabs.active.id === ft.id
    fileTabNodes.push(
      jsxs(
        'div',
        {
          className: 'dshw-tabc',
          role: 'tab',
          'data-active': fActive ? '' : undefined,
          title: ft.relPath,
          onClick: () => activateFile(ft.id),
          // 中键关闭(脏文件二次确认);mousedown 拦掉中键自动滚轮
          onMouseDown: (e: React.MouseEvent) => {
            if (e.button === 1) e.preventDefault()
          },
          onAuxClick: (e: React.MouseEvent) => {
            if (e.button !== 1) return
            e.stopPropagation()
            if (ft.dirty && !window.confirm(t('editor.closeDirtyConfirm', { name: fname }))) return
            closeFile(ft.id)
          },
          children: [
            jsx('span', {
              key: 'ico',
              style: { display: 'inline-flex' },
              children: jsx(FileIcon, { name: ft.relPath }),
            }),
            jsx(
              'span',
              {
                key: 'lb',
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                children: fname,
              },
            ),
            // 脏标记点:未保存时显影(与编辑覆盖层头部同源状态)
            jsx('span', {
              key: 'dt',
              title: t('editor.dirtyDot'),
              style: {
                width: 6,
                height: 6,
                borderRadius: '50%',
                flexShrink: 0,
                background: ft.dirty ? 'var(--dsw-alias-brand-primary)' : 'transparent',
              },
            }),
            jsx('button', {
              key: 'ax',
              className: 'dshw-tbx',
              title: t('editor.close'),
              onClick: (e: React.MouseEvent) => {
                e.stopPropagation()
                if (ft.dirty && !window.confirm(t('editor.closeDirtyConfirm', { name: fname }))) return
                closeFile(ft.id)
              },
              children: '✕',
            }),
          ],
        },
        ft.id,
      ),
    )
  }
  bar.push(...fileTabNodes)
  // "+"新建:内容不满时紧跟最后一个 TAB(内层滚动区宽度=内容宽),撑满溢出时被
  // 内层 flex 压缩自然推到最右(boss 定版)——纯 flex 布局,无需溢出检测。
  const newBtn = jsx(
    'button',
    {
      key: 'new',
      className: 'dshw-tbnew',
      title: t('topbar.new'),
      disabled: busy || cwd === undefined,
      onClick: onCreate,
      // 通用加号(不用 IconNewChat:该钮后期要拓展其他标签页类型)
      children: jsx('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        children: jsx('path', { d: 'M7 2.5v9M2.5 7h9' }),
      }),
    },
  )

  return jsxs(Fragment, {
    children: [
      // 双层:外层 fixed 定宽(overflow hidden),内层滚动区(flex 端缩,width=内容宽,
      // 溢出才滚),new 钮 sibling(shrink-0)——内容少时紧跟最后 TAB,撑满时退守最右
      jsxs('div', {
        ref: barRef,
        style: { ...barStyle, left: colBox.left, width: colBox.width, overflowX: 'hidden', gap: 0 },
        children: [
          jsx('div', {
            ref: (el: HTMLDivElement | null) => {
              scrollerRef.current = el
            },
            onWheel: (e: React.WheelEvent) => {
              // 立式滚轮 deltaY 转横滚(触控板 deltaX 原生已横滚,不叠加);宿主满屏无页面竖滚,无需 preventDefault
              if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              flex: '0 1 auto',
              overflowX: 'auto',
              overflowY: 'hidden',
              height: '100%',
              position: 'relative',
              scrollbarWidth: 'none',
            },
            children: bar,
          }),
          newBtn,
        ],
      }),
      toast !== undefined
        ? jsx(
            'div',
            {
              style: {
                position: 'fixed',
                top: TOPBAR_HEIGHT + 10,
                // 右缘贴对话区右边界(顶栏同款对齐,再内收 16)
                right: Math.max(16, window.innerWidth - colBox.left - colBox.width + 16),
                zIndex: 22,
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: 12.5,
                maxWidth: 360,
                color: toast.tone === 'error' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                background: 'var(--dsw-alias-bg-multi-select)',
                border: '1px solid var(--dsw-alias-border-l2)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
              },
              children: toast.text,
            },
          )
        : null,
    ],
  })
}
