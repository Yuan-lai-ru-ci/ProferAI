import { PROFER_PLUGIN_ID_PATTERN, type ProferPluginRpcRequest, type ProferPluginRpcResponse } from '@profer/plugin-api'
import { PluginRpcError, toPluginRpcFailure } from './plugin-rpc-errors'
import { pluginRequests } from './plugin-requests'
import type { PluginRequestContext } from '@profer/plugin-api'

export const PROTOCOL = 'plugin-host.rpc.v1' as const
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_TIMEOUT_MS = 60_000

export function validatePluginRpcRequest(value: unknown): ProferPluginRpcRequest<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'RPC 请求必须是对象')
  const request = value as Partial<ProferPluginRpcRequest<unknown>>
  if (request.protocol !== PROTOCOL) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '不支持的插件 RPC 协议')
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'requestId 非法')
  if (typeof request.operation !== 'string' || !/^[a-z][a-z0-9._-]{0,100}$/.test(request.operation)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'operation 非法')
  if (!Object.hasOwn(request, 'payload')) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'RPC payload 缺失')
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'timeoutMs 超出宿主限制')
  }
  return request as ProferPluginRpcRequest<unknown>
}

export function resolvePluginRpcTimeout(timeoutMs: number | undefined): number { return timeoutMs ?? DEFAULT_TIMEOUT_MS }

export function successPluginRpc<T>(request: ProferPluginRpcRequest<unknown>, value: T, revision?: number): ProferPluginRpcResponse<T> {
  return { protocol: PROTOCOL, ok: true, requestId: request.requestId, operation: request.operation, value, ...(revision === undefined ? {} : { revision }) }
}

export async function dispatchPluginRpc<T>(
  rawRequest: ProferPluginRpcRequest<T> | unknown,
  context: PluginRequestContext,
  handler: (payload: T, context: PluginRequestContext) => Promise<unknown>,
): Promise<ProferPluginRpcResponse<unknown>> {
  let request: ProferPluginRpcRequest<T> | undefined
  try {
    request = validatePluginRpcRequest(rawRequest) as ProferPluginRpcRequest<T>
    if (!PROFER_PLUGIN_ID_PATTERN.test(context.pluginId) || context.ownerId <= 0 || !context.pageId || context.requestId !== request.requestId) {
      throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件请求上下文非法')
    }
    const value = await pluginRequests.run(context.pluginId, request.requestId, (signal) => handler(request!.payload, { ...context, signal }), resolvePluginRpcTimeout(request.timeoutMs), context.ownerId, context.signal)
    return successPluginRpc(request, value)
  } catch (error) {
    const fallback = request ?? { requestId: context.requestId, operation: context.operation }
    return {
      ...toPluginRpcFailure(error),
      requestId: fallback.requestId,
      operation: fallback.operation,
    }
  }
}
