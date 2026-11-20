import type { Socket } from 'node:net'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentSessionMeta, ChannelCreateInput, ChannelUpdateInput } from '@profer/shared'
import type { CoreAgentRuntime, CoreEvent } from './runtime'
import { CORE_ATTACHMENT_BODY_MAX_BYTES } from './core-attachment-service'
import { attachCoreWebSocketGateway } from './gateway'
import { parseCoreMessageOptions } from './message-input'
import { discoverCoreModels, testCoreChannel } from './channel-probe'
import { describeCoreDebugState, resetCoreSessionData, type CoreDebugOptions } from './debug'
import { executeCorePlanningOperation } from './planning-operations'
import { CORE_HOST_CAPABILITIES } from './host-capabilities'
import { createCoreDirectory, describeCoreFileSystem, listCoreDirectories, planCoreProject, probeCoreDirectory } from './core-fs-service'
import { buildAgentSessionUiProjection, PLANNING_CONFLICT_ERROR, PROVIDER_CAPABILITIES } from '@profer/shared'

export interface CoreHealth {
  status: 'ok'
  service: 'profer-core'
  version: string
}

export interface CoreServerOptions {
  version: string
  runtime?: CoreAgentRuntime
  apiKey?: string
  coreId?: string
  onEvent?: (event: CoreEvent) => void
  /** 仅 PROFER_CORE_DEBUG=1 时传入；不存在时不挂载 /debug/*。 */
  debug?: CoreDebugOptions
}

interface Subscriber {
  sessionId: string
  response: ServerResponse
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(payload))
  response.end(payload)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return readBoundedJson(request, 4 * 1024 * 1024, 'Core')
}

class BoundedBodyError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message) }
}

/** 读取期间限制字节总量；只对显式调用方启用，不改变消息/图片接口契约。 */
function readBoundedJson(request: IncomingMessage, maxBytes: number, label: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      request.off('data', onData); request.off('end', onEnd)
      request.off('error', onError); request.off('aborted', onAborted)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      chunks.length = 0
      cleanup()
      // 响应错误后仍可能收到socket reset，不能让未监听的流error成为进程异常。
      request.once('error', () => {})
      request.resume(); reject(error)
    }
    const onError = (error: Error): void => fail(error)
    const onAborted = (): void => fail(new BoundedBodyError(`${label} request aborted`, 400))
    const onData = (chunk: Buffer): void => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) { fail(new BoundedBodyError(`${label} request body too large`, 413)); return }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        const value: unknown = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be a JSON object')
        resolve(value as Record<string, unknown>)
      } catch (error) { reject(error) }
    }
    const timer = setTimeout(() => fail(new BoundedBodyError(`${label} request body timed out`, 408)), 30_000)
    const declaredLength = request.headers['content-length']
    if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
      fail(new BoundedBodyError(`${label} request body too large`, 413))
      return
    }
    request.on('data', onData); request.once('end', onEnd)
    request.once('error', onError); request.once('aborted', onAborted)
  })
}

function readPlanningJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return readBoundedJson(request, 1024 * 1024, 'Planning')
}

function authorized(request: IncomingMessage, apiKey?: string): boolean {
  if (!apiKey) return true
  return request.headers.authorization === `Bearer ${apiKey}`
}

function sessionIdFromPath(pathname: string, suffix: string): string | undefined {
  const prefix = '/sessions/'
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined
  const value = pathname.slice(prefix.length, pathname.length - suffix.length)
  return value || undefined
}

function sendEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export function createCoreServer(options: CoreServerOptions): Server {
  const subscribers = new Set<Subscriber>()
  const runtime = options.runtime
  const emit = (event: CoreEvent): void => {
    options.onEvent?.(event)
    for (const subscriber of subscribers) {
      if (subscriber.sessionId === event.sessionId) sendEvent(subscriber.response, event)
    }
  }
  const unsubscribe = runtime?.subscribe(emit)

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'profer-core', version: options.version } satisfies CoreHealth)
      return
    }
    if (!authorized(request, options.apiKey)) {
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/identity') {
      sendJson(response, 200, {
        protocolVersion: 1,
        coreId: options.coreId ?? 'test-core',
        version: options.version,
        /** 所属 Core 的运行平台；桌面据此决定路径文案和“本机/对面”行为。 */
        platform: process.platform,
        hostCapabilities: CORE_HOST_CAPABILITIES,
        capabilities: ['sessions.read', 'sessions.write', 'workspaces.read', 'workspaces.write', 'agent.pi', 'agent.events', 'agent.stop', 'planning', 'automation', 'delegation', 'agent.events.resume', 'resources.manage', ...(runtime?.chat ? ['chat'] : [])],
      })
      return
    }
    if (!runtime) {
      if (request.method === 'GET' && url.pathname !== '/health') sendJson(response, 404, { error: 'not_found' })
      else sendJson(response, 503, { error: 'runtime_unavailable' })
      return
    }
    try {
      if (request.method === 'POST' && url.pathname === '/chat/operations') {
        const body = await readBoundedJson(request, CORE_ATTACHMENT_BODY_MAX_BYTES, 'Core Chat')
        if (typeof body.operation !== 'string' || !Array.isArray(body.args)) throw new Error('Core Chat操作或参数无效')
        const result = await runtime.chat.operation(body.operation, body.args)
        sendJson(response, 200, { result: result ?? null })
        return
      }
      if (request.method === 'POST' && url.pathname === '/resources/operations') {
        const body = await readBoundedJson(request, 2 * 1024 * 1024, 'Core resources')
        if (typeof body.operation !== 'string' || !Array.isArray(body.args)) throw new Error('Core资源操作或参数无效')
        const result = await runtime.resourceOperation({ operation: body.operation, args: body.args })
        sendJson(response, 200, { result: result ?? null })
        return
      }
      if (request.method === 'POST' && url.pathname === '/planning/operations') {
        try {
          const body = await readPlanningJson(request)
          const result = executeCorePlanningOperation(runtime, body)
          sendJson(response, 200, { result })
          if (typeof body.operation === 'string' && !/^(list|get)/.test(body.operation)) {
            runtime.publish({ type: 'planning', sessionId: '', payload: { type: 'changed', resources: ['todos', 'calendar_events', 'todo_groups', 'calendar_groups', 'tags', 'reminders'] } })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(response, error instanceof BoundedBodyError ? error.statusCode : message === PLANNING_CONFLICT_ERROR ? 409 : 400, { error: message })
        }
        return
      }
      if (options.debug && request.method === 'GET' && url.pathname === '/debug/state') {
        sendJson(response, 200, describeCoreDebugState(runtime, options.debug))
        return
      }
      if (options.debug && request.method === 'POST' && url.pathname === '/debug/reset') {
        const body = await readJson(request)
        if (body.confirm !== 'reset') { sendJson(response, 400, { error: 'confirm_required' }); return }
        sendJson(response, 200, { reset: true, ...resetCoreSessionData(options.debug.configDir) })
        return
      }
      if (request.method === 'POST' && url.pathname === '/channels/discover') {
        const body = await readJson(request)
        if (typeof body.provider !== 'string' || !Object.hasOwn(PROVIDER_CAPABILITIES, body.provider) || typeof body.baseUrl !== 'string' || typeof body.apiKey !== 'string') {
          sendJson(response, 400, { error: 'invalid_probe_input' }); return
        }
        sendJson(response, 200, await discoverCoreModels(body as unknown as import('@profer/shared').FetchModelsInput))
        return
      }
      if (request.method === 'POST' && url.pathname === '/channels/test') {
        const body = await readJson(request)
        if (typeof body.provider !== 'string' || !Object.hasOwn(PROVIDER_CAPABILITIES, body.provider) || typeof body.baseUrl !== 'string' || typeof body.apiKey !== 'string') {
          sendJson(response, 400, { error: 'invalid_probe_input' }); return
        }
        sendJson(response, 200, await testCoreChannel(body as unknown as import('@profer/shared').FetchModelsInput))
        return
      }
      if (request.method === 'GET' && url.pathname === '/channels') {
        sendJson(response, 200, { channels: runtime.channels.map(channel => ({
          ...channel,
          models: channel.models ?? [],
          enabled: channel.enabled !== false,
        })) })
        return
      }
      if (request.method === 'POST' && url.pathname === '/channels') {
        const body = await readJson(request)
        if (typeof body.name !== 'string' || typeof body.provider !== 'string' || !Object.hasOwn(PROVIDER_CAPABILITIES, body.provider) || typeof body.apiKey !== 'string') {
          sendJson(response, 400, { error: 'invalid_channel' }); return
        }
        const created = runtime.createChannel({
          name: body.name.trim(), provider: body.provider as ChannelCreateInput['provider'], apiKey: body.apiKey,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
          ...(typeof body.agentBaseUrl === 'string' ? { agentBaseUrl: body.agentBaseUrl } : {}),
          ...(body.credentialMode === 'api-key' || body.credentialMode === 'oauth' ? { credentialMode: body.credentialMode } : {}),
          ...(body.apiProtocol === 'responses' || body.apiProtocol === 'chat-completions' ? { apiProtocol: body.apiProtocol } : {}),
          ...(typeof body.agentExperimentalEnabled === 'boolean' ? { agentExperimentalEnabled: body.agentExperimentalEnabled } : {}),
          ...(Array.isArray(body.agentRuntimes) ? { agentRuntimes: body.agentRuntimes.filter((item): item is 'claude' | 'pi' => item === 'claude' || item === 'pi') } : {}),
          models: Array.isArray(body.models) ? body.models.filter((model): model is NonNullable<ChannelCreateInput['models']>[number] => Boolean(model && typeof model.id === 'string' && typeof model.name === 'string' && typeof model.enabled === 'boolean')) : [],
          enabled: body.enabled !== false,
        })
        const { apiKey: _apiKey, codexOAuthCredentials: _codex, xaiOAuthCredentials: _xai, ...safe } = created
        sendJson(response, 201, safe)
        return
      }
      if (url.pathname.startsWith('/channels/')) {
        const id = decodeURIComponent(url.pathname.slice('/channels/'.length))
        if (!id) { sendJson(response, 400, { error: 'channel_id_required' }); return }
        if (request.method === 'DELETE') {
          runtime.deleteChannel(id)
          sendJson(response, 204, {})
          return
        }
        if (request.method === 'PATCH' || request.method === 'PUT') {
          const body = await readJson(request)
          const patch: Partial<import('./config').CoreChannelConfig> = {}
          for (const field of ['name', 'baseUrl', 'agentBaseUrl'] as const) if (typeof body[field] === 'string') patch[field] = body[field] as string
          if (typeof body.apiKey === 'string' && body.apiKey) patch.apiKey = body.apiKey
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (typeof body.agentExperimentalEnabled === 'boolean') patch.agentExperimentalEnabled = body.agentExperimentalEnabled
          if (body.credentialMode === 'api-key' || body.credentialMode === 'oauth') patch.credentialMode = body.credentialMode
          if (body.apiProtocol === 'responses' || body.apiProtocol === 'chat-completions') patch.apiProtocol = body.apiProtocol
          if (Array.isArray(body.agentRuntimes)) patch.agentRuntimes = body.agentRuntimes.filter((item): item is 'claude' | 'pi' => item === 'claude' || item === 'pi')
          if (Array.isArray(body.models)) patch.models = body.models.filter((model): model is NonNullable<ChannelCreateInput['models']>[number] => Boolean(model && typeof model.id === 'string' && typeof model.name === 'string' && typeof model.enabled === 'boolean'))
          const updated = runtime.updateChannel(id, patch)
          const { apiKey: _apiKey, codexOAuthCredentials: _codex, xaiOAuthCredentials: _xai, ...safe } = updated
          sendJson(response, 200, safe)
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/workspaces') {
        sendJson(response, 200, { workspaces: runtime.workspaces.list() })
        return
      }
      if (request.method === 'POST' && url.pathname === '/workspaces') {
        const body = await readJson(request)
        const workspace = runtime.workspaces.createManaged(typeof body.name === 'string' ? body.name : '')
        sendJson(response, 201, workspace)
        return
      }
      if (request.method === 'POST' && url.pathname === '/workspaces/projects') {
        const body = await readJson(request)
        const result = runtime.workspaces.bindProject({
          rootPath: typeof body.rootPath === 'string' ? body.rootPath : '',
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          open: body.open === true,
        })
        runtime.automations.workspaceBindingsChanged()
        sendJson(response, result.created ? 201 : 200, result)
        return
      }
      if (request.method === 'GET' && url.pathname === '/sessions') {
        sendJson(response, 200, { sessions: runtime.sessions.list() })
        return
      }
      if (request.method === 'POST' && (url.pathname === '/sessions' || url.pathname === '/sessions/configured')) {
        const body = await readJson(request)
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
        if (!workspaceId) { sendJson(response, 400, { error: 'workspace_id_required' }); return }
        if (!runtime.workspaces.list().some(workspace => workspace.id === workspaceId)) {
          sendJson(response, 404, { error: 'workspace_not_found' }); return
        }
        if (body.useCoreDefaults !== undefined && typeof body.useCoreDefaults !== 'boolean') throw new Error('invalid useCoreDefaults')
        if (url.pathname === '/sessions/configured' || body.useCoreDefaults === true) {
          for (const key of ['title', 'workspaceId', 'channelId', 'modelId', 'presetId', 'runtime', 'permissionMode'] as const) {
            if (body[key] !== undefined && typeof body[key] !== 'string') throw new Error(`invalid ${key}`)
          }
          if (body.runtime !== undefined && body.runtime !== 'claude' && body.runtime !== 'pi') throw new Error('invalid runtime')
          if (body.permissionMode !== undefined && body.permissionMode !== 'auto' && body.permissionMode !== 'plan' && body.permissionMode !== 'bypassPermissions') throw new Error('invalid permission mode')
          const session = runtime.createConfiguredSession({ title: body.title as string | undefined, workspaceId,
            channelId: body.channelId as string | undefined, modelId: body.modelId as string | undefined, presetId: body.presetId as string | undefined,
            runtime: body.runtime as 'claude' | 'pi' | undefined, permissionMode: body.permissionMode as AgentSessionMeta['permissionMode'] })
          sendJson(response, 201, session)
          return
        }
        const requestedRuntime = body.runtime === 'claude' || body.runtime === 'pi' ? body.runtime : undefined
        const session = runtime.sessions.create({
          title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New session',
          ...(requestedRuntime ? { runtime: requestedRuntime } : {}),
          modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
          channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
          workspaceId,
          presetId: typeof body.presetId === 'string' ? body.presetId : undefined,
          presetReference: body.presetReference && typeof body.presetReference === 'object' ? body.presetReference as AgentSessionMeta['presetReference'] : undefined,
          permissionMode: body.permissionMode === 'auto' || body.permissionMode === 'plan' || body.permissionMode === 'bypassPermissions' ? body.permissionMode : undefined,
        })
        sendJson(response, 201, session)
        return
      }
      if (request.method === 'POST' && url.pathname === '/workspaces/projects/relocate') {
        const body = await readJson(request)
        if (typeof body.id !== 'string' || !body.id || typeof body.rootPath !== 'string') throw new Error('项目重新定位参数无效')
        const relocated = runtime.workspaces.relocateProject({ id: body.id, rootPath: body.rootPath })
        runtime.automations.workspaceBindingsChanged()
        sendJson(response, 200, relocated)
        return
      }
      if (request.method === 'POST' && url.pathname === '/workspaces/reorder') {
        const body = await readJson(request)
        if (!Array.isArray(body.orderedIds) || body.orderedIds.some(id => typeof id !== 'string')) throw new Error('工作区排序ID无效')
        sendJson(response, 200, { workspaces: runtime.workspaces.reorder(body.orderedIds as string[]) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/automation-project-mirrors') {
        sendJson(response, 200, { mirrors: runtime.automations.projectMirrorStatuses() })
        return
      }
      if (request.method === 'POST' && url.pathname === '/automation-project-mirrors/retry') {
        runtime.automations.retryProjectMirrors()
        sendJson(response, 200, { mirrors: runtime.automations.projectMirrorStatuses() })
        return
      }
      if (request.method === 'GET' && url.pathname === '/workspace-deletions') {
        sendJson(response, 200, { operations: runtime.listWorkspaceDeleteOperations().map(item => ({ operationId: item.operationId, workspaceId: item.workspace.id,
          workspaceName: item.workspace.name, status: item.status, revision: item.revision, requestedAt: item.requestedAt,
          sessionCount: item.sessionIds.length, automationCount: item.automationIds.length, ...(item.error ? { error: item.error } : {}) })) })
        return
      }
      if (request.method === 'POST' && url.pathname === '/workspaces/delete/retry') {
        const body = await readJson(request)
        if (typeof body.operationId !== 'string' || !body.operationId) throw new Error('工作区删除operationId无效')
        await runtime.retryWorkspaceDelete(body.operationId)
        sendJson(response, 204, {})
        return
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/workspaces/projects/')) {
        const id = decodeURIComponent(url.pathname.slice('/workspaces/projects/'.length))
        if (!id) { sendJson(response, 400, { error: 'workspace_id_required' }); return }
        await runtime.deleteWorkspace(id, { projectOnly: true })
        sendJson(response, 204, {})
        return
      }
      if (request.method === 'PATCH' && url.pathname.startsWith('/workspaces/')) {
        const id = decodeURIComponent(url.pathname.slice('/workspaces/'.length))
        if (!id) { sendJson(response, 400, { error: 'workspace_id_required' }); return }
        const body = await readJson(request)
        if (body.name !== undefined && typeof body.name !== 'string') throw new Error('invalid workspace name')
        if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new Error('invalid workspace archived')
        sendJson(response, 200, runtime.updateWorkspace(id, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) }))
        return
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/workspaces/')) {
        const id = decodeURIComponent(url.pathname.slice('/workspaces/'.length))
        if (!id) { sendJson(response, 400, { error: 'workspace_id_required' }); return }
        await runtime.deleteWorkspace(id)
        sendJson(response, 204, {})
        return
      }
      if (request.method === 'POST' && (url.pathname === '/project-draft-sessions' || url.pathname === '/project-draft-sessions/configured')) {
        const body = await readJson(request)
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
        if (!workspaceId || !runtime.workspaces.list().some(workspace => workspace.id === workspaceId)) {
          sendJson(response, 404, { error: 'workspace_not_found' }); return
        }
        for (const field of ['channelId', 'modelId'] as const) {
          if (body[field] !== undefined && typeof body[field] !== 'string') throw new Error(`invalid ${field}`)
        }
        if (body.useCoreDefaults !== undefined && typeof body.useCoreDefaults !== 'boolean') throw new Error('invalid useCoreDefaults')
        const session = runtime.ensureProjectDraftSession({ workspaceId,
          useCoreDefaults: url.pathname === '/project-draft-sessions/configured' || body.useCoreDefaults === true,
          channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
          modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        })
        sendJson(response, 200, session)
        return
      }
      if (request.method === 'POST' && url.pathname === '/workspace-sessions') {
        const body = await readJson(request)
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
        if (!workspaceId || !runtime.workspaces.list().some(workspace => workspace.id === workspaceId)) {
          sendJson(response, 404, { error: 'workspace_not_found' }); return
        }
        const session = runtime.ensureWorkspaceSession({
          workspaceId,
          channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
          modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        })
        sendJson(response, 200, session)
        return
      }
      if (request.method === 'PATCH' && url.pathname.startsWith('/sessions/')) {
        const sessionId = sessionIdFromPath(url.pathname, '')
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        const body = await readJson(request)
        const patch: Parameters<CoreAgentRuntime['updateSessionMeta']>[1] = {}
        if (typeof body.channelId === 'string' || body.channelId === null) patch.channelId = body.channelId || undefined
        if (typeof body.modelId === 'string' || body.modelId === null) patch.modelId = body.modelId || undefined
        if (body.presetId !== undefined) {
          if (typeof body.presetId !== 'string' || !body.presetId.trim()) throw new Error('预设ID不能为空')
          patch.presetId = body.presetId.trim()
        }
        if (body.presetReference !== undefined) {
          if (!body.presetReference || typeof body.presetReference !== 'object' || Array.isArray(body.presetReference)) throw new Error('无效的预设引用')
          patch.presetReference = body.presetReference as AgentSessionMeta['presetReference']
        }
        if (body.agentRuntime !== undefined) {
          if (body.agentRuntime !== 'claude' && body.agentRuntime !== 'pi') throw new Error('无效的 Agent runtime')
          patch.agentRuntime = body.agentRuntime
        }
        if (body.permissionMode === 'auto' || body.permissionMode === 'plan' || body.permissionMode === 'bypassPermissions') patch.permissionMode = body.permissionMode
        if (body.permissionMode !== undefined && !['auto', 'plan', 'bypassPermissions'].includes(String(body.permissionMode))) throw new Error('invalid permission mode')
        if (body.codexFastMode !== undefined) {
          if (typeof body.codexFastMode !== 'boolean') throw new Error('无效的 Codex Fast Mode 状态')
          patch.codexFastMode = body.codexFastMode
        }
        if (body.openAIThinkingLevel !== undefined) {
          const levels = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
          if (body.openAIThinkingLevel !== null && (typeof body.openAIThinkingLevel !== 'string' || !levels.includes(body.openAIThinkingLevel as typeof levels[number]))) throw new Error('无效的推理档位')
          patch.openAIThinkingLevel = body.openAIThinkingLevel as AgentSessionMeta['openAIThinkingLevel']
        }
        if (body.agentEffort !== undefined) {
          const efforts = [null, 'low', 'medium', 'high', 'max'] as const
          if (body.agentEffort !== null && (typeof body.agentEffort !== 'string' || !efforts.includes(body.agentEffort as typeof efforts[number]))) throw new Error('无效的推理强度')
          patch.agentEffort = body.agentEffort as AgentSessionMeta['agentEffort']
        }
        if (body.title !== undefined) {
          if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw new Error('无效的会话标题')
          patch.title = body.title.trim()
        }
        if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0)) throw new Error('invalid expected revision')
        const updated = await runtime.updateSessionMeta(sessionId, patch, body.expectedRevision as number | undefined)
        sendJson(response, 200, updated)
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/attachments')) {
        const sessionId = sessionIdFromPath(url.pathname, '/attachments')
        if (!sessionId || !runtime.sessions.getMeta(sessionId)) { sendJson(response, 404, { error: 'session_not_found' }); return }
        const body = await readBoundedJson(request, CORE_ATTACHMENT_BODY_MAX_BYTES, 'Attachment')
        if (typeof body.filename !== 'string' || typeof body.base64 !== 'string') throw new Error('invalid attachment')
        sendJson(response, 201, runtime.saveAttachment(sessionId, body.filename, body.base64))
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/detail')) {
        const sessionId = sessionIdFromPath(url.pathname, '/detail')
        const session = sessionId ? runtime.sessions.getMeta(sessionId) : undefined
        if (!session || runtime.deletions.isDeleting(session.id)) { sendJson(response, 404, { error: 'session_not_found' }); return }
        sendJson(response, 200, { session: buildAgentSessionUiProjection(session), active: Boolean(runtime.coordinator.ownership.getOwner(session.id)) })
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/search')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/search')
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        const query = url.searchParams.get('query') ?? ''
        const rawLimit = Number(url.searchParams.get('limit') ?? '200')
        sendJson(response, 200, runtime.searchFiles(sessionId, query, Number.isFinite(rawLimit) ? rawLimit : 200))
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/read')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/read')
        const filePath = url.searchParams.get('path') ?? ''
        if (!sessionId || !filePath) { sendJson(response, 400, { error: 'file_path_required' }); return }
        const result = runtime.readFile(sessionId, filePath)
        if (!result) { sendJson(response, 404, { error: 'file_not_found' }); return }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/roots')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/roots')
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        sendJson(response, 200, runtime.describeFileRoots(sessionId))
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/rename')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/rename')
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        const body = await readJson(request)
        sendJson(response, 200, runtime.renameSessionEntry(sessionId, typeof body.path === 'string' ? body.path : '', typeof body.name === 'string' ? body.name : ''))
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/move')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/move')
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        const body = await readJson(request)
        sendJson(response, 200, runtime.moveSessionEntry(sessionId, typeof body.path === 'string' ? body.path : '', typeof body.toDir === 'string' ? body.toDir : '', body.overwrite === true))
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/copy')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/copy')
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        const body = await readJson(request)
        sendJson(response, 200, runtime.copySessionEntry(sessionId, typeof body.path === 'string' ? body.path : '', typeof body.toDir === 'string' ? body.toDir : '', body.overwrite === true))
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/trash')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/trash')
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        const body = await readJson(request)
        sendJson(response, 200, runtime.trashSessionEntry(sessionId, typeof body.path === 'string' ? body.path : ''))
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/preview')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/preview')
        const filePath = url.searchParams.get('path') ?? ''
        if (!sessionId || !filePath) { sendJson(response, 400, { error: 'file_path_required' }); return }
        const result = runtime.previewSessionFile(sessionId, filePath)
        if (!result) { sendJson(response, 415, { error: 'unsupported_preview' }); return }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/files/entries')) {
        const sessionId = sessionIdFromPath(url.pathname, '/files/entries')
        const dirPath = url.searchParams.get('path') ?? ''
        if (!sessionId) { sendJson(response, 400, { error: 'session_id_required' }); return }
        if (!dirPath) { sendJson(response, 400, { error: 'path_required' }); return }
        sendJson(response, 200, { entries: runtime.listDirectoryEntries(sessionId, dirPath) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/fs/roots') {
        sendJson(response, 200, describeCoreFileSystem())
        return
      }
      if (request.method === 'GET' && url.pathname === '/fs/entries') {
        sendJson(response, 200, listCoreDirectories(url.searchParams.get('path') ?? '', url.searchParams.get('includeFiles') === '1'))
        return
      }
      if (request.method === 'POST' && url.pathname === '/fs/rename') {
        const body = await readJson(request)
        sendJson(response, 200, runtime.renameSystemEntry(typeof body.path === 'string' ? body.path : '', typeof body.name === 'string' ? body.name : ''))
        return
      }
      if (request.method === 'POST' && url.pathname === '/fs/move') {
        const body = await readJson(request)
        sendJson(response, 200, runtime.moveSystemEntry(typeof body.path === 'string' ? body.path : '', typeof body.toDir === 'string' ? body.toDir : '', body.overwrite === true))
        return
      }
      if (request.method === 'POST' && url.pathname === '/fs/copy') {
        const body = await readJson(request)
        sendJson(response, 200, runtime.copySystemEntry(typeof body.path === 'string' ? body.path : '', typeof body.toDir === 'string' ? body.toDir : '', body.overwrite === true))
        return
      }
      if (request.method === 'POST' && url.pathname === '/fs/trash') {
        const body = await readJson(request)
        sendJson(response, 200, runtime.trashSystemEntry(typeof body.path === 'string' ? body.path : ''))
        return
      }
      if (request.method === 'GET' && url.pathname === '/fs/preview') {
        const result = runtime.previewSystemFile(url.searchParams.get('path') ?? '')
        if (!result) { sendJson(response, 415, { error: 'unsupported_preview' }); return }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && url.pathname === '/fs/probe') {
        sendJson(response, 200, probeCoreDirectory(url.searchParams.get('path') ?? ''))
        return
      }
      if (request.method === 'POST' && url.pathname === '/fs/plan') {
        const body = await readJson(request)
        sendJson(response, 200, planCoreProject({
          basePath: typeof body.basePath === 'string' ? body.basePath : '',
          ...(typeof body.projectName === 'string' ? { projectName: body.projectName } : {}),
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/fs/dirs') {
        const body = await readJson(request)
        sendJson(response, 201, createCoreDirectory(typeof body.path === 'string' ? body.path : ''))
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/messages')) {
        const sessionId = sessionIdFromPath(url.pathname, '/messages')
        const session = sessionId ? runtime.sessions.getMeta(sessionId) : undefined
        if (!session) { sendJson(response, 404, { error: 'session_not_found' }); return }
        sendJson(response, 200, { messages: runtime.sessions.readMessages(session.id) })
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/events')) {
        const sessionId = sessionIdFromPath(url.pathname, '/events')
        if (!sessionId || !runtime.sessions.getMeta(sessionId)) { sendJson(response, 404, { error: 'session_not_found' }); return }
        response.statusCode = 200
        response.setHeader('content-type', 'text/event-stream; charset=utf-8')
        response.setHeader('cache-control', 'no-cache')
        response.setHeader('connection', 'keep-alive')
        response.flushHeaders()
        const subscriber = { sessionId, response }
        subscribers.add(subscriber)
        response.on('close', () => subscribers.delete(subscriber))
        sendEvent(response, { type: 'ready', sessionId })
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/messages')) {
        const sessionId = sessionIdFromPath(url.pathname, '/messages')
        const session = sessionId ? runtime.sessions.getMeta(sessionId) : undefined
        if (!session) { sendJson(response, 404, { error: 'session_not_found' }); return }
        const body = await readJson(request)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (!prompt) { sendJson(response, 400, { error: 'prompt_required' }); return }
        const input = parseCoreMessageOptions(body, Boolean(options.apiKey))
        const actor = input.context?.trigger.actor.type
        const initiator = actor === 'automation' ? 'automation' : actor === 'agent' ? 'delegation' : actor === 'system' ? 'external' : 'user'
        runtime.assertAcceptingRuns()
        if (initiator === 'user' || initiator === 'external') await runtime.goals.prepareUserTurn(session.id)
        runtime.assertAcceptingRuns()
        const ownershipToken = Symbol(`core-http-message:${session.id}`)
        let settleAdmission!: (failure?: string) => void
        const admission = new Promise<string | undefined>(resolve => { settleAdmission = resolve })
        const handle = runtime.coordinator.run({ ...runtime.createQuery(session, prompt, input), initiator, ownershipToken }, {
          onEvent() {},
          onRunStarted() { settleAdmission() },
          onPreparationFailure(failure) { settleAdmission(failure.message) },
          onComplete(outcome) { settleAdmission(outcome.status === 'failed' ? outcome.error : undefined) },
          onError() {},
        })
        // 占用登记在 run() 内同步取得：持有者不是本次请求的 token，说明这一轮根本没启动
        // （典型是同一会话已有活跃运行）。这种请求不能回 202，否则桌面会把界面留在“运行中”，
        // 且永远等不到终态事件。
        if (runtime.coordinator.ownership.getOwner(session.id)?.token !== ownershipToken) {
          const failure = await handle.promise.then(() => undefined, (error: unknown) => error)
          sendJson(response, 409, { error: failure instanceof Error ? failure.message : '运行未能启动' })
          return
        }
        void handle.promise.then(outcome => settleAdmission(outcome.status === 'failed' ? outcome.error : undefined), error => settleAdmission(error instanceof Error ? error.message : String(error)))
        const preparationError = await admission
        if (preparationError) { sendJson(response, 400, { error: preparationError }); return }
        sendJson(response, 202, { accepted: true, sessionId: session.id })
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/stop')) {
        const sessionId = sessionIdFromPath(url.pathname, '/stop')
        if (!sessionId || !runtime.sessions.getMeta(sessionId)) { sendJson(response, 404, { error: 'session_not_found' }); return }
        // 与 WebSocket 的 stop_agent 同一判定：有活跃运行或活跃 Goal 才算“真的停到了东西”。
        // 无运行却回 stopped:true 会让桌面停在“停止中”，等一个不会到来的终态事件。
        const stopped = Boolean(runtime.coordinator.ownership.getOwner(sessionId))
          || runtime.goals.list(sessionId).some(goal => goal.status === 'active' || goal.status === 'stopping')
        await runtime.stopDelegationsForParent(sessionId)
        const pausedGoal = runtime.goals.pauseSessionForInterrupt(sessionId)
        if (pausedGoal) await pausedGoal
        else await runtime.coordinator.stopAndWait(sessionId)
        sendJson(response, 202, { stopped, sessionId })
        return
      }
      sendJson(response, 404, { error: 'not_found' })
    } catch (error) {
      if (response.destroyed || response.writableEnded) return
      if (error instanceof BoundedBodyError) response.setHeader('connection', 'close')
      sendJson(response, error instanceof BoundedBodyError ? error.statusCode : 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  // HTTP close 不会回收已升级的 WebSocket；统一追踪底层连接以关闭准入。
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  coreServerSockets.set(server, sockets)
  if (runtime) coreServerBeginShutdown.set(server, () => runtime.beginShutdown())
  if (options.runtime && options.apiKey) attachCoreWebSocketGateway({ server, runtime: options.runtime, token: options.apiKey })
  return server
}

export function listenCoreServer(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
    const onListening = (): void => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

const coreServerBeginShutdown = new WeakMap<Server, () => void>()
const coreServerSockets = new WeakMap<Server, Set<Socket>>()
const coreServerClosures = new WeakMap<Server, Promise<void>>()

export function closeCoreServer(server: Server): Promise<void> {
  coreServerBeginShutdown.get(server)?.()
  const pending = coreServerClosures.get(server)
  if (pending) return pending
  if (!server.listening) return Promise.resolve()
  const closed = new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    // 先停止监听，再断开传输；运行的取消与持久化由 runtime.shutdown 等待。
    for (const socket of coreServerSockets.get(server) ?? []) socket.destroy()
  })
  coreServerClosures.set(server, closed)
  return closed
}
