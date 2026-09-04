import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { t } from './i18n.js'
import {
  fileTabsSubscribe,
  fileTabsGetSnapshot,
  closeFile,
  setFileDirty,
  type FileTab,
} from './file-tabs.js'
import { alignLines, diffBlocks, type DiffRow } from './panel-diff.js'
import { langOf, highlightLines } from './highlight-hljs.js'
import { TOPBAR_HEIGHT } from './topbar-core.js'

/**
 * 文件编辑覆盖层:顶部栏「文件 TAB」激活时盖住宿主对话区(centerCol 矩形,
 * top 从顶栏下沿起),内嵌「编辑 / Diff」双视图。挂 shell.overlay additive
 * 第三枚(client.tsx),与 panel/topbar 同 bundle 共享 file-tabs store,
 * 无跨根通信。
 *
 * 布局套路与 topbar 同款:实测 [class*="_centerCol"] 矩形 + ResizeObserver
 * 跟随(侧栏拖宽/面板推挤都会改 rect);拿不到时回落全宽。
 */

/** 插件自有路由 POST(与 panel.tsx postJson 同形态):ok=false 抛 message。 */
async function rpc<T = any>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/dsh-coding-workspace/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json()
  if (!body?.ok) throw new Error(body?.message ?? `${method}: ${res.status}`)
  return body as T
}

/** 实测中间对话区矩形(与 topbar.measureCenterCol 同款;独立小实现避免跨模块耦合)。 */
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

/** 文件图标(14px 线性,currentColor;与树内 FileIcon 视觉同族)。 */
function FileGlyph(props: { size?: number }) {
  return jsx('svg', {
    width: props.size ?? 13,
    height: props.size ?? 13,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { flexShrink: 0 },
    children: jsx('path', { d: 'M8 1.5H3.5A1 1 0 0 0 2.5 2.5v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5zM8 1.5V5h3.5' }),
  })
}

const MONO_FONT = 'var(--ds-font-family-mono, monospace)'
const LINE_HEIGHT = 20

/** hljs token 色板(one-dark 系)+ 亮色系统主题兜底;幂等注入一次。 */
function ensureEditorStyle(): void {
  try {
    if (document.getElementById('dshw-editor-style') !== null) return
    const tag = document.createElement('style')
    tag.id = 'dshw-editor-style'
    tag.textContent = `
.dshw-code .hljs-comment, .dshw-code .hljs-quote { color: #7f848e; font-style: italic; }
.dshw-code .hljs-keyword, .dshw-code .hljs-selector-tag, .dshw-code .hljs-doctag,
.dshw-code .hljs-formula, .dshw-code .hljs-name { color: #c678dd; }
.dshw-code .hljs-string, .dshw-code .hljs-regexp, .dshw-code .hljs-addition,
.dshw-code .hljs-attribute, .dshw-code .hljs-meta .hljs-string { color: #98c379; }
.dshw-code .hljs-number, .dshw-code .hljs-variable, .dshw-code .hljs-template-variable,
.dshw-code .hljs-selector-class, .dshw-code .hljs-selector-attr, .dshw-code .hljs-selector-pseudo { color: #d19a66; }
.dshw-code .hljs-title, .dshw-code .hljs-section, .dshw-code .hljs-title.function_ { color: #61afef; }
.dshw-code .hljs-title.class_, .dshw-code .hljs-class .hljs-title, .dshw-code .hljs-built_in { color: #e5c07b; }
.dshw-code .hljs-attr, .hljs-symbol, .dshw-code .hljs-bullet, .dshw-code .hljs-link { color: #e06c75; }
.dshw-code .hljs-meta, .dshw-code .hljs-literal { color: #56b6c2; }
.dshw-code .hljs-deletion { color: #e5534b; }
.dshw-code .hljs-emphasis { font-style: italic; }
.dshw-code .hljs-strong { font-weight: 600; }
@media (prefers-color-scheme: light) {
  .dshw-code .hljs-comment, .dshw-code .hljs-quote { color: #a0a1a7; }
  .dshw-code .hljs-keyword, .dshw-code .hljs-selector-tag, .dshw-code .hljs-doctag,
  .dshw-code .hljs-formula, .dshw-code .hljs-name { color: #a626a4; }
  .dshw-code .hljs-string, .dshw-code .hljs-regexp, .dshw-code .hljs-addition,
  .dshw-code .hljs-attribute, .dshw-code .hljs-meta .hljs-string { color: #50a14f; }
  .dshw-code .hljs-number, .dshw-code .hljs-variable, .dshw-code .hljs-template-variable,
  .dshw-code .hljs-selector-class, .dshw-code .hljs-selector-attr, .dshw-code .hljs-selector-pseudo { color: #986801; }
  .dshw-code .hljs-title, .dshw-code .hljs-section, .dshw-code .hljs-title.function_ { color: #4078f2; }
  .dshw-code .hljs-title.class_, .dshw-code .hljs-class .hljs-title, .dshw-code .hljs-built_in { color: #c18401; }
  .dshw-code .hljs-attr, .dshw-code .hljs-symbol, .dshw-code .hljs-bullet, .dshw-code .hljs-link { color: #e45649; }
  .dshw-code .hljs-meta, .dshw-code .hljs-literal { color: #0184bc; }
  .dshw-code .hljs-deletion { color: #e5534b; }
}
`
    document.head.appendChild(tag)
  } catch {
    // 无 document 等极端环境:高亮退纯文本
  }
}

/** 编辑视图:fs-read 加载 → 行号 gutter + auto-grow textarea(wrap=off,行号天然对齐)。 */
function EditView(props: { tab: FileTab }): any {
  const { tab } = props
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const loadSeq = useRef(0)

  useEffect(() => {
    const seq = ++loadSeq.current
    setText(null)
    setError(undefined)
    rpc<any>('fs-read', { root: tab.cwd, path: tab.relPath })
      .then((body) => {
        if (loadSeq.current !== seq) return
        setText(body.content ?? '')
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [tab.cwd, tab.relPath])

  const save = async (): Promise<void> => {
    if (text === null || saving) return
    setSaving(true)
    try {
      await rpc<any>('fs-write', { root: tab.cwd, path: tab.relPath, content: text })
      setFileDirty(tab.id, false)
      setSavedAt(Date.now())
    } catch (e) {
      // 保存失败保持脏标记;浮条提示(不顶替编辑区)
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // 保存结果浮条:成功 2s 淡出,失败 4s
  const [savedAt, setSavedAt] = useState(0)
  const [toast, setToast] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (savedAt === 0 && toast === undefined) return
    const timer = setTimeout(() => {
      setSavedAt(0)
      setToast(undefined)
    }, toast !== undefined ? 4000 : 2000)
    return () => clearTimeout(timer)
  }, [savedAt, toast])

  // 逐行高亮 HTML(textarea 的 value 含 CRLF,highlightLines 内部已归一);
  // 必须在条件 return 之前(hooks 顺序不可分叉)
  const hl = useMemo(() => highlightLines(text ?? '', langOf(tab.relPath)), [text, tab.relPath])

  if (error !== undefined) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 12.5, color: '#f85149', whiteSpace: 'pre-wrap' },
      children: `${t('editor.loadFailed', { error })}`,
    })
  }
  if (text === null) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--dsw-alias-label-dimmed)' },
      children: t('editor.loading'),
    })
  }
  const lines = text.split('\n')
  ensureEditorStyle()
  const codeFont = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: `${LINE_HEIGHT}px`, tabSize: 2 } as const
  return jsxs('div', {
    style: { flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--dsw-alias-bg-base)', position: 'relative' },
    onKeyDown: (e: any) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', minWidth: 'max-content', minHeight: '100%' },
        children: [
          jsx('div', {
            // 行号 gutter:auto-grow 布局下行号与代码区同高同流,天然对齐
            style: {
              flexShrink: 0,
              width: 52,
              padding: `8px 8px 8px 0`,
              textAlign: 'right',
              ...codeFont,
              color: 'var(--dsw-alias-label-dimmed)',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.06))',
              borderRight: '1px solid var(--dsw-alias-border-l1)',
              userSelect: 'none',
            },
            children: lines.map((_, i) => jsx('div', { key: i + 1, children: i + 1 })),
          }),
          // 高亮区:pre 正常流撑尺寸(高亮只读层)+ textarea 叠加(文字透明,caret/选区可见)
          // 两者 padding/字体/行高逐像素一致,minWidth:max-content 下宽度由 pre 撑起,
          // textarea inset 0 完全覆盖 → 无内部滚动,对齐零漂移
          jsxs('div', {
            style: { position: 'relative', flexShrink: 0 },
            children: [
              jsx('pre', {
                'aria-hidden': true,
                className: 'dshw-code',
                style: {
                  margin: 0,
                  padding: 8,
                  minHeight: lines.length * LINE_HEIGHT + 16,
                  boxSizing: 'content-box',
                  ...codeFont,
                  color: 'var(--dsw-alias-label-primary)',
                  pointerEvents: 'none',
                },
                children: hl.map((line, i) =>
                  jsx('div', {
                    key: i + 1,
                    style: { minHeight: LINE_HEIGHT },
                    dangerouslySetInnerHTML: { __html: line.html === '' ? '&nbsp;' : line.html },
                  }),
                ),
              }),
              jsx('textarea', {
                value: text,
                spellCheck: false,
                wrap: 'off',
                onChange: (e: any) => {
                  setText(e.target.value)
                  setFileDirty(tab.id, true)
                },
                onKeyDown: (e: any) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    void save()
                  }
                },
                style: {
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  boxSizing: 'border-box',
                  padding: 8,
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  overflow: 'hidden',
                  background: 'transparent',
                  color: 'transparent',
                  caretColor: 'var(--dsw-alias-label-primary)',
                  // 双保险:color 之外再压 -webkit-text-fill-color(宿主全局样式可能用后者强设字色)
                  WebkitTextFillColor: 'transparent',
                  ...codeFont,
                  whiteSpace: 'pre',
                },
              }),
            ],
          }),
        ],
      }),
      // 保存结果浮条(成功淡绿 / 失败红)
      toast !== undefined || savedAt !== 0
        ? jsx('div', {
            style: {
              position: 'absolute',
              bottom: 14,
              left: '50%',
              transform: 'translateX(-50%)',
              maxWidth: 420,
              padding: '5px 12px',
              borderRadius: 8,
              fontSize: 12,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: toast !== undefined ? '#f85149' : 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-multi-select)',
              border: `1px solid ${toast !== undefined ? 'rgba(248,81,73,0.5)' : 'var(--dsw-alias-border-l2)'}`,
              boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            },
            children: toast !== undefined ? `${t('editor.saveFailed', { error: toast })}` : t('editor.saved', { path: name(tab.relPath) }),
          })
        : null,
      // 浮动保存钮:脏时显影(与 Ctrl+S 等效)
      tab.dirty
        ? jsx(
            'button',
            {
              onClick: () => void save(),
              disabled: saving,
              title: t('editor.dirtyDot'),
              style: {
                position: 'absolute',
                bottom: 14,
                right: 16,
                border: 'none',
                padding: '6px 14px',
                borderRadius: 8,
                fontSize: 12.5,
                fontFamily: 'inherit',
                cursor: 'pointer',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-brand-primary)',
                opacity: saving ? 0.6 : 1,
                boxShadow: '0 2px 10px rgba(0,0,0,0.22)',
              },
              children: t('editor.save'),
            },
          )
        : null,
    ],
  })
}

/** 文件名(相对路径末段)。 */
function name(rel: string): string {
  return rel.split('/').pop() ?? rel
}

const DEL_BG = 'rgba(248, 81, 73, 0.14)'
const ADD_BG = 'rgba(63, 185, 80, 0.13)'
const EMPTY_BG = 'rgba(127, 127, 127, 0.06)'
const DEL_EDGE = 'rgba(248, 81, 73, 0.75)'
const ADD_EDGE = 'rgba(63, 185, 80, 0.75)'
/** 左右分栏比例记忆。 */
const RATIO_KEY = 'dsh-coding-workspace.file-diff-ratio'
function readRatio(): number {
  try {
    const v = Number(localStorage.getItem(RATIO_KEY))
    return Number.isFinite(v) && v >= 0.15 && v <= 0.85 ? v : 0.5
  } catch {
    return 0.5
  }
}

/**
 * 分栏 Diff 视图(unified 单栏,GitHub/IDEA inline 式):
 * [+/- 标记 | 旧行号 | 新行号](sticky 固定)+ 全宽内容色带。
 * 覆盖层宽度受限,单栏把宽度全给内容,对应关系上下相邻天然可读,
 * 行指向带/分栏比例交互整套退役;右缘缩略状态列保留(点击跳转)。
 */
function DiffView(props: { tab: FileTab }): any {
  const { tab } = props
  const [rows, setRows] = useState<DiffRow[] | null>(null)
  // 两侧逐行高亮 HTML:行对齐后按 left/right 行号取色(diff 行交错,不能整段染)
  const [hl, setHl] = useState<{ base: { html: string }[]; current: { html: string }[] } | null>(null)
  const [untracked, setUntracked] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const scRef = useRef<HTMLDivElement | null>(null)
  const loadSeq = useRef(0)

  useEffect(() => {
    const seq = ++loadSeq.current
    setRows(null)
    setHl(null)
    setError(undefined)
    rpc<any>('git-diff', { cwd: tab.cwd, path: tab.relPath })
      .then((body) => {
        if (loadSeq.current !== seq) return
        setUntracked(body.untracked === true)
        const lang = langOf(tab.relPath)
        setRows(alignLines(String(body.base ?? ''), String(body.current ?? '')))
        setHl({
          base: highlightLines(String(body.base ?? ''), lang),
          current: highlightLines(String(body.current ?? ''), lang),
        })
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return
        setError(e instanceof Error ? e.message : String(e))
      })
    // dirty 参与依赖:编辑视图保存后脏标记翻负,自动重拉最新内容
  }, [tab.cwd, tab.relPath, tab.dirty])

  const blocks = useMemo(() => (rows === null ? [] : diffBlocks(rows)), [rows])
  const total = rows === null ? 0 : rows.length

  // 状态列点击:按点击纵向比例换算行号,滚动容器定位到该行(上移 1/3 屏让上下文可见)
  const onMapClick = (e: any): void => {
    const sc = scRef.current
    if (sc === null || total === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratioY = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
    sc.scrollTop = Math.max(0, Math.round(ratioY * total) * LINE_HEIGHT - sc.clientHeight / 3)
  }

  if (error !== undefined) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 12.5, color: '#f85149', whiteSpace: 'pre-wrap' },
      children: `${t('editor.loadFailed', { error })}`,
    })
  }
  if (rows === null) {
    return jsx('div', {
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--dsw-alias-label-dimmed)' },
      children: t('editor.loading'),
    })
  }
  const changed = rows.some((r) => r.type !== 'eq')
  const codeFont = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: `${LINE_HEIGHT}px`, whiteSpace: 'pre', height: LINE_HEIGHT, display: 'flex', alignItems: 'center' } as const
  // sticky 列的实底:行色半透明叠在面板底色上(多背景预混),横滚时不透出下层行文字
  const stickyBg = (row: DiffRow): string =>
    row.type === 'del'
      ? `${DEL_BG}, var(--dsw-alias-bg-base)`
      : row.type === 'add'
        ? `${ADD_BG}, var(--dsw-alias-bg-base)`
        : 'var(--dsw-alias-bg-base)'
  return jsxs('div', {
    style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)' },
    children: [
      untracked || !changed
        ? jsx('div', {
            style: {
              padding: '5px 12px',
              fontSize: 11.5,
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              flexShrink: 0,
            },
            children: untracked ? t('editor.untrackedHint') : t('editor.noDiff'),
          })
        : null,
      jsxs('div', {
        style: { flex: 1, minHeight: 0, display: 'flex' },
        children: [
          jsx('div', {
            ref: scRef,
            style: { flex: 1, minWidth: 0, overflow: 'auto', position: 'relative' },
            children: jsx('div', {
              style: { minWidth: 'max-content', minHeight: '100%', paddingTop: 4 },
              children: rows.map((row, i) =>
                jsxs('div', {
                  key: i,
                  style: {
                    ...codeFont,
                    minWidth: '100%',
                    width: 'max-content',
                    background: row.type === 'del' ? DEL_BG : row.type === 'add' ? ADD_BG : undefined,
                  },
                  children: [
                    // +/- 标记(GitHub 式单字符;eq 行占位对齐)
                    jsx('span', {
                      style: {
                        position: 'sticky', left: 0, width: 22, flexShrink: 0, justifyContent: 'center',
                        background: stickyBg(row),
                        color: row.type === 'del' ? '#e5534b' : row.type === 'add' ? '#57ab5a' : 'transparent',
                        fontWeight: 600, userSelect: 'none',
                      },
                      children: row.type === 'del' ? '-' : row.type === 'add' ? '+' : '.',
                    }),
                    // 旧行号(HEAD)
                    jsx('span', {
                      style: {
                        position: 'sticky', left: 22, width: 38, flexShrink: 0, justifyContent: 'flex-end', paddingRight: 7,
                        background: stickyBg(row), color: 'var(--dsw-alias-label-dimmed)', fontSize: 11, userSelect: 'none',
                        borderRight: '1px solid var(--dsw-alias-border-l1)',
                      },
                      children: row.left ?? '',
                    }),
                    // 新行号(工作区)
                    jsx('span', {
                      style: {
                        position: 'sticky', left: 60, width: 38, flexShrink: 0, justifyContent: 'flex-end', paddingRight: 7,
                        background: stickyBg(row), color: 'var(--dsw-alias-label-dimmed)', fontSize: 11, userSelect: 'none',
                      },
                      children: row.right ?? '',
                    }),
                    // 内容:del 左缘红竖线 / add 左缘绿竖线(IDEA inline 位);
                    // 高亮按行号取自 base/current 的逐行 HTML(行号 1 起 → 数组 -1);
                    // dshw-code 必挂:hljs token 色板挂在 .dshw-code 祖先类下,缺类=颜色全不命中
                    jsx('span', {
                      className: 'dshw-code',
                      style: {
                        minWidth: 420, paddingLeft: 10, flex: 1,
                        borderLeft: row.type === 'del' ? `2px solid ${DEL_EDGE}` : row.type === 'add' ? `2px solid ${ADD_EDGE}` : '2px solid transparent',
                      },
                      ...(hl !== null && row.left !== null && hl.base[row.left - 1] !== undefined
                        ? { dangerouslySetInnerHTML: { __html: hl.base[row.left - 1].html } }
                        : hl !== null && row.right !== null && hl.current[row.right - 1] !== undefined
                          ? { dangerouslySetInnerHTML: { __html: hl.current[row.right - 1].html } }
                          : { children: row.text }),
                    }),
                  ],
                }),
              ),
            }),
          }),
          // 右缘缩略状态列:行占比色块,点击跳转
          jsx('div', {
            title: t('editor.diffMapTitle'),
            onClick: onMapClick,
            style: {
              flexShrink: 0,
              width: 12,
              cursor: 'pointer',
              background: 'var(--dsw-alias-bg-multi-select, rgba(127,127,127,0.08))',
              borderLeft: '1px solid var(--dsw-alias-border-l1)',
              position: 'relative',
            },
            children:
              total === 0
                ? null
                : blocks.map((b, k) =>
                    jsx('div', {
                      key: k,
                      style: {
                        position: 'absolute',
                        left: 2,
                        right: 2,
                        top: `${((b.start * LINE_HEIGHT) / (total * LINE_HEIGHT)) * 100}%`,
                        height: `max(2px, ${((b.end - b.start) / total) * 100}%)`,
                        background: b.type === 'del' ? DEL_EDGE : ADD_EDGE,
                        opacity: 0.75,
                        borderRadius: 1,
                      },
                    }),
                  ),
          }),
        ],
      }),
    ],
  })
}

export function EditorOverlay(props: any): any {
  void props
  const snap = useSyncExternalStore(fileTabsSubscribe, fileTabsGetSnapshot)
  const tab = snap.active.kind === 'file' ? snap.tabs.find((tb) => tb.id === snap.active.id) : undefined

  // 左右边界实时对齐中间对话区(与 topbar 同款:值比较防 ref 重建循环)
  const [colBox, setColBox] = useState<{ left: number; width: number }>(() => measureCenterCol())
  const roRef = useRef<ResizeObserver | null>(null)
  const applyBox = (): void => {
    const next = measureCenterCol()
    setColBox((prev) => (prev.left === next.left && prev.width === next.width ? prev : next))
  }
  const rootRef = (el: HTMLDivElement | null): void => {
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

  if (tab === undefined) return null

  const name = tab.relPath.split('/').pop() ?? tab.relPath
  const onClose = (): void => {
    if (tab.dirty && !window.confirm(t('editor.closeDirtyConfirm', { name }))) return
    closeFile(tab.id)
  }

  return jsx('div', {
    ref: rootRef,
    style: {
      position: 'fixed',
      top: TOPBAR_HEIGHT,
      left: colBox.left,
      width: colBox.width,
      bottom: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--dsw-alias-bg-base)',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      zIndex: 20,
    },
    children: jsxs(Fragment, {
      children: [
        // 头部:文件名 + (编辑 TAB)脏标记 + 关闭;类型由入口决定,无视图切换
        jsxs('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 36,
            padding: '0 10px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            flexShrink: 0,
          },
          children: [
            jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' }, children: jsx(FileGlyph, { size: 13 }) }),
            jsx('span', {
              title: tab.relPath,
              style: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              children: jsx('span', {
                children: [
                  jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed)' }, children: tab.relPath.slice(0, tab.relPath.length - name.length) }),
                  jsx('span', { style: { color: 'var(--dsw-alias-label-primary)' }, children: name }),
                ],
              }),
            }),
            // 脏标记点(仅编辑 TAB 有意义)
            tab.view === 'edit'
              ? jsx('span', {
                  title: t('editor.dirtyDot'),
                  style: {
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: tab.dirty ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                  },
                })
              : null,
            // diff TAB 提示:只读对比
            tab.view === 'diff'
              ? jsx('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed)', flexShrink: 0 }, children: 'Diff' })
              : null,
            jsx('div', { style: { flex: 1 } }),
            jsx(
              'button',
              {
                className: 'dshw-iconbtn',
                title: t('editor.close'),
                onClick: onClose,
                style: { fontSize: 14, lineHeight: 1 },
                children: '✕',
              },
            ),
          ],
        }),
        tab.view === 'edit' ? jsx(EditView, { tab }) : jsx(DiffView, { tab }),
      ],
    }),
  })
}
