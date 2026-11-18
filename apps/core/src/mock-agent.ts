import type { AgentRuntimeAdapter } from '@profer/agent-runtime'
import type { SDKMessage } from '@profer/shared'
import { randomUUID } from 'node:crypto'

/** 仅用于本地调试：合成 Agent 回复，不访问任何模型服务。 */
export const MOCK_AGENT_NOTICE = 'Core 调试模式（PROFER_CORE_MOCK_AGENT=1）生成的合成回复，未调用真实模型。'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function assistantMessage(sessionId: string, messageId: string, text: string, partial: boolean): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: messageId,
    ...(partial ? { _partial: true } : {}),
    message: {
      model: 'profer-core-mock',
      content: [{ type: 'text', text }],
      stop_reason: partial ? null : 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as SDKMessage
}

export function createMockAgentAdapter(): AgentRuntimeAdapter {
  const stopped = new Set<string>()
  return {
    runtime: 'pi',
    async query() {
      return { status: 'completed' }
    },
    async *stream(input) {
      const sessionId = input.sessionId
      stopped.delete(sessionId)
      const messageId = `mock-${randomUUID()}`
      const reply = [
        MOCK_AGENT_NOTICE,
        '',
        `你发送的内容：${input.prompt}`,
        '',
        `sessionId: ${sessionId}`,
        `channelId: ${input.channelId ?? '(未指定)'}`,
        `modelId: ${input.modelId ?? '(未指定)'}`,
        `cwd: ${input.cwd ?? '(未指定)'}`,
      ].join('\n')

      yield assistantMessage(sessionId, messageId, '正在生成调试回复…', true)
      const steps = [
        `已收到你的消息：${input.prompt}`,
        `当前渠道：${input.channelId ?? '(未指定)'}；模型：${input.modelId ?? '(未指定)'}`,
        '这段文字由 Core 调试模式合成，不访问任何模型服务。',
      ]
      let streamed = '正在生成调试回复…'
      for (const step of steps) {
        await sleep(1200)
        if (stopped.has(sessionId)) return
        streamed += `\n\n${step}`
        yield assistantMessage(sessionId, messageId, streamed, true)
      }
      await sleep(400)
      if (stopped.has(sessionId)) return
      yield assistantMessage(sessionId, messageId, reply, false)
      yield {
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        uuid: messageId,
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      } as SDKMessage
    },
    stop(_reason?: string, sessionId?: string) {
      if (sessionId) stopped.add(sessionId)
    },
  }
}
