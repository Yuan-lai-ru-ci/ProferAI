import { randomUUID } from 'node:crypto'
import { createAgentRunContext, type AgentRuntimeQueuedInput, type AgentRuntimeQueuedInputResult } from '@profer/agent-runtime'
import type { AgentQueueMessageInput, AgentRuntime, SDKUserMessageInput, SendQueuedMessageOptions } from '@profer/shared'

export interface RuntimeQueueDependencies {
  runtime: AgentRuntime
  queue(input: AgentRuntimeQueuedInput): Promise<AgentRuntimeQueuedInputResult>
  send(sessionId: string, message: SDKUserMessageInput, options: SendQueuedMessageOptions): Promise<void>
  interrupt?(sessionId: string): Promise<void>
  enrich?(input: AgentQueueMessageInput): string | Promise<string>
}

/** Provider 确认接收后由 coordinator 关联原 Run、落盘并广播；不转为下一轮。 */
export async function queueRuntimeUserMessage(input: AgentQueueMessageInput, deps: RuntimeQueueDependencies): Promise<string> {
  const uuid = input.uuid ?? randomUUID()
  const context = createAgentRunContext({ sessionId: input.sessionId, uuid, taskOrigin: { actor: { type: 'user' } },
    messageAuthor: { type: 'user' }, taskAuthorization: { kind: 'direct', sourceRef: { type: 'message', id: uuid } } }, randomUUID)
  await deps.queue({
    sessionId: input.sessionId,
    context,
    message: { type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: input.rawUserMessage ?? input.userMessage }] }, _createdAt: Date.now() },
    receive: async ({ message, isCurrent }) => {
      const prompt = await deps.enrich?.(input) ?? input.userMessage
      if (!isCurrent()) throw new Error('会话未运行，无法追加消息')
      if (deps.runtime === 'claude' && input.interrupt && deps.interrupt) {
        await deps.interrupt(input.sessionId)
        if (!isCurrent()) throw new Error('会话已结束，无法追加消息')
      }
  const options = { interrupt: input.interrupt, skillMentions: input.mentionedSkills, isCurrent }
      await deps.send(input.sessionId, { ...message, type: 'user', parent_tool_use_id: null, session_id: input.sessionId, priority: 'next',
        message: { role: 'user', content: prompt } }, options)
    },
  })
  return uuid
}
