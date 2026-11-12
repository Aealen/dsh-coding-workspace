/**
 * 右栏编辑器/只读 diff 渲染冒烟(node --test 直跑):宿主环境无法 CLI 复现,
 * 这里用 react-dom/server renderToString 把「编辑视图」「commit diff 视图」
 * 的完整渲染跑一遍,任何 ReferenceError/invalid element 都会在此暴露。
 *
 * 覆盖组件已随右栏迁移从 EditorOverlay 换成 EditView / CommitDiffView
 * (顶部栏与覆盖层已删除,见 dshw-editor / dshw-diff tab)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

// node 无 DOM:最小 shim(生产 webview 有真 window/document,这里只为让渲染跑通)
globalThis.window = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
globalThis.document = {
  querySelector: () => null,
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.fetch = async () => ({ json: async () => ({}) })

/** 右栏编辑 tab 的伪 tab 对象(EditorBody 内部同款构造)。 */
const mkTab = (over = {}) => ({ id: 'editor-smoke', cwd: 'C:/smoke-repo', relPath: 'src/a.ts', view: 'edit', dirty: false, ...over })

test('EditView / CommitDiffView 渲染冒烟:renderToString', async () => {
  const out = join(fileURLToPath(new URL('.', import.meta.url)), '.smoke-editor.cjs')
  await build({
    entryPoints: [join(fileURLToPath(new URL('.', import.meta.url)), '.smoke-entry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2023',
    outfile: out,
    // primitives 宿主运行时才提供,node 冒烟用 stub 顶住(见 .stub-primitives.js)
    alias: { '@deepseek-ai/dsh-client-ui-primitives': join(fileURLToPath(new URL('.', import.meta.url)), '.stub-primitives.js') },
    external: ['react', 'react/jsx-runtime'],
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
  })
  const mod = await import(pathToFileURL(out).href)
  const React = (await import('react')).default
  const { renderToString } = await import('react-dom/server')

  // 编辑视图:无 bridge(降级路径)也应正常渲染
  const html = renderToString(React.createElement(mod.EditView, { tab: mkTab() }))
  assert.ok(html.length > 100, '应有实际渲染输出')

  // 带 bridge 渲染(行评论「发送到会话」通道)
  const bridge = { scope: () => ({}), conversationInput: () => undefined }
  const html2 = renderToString(React.createElement(mod.EditView, { tab: mkTab(), bridge }))
  assert.ok(html2.length > 100)

  // 历史 commit diff 视图(dshw-diff tab 正文复用同一组件)
  const html3 = renderToString(
    React.createElement(mod.CommitDiffView, { tab: mkTab({ id: 'diff-smoke', commit: 'abc1234' }), bridge }),
  )
  assert.ok(html3.length > 100)
})
