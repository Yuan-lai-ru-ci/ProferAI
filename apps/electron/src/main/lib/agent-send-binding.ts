import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'

export type AgentSendBindingResult =
  | { ok: true }
  | { ok: false; code: string; message: string }

/**
 * SEND_MESSAGE 的主进程归属校验。session/workspace 以持久化 meta 为准；
 * channel 允许在已启用渠道之间切换，不能把历史 channelId 当作不可变绑定。
 */
export function validateAgentSendBinding(
  input: AgentSendInput,
  session: AgentSessionMeta | undefined,
  workspaceExists: boolean,
  channel: Channel | undefined,
): AgentSendBindingResult {
  if (!session) {
    return { ok: false, code: 'AGENT_SESSION_NOT_FOUND', message: `Agent 会话不存在: ${input.sessionId}` }
  }
  if (session.workspaceId !== input.workspaceId) {
    return { ok: false, code: 'AGENT_SESSION_WORKSPACE_MISMATCH', message: 'Agent 会话与工作区归属不匹配' }
  }
  if (session.workspaceId && !workspaceExists) {
    return { ok: false, code: 'AGENT_WORKSPACE_NOT_FOUND', message: 'Agent 会话所属工作区不存在' }
  }
  if (!channel) {
    return { ok: false, code: 'AGENT_CHANNEL_NOT_FOUND', message: `Agent 渠道不存在: ${input.channelId}` }
  }
  if (!channel.enabled) {
    return { ok: false, code: 'AGENT_CHANNEL_DISABLED', message: `Agent 渠道已停用: ${input.channelId}` }
  }
  if (input.modelId) {
    const model = channel.models?.find((candidate) => candidate.id === input.modelId)
    if (!model) {
      return { ok: false, code: 'AGENT_MODEL_NOT_IN_CHANNEL', message: `所选模型不属于当前 Agent 渠道: ${input.modelId}` }
    }
    if (!model.enabled) {
      return { ok: false, code: 'AGENT_MODEL_DISABLED', message: `所选 Agent 模型已停用: ${input.modelId}` }
    }
  }
  return { ok: true }
}
