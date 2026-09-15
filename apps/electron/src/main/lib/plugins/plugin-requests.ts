/** 插件调用的并发、限流与取消独立于页面代码，撤权后立即终止。 */
import { PluginRpcError } from './plugin-rpc-errors'

interface ActiveCall { controller: AbortController; ownerId?: number }

export class PluginRequests {
  private readonly active = new Map<string, Map<string, ActiveCall>>()
  private readonly recent = new Map<string, number[]>()

  async run<T>(pluginId: string, requestId: string, operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 60_000, ownerId?: number, parentSignal?: AbortSignal): Promise<T> {
    const calls = this.active.get(pluginId) ?? new Map<string, ActiveCall>()
    if (calls.has(requestId)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'requestId 已在使用')
    if (calls.size >= 4) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件最多同时进行 4 项调用')
    const recent = (this.recent.get(pluginId) ?? []).filter((time) => Date.now() - time < 60_000)
    if (recent.length >= 30) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件调用过于频繁，请稍后重试')
    recent.push(Date.now()); this.recent.set(pluginId, recent)
    const controller = new AbortController()
    calls.set(requestId, { controller, ownerId }); this.active.set(pluginId, calls)
    const cancelFromParent = (): void => controller.abort(new PluginRpcError('PLUGIN_REQUEST_CANCELLED', '插件请求已取消'))
    parentSignal?.addEventListener('abort', cancelFromParent, { once: true })
    const timer = setTimeout(() => controller.abort(new PluginRpcError('PLUGIN_REQUEST_TIMEOUT', '插件请求超时', true)), timeoutMs)
    let onAbort: (() => void) | undefined
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason instanceof PluginRpcError
          ? controller.signal.reason
          : new PluginRpcError('PLUGIN_REQUEST_CANCELLED', '插件请求已取消'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) onAbort()
      })
      return await Promise.race([operation(controller.signal), aborted])
    } finally {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', cancelFromParent)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      calls.delete(requestId)
      if (calls.size === 0) this.active.delete(pluginId)
    }
  }

  cancel(pluginId: string, requestId: string, ownerId?: number): boolean {
    const call = this.active.get(pluginId)?.get(requestId)
    if (!call || (ownerId !== undefined && call.ownerId !== ownerId)) return false
    call.controller.abort(new PluginRpcError('PLUGIN_REQUEST_CANCELLED', '插件请求已取消'))
    return true
  }
  cancelOwner(ownerId: number): void {
    for (const calls of this.active.values()) for (const call of calls.values()) {
      if (call.ownerId === ownerId) call.controller.abort(new PluginRpcError('PLUGIN_PAGE_CLOSED', '插件请求已取消（插件页面已关闭）'))
    }
  }
  cancelPlugin(pluginId: string): void {
    for (const call of this.active.get(pluginId)?.values() ?? []) call.controller.abort(new PluginRpcError('PLUGIN_REVOKED', '插件请求已取消（插件授权已撤销）'))
  }
}
export const pluginRequests = new PluginRequests()
