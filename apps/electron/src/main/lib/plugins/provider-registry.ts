import type {
  PluginCapabilityDeclaration,
  PluginCapabilityRef,
  PluginPresetCatalog,
  PluginPresetMetadata,
  PluginRequestContext,
  PluginRuntimeCapabilityView,
  PluginSecretMetadata,
  PluginSecretRef,
  PluginSessionMetadata,
} from '@profer/plugin-api'
import { assertPluginProviderScope, assertPluginResourceScope, assertPluginWorkspaceScope, isPluginProviderAllowed } from './plugin-capability-boundary'
import { pluginConfirmations } from './plugin-confirmation'
import { PluginRpcError } from './plugin-rpc-errors'
import type { PluginCapabilityProviders } from './ports/capabilities'

let providers: PluginCapabilityProviders = {}

export function configurePluginCapabilityProviders(next: PluginCapabilityProviders): void { providers = next }
export function getPluginCapabilityProviders(): PluginCapabilityProviders { return providers }
export function clearPluginCapabilityProviders(): void { providers = {} }

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件参数必须是对象')
  return value as Record<string, unknown>
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', `${field} 非法`)
  return value.trim()
}
function optionalString(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', `${field} 非法`)
  return value.trim() || undefined
}
function revision(value: unknown, field = 'expectedRevision'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', `${field} 必须是非负整数`)
  return value as number
}
function requireProvider<T>(provider: T | undefined, label: string): T {
  if (!provider) throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', `${label} provider 尚未配置`)
  return provider
}
function requireScope(context: PluginRequestContext, permission: 'sessions.read' | 'sessions.create' | 'sessions.configure' | 'sessions.control' | 'presets.read' | 'presets.switch' | 'runtime.capabilities.read' | 'runtime.capabilities.inject' | 'workspace.read', workspaceId: string): void {
  assertPluginWorkspaceScope(context.pluginId, permission, workspaceId)
}
function consumeConfirmation(context: PluginRequestContext, operation: string, resource: string, value: unknown, expectedRevision: number): void {
  pluginConfirmations.consume(value, {
    pluginId: context.pluginId,
    pageId: context.pageId,
    ownerId: context.ownerId,
    requestId: context.requestId,
    operation,
    resource,
    revision: expectedRevision,
  })
}
function assertReferences(value: unknown): PluginCapabilityRef[] {
  if (!Array.isArray(value) || value.length > 100) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'capability references 必须是有限数组')
  return value.map((entry) => {
    const record = objectPayload(entry)
    const kind = record.kind
    if (kind !== 'preset' && kind !== 'skill' && kind !== 'tool' && kind !== 'service') throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'capability kind 非法')
    const id = requiredString(record.id, 'capability id')
    const version = record.version === undefined ? undefined : revision(record.version, 'capability version')
    return { kind, id, ...(version === undefined ? {} : { version }) }
  })
}
function declaration(value: unknown): PluginCapabilityDeclaration {
  const record = objectPayload(value)
  return { references: assertReferences(record.references) }
}
function projectPreset(value: PluginPresetMetadata): PluginPresetMetadata {
  return { presetId: requiredString(value.presetId, 'presetId'), displayName: requiredString(value.displayName, 'displayName'), ...(value.description === undefined ? {} : { description: optionalString(value.description, 'description', 1000) }), version: revision(value.version, 'preset version'), enabled: value.enabled === true }
}
function projectPresetCatalog(value: PluginPresetCatalog): PluginPresetCatalog {
  return { revision: revision(value.revision, 'revision'), items: value.items.map(projectPreset) }
}
function projectSession(value: PluginSessionMetadata, expectedWorkspaceId: string, expectedSessionId?: string): PluginSessionMetadata {
  const status = value.status
  if (!['draft', 'idle', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(status)) throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'provider 返回未知 session 状态')
  if (value.runtime !== 'claude' && value.runtime !== 'pi') throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'provider 返回未知 runtime')
  const sessionId = requiredString(value.sessionId, 'sessionId')
  const returnedWorkspaceId = requiredString(value.workspaceId, 'workspaceId')
  if (returnedWorkspaceId !== expectedWorkspaceId || (expectedSessionId !== undefined && sessionId !== expectedSessionId)) {
    throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'provider 返回的 session 归属与请求不一致')
  }
  return {
    sessionId, workspaceId: returnedWorkspaceId,
    title: optionalString(value.title, 'title', 500) ?? '', status, runtime: value.runtime,
    presetId: value.presetId === null ? null : requiredString(value.presetId, 'presetId'),
    ...(value.presetVersion === undefined ? {} : { presetVersion: revision(value.presetVersion, 'presetVersion') }),
    createdAt: Number.isSafeInteger(value.createdAt) ? value.createdAt : 0,
    updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : 0,
    revision: revision(value.revision, 'revision'),
  }
}
function projectRuntime(value: PluginRuntimeCapabilityView, injection: boolean): PluginRuntimeCapabilityView {
  if (value.runtime !== 'claude' && value.runtime !== 'pi') throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'provider 返回未知 runtime')
  if (value.effectiveFrom !== 'next_turn' && value.effectiveFrom !== 'new_session') throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'provider 返回未知生效边界')
  const outcome = value.outcome
  if (outcome !== 'committed' && outcome !== 'rolled_back' && outcome !== 'unknown') {
    throw new PluginRpcError(injection ? 'PLUGIN_RUNTIME_INJECTION_FAILED' : 'PLUGIN_INVALID_ARGUMENT', 'provider 返回未知或缺失 runtime outcome')
  }
  return { snapshotId: requiredString(value.snapshotId, 'snapshotId'), fingerprint: requiredString(value.fingerprint, 'fingerprint'), runtime: value.runtime, references: assertReferences(value.references), revision: revision(value.revision, 'revision'), effectiveFrom: value.effectiveFrom, outcome }
}
function projectSecretMetadata(value: PluginSecretMetadata): PluginSecretMetadata {
  return { secretId: requiredString(value.secretId, 'secretId'), providerId: requiredString(value.providerId, 'providerId'), field: requiredString(value.field, 'field'), configured: value.configured === true, updatedAt: requiredString(value.updatedAt, 'updatedAt') }
}
function projectSecretRef(value: PluginSecretRef): PluginSecretRef {
  return { secretId: requiredString(value.secretId, 'secretId'), providerId: requiredString(value.providerId, 'providerId'), field: requiredString(value.field, 'field') }
}

export async function callSessionOrPresetOperation(operation: string, rawPayload: unknown, context: PluginRequestContext): Promise<unknown> {
  const input = objectPayload(rawPayload)
  const workspaceId = requiredString(input.workspaceId, 'workspaceId')
  if (operation === 'sessions.presets.list' || operation === 'sessions.presets.get') {
    requireScope(context, 'presets.read', workspaceId)
    const provider = requireProvider(providers.presets, 'preset')
    if (operation === 'sessions.presets.list') return projectPresetCatalog(await provider.list({ workspaceId }, context))
    const presetId = requiredString(input.presetId, 'presetId')
    return projectPreset(await provider.get({ workspaceId, presetId }, context))
  }
  const provider = requireProvider(providers.sessions, 'session')
  if (operation === 'sessions.create') {
    requireScope(context, 'sessions.create', workspaceId)
    const expectedRevision = revision(input.expectedRevision)
    consumeConfirmation(context, operation, `workspace:${workspaceId}`, input.confirmationId, expectedRevision)
    return projectSession(await provider.create({ workspaceId, presetId: input.presetId === undefined ? undefined : requiredString(input.presetId, 'presetId'), title: optionalString(input.title, 'title', 500), runtime: input.runtime === undefined ? undefined : input.runtime === 'claude' || input.runtime === 'pi' ? input.runtime : (() => { throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'runtime 非法') })(), expectedRevision }, context), workspaceId)
  }
  if (operation === 'sessions.list') {
    requireScope(context, 'sessions.read', workspaceId)
    const result = await provider.list({ workspaceId }, context)
    return { revision: revision(result.revision), items: result.items.map((item) => projectSession(item, workspaceId)) }
  }
  const sessionId = requiredString(input.sessionId, 'sessionId')
  requireScope(context, operation === 'sessions.configure' ? 'sessions.configure' : operation === 'sessions.cancel' ? 'sessions.control' : operation === 'sessions.preset.request' ? 'presets.switch' : 'sessions.read', workspaceId)
  if (operation === 'sessions.get') return projectSession(await provider.get({ workspaceId, sessionId }, context), workspaceId, sessionId)
  const expectedRevision = revision(input.expectedRevision)
  const mutationResource = `workspace:${workspaceId}/session:${sessionId}`
  if (operation === 'sessions.configure') {
    consumeConfirmation(context, operation, mutationResource, input.confirmationId, expectedRevision)
    return projectSession(await provider.configure({ workspaceId, sessionId, title: optionalString(input.title, 'title', 500), modelId: optionalString(input.modelId, 'modelId'), expectedRevision }, context), workspaceId, sessionId)
  }
  if (operation === 'sessions.preset.request') {
    const presetId = requiredString(input.presetId, 'presetId')
    consumeConfirmation(context, operation, mutationResource, input.confirmationId, expectedRevision)
    const result = await provider.requestPreset({ workspaceId, sessionId, presetId, expectedRevision }, context)
    if (result.effectiveFrom !== 'next_turn' || !result.auditEventId) throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'provider 未返回安全的 preset 变更终态')
    const returnedSessionId = requiredString(result.sessionId, 'sessionId')
    if (returnedSessionId !== sessionId) throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'provider 返回的 session 归属与请求不一致')
    return { sessionId: returnedSessionId, presetId: requiredString(result.presetId, 'presetId'), effectiveFrom: 'next_turn', revision: revision(result.revision), auditEventId: requiredString(result.auditEventId, 'auditEventId') }
  }
  if (operation === 'sessions.cancel') {
    consumeConfirmation(context, operation, mutationResource, input.confirmationId, expectedRevision)
    return projectSession(await provider.cancel({ workspaceId, sessionId, expectedRevision }, context), workspaceId, sessionId)
  }
  throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '未知的 session/preset 操作')
}

export async function callRuntimeOperation(operation: string, rawPayload: unknown, context: PluginRequestContext): Promise<unknown> {
  const input = objectPayload(rawPayload)
  const workspaceId = requiredString(input.workspaceId, 'workspaceId')
  requireScope(context, operation === 'runtime.capabilities.inject' ? 'runtime.capabilities.inject' : 'runtime.capabilities.read', workspaceId)
  const runtime: 'claude' | 'pi' = input.runtime === 'claude' || input.runtime === 'pi'
    ? input.runtime
    : (() => { throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'runtime 非法') })()
  const provider = requireProvider(providers.runtime, 'runtime capability')
  const sessionId = input.sessionId === undefined ? undefined : requiredString(input.sessionId, 'sessionId')
  const value = { workspaceId, ...(sessionId ? { sessionId } : {}), declaration: declaration(input.declaration), runtime }
  if (operation === 'runtime.capabilities.resolve') return projectRuntime(await provider.resolve(value, context), false)
  if (operation === 'runtime.capabilities.inject') {
    if (!provider.inject) throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', 'runtime injection provider 尚未配置')
    const expectedRevision = revision(input.expectedRevision)
    consumeConfirmation(context, operation, `workspace:${workspaceId}${sessionId ? `/session:${sessionId}` : ''}`, input.confirmationId, expectedRevision)
    return projectRuntime(await provider.inject({ ...value, expectedRevision }, context), true)
  }
  throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '未知的 runtime 操作')
}

export async function callSecretOperation(operation: string, rawPayload: unknown, context: PluginRequestContext): Promise<unknown> {
  const input = objectPayload(rawPayload)
  const provider = requireProvider(providers.secrets, 'secret')
  if (operation === 'secrets.metadata.list') {
    const providerId = input.providerId === undefined ? undefined : requiredString(input.providerId, 'providerId')
    if (providerId) assertPluginProviderScope(context.pluginId, 'secrets.readMetadata', providerId)
    const result = await provider.listMetadata({ providerId }, context)
    const items = result.items
      .filter((item) => isPluginProviderAllowed(context.pluginId, item.providerId, item.field))
      .map(projectSecretMetadata)
    return { revision: revision(result.revision), items }
  }
  if (operation === 'secrets.configure.request') {
    const providerId = requiredString(input.providerId, 'providerId')
    const field = requiredString(input.field, 'field')
    assertPluginProviderScope(context.pluginId, 'secrets.configure', providerId, field)
    const expectedRevision = revision(input.expectedRevision)
    consumeConfirmation(context, operation, `provider:${providerId}/field:${field}`, input.confirmationId, expectedRevision)
    return projectSecretRef(await provider.requestConfigure({ providerId, field, expectedRevision }, context))
  }
  throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '未知的 secret 操作')
}
