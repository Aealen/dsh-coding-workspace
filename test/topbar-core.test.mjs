import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeCwd, topbarSessions, normalizeSessionId, countSubagents } from '../lib/topbar-core.js'

test('normalizeCwd: 反斜杠统一为正斜杠', () => {
  assert.equal(normalizeCwd('C:\\repo\\.worktree\\feat'), 'C:/repo/.worktree/feat')
})

test('normalizeCwd: 正斜杠原样透传', () => {
  assert.equal(normalizeCwd('/home/u/repo'), '/home/u/repo')
})

test('normalizeCwd: 空/undefined 返回 null', () => {
  assert.equal(normalizeCwd(undefined), null)
  assert.equal(normalizeCwd(''), null)
  assert.equal(normalizeCwd('   '), null)
})

test('topbarSessions: 只保留 cwd 归一后匹配的会话', () => {
  const rows = [
    { sessionId: 'a', cwd: 'C:\\repo\\.worktree\\feat' },
    { sessionId: 'b', cwd: 'C:/repo/.worktree/other' },
    { sessionId: 'c' },
  ]
  const out = topbarSessions(rows, 'C:/repo/.worktree/feat', new Set())
  assert.deepEqual(out.map((r) => r.sessionId), ['a'])
})

test('topbarSessions: 排除子代理会话', () => {
  const rows = [
    { sessionId: 'a', cwd: 'C:/repo' },
    { sessionId: 'sub', cwd: 'C:/repo', origin: 'subagent' },
  ]
  const out = topbarSessions(rows, 'C:/repo', new Set())
  assert.deepEqual(out.map((r) => r.sessionId), ['a'])
})

test('topbarSessions: 排除已归档会话', () => {
  const rows = [
    { sessionId: 'a', cwd: 'C:/repo' },
    { sessionId: 'gone', cwd: 'C:/repo' },
  ]
  const out = topbarSessions(rows, 'C:/repo', new Set(['gone']))
  assert.deepEqual(out.map((r) => r.sessionId), ['a'])
})

test('topbarSessions: 按 updatedAt 升序(新会话靠右),缺失殿后', () => {
  const rows = [
    { sessionId: 'late', cwd: 'C:/repo', updatedAt: 300 },
    { sessionId: 'none', cwd: 'C:/repo' },
    { sessionId: 'early', cwd: 'C:/repo', updatedAt: 100 },
    { sessionId: 'mid', cwd: 'C:/repo', updatedAt: 200 },
  ]
  const out = topbarSessions(rows, 'C:/repo', new Set())
  assert.deepEqual(out.map((r) => r.sessionId), ['early', 'mid', 'late', 'none'])
})

test('topbarSessions: 当前 cwd 缺失返回空数组', () => {
  assert.deepEqual(topbarSessions([{ sessionId: 'a', cwd: 'C:/repo' }], undefined, new Set()), [])
})

test('normalizeSessionId: 剥掉可选 session- 前缀', () => {
  assert.equal(normalizeSessionId('session-abc123'), 'abc123')
  assert.equal(normalizeSessionId('abc123'), 'abc123')
  assert.equal(normalizeSessionId(undefined), '')
})

test('countSubagents: 按 parentSessionId 归一化计数(前缀变体等价)', () => {
  const rows = [
    { sessionId: 'sub1', origin: 'subagent', parentSessionId: 'session-parent1' },
    { sessionId: 'sub2', origin: 'subagent', parentSessionId: 'parent1' },
    { sessionId: 'sub3', origin: 'subagent', parentSessionId: 'other' },
    { sessionId: 'sub4', parentSessionId: 'parent1' },
    { sessionId: 'parent1' },
  ]
  assert.equal(countSubagents(rows, 'session-parent1'), 2)
  assert.equal(countSubagents(rows, 'parent1'), 2)
  assert.equal(countSubagents(rows, 'other'), 1)
})

test('countSubagents: fork 血缘 parentSessionId 不计入(顶层互指)', () => {
  const rows = [
    { sessionId: 'forked', parentSessionId: 'source' },
    { sessionId: 'source' },
  ]
  assert.equal(countSubagents(rows, 'source'), 0)
})

test('countSubagents: 空/无效 id 返回 0', () => {
  assert.equal(countSubagents([{ sessionId: 'x', origin: 'subagent', parentSessionId: 'p' }], ''), 0)
})
