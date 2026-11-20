import { isAgentRuntime, isProferPermissionMode, type AgentSessionMeta, type AgentSessionUiAction } from '@profer/shared'
import { projectSdkMessageForPocket, projectSdkMessagesToPocketView } from './pocket-agent-projection'
import type { CoreClient } from './core-client'

type Result = { ok: true; data: unknown } | { ok: false; error: string; conflict?: { code: 'REVISION_CONFLICT'; expectedRevision: number; actualRevision: number; sessionId: string } }
const commands = new Set([
  'update_session_model', 'update_session_runtime', 'update_permission_mode', 'update_session_preset', 'rename_session',
  'update_session_thinking_level', 'update_session_agent_effort', 'toggle_session_pin', 'toggle_session_archive',
  'mark_session_read', 'mark_session_unread', 'get_pending_interactions',
  'respond_permission', 'respond_ask_user', 'respond_exit_plan_mode',
  'create_session', 'ensure_project_draft_session',
  'upload_attachment', 'save_agent_attachment', 'get_sdk_messages', 'session_detail', 'search_workspace_files', 'resolve_and_read_file', 'read_file_as_data_url', 'queue_message', 'stop_agent',
])

/** Pocket经桌面的连接属于本地Core；不使用桌面当前选择的远程Core或本地manager作失败回退。 */
export async function routePocketSessionToCore(input: Record<string, unknown>, deps: {
  getClient(): CoreClient | null
  coreEnabled(): boolean
  paginateMessages?: (messages: import('@profer/shared').SDKMessage[], options: { before?: number; targetMessages?: number }) => { messages: import('@profer/shared').SDKMessage[]; total: number; startIndex: number; endIndex: number; hasMore: boolean }
  sessionItem(meta: AgentSessionMeta): unknown
}): Promise<Result | null> {
  if (typeof input.type !== 'string' || !commands.has(input.type)) return null
  const core = deps.getClient()
  if (!core && !deps.coreEnabled()) return null
  try {
    if (!core) throw new Error('本地Core未就绪')
    const current = () => { if (deps.getClient() !== core) throw new Error('本地Core连接已变化，操作结果请重新查询') }
    if (input.type === 'create_session' || input.type === 'ensure_project_draft_session') {
      for (const field of ['title', 'workspaceId', 'channelId', 'modelId', 'presetId'] as const) {
        if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim())) throw new Error(`无效的会话创建字段：${field}`)
      }
      if (input.runtime !== undefined && !isAgentRuntime(input.runtime)) throw new Error('无效的Agent runtime')
      if (input.permissionMode !== undefined && (typeof input.permissionMode !== 'string' || !isProferPermissionMode(input.permissionMode))) throw new Error('无效的权限模式')
      const workspaceId = input.workspaceId as string | undefined
      if (workspaceId?.startsWith('core:')) throw new Error('工作区不属于本地Core')
      let meta
      if (input.type === 'ensure_project_draft_session') {
        if (!workspaceId) throw new Error('缺少workspaceId')
        meta = await core.ensureProjectDraftSession({ workspaceId, channelId: input.channelId as string | undefined, modelId: input.modelId as string | undefined, useCoreDefaults: true })
      } else {
        meta = await core.createSession({ useCoreDefaults: true, title: input.title as string | undefined, workspaceId,
          channelId: input.channelId as string | undefined, modelId: input.modelId as string | undefined, presetId: input.presetId as string | undefined,
          runtime: input.runtime as 'claude' | 'pi' | undefined, permissionMode: input.permissionMode as AgentSessionMeta['permissionMode'] })
      }
      current()
      const item = deps.sessionItem(meta as AgentSessionMeta)
      if (!item || typeof item !== 'object') throw new Error('Core会话投影无效')
      return { ok: true, data: { ...item, sessionId: meta.id, title: meta.title, draft: meta.draft ?? false } }
    }
    const sessionId = input.sessionId
    if (input.type === 'get_pending_interactions' && sessionId === undefined) {
      const sessions = await core.listSessions()
      current()
      const snapshots = await Promise.all(sessions.map(session => core.listPendingRequests(session.id)))
      current()
      return { ok: true, data: {
        permissions: snapshots.flatMap(snapshot => snapshot.permissions), askUsers: snapshots.flatMap(snapshot => snapshot.askUsers),
        exitPlans: snapshots.flatMap(snapshot => snapshot.exitPlans), goalProposals: snapshots.flatMap(snapshot => snapshot.goalProposals ?? []),
      } }
    }
    if (typeof sessionId !== 'string' || !sessionId || sessionId.startsWith('core:')) throw new Error('缺少本地Core会话身份')
    const expectedRevision = input.expectedRevision
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('expectedRevision 必须是非负整数')
    if (input.type === 'search_workspace_files') {
      if (input.query !== undefined && typeof input.query !== 'string') throw new Error('无效的文件搜索query')
      if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1)) throw new Error('无效的文件搜索limit')
      const result = await core.searchFiles(sessionId, typeof input.query === 'string' ? input.query : '', typeof input.limit === 'number' ? input.limit : undefined)
      current(); return { ok: true, data: result }
    }
    if (input.type === 'resolve_and_read_file' || input.type === 'read_file_as_data_url') {
      if (typeof input.filePath !== 'string' || !input.filePath) throw new Error('缺少 filePath')
      const result = await core.readFile(sessionId, input.filePath)
      current()
      const base = { resolvedPath: result.resolvedPath, version: result.version }
      return { ok: true, data: input.type === 'read_file_as_data_url' ? { ...base, dataUrl: `data:${result.mime};base64,${result.base64}` }
        : { ...base, content: Buffer.from(result.base64, 'base64').toString('utf8') } }
    }
    if (input.type === 'upload_attachment' || input.type === 'save_agent_attachment') {
      if (typeof input.filename !== 'string' || typeof input.base64 !== 'string' || !input.filename || !input.base64) throw new Error('缺少有效附件数据')
      const result = await core.saveAttachment(sessionId, input.filename, input.base64)
      current(); return { ok: true, data: result }
    }
    if (input.type === 'get_sdk_messages') {
      for (const key of ['before', 'targetMessages'] as const) {
        const value = input[key]
        if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'before' ? 0 : 1))) throw new Error(`无效的分页参数：${key}`)
      }
      const messages = await core.getMessages(sessionId) as import('@profer/shared').SDKMessage[]
      current()
      if (input.before === undefined && input.targetMessages === undefined) return { ok: true, data: messages.map(projectSdkMessageForPocket) }
      if (!deps.paginateMessages) throw new Error('Core消息分页投影未装配')
      const page = deps.paginateMessages(messages, { before: input.before as number | undefined, targetMessages: input.targetMessages as number | undefined })
      return { ok: true, data: { ...page, messages: page.messages.map(projectSdkMessageForPocket) } }
    }
    if (input.type === 'session_detail') {
      const detail = await core.getSessionDetail(sessionId)
      current()
      const messages = await core.getMessages(sessionId) as import('@profer/shared').SDKMessage[]
      current()
      const item = deps.sessionItem(detail.session as AgentSessionMeta)
      if (!item || typeof item !== 'object') throw new Error('Core会话投影无效')
      return { ok: true, data: { meta: { ...item, active: detail.active }, messages: projectSdkMessagesToPocketView(messages) } }
    }
    if (input.type === 'stop_agent') {
      const result = await core.stopAgent(sessionId)
      current()
      return { ok: true, data: result }
    }
    if (input.type === 'queue_message') {
      if (typeof input.userMessage !== 'string' || !input.userMessage.trim()) throw new Error('追加消息不能为空')
      if (input.interrupt !== undefined && typeof input.interrupt !== 'boolean') throw new Error('无效的追加消息interrupt')
      if (input.uuid !== undefined && (typeof input.uuid !== 'string' || !input.uuid.trim())) throw new Error('无效的追加消息uuid')
      for (const field of ['uuid', 'rawUserMessage'] as const) if (input[field] !== undefined && typeof input[field] !== 'string') throw new Error(`无效的追加消息字段：${field}`)
      // 现有Core队列尚不解析显式提及资源；不能吞掉这些字段后冒充已正确接收。
      for (const field of ['mentionedSkills', 'mentionedMcpServers', 'mentionedSessionIds'] as const) {
        if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length > 0)) throw new Error('Core追加消息暂不支持显式资源提及，请使用普通输入')
      }
      const result = await core.queueMessage(sessionId, input.userMessage, { uuid: input.uuid as string | undefined,
        rawUserMessage: input.rawUserMessage as string | undefined, interrupt: input.interrupt === true })
      current()
      return { ok: true, data: { accepted: true, uuid: result.messageId, runId: result.runId, taskId: result.taskId, triggerId: result.triggerId,
        ...(result.recordingError ? { recordingError: result.recordingError } : {}) } }
    }
    const pending = async () => { const result = await core.listPendingRequests(sessionId); current(); return result }
    if (input.type === 'get_pending_interactions') return { ok: true, data: await pending() }
    if (input.type.startsWith('respond_')) {
      if (typeof input.requestId !== 'string' || !input.requestId) throw new Error('缺少有效requestId')
      // 不按requestId猜运行身份，也不将Pocket连接的activeSessionId当审批授权。
      if (typeof input.runId !== 'string' || !input.runId) throw new Error('审批缺少runId，请刷新会话后重试')
      const scope = { sessionId, requestId: input.requestId, runId: input.runId }
      let handled: boolean
      if (input.type === 'respond_permission') {
        if (input.behavior !== 'allow' && input.behavior !== 'deny') throw new Error('无效的权限回答')
        handled = await core.respondPermission({ ...scope, behavior: input.behavior, alwaysAllow: input.alwaysAllow === true })
      } else if (input.type === 'respond_ask_user') {
        if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers) || Object.values(input.answers).some(value => typeof value !== 'string')) throw new Error('无效的提问回答')
        handled = await core.respondAskUser({ ...scope, answers: input.answers as Record<string, string> })
      } else {
        const action = input.action
        if (action !== 'approve_auto' && action !== 'approve_edit' && action !== 'deny' && action !== 'feedback') throw new Error('无效的计划审批回答')
        if (input.feedback !== undefined && typeof input.feedback !== 'string') throw new Error('无效的计划反馈')
        handled = await core.respondExitPlan({ ...scope, action, feedback: input.feedback as string | undefined })
      }
      current()
      if (!handled) throw new Error('Core请求不存在、身份不匹配或已处理')
      return { ok: true, data: { sessionId } }
    }
    let action: AgentSessionUiAction | undefined
    const patch: Parameters<CoreClient['updateSessionMeta']>[1] = { ...(expectedRevision !== undefined ? { expectedRevision } : {}) }
    switch (input.type) {
      case 'update_session_model':
        if (input.channelId !== undefined && (typeof input.channelId !== 'string' || !input.channelId.trim())) throw new Error('无效的渠道')
        if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !input.modelId.trim())) throw new Error('无效的模型')
        if (input.channelId === undefined && input.modelId !== undefined) throw new Error('模型必须绑定到有效渠道')
        patch.channelId = input.channelId as string | undefined; patch.modelId = input.modelId as string | undefined; break
      case 'update_session_runtime':
        if (!isAgentRuntime(input.runtime)) throw new Error('无效的Agent runtime')
        patch.agentRuntime = input.runtime; break
      case 'update_permission_mode':
        if (typeof input.mode !== 'string' || !isProferPermissionMode(input.mode)) throw new Error('无效的权限模式')
        patch.permissionMode = input.mode; break
      case 'update_session_preset':
        if (typeof input.presetId !== 'string' || !input.presetId.trim()) throw new Error('缺少presetId')
        patch.presetId = input.presetId; break
      case 'rename_session':
        if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('缺少title')
        patch.title = input.title.trim(); break
      case 'update_session_thinking_level': {
        const level = input.level
        if (level !== null && level !== 'off' && level !== 'minimal' && level !== 'low' && level !== 'medium' && level !== 'high' && level !== 'xhigh' && level !== 'max') throw new Error('无效的推理档位')
        patch.openAIThinkingLevel = level; break
      }
      case 'update_session_agent_effort': {
        const effort = input.effort
        if (effort !== null && effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'max') throw new Error('无效的推理强度')
        patch.agentEffort = effort; break
      }
      case 'toggle_session_pin': action = { type: 'toggle_pin' }; break
      case 'toggle_session_archive': action = { type: 'toggle_archive' }; break
      case 'mark_session_unread': action = { type: 'set_unread', unread: true }; break
      case 'mark_session_read': action = { type: 'set_unread', unread: false, explicit: input.explicit === true }; break
    }
    const meta = action ? await core.applySessionUiAction(sessionId, action, expectedRevision as number | undefined) : await core.updateSessionMeta(sessionId, patch)
    current()
    return { ok: true, data: deps.sessionItem(meta as AgentSessionMeta) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Core会话操作失败'
    // Pocket原有冲突结构保持不变；actualRevision只取所属Core，不能读桌面镜像。
    if (message.includes('REVISION_CONFLICT') && core && deps.getClient() === core && typeof input.sessionId === 'string'
      && typeof input.expectedRevision === 'number' && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0) {
      try {
        const meta = (await core.listSessions()).find(session => session.id === input.sessionId)
        if (meta && deps.getClient() === core && typeof meta.revision === 'number') return { ok: false, error: message,
          conflict: { code: 'REVISION_CONFLICT', expectedRevision: input.expectedRevision, actualRevision: meta.revision, sessionId: input.sessionId } }
      } catch { /* 无法取得权威版本时仍返回原冲突，不猜测版本。 */ }
    }
    return { ok: false, error: message }
  }
}
