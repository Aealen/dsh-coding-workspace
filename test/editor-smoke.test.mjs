/**
 * EditorOverlay 渲染冒烟(node --test 直跑):宿主环境无法 CLI 复现,
 * 这里用 react-dom/server renderToString 把「文件 TAB 激活」的完整渲染
 * 跑一遍,任何 ReferenceError/invalid element 都会在此暴露。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const execFileAsync = promisify(execFile)

// node 无 DOM:最小 shim(生产 webview 有真 window/document,这里只为让渲染跑通)
globalThis.window = { innerWidth: 1200, innerHeight: 800 }
globalThis.document = {
  querySelector: () => null,
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.fetch = async () => ({ json: async () => ({}) })

test('EditorOverlay 渲染冒烟:激活文件 TAB 全树 renderToString', async () => {
  const out = join(fileURLToPath(new URL('.', import.meta.url)), '.smoke-editor.cjs')
  await build({
    entryPoints: [join(fileURLToPath(new URL('.', import.meta.url)), '.smoke-entry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2023',
    outfile: out,
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
  })
  const mod = await import(pathToFileURL(out).href)
  const React = (await import('react')).default
  const { renderToString } = await import('react-dom/server')
  const { openFile, fileTabsGetSnapshot } = mod

  // 激活一个文件 TAB(编辑视图)
  openFile({ cwd: 'C:/smoke-repo', relPath: 'src/a.ts', view: 'edit' })
  const snap = fileTabsGetSnapshot()
  assert.equal(snap.active.kind, 'file')

  // EditorOverlay props:无 dshwBridge(降级路径)也应正常渲染
  const html = renderToString(React.createElement(mod.EditorOverlay, {}))
  assert.ok(html.length > 100, '应有实际渲染输出')

  // 带 bridge 渲染
  const bridge = { scope: () => ({}), conversationInput: () => undefined }
  const html2 = renderToString(React.createElement(mod.EditorOverlay, { dshwBridge: bridge }))
  assert.ok(html2.length > 100)

  // 切 diff 视图文件
  openFile({ cwd: 'C:/smoke-repo', relPath: 'src/b.ts', view: 'diff' })
  const html3 = renderToString(React.createElement(mod.EditorOverlay, { dshwBridge: bridge }))
  assert.ok(html3.length > 100)
})
