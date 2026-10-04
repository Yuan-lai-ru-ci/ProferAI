import type { SDKMessage, SDKAssistantMessage, SDKUserMessage, VisualizationRecord } from '@profer/shared'

/** 来源优先，否则通过工具结果中的结果 ID 绑定产生它的轮次；不使用时间猜测。 */
export function visualizationsForTurn(records: readonly VisualizationRecord[], messages: readonly SDKMessage[], allMessages: readonly SDKMessage[] = messages): VisualizationRecord[] {
  const assistantIds = new Set(allMessages.flatMap((message) => message.type === 'assistant' && 'uuid' in message && typeof message.uuid === 'string' ? [message.uuid] : []))
  const messageIds = new Set(messages.flatMap((message) => 'uuid' in message && typeof message.uuid === 'string' ? [message.uuid] : []))
  const toolIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of ((message as SDKAssistantMessage).message?.content ?? [])) {
        if (block.type === 'tool_use') toolIds.add(String(block.id))
      }
    }
    if (message.type !== 'user') continue
    const content = (message as SDKUserMessage).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const raw = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content) ? block.content.filter((part: { type?: string }) => part.type === 'text').map((part: { text?: string }) => part.text ?? '').join('\n') : ''
      try {
        const data = JSON.parse(raw)
        // 只由创建结果绑定。后续修改/inspect 返回同一 ID，不能再投影到另一轮。
        const result = data?.visualization
        if (typeof result?.id === 'string' && result.recordVersion === 1) resultIds.add(result.id)
      } catch { /* 其他工具结果不属于可视化。 */ }
    }
  }
  return records.filter((record) => record.sourceMessageId && assistantIds.has(record.sourceMessageId)
    ? messageIds.has(record.sourceMessageId)
    : toolIds.has(record.toolCallId) || resultIds.has(record.id))
}
