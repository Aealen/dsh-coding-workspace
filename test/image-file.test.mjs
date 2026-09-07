import test from 'node:test'
import assert from 'node:assert/strict'
import { isImagePath, contentTypeOf } from '../lib/image-file.js'
import { openFile, fileTabsGetSnapshot, resetFileTabs } from '../lib/file-tabs.js'

test('isImagePath:白名单扩展名判定', () => {
  for (const p of ['a.png', 'b/jpg/2.JPG', 'x.jpeg', 'y.gif', 'z.webp', 'i.svg', 'm.bmp', 'f.ico', 'n.avif', '  tail.png  ']) {
    assert.equal(isImagePath(p), true, p)
  }
  for (const p of ['a.png.txt', 'png', 'a.pngx', 'a.tar.gz', '', 'a.', 'a.PNGX']) {
    assert.equal(isImagePath(p), false, p)
  }
})

test('contentTypeOf:扩展名 → MIME,非白名单 null', () => {
  assert.equal(contentTypeOf('a.png'), 'image/png')
  assert.equal(contentTypeOf('A.JPG'), 'image/jpeg')
  assert.equal(contentTypeOf('a.svg'), 'image/svg+xml')
  assert.equal(contentTypeOf('a.ico'), 'image/x-icon')
  assert.equal(contentTypeOf('a.txt'), null)
  assert.equal(contentTypeOf('noext'), null)
})

test('openFile:图片扩展名强制 image 视图(任何入口)', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'assets/logo.png', view: 'edit' })
  assert.equal(fileTabsGetSnapshot().tabs[0].view, 'image')
  openFile({ cwd: 'C:/repo', relPath: 'assets/diff-view.svg', view: 'diff' })
  assert.equal(fileTabsGetSnapshot().tabs[1].view, 'image')
  // 同文件复用:入口不同视图也保持 image
  const id = openFile({ cwd: 'C:/repo', relPath: 'assets/logo.png', view: 'diff' })
  const tab = fileTabsGetSnapshot().tabs.find((tb) => tb.id === id)
  assert.equal(tab.view, 'image')
})

test('openFile:非图片不受 image 判定影响', () => {
  resetFileTabs()
  openFile({ cwd: 'C:/repo', relPath: 'src/a.ts' })
  assert.equal(fileTabsGetSnapshot().tabs[0].view, 'edit')
  openFile({ cwd: 'C:/repo', relPath: 'src/b.ts', view: 'diff' })
  assert.equal(fileTabsGetSnapshot().tabs[1].view, 'diff')
})
