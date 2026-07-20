import { normalizeAgentRuntime, type AgentSendInput, type AgentSessionMeta, type Channel } from '@profer/shared'

export type AgentSendBindingResult =
  | { ok: true }
  | { ok: false; code: string; message: string }

/** 校验 renderer 提交的渠道/模型组合，主进程必须以 channel-manager 数据为准。 */
export function validateAgentChannelModelBinding(
  channelId: string | undefined,
  modelId: string | undefined,
  channel: Channel | undefined,
): AgentSendBindingResult {
  if (!channelId) {
    return { ok: false, code: 'AGENT_CHANNEL_NOT_FOUND', message: 'Agent 渠道不能为空' }
  }
  if (!channel) {
    return { ok: false, code: 'AGENT_CHANNEL_NOT_FOUND', message: `Agent 渠道不存在: ${channelId}` }
  }
  if (!channel.enabled) {
    return { ok: false, code: 'AGENT_CHANNEL_DISABLED', message: `Agent 渠道已停用: ${channelId}` }
  }
  if (!modelId) {
    return { ok: false, code: 'AGENT_MODEL_NOT_IN_CHANNEL', message: 'Agent 模型不能为空' }
  }
  const model = channel.models?.find((candidate) => candidate.id === modelId)
  if (!model) {
    return { ok: false, code: 'AGENT_MODEL_NOT_IN_CHANNEL', message: `所选模型不属于当前 Agent 渠道: ${modelId}` }
  }
  if (!model.enabled) {
    return { ok: false, code: 'AGENT_MODEL_DISABLED', message: `所选 Agent 模型已停用: ${modelId}` }
  }
  return { ok: true }
}

/** UPDATE_SESSION_MODEL 的主进程契约：session 存在、空闲，且渠道/模型仍可用。 */
export function validateAgentSessionModelUpdate(
  sessionId: string,
  channelId: string | undefined,
  modelId: string | undefined,
  session: AgentSessionMeta | undefined,
  channel: Channel | undefined,
  isActive: boolean,
): AgentSendBindingResult {
  if (!session) {
    return { ok: false, code: 'AGENT_SESSION_NOT_FOUND', message: `Agent 会话不存在: ${sessionId}` }
  }
  if (isActive) {
    return { ok: false, code: 'AGENT_SESSION_ACTIVE', message: 'Agent 正在运行，完成后再切换模型' }
  }
  return validateAgentChannelModelBinding(channelId, modelId, channel)
}

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
  // runtime 是会话元数据的归属，不允许过期 renderer / 延迟请求越过切换结果。
  if (input.agentRuntime !== undefined && input.agentRuntime !== normalizeAgentRuntime(session.agentRuntime)) {
    return { ok: false, code: 'AGENT_SESSION_RUNTIME_MISMATCH', message: 'Agent 会话内核已切换，请重新发送消息' }
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
  if (!input.modelId) return { ok: true }
  return validateAgentChannelModelBinding(input.channelId, input.modelId, channel)
}
