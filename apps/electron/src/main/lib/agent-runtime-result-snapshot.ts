import type { AgentMessage, SDKMessage } from '@profer/shared'

/** 当前 run 的最后一条完整 assistant 答复；不读盘，也不随中间轮数增长。 */
export function createRuntimeResultSnapshot() {
  let latest: AgentMessage | undefined
  let anonymousSequence = 0
  return {
    observe(message: SDKMessage): void {
      const record = message as SDKMessage & {
        _partial?: boolean
        isReplay?: boolean
        uuid?: string
        _createdAt?: number
        _provenance?: { messageId?: string }
        message?: { id?: string; content?: unknown }
      }
      if (message.type !== 'assistant' || record._partial || record.isReplay) return
      const content = record.message?.content
      if (!Array.isArray(content)) return
      const text = content.flatMap(block => {
        if (!block || typeof block !== 'object') return []
        const part = block as { type?: unknown; text?: unknown }
        return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
      }).join('\n')
      if (!text.trim()) return
      const id = record._provenance?.messageId ?? record.uuid ?? record.message?.id ?? `assistant-${anonymousSequence++}`
      latest = { id, role: 'assistant', content: text, createdAt: record._createdAt ?? Date.now() }
    },
    messages(): AgentMessage[] {
      return latest ? [{ ...latest }] : []
    },
    clear(): void { latest = undefined },
  }
}
