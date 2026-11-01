import type { AgentExternalRunSource, AgentSendInput } from '@profer/shared'

/** 公开发送入口重新签发来源；编辑重发与复制来的文本都属于本次用户输入。 */
export function normalizeUserSendInput(input: AgentSendInput): AgentSendInput {
  const {
    taskOrigin: _origin, taskAuthorization: _authorization, taskId: _taskId,
    triggerId: _triggerId, messageAuthor: _author, triggeredBy: _triggeredBy,
    taskReturnReferences: _taskReturnReferences,
    initiator: _initiator, internalPrompt: _internalPrompt,
    suppressUserMessagePersistence: _suppress, ...fields
  } = input
  return {
    ...fields,
    initiator: 'user',
    taskOrigin: { actor: { type: 'user' } },
    taskAuthorization: { kind: 'direct', ...(input.uuid ? { sourceRef: { type: 'message', id: input.uuid } } : {}) },
    messageAuthor: { type: 'user' },
  }
}

/** 此入口仅接受主进程调用方；公开 Pocket 参数由远程服务白名单重建。 */
export function normalizeHeadlessSendInput(input: AgentSendInput, source?: AgentExternalRunSource): AgentSendInput {
  if (input.taskOrigin) return input
  if (input.initiator === 'user' || input.triggeredBy === 'user') return normalizeUserSendInput(input)
  const actor = input.triggeredBy === 'automation' || source === 'automation' ? { type: 'automation' as const }
    : input.triggeredBy === 'delegation' || source === 'delegation' ? { type: 'agent' as const }
      : input.triggeredBy === 'goal' || source === 'goal' ? { type: 'system' as const, id: 'goal' }
        : { type: 'external' as const, ...(source ? { id: source } : {}) }
  return {
    ...input,
    taskOrigin: { actor },
    messageAuthor: input.messageAuthor ?? actor,
    taskAuthorization: input.taskAuthorization ?? { kind: actor.type === 'external' ? 'external' : 'policy' },
  }
}
