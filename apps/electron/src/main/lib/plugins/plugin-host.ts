import type { ProferPluginPermission, ProferPluginRpcRequest, ProferPluginTaskReference, PluginRequestContext } from '@profer/plugin-api'
import { assertPluginPermission } from './plugin-permissions'
import { listPluginModels, generatePluginModel } from './plugin-models'
import { getPluginRoutingRules, setPluginRoutingRules } from './plugin-routing'
import { fetchPluginNetwork } from './plugin-network'
import { readPluginTaskContext, selectPluginAttachments } from './plugin-context'
import { fetchSchema, generateSchema, requestIdSchema } from './plugin-capabilities'
import { pluginRequests } from './plugin-requests'
import { PluginRpcError } from './plugin-rpc-errors'
import { callWorkspaceOperation } from './workspace-provider'
import { isPluginWorkspaceAllowed } from './plugin-capability-boundary'
import { callRuntimeOperation, callSecretOperation, callSessionOrPresetOperation, getPluginCapabilityProviders } from './provider-registry'
import { assertFloatingPageAllowed, pluginFloatingWindowManager } from './plugin-floating-window'

const floatingWindowPermissions: Record<string, ProferPluginPermission> = {
  'window.floating.open': 'window.floating',
  'window.floating.show': 'window.floating',
  'window.floating.hide': 'window.floating',
  'window.floating.close': 'window.floating',
  // RPC operation 只允诺小写/连字符（plugin-host-rpc 校验）；camelCase 由 preload 侧映射。
  'window.floating.is-visible': 'window.floating',
  'window.floating.get-bounds': 'window.floating',
  'window.floating.set-bounds': 'window.floating',
  'window.floating.set-ignore-mouse-events': 'window.floating',
}

const permissions: Record<string, ProferPluginPermission> = {
  'models.list': 'models.read', 'models.generate': 'models.invoke', 'routing.get': 'modelRouting.rules.write',
  'routing.set': 'modelRouting.rules.write', 'context.read': 'context.read', 'attachments.select': 'attachments.read', 'network.fetch': 'network.fetch',
  'workspace.list': 'workspace.read', 'workspace.files.list': 'workspace.files.read', 'workspace.files.read': 'workspace.files.read', 'workspace.files.write': 'workspace.files.write',
  'sessions.presets.list': 'presets.read', 'sessions.presets.get': 'presets.read', 'sessions.list': 'sessions.read', 'sessions.get': 'sessions.read',
  'sessions.create': 'sessions.create', 'sessions.configure': 'sessions.configure', 'sessions.preset.request': 'presets.switch', 'sessions.cancel': 'sessions.control',
  'runtime.capabilities.resolve': 'runtime.capabilities.read', 'runtime.capabilities.inject': 'runtime.capabilities.inject', 'secrets.metadata.list': 'secrets.readMetadata', 'secrets.configure.request': 'secrets.configure',
  ...floatingWindowPermissions,
}

/** 统一 RPC dispatcher 的业务 handler。身份来自 PluginViewManager，不读取 renderer 自报的 pluginId/pageId。 */
function hasProviderFor(operation: string): boolean {
  const configured = getPluginCapabilityProviders()
  if (operation.startsWith('sessions.')) return Boolean(configured.sessions || configured.presets)
  if (operation.startsWith('runtime.')) return Boolean(configured.runtime)
  if (operation.startsWith('secrets.')) return Boolean(configured.secrets)
  return true
}

function callFloatingWindowOperation(method: string, payload: unknown, context: PluginRequestContext): unknown {
  const { pluginId, pageId } = context
  switch (method) {
    case 'window.floating.open':
      return pluginFloatingWindowManager.open(pluginId, pageId)
    case 'window.floating.show':
      pluginFloatingWindowManager.show(pluginId, pageId)
      return { visible: true }
    case 'window.floating.hide':
      pluginFloatingWindowManager.hide(pluginId, pageId)
      return { visible: false }
    case 'window.floating.close':
      pluginFloatingWindowManager.close(pluginId, pageId)
      return { closed: true }
    case 'window.floating.is-visible':
      return pluginFloatingWindowManager.isVisible(pluginId, pageId)
    case 'window.floating.get-bounds':
      return pluginFloatingWindowManager.getBounds(pluginId, pageId)
    case 'window.floating.set-bounds': {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '窗口位置参数必须是对象')
      const input = payload as { x?: unknown; y?: unknown }
      for (const [key, value] of Object.entries(input)) {
        if (key !== 'x' && key !== 'y') throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '悬浮窗口只允许设置位置（x/y）')
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', `窗口位置 ${key} 必须是有限数字`)
      }
      return pluginFloatingWindowManager.setBounds(pluginId, pageId, input as { x?: number; y?: number })
    }
    case 'window.floating.set-ignore-mouse-events': {
      if (!payload || typeof payload !== 'object' || typeof (payload as { ignore?: unknown }).ignore !== 'boolean') {
        throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '鼠标穿透参数必须是 { ignore: boolean }')
      }
      pluginFloatingWindowManager.setIgnoreMouseEvents(pluginId, pageId, (payload as { ignore: boolean }).ignore)
      return { ignoreMouseEvents: (payload as { ignore: boolean }).ignore }
    }
    default:
      throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '未知的悬浮窗口操作')
  }
}

export async function callPluginHost(
  request: ProferPluginRpcRequest<unknown>,
  context: PluginRequestContext,
  taskContext: ProferPluginTaskReference | null,
): Promise<unknown> {
  const method = request.operation
  if (method === 'requests.cancel') {
    const requestId = requestIdSchema.parse(request.payload)
    if (!pluginRequests.cancel(context.pluginId, requestId, context.ownerId)) {
      throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '请求不存在或不属于当前插件页面')
    }
    return { requestId, cancelled: true }
  }
  if (!Object.hasOwn(permissions, method)) throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '未知的插件宿主操作')
  const permission = permissions[method]!
  // provider 缺失不能遮蔽停用、撤权或权限拒绝；先执行统一状态/授权检查。
  assertPluginPermission(context.pluginId, permission)
  if (method.startsWith('window.floating.')) {
    // 悬浮窗口只允许声明了 floating placement 的页面操作自己；身份来自 PluginViewManager 绑定。
    try { assertFloatingPageAllowed(context.pluginId, context.pageId) } catch {
      throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '插件页面未声明悬浮窗口入口')
    }
    return callFloatingWindowOperation(method, request.payload, context)
  }
  if ((method.startsWith('sessions.') || method.startsWith('runtime.') || method.startsWith('secrets.')) && !hasProviderFor(method)) {
    throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '该插件能力尚未配置宿主 provider')
  }
  let result: unknown
  switch (method) {
    case 'workspace.list':
    case 'workspace.files.list':
    case 'workspace.files.read':
    case 'workspace.files.write':
      result = await callWorkspaceOperation(method, request.payload, context, (workspaceId) => isPluginWorkspaceAllowed(context.pluginId, workspaceId))
      break
    case 'models.list': result = listPluginModels(); break
    case 'routing.get': result = getPluginRoutingRules(context.pluginId); break
    case 'routing.set': result = setPluginRoutingRules(context.pluginId, request.payload); break
    case 'context.read': result = readPluginTaskContext(taskContext); break
    case 'attachments.select': result = await selectPluginAttachments(); break
    case 'models.generate': {
      const args = generateSchema.parse(request.payload)
      result = await generatePluginModel(args, context.signal)
      break
    }
    case 'network.fetch': {
      const args = fetchSchema.parse(request.payload)
      result = await fetchPluginNetwork(context.pluginId, args, context.signal)
      break
    }
    case 'sessions.presets.list':
    case 'sessions.presets.get':
    case 'sessions.list':
    case 'sessions.get':
    case 'sessions.create':
    case 'sessions.configure':
    case 'sessions.preset.request':
    case 'sessions.cancel':
      result = await callSessionOrPresetOperation(method, request.payload, context)
      break
    case 'runtime.capabilities.resolve':
    case 'runtime.capabilities.inject':
      result = await callRuntimeOperation(method, request.payload, context)
      break
    case 'secrets.metadata.list':
    case 'secrets.configure.request':
      result = await callSecretOperation(method, request.payload, context)
      break
    default: throw new PluginRpcError('PLUGIN_OPERATION_NOT_SUPPORTED', '未知的插件宿主操作')
  }
  // 等待过程中可能被撤权；结果也不能继续交回插件。
  assertPluginPermission(context.pluginId, permission)
  return result
}
