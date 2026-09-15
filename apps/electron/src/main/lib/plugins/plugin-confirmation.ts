import { randomUUID } from 'node:crypto'
import { PluginRpcError } from './plugin-rpc-errors'

export interface PluginConfirmationBinding {
  pluginId: string
  pageId: string
  ownerId: number
  requestId: string
  operation: string
  resource: string
  revision?: number
}

interface ConfirmationRecord extends PluginConfirmationBinding { expiresAt: number }

/** 一次性、绑定请求上下文的确认令牌；撤权/页面关闭时可按 owner 或插件批量清理。 */
export class PluginConfirmations {
  private readonly records = new Map<string, ConfirmationRecord>()

  issue(binding: PluginConfirmationBinding, ttlMs = 5 * 60_000): string {
    if (!Number.isSafeInteger(binding.ownerId) || binding.ownerId <= 0 || !binding.pluginId || !binding.pageId || !binding.requestId || !binding.operation || !binding.resource) {
      throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '确认请求上下文非法')
    }
    const token = randomUUID()
    this.records.set(token, { ...binding, expiresAt: Date.now() + Math.min(Math.max(ttlMs, 1_000), 10 * 60_000) })
    return token
  }

  consume(token: unknown, binding: PluginConfirmationBinding): void {
    if (typeof token !== 'string') throw new PluginRpcError('PLUGIN_CONFIRMATION_REQUIRED', '此操作需要宿主确认')
    const record = this.records.get(token)
    this.records.delete(token)
    if (!record || record.expiresAt < Date.now() || !sameBinding(record, binding)) {
      throw new PluginRpcError('PLUGIN_CONFIRMATION_REQUIRED', '确认令牌无效或已过期')
    }
  }

  revokeOwner(ownerId: number): void { for (const [token, record] of this.records) if (record.ownerId === ownerId) this.records.delete(token) }
  revokePlugin(pluginId: string): void { for (const [token, record] of this.records) if (record.pluginId === pluginId) this.records.delete(token) }
  clear(): void { this.records.clear() }
}

function sameBinding(left: PluginConfirmationBinding, right: PluginConfirmationBinding): boolean {
  return left.pluginId === right.pluginId && left.pageId === right.pageId && left.ownerId === right.ownerId
    && left.requestId === right.requestId && left.operation === right.operation && left.resource === right.resource
    && left.revision === right.revision
}

export const pluginConfirmations = new PluginConfirmations()
