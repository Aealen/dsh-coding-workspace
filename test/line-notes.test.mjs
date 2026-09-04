import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPTY_NOTES,
  noteKey,
  addNote,
  updateNote,
  deleteNote,
  notesForFile,
  createLineNotesStore,
} from '../lib/line-notes.js'

test('noteKey:cwd+path 归一(反斜杠等价)', () => {
  assert.equal(noteKey('C:\\repo', 'src/a.ts'), noteKey('C:/repo', 'src/a.ts'))
  assert.notEqual(noteKey('C:/repo', 'src/a.ts'), noteKey('C:/repo', 'src/b.ts'))
})

test('addNote:追加,id 唯一,同文件多行可共存', () => {
  let state = EMPTY_NOTES
  state = addNote(state, 'k', 462, 'first')
  state = addNote(state, 'k', 462, 'second')
  state = addNote(state, 'k', 100, 'other line')
  const file = state.byFile.k
  assert.equal(file.length, 3)
  assert.equal(new Set(file.map((n) => n.id)).size, 3)
  assert.ok(file.every((n) => n.createdAt > 0))
})

test('addNote:空文本/非法行号拒绝(返回原引用)', () => {
  const before = EMPTY_NOTES
  assert.equal(addNote(before, 'k', 0, 'x'), before)
  assert.equal(addNote(before, 'k', -1, 'x'), before)
  assert.equal(addNote(before, 'k', 1, '   '), before)
})

test('updateNote:改文本,他者不动;不存在返回原引用', () => {
  let state = EMPTY_NOTES
  state = addNote(state, 'k', 10, 'old')
  const id = state.byFile.k[0].id
  const next = updateNote(state, 'k', id, 'new')
  assert.equal(next.byFile.k[0].text, 'new')
  assert.equal(updateNote(state, 'k', 'nope', 'x'), state)
})

test('deleteNote:删除;空文件清单自然清理', () => {
  let state = EMPTY_NOTES
  state = addNote(state, 'k', 1, 'a')
  const id = state.byFile.k[0].id
  state = deleteNote(state, 'k', id)
  assert.equal(state.byFile.k, undefined)
  assert.equal(deleteNote(state, 'k', 'nope'), state)
})

test('notesForFile:无记录返回空数组', () => {
  assert.deepEqual(notesForFile(EMPTY_NOTES, 'k'), [])
})

test('createLineNotesStore:持久化往返 + 损坏文件按空处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-notes-'))
  try {
    const file = join(dir, 'notes.json')
    const store = createLineNotesStore(file)
    const key = noteKey('C:/repo', 'a.ts')
    let state = await store.readAll()
    state = addNote(state, key, 7, 'hello')
    await store.writeAll(state)
    // 新实例读回
    const again = createLineNotesStore(file)
    const read = await again.readAll()
    assert.equal(read.byFile[key][0].text, 'hello')
    // 落盘结构带版本号
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    // 损坏文件:按空处理不炸
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{broken', 'utf8')
    assert.deepEqual((await createLineNotesStore(file).readAll()).byFile, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
