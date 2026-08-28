import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSessionLineageStore } from '../lib/session-lineage.js'
import { buildFocusSeedEvents } from '../lib/focus-seed.js'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wt-sesslineage-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('buildFocusSeedEvents: 完整回合三件套(反 blank 判定)', () => {
  const events = buildFocusSeedEvents('结论摘要', 'session-abc', 12345)
  assert.equal(events.length, 3)
  const [start, msg, end] = events
  assert.equal(start.type, 'turn/start')
  assert.deepEqual(start.data, { turn: 0 })
  assert.equal(msg.type, 'user/message')
  assert.equal(msg.seq, 1)
  assert.equal(msg.data.role, 'user')
  assert.deepEqual(msg.data.source, { kind: 'user' })
  assert.equal(msg.data.content[0].type, 'text')
  assert.match(msg.data.content[0].text, /【聚焦交接\|源会话 session-abc】/)
  assert.match(msg.data.content[0].text, /结论摘要/)
  assert.equal(end.type, 'turn/end')
  assert.deepEqual(end.data, { turn: 0, reason: { kind: 'completed' } })
  // seq 连续(agents.create seed 校验要求从 0 起连续)
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2])
  // 有 turn/start => sessionBlank 为 false
  assert.ok(events.some((e) => e.type === 'turn/start'))
  // 纯 JSON 可落盘
  assert.doesNotThrow(() => JSON.stringify(events))
})

test('session lineage store: 写读/childrenOf/删除往返', async () => {
  await withTempHome(async (home) => {
    const store = createFileSessionLineageStore(home)
    await store.writeEdge('child-1', { sourceId: 'src-1', mode: 'full', cwd: '/w', createdAt: 1 })
    await store.writeEdge('child-2', { sourceId: 'src-1', mode: 'focus', createdAt: 2 })
    await store.writeEdge('child-3', { sourceId: 'src-2', mode: 'full', createdAt: 3 })

    const kids = await store.childrenOf('src-1')
    assert.deepEqual(Object.keys(kids).sort(), ['child-1', 'child-2'])

    // 重开实例验证持久化
    const reopened = await createFileSessionLineageStore(home).readAll()
    assert.equal(reopened['child-2'].mode, 'focus')

    assert.equal(await store.removeEdge('child-1'), true)
    assert.equal(await store.removeEdge('child-1'), false)
    assert.equal((await store.readAll())['child-1'], undefined)
  })
})
