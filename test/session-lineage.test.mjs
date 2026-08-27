import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSessionLineageStore } from '../lib/session-lineage.js'
import { buildFocusSeedEvent } from '../lib/focus-seed.js'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wt-sesslineage-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('buildFocusSeedEvent: user/message 信封 + UserMessage 形状', () => {
  const event = buildFocusSeedEvent('结论摘要', 'session-abc', 12345)
  assert.equal(event.type, 'user/message')
  assert.equal(event.seq, 0)
  assert.equal(event.time, 12345)
  assert.equal(event.surfaceOp, 'append')
  const data = event.data
  assert.equal(data.role, 'user')
  assert.deepEqual(data.source, { kind: 'user' })
  assert.equal(data.content.length, 1)
  assert.equal(data.content[0].type, 'text')
  assert.match(data.content[0].text, /【聚焦交接\|源会话 session-abc】/)
  assert.match(data.content[0].text, /结论摘要/)
  assert.ok(typeof data.id === 'string' && data.id.length > 0)
  // 纯 JSON 可落盘(Session.append 有 lossless-JSON 校验)
  assert.doesNotThrow(() => JSON.stringify(event))
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
