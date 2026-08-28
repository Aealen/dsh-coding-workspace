/**
 * 聚焦交接种子构造(零依赖纯函数,便于单测)。
 *
 * 形状对齐 @deepseek-ai/dsh-session 的 SessionEvent envelope 与
 * @deepseek-ai/dsh-llm 的 UserMessage(TextBlock 内容 + user source)。
 *
 * 必须是「完整回合」三件套(turn/start + 摘要 + turn/end):
 * - agents.create 的 seed 校验拒绝开放 turn;
 * - 宿主 sessionBlank() = 日志无 turn/start,纯 user 消息种子会被
 *   判为空会话,GUI 侧栏不渲染(真机踩坑实证)。
 */
export function buildFocusSeedEvents(
  summary: string,
  sourceId: string,
  now = Date.now(),
): Record<string, unknown>[] {
  const text = `【聚焦交接|源会话 ${sourceId}】\n\n${summary}`
  return [
    { type: 'turn/start', seq: 0, time: now, data: { turn: 0 } },
    {
      type: 'user/message',
      seq: 1,
      time: now,
      data: {
        id: `msg-focus-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    {
      type: 'turn/end',
      seq: 2,
      time: now,
      data: { turn: 0, reason: { kind: 'completed' } },
    },
  ]
}
