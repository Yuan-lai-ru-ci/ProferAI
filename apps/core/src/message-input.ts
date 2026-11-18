import { PROVIDER_CAPABILITIES, parseCodexCredentials, parseXaiCredentials, type ProviderType } from '@profer/shared'
import type { AgentRunContext, RuntimeCredential } from '@profer/agent-runtime'

/** 仅用于单轮请求；不能存入会话元数据、运行台账或事件。 */
export interface CoreMessageOptions {
  channelId?: string
  modelId?: string
  uuid?: string
  rawUserMessage?: string
  /** 渲染进程生成的流式开始时间戳；Core 原样回传到 runtime_started/finished。 */
  startedAt?: number
  context?: AgentRunContext
  credentials?: RuntimeCredential
}

type Trigger = AgentRunContext['trigger']
type Actor = Trigger['actor']
type Resource = NonNullable<Trigger['source']>
type Authorization = NonNullable<Trigger['authorization']>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid message options')
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('invalid message option string')
  return value
}

function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error('invalid message option type')
  return value as T
}

function actor(value: unknown): Actor {
  const input = record(value)
  return { type: choice(input.type, ['user', 'agent', 'automation', 'external', 'system', 'unknown']), ...(input.id !== undefined ? { id: text(input.id) } : {}) }
}

function resource(value: unknown): Resource {
  const input = record(value)
  const id = text(input.id)
  if (!id) throw new Error('invalid message source id')
  return { type: choice(input.type, ['task', 'run', 'session', 'message', 'automation', 'request']), id }
}

function authorization(value: unknown): Authorization {
  const input = record(value)
  return {
    kind: choice(input.kind, ['direct', 'confirmed', 'inherited', 'scheduled', 'external', 'policy']),
    ...(input.sourceRef !== undefined ? { sourceRef: resource(input.sourceRef) } : {}),
  }
}

function context(value: unknown): AgentRunContext {
  const input = record(value)
  const trigger = record(input.trigger)
  const id = text(trigger.id)
  if (!id || trigger.schemaVersion !== 1 || typeof trigger.createdAt !== 'number' || !Number.isFinite(trigger.createdAt)) throw new Error('invalid message trigger')
  return {
    trigger: {
      schemaVersion: 1, id,
      kind: choice(trigger.kind, ['user_message', 'delegation', 'automation', 'external_request', 'resume']),
      actor: actor(trigger.actor), createdAt: trigger.createdAt,
      ...(trigger.source !== undefined ? { source: resource(trigger.source) } : {}),
      ...(trigger.authorization !== undefined ? { authorization: authorization(trigger.authorization) } : {}),
    },
    ...(input.taskId !== undefined ? { taskId: text(input.taskId) } : {}),
    ...(input.messageAuthor !== undefined ? { messageAuthor: actor(input.messageAuthor) } : {}),
  }
}

function credentials(value: unknown): RuntimeCredential {
  const input = record(value)
  const provider = input.provider
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_CAPABILITIES, provider)) throw new Error('invalid credential provider')
  const apiKey = text(input.apiKey)
  if (!apiKey || typeof input.forceBearerAuth !== 'boolean') throw new Error('invalid credentials')
  const codex = input.codexOAuthCredentials === undefined ? undefined : parseCodexCredentials(JSON.stringify(input.codexOAuthCredentials))
  const xai = input.xaiOAuthCredentials === undefined ? undefined : parseXaiCredentials(JSON.stringify(input.xaiOAuthCredentials))
  if (codex === null || xai === null) throw new Error('invalid OAuth credentials')
  return {
    apiKey, provider: provider as ProviderType,
    baseUrl: text(input.baseUrl), forceBearerAuth: input.forceBearerAuth,
    ...(codex ? { codexOAuthCredentials: codex } : {}),
    ...(xai ? { xaiOAuthCredentials: xai } : {}),
    ...(input.xaiCredentialMode !== undefined ? { xaiCredentialMode: choice(input.xaiCredentialMode, ['api-key', 'oauth']) } : {}),
    ...(input.xaiApiProtocol !== undefined ? { xaiApiProtocol: choice(input.xaiApiProtocol, ['responses', 'chat-completions']) } : {}),
  }
}

/** context/credentials 是已鉴权宿主信息，不接收匿名身份声明或任意 prepared/providerInput。 */
export function parseCoreMessageOptions(body: Record<string, unknown>, authenticated: boolean): CoreMessageOptions {
  if (!authenticated && (body.credentials !== undefined || body.context !== undefined)) throw new Error('authenticated_host_required')
  const channelId = text(body.channelId)
  if (body.credentials !== undefined && !channelId) throw new Error('channel_required')
  return {
    ...(channelId !== undefined ? { channelId } : {}),
    ...(body.modelId !== undefined ? { modelId: text(body.modelId) } : {}),
    ...(body.uuid !== undefined ? { uuid: text(body.uuid) } : {}),
    ...(body.rawUserMessage !== undefined ? { rawUserMessage: text(body.rawUserMessage) } : {}),
    ...(typeof body.startedAt === 'number' && Number.isFinite(body.startedAt) && body.startedAt > 0 ? { startedAt: body.startedAt } : {}),
    ...(body.context !== undefined ? { context: context(body.context) } : {}),
    ...(body.credentials !== undefined ? { credentials: credentials(body.credentials) } : {}),
  }
}
