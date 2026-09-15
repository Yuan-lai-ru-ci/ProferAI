import type { PluginRequestContext } from '@profer/plugin-api'
import { assertPluginResourceScope } from './plugin-capability-boundary'
import { pluginConfirmations } from './plugin-confirmation'
import { PluginRpcError } from './plugin-rpc-errors'
import type { WorkspaceProvider } from './ports/workspace'

let provider: WorkspaceProvider | undefined

export function configureWorkspaceProvider(next: WorkspaceProvider | undefined): void { provider = next }
export function getWorkspaceProvider(): WorkspaceProvider | undefined { return provider }

function record(context: PluginRequestContext, operation: string, resource: string, token: unknown, revision?: number): void {
  pluginConfirmations.consume(token, { pluginId: context.pluginId, pageId: context.pageId, ownerId: context.ownerId, requestId: context.requestId, operation, resource, revision })
}

function requireProvider(): WorkspaceProvider {
  if (!provider) throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '该插件能力尚未配置宿主 provider')
  return provider
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace 参数必须是对象')
  return value as Record<string, unknown>
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', `${name} 非法`)
  return value
}

export async function callWorkspaceOperation(
  operation: string,
  payload: unknown,
  context: PluginRequestContext,
  isWorkspaceAllowed: (workspaceId: string) => boolean,
): Promise<unknown> {
  const workspace = requireProvider()
  if (operation === 'workspace.list') {
    const result = await workspace.resolver.list(context.signal)
    return { ...result, items: result.items.filter((item) => isWorkspaceAllowed(item.workspaceId)) }
  }
  const input = objectPayload(payload)
  const workspaceId = stringField(input.workspaceId, 'workspaceId')
  if (operation === 'workspace.files.list') {
    const path = input.path === undefined ? undefined : stringField(input.path, 'path')
    assertPluginResourceScope(context.pluginId, 'workspace.files.read', workspaceId, path)
    return workspace.files.list({ workspaceId, path, depth: input.depth as number | undefined, signal: context.signal })
  }
  if (operation === 'workspace.files.read') {
    const path = stringField(input.path, 'path')
    assertPluginResourceScope(context.pluginId, 'workspace.files.read', workspaceId, path)
    return workspace.files.read({ workspaceId, path, maxBytes: input.maxBytes as number | undefined, signal: context.signal })
  }
  if (operation === 'workspace.files.write') {
    const path = stringField(input.path, 'path')
    assertPluginResourceScope(context.pluginId, 'workspace.files.write', workspaceId, path)
    const expectedRevision = input.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'expectedRevision 必须是非负整数')
    const mode = input.mode
    if (mode !== 'create' && mode !== 'replace') throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'write mode 非法')
    record(context, operation, `workspace:${workspaceId}/${path}`, input.confirmationId, expectedRevision as number)
    return workspace.files.write({ workspaceId, path, content: input.content as string, mode, expectedRevision: expectedRevision as number, confirmationId: input.confirmationId as string | undefined, signal: context.signal })
  }
  throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '未知的 workspace 操作')
}
