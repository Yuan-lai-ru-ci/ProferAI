import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { PROFER_PLUGIN_HOST_CHANNELS } from '@profer/plugin-api'
import { resolvePluginPage } from './plugin-manager'
import { assertPluginPermission } from './plugin-permissions'
import { pluginRequests } from './plugin-requests'

interface PendingCall { senderId: number; resolve(value: unknown): void; reject(error: Error): void }
export class PluginToolBroker {
  private readonly registrations = new Map<number, Set<string>>()
  private readonly changed = new EventEmitter()
  private readonly pending = new Map<string, PendingCall>()
  register(pluginId: string, pageId: string, senderId: number, toolId: unknown): void {
    assertPluginPermission(pluginId, 'agent.tools')
    const { plugin } = resolvePluginPage(pluginId, pageId)
    if (typeof toolId !== 'string' || !plugin.manifest.contributes.tools?.some((tool) => tool.id === toolId && tool.pageId === pageId)) throw new Error('工具不属于当前插件页面')
    const registered = this.registrations.get(senderId) ?? new Set<string>()
    registered.add(toolId); this.registrations.set(senderId, registered); this.changed.emit('registered')
  }
  dispose(senderId: number): void {
    this.registrations.delete(senderId)
    for (const [id, call] of this.pending) {
      if (call.senderId === senderId) { call.reject(new Error('插件工具页面已关闭')); this.pending.delete(id) }
    }
    this.changed.emit('registered')
  }
  result(senderId: number, callId: unknown, value: unknown, error: unknown): void {
    if (typeof callId !== 'string') throw new Error('工具调用标识非法')
    const call = this.pending.get(callId)
    if (!call || call.senderId !== senderId) throw new Error('工具结果来源不匹配')
    this.pending.delete(callId)
    if (typeof error === 'string') { call.reject(new Error(error.slice(0, 2000))); return }
    try {
      const json = JSON.stringify(value ?? null)
      if (json.length > 1_000_000) throw new Error('插件工具结果超过限制')
      call.resolve(JSON.parse(json) as unknown)
    } catch { call.reject(new Error('插件工具结果必须为 1 MB 以内的 JSON')) }
  }
  async run(pluginId: string, toolId: string, args: Record<string, unknown>, contents: WebContents, signal?: AbortSignal): Promise<unknown> {
    const callId = randomUUID()
    const cancel = (): void => { pluginRequests.cancel(pluginId, callId) }
    signal?.throwIfAborted()
    const operation = pluginRequests.run(pluginId, callId, async (localSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('插件工具未在 10 秒内注册')), 10_000)
        const check = (): void => {
          if (contents.isDestroyed()) finish(new Error('插件工具页面已关闭'))
          else if (this.registrations.get(contents.id)?.has(toolId)) finish()
        }
        const abort = (): void => finish(new Error('插件工具已取消'))
        const finish = (error?: Error): void => {
          clearTimeout(timer); this.changed.removeListener('registered', check); localSignal.removeEventListener('abort', abort)
          if (error) reject(error); else resolve()
        }
        this.changed.on('registered', check); localSignal.addEventListener('abort', abort, { once: true })
        if (localSignal.aborted) abort(); else check()
      })
      localSignal.throwIfAborted()
      assertPluginPermission(pluginId, 'agent.tools')
      return new Promise<unknown>((resolve, reject) => {
        this.pending.set(callId, { senderId: contents.id, resolve, reject })
        contents.send(PROFER_PLUGIN_HOST_CHANNELS.TOOL_CALL, { callId, toolId, args })
      })
    }, 60_000, contents.id)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    try { return await operation } finally {
      signal?.removeEventListener('abort', cancel)
      this.pending.delete(callId)
      if (!contents.isDestroyed()) contents.send(PROFER_PLUGIN_HOST_CHANNELS.TOOL_CANCEL, callId)
    }
  }
}
export const pluginToolBroker = new PluginToolBroker()
