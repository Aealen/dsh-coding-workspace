import test from 'node:test'
import assert from 'node:assert/strict'
import { hljs, langOf, highlightLines } from '../lib/highlight-hljs.js'

test('langOf:扩展名到 hljs 语言映射', () => {
  assert.equal(langOf('a.ts'), 'typescript')
  assert.equal(langOf('a.tsx'), 'typescript')
  assert.equal(langOf('a.js'), 'javascript')
  assert.equal(langOf('a.json'), 'json')
  assert.equal(langOf('a.css'), 'css')
  assert.equal(langOf('a.md'), 'markdown')
  assert.equal(langOf('a.py'), 'python')
  assert.equal(langOf('a.sh'), 'bash')
  assert.equal(langOf('a.html'), 'xml')
  assert.equal(langOf('Makefile'), 'plain')
})

test('highlightLines:关键字/字符串染出 hljs token 类', () => {
  const lines = highlightLines('const s = "x";', 'typescript')
  assert.equal(lines.length, 1)
  assert.match(lines[0].html, /hljs-keyword/)
  assert.match(lines[0].html, /hljs-string/)
})

test('highlightLines:块注释行整体染 comment(状态机跨行)', () => {
  const lines = highlightLines('let a = 1;\n/* open\nstill inside\nclosed */ let b;', 'typescript')
  assert.match(lines[1].html, /^<span class="hljs-comment">/)
  assert.match(lines[2].html, /^<span class="hljs-comment">/)
  // 闭合行恢复单行 hljs 染色
  assert.match(lines[3].html, /hljs-keyword/)
})

test('highlightLines:单行 JSDoc 开后同闭,后续行不拖进注释态', () => {
  // 真机回归:此前 /** x */ 被误判「开启未闭合」,之后整个函数全染灰
  const lines = highlightLines('/** doc */\nfunction f() {\n  return 1;\n}', 'typescript')
  assert.match(lines[0].html, /hljs-comment/)
  assert.match(lines[1].html, /hljs-keyword/)
  assert.match(lines[2].html, /hljs-keyword/)
  assert.ok(!lines[1].html.includes('hljs-comment'), '函数行不得染成注释')
})

test('highlightLines:块外裸 */ 不翻状态', () => {
  const lines = highlightLines('const a = b / c;\n*/ weird\nclass X {}', 'typescript')
  assert.ok(!lines[1].html.includes('hljs-comment'))
  assert.match(lines[2].html, /hljs-keyword/)
})

test('highlightLines:模板串跨行(同闭反引号奇偶)', () => {
  const lines = highlightLines('const s = `line1\nline2`;\nconst ok = 1;', 'typescript')
  assert.match(lines[1].html, /^<span class="hljs-string">/)
  assert.match(lines[2].html, /hljs-keyword/)
})

test('highlightLines:HTML 特殊字符转义(块内行)', () => {
  const lines = highlightLines('/* <script> & "x" */', 'typescript')
  assert.ok(!lines[0].html.includes('<script>'))
  assert.match(lines[0].html, /&lt;script&gt;/)
})

test('highlightLines:hljs 输出本身转义普通文本', () => {
  const lines = highlightLines('const lt = "<b>";', 'typescript')
  assert.ok(!lines[0].html.includes('<b>'))
})

test('highlightLines:plain 不染只转义', () => {
  const lines = highlightLines('a < b', 'plain')
  assert.equal(lines[0].html, 'a &lt; b')
})

test('highlightLines:json 键值染色', () => {
  const lines = highlightLines('{ "name": "x", "n": 1 }', 'json')
  assert.match(lines[0].html, /hljs-attr/)
  assert.match(lines[0].html, /hljs-string|hljs-number/)
})

test('highlightLines:每行 HTML 独立(逐行行数守恒)', () => {
  const lines = highlightLines('a\n\nb\n', 'typescript')
  assert.equal(lines.length, 4)
})

test('hljs 实例可访问(注册语言生效)', () => {
  assert.ok(hljs.getLanguage('typescript') !== undefined)
  assert.ok(hljs.getLanguage('python') !== undefined)
})
