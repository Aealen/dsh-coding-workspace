/**
 * 语法高亮(highlight.js 移植):逐行染 + 块状态机混合。
 *
 * hljs 对「整段代码」染色精确,但编辑器/行式 diff 需要逐行独立 HTML(行号对齐),
 * 跨行语法(块注释/模板串/三引号字符串)逐行喂给 hljs 会断染。混合策略:
 * - 块状态机(复用原 file-highlight 的扫描语义)先判行:块注释行整体染 com、
 *   模板串行整体染 str;
 * - 其余行交给 hljs.highlight 单行染色(关键字/字符串/函数名等单行闭合语法精确)。
 *
 * 输出每行一段 HTML(hljs 输出文本已转义;块内行自行 escape),渲染层
 * dangerouslySetInnerHTML 直挂。语言注册走 hljs core + 显式语言模块
 * (函数导出,无全局依赖,esbuild 打包安全)。
 */
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)

export { hljs }

export type Lang = 'typescript' | 'javascript' | 'xml' | 'css' | 'json' | 'markdown' | 'python' | 'bash' | 'plain'

/** 扩展名 → hljs 语言(tsx 用 typescript grammar,标签属性染色略有折扣,可接受)。 */
export function langOf(name: string): Lang {
  const base = name.split('/').pop() ?? name
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : ''
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'vue') return 'xml'
  if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css'
  if (ext === 'json') return 'json'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'py') return 'python'
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'bash'
  return 'plain'
}

/** 单行 HTML 转义(块内行整体染色前的文本安全)。 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 每行染色结果:html 为独立完整的行内 HTML。 */
export interface HighlightLine {
  html: string
}

/** 行高亮主入口。 */
export function highlightLines(code: string, lang: Lang): HighlightLine[] {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  if (lang === 'plain') return lines.map((line) => ({ html: escapeHtml(line) }))
  const grammar = hljs.getLanguage(lang)
  if (grammar === undefined) return lines.map((line) => ({ html: escapeHtml(line) }))
  const out: HighlightLine[] = []
  let inBlock = false // /* */ 内
  let inTemplate = false // ` ` (ts) 或 """ """ (py) 内
  for (const line of lines) {
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) {
        out.push({ html: `<span class="hljs-comment">${escapeHtml(line)}</span>` })
        continue
      }
      // 同行闭合:注释段 com,余下段落恢复单行染色
      const head = line.slice(0, end + 2)
      const rest = line.slice(end + 2)
      out.push({
        html: `<span class="hljs-comment">${escapeHtml(head)}</span>${hljs.highlight(rest, { language: lang, ignoreIllegals: true }).value}`,
      })
      inBlock = false
      continue
    }
    if (inTemplate) {
      out.push({ html: `<span class="hljs-string">${escapeHtml(line)}</span>` })
      if (line.includes('`') || line.includes('"""')) inTemplate = false
      continue
    }
    // 单行 hljs 染色(ignoreIllegals 容错非法序列)
    out.push({ html: hljs.highlight(line, { language: lang, ignoreIllegals: true }).value })
    // 块状态推进:状态驱动(在块内找 */,在块外找 /*),非位置猜——
    // `/** x */` 开后同闭状态必须回 false(此前版本误判,之后全部行被拖进注释态);
    // 块外裸 */ 不翻状态
    {
      let idx = 0
      while (idx < line.length) {
        if (inBlock) {
          const close = line.indexOf('*/', idx)
          if (close === -1) break
          inBlock = false
          idx = close + 2
        } else {
          const open = line.indexOf('/*', idx)
          if (open === -1) break
          inBlock = true
          idx = open + 2
        }
      }
      if (!inBlock && (lang === 'typescript' || lang === 'javascript')) {
        // 模板串奇偶翻转(块状态干净后才数反引号,注释里的 ` 不计)
        let from = 0
        while (true) {
          const bt = line.indexOf('`', from)
          if (bt === -1) break
          inTemplate = !inTemplate
          from = bt + 1
        }
      }
      if (!inBlock && lang === 'python') {
        let from = 0
        while (true) {
          const tq = line.indexOf('"""', from)
          if (tq === -1) break
          inTemplate = !inTemplate
          from = tq + 3
        }
      }
    }
  }
  return out
}
