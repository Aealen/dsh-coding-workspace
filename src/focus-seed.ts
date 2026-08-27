/**
 * 聚焦交接种子构造(零依赖纯函数,便于单测)。
 *
 * 形状对齐 @deepseek-ai/dsh-session 的 SessionEvent envelope 与
 * @deepseek-ai/dsh-llm 的 UserMessage(TextBlock 内容 + user source)。
 */
export function buildFocusSeedEvent(
  summary: string,
  sourceId: string,
  now = Date.now(),
): Record<string, unknown> {
  return {
    type: 'user/message',
    seq: 0,
    time: now,
    data: {
      id: `msg-focus-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text: `【聚焦交接|源会话 ${sourceId}】\n\n${summary}` }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
}
