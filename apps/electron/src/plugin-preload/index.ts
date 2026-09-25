/**
 * 第三方插件页面专属 preload。
 *
 * 只暴露稳定的最小 Plugin Host API；插件页面永远拿不到主应用 electronAPI。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  PROFER_PLUGIN_HOST_CHANNELS,
  type ProferPluginContext,
  type ProferPluginError,
  type ProferPluginHostApi,
  type ProferPluginRpcResponse,
} from '@profer/plugin-api'

const context = (): Promise<ProferPluginContext> => ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.GET_CONTEXT)

const applyContext = (value: ProferPluginContext): void => {
  const apply = (): void => {
    document.documentElement.dataset.proferTheme = value.theme
    document.documentElement.lang = value.locale
  }
  if (document.documentElement) apply()
  else window.addEventListener('DOMContentLoaded', apply, { once: true })
}
const listeners = new Set<(context: ProferPluginContext) => void>()
const handlers = new Map<string, Parameters<ProferPluginHostApi['tools']['register']>[1]>()
const calls = new Map<string, AbortController>()
if (process.isMainFrame) {
  void context().then(applyContext).catch(() => undefined)
  ipcRenderer.on(PROFER_PLUGIN_HOST_CHANNELS.CONTEXT_CHANGED, (_event, value: ProferPluginContext) => {
    applyContext(value)
    for (const listener of listeners) { try { listener(value) } catch { /* 单个插件监听失败不阻断其他监听 */ } }
  })
  ipcRenderer.on(PROFER_PLUGIN_HOST_CHANNELS.TOOL_CALL, (_event, input: { callId: string; toolId: string; args: Record<string, unknown> }) => {
    const controller = new AbortController(); calls.set(input.callId, controller)
    const run = async (): Promise<unknown> => {
      const handler = handlers.get(input.toolId)
      if (!handler) throw new Error('工具尚未注册')
      return handler(input.args, {
        callId: input.callId,
        isCancelled: () => controller.signal.aborted,
        onCancel: (callback) => {
          controller.signal.addEventListener('abort', callback, { once: true })
          if (controller.signal.aborted) callback()
          return () => controller.signal.removeEventListener('abort', callback)
        },
      })
    }
    void run().then(
      (value) => ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.TOOL_RESULT, input.callId, value),
      (error: unknown) => ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.TOOL_RESULT, input.callId, null, error instanceof Error ? error.message : String(error)),
    ).catch(() => undefined).finally(() => calls.delete(input.callId))
  })
  ipcRenderer.on(PROFER_PLUGIN_HOST_CHANNELS.TOOL_CANCEL, (_event, callId: string) => calls.get(callId)?.abort())
}
const call = async <T>(operation: string, payload?: unknown): Promise<T> => {
  const payloadRequestId = payload && typeof payload === 'object' && 'requestId' in payload && typeof payload.requestId === 'string'
    ? payload.requestId
    : undefined
  const response = await ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.CALL, {
    protocol: 'plugin-host.rpc.v1',
    requestId: payloadRequestId ?? crypto.randomUUID().replaceAll('-', '_'),
    operation,
    payload,
  }) as ProferPluginRpcResponse<T> | null
  if (!response || response.ok !== true) {
    // contextBridge 跨世界传递 Error 实例会丢失自定义属性（code 等），
    // 因此以 ProferPluginError 纯对象 reject，保证错误契约完整到达插件页面。
    const error = response?.ok === false ? response.error : undefined
    const failure: ProferPluginError = {
      name: 'ProferPluginError',
      code: error?.code ?? 'PLUGIN_INTERNAL_ERROR',
      message: error?.message ?? '插件宿主操作失败',
      retryable: error?.retryable ?? false,
      requestId: response?.requestId ?? 'unknown',
      operation: response?.operation ?? operation,
    }
    if (error?.details) failure.details = error.details
    throw failure
  }
  return response.value as T
}

const api: ProferPluginHostApi = {
  getContext: context,
  onContextChanged: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
  models: { list: () => call('models.list'), generate: (input) => call('models.generate', input) },
  routing: { getRules: () => call('routing.get'), setRules: (rules) => call('routing.set', rules) },
  context: { read: () => call('context.read') },
  attachments: { select: () => call('attachments.select') },
  network: { fetch: (input) => call('network.fetch', input) },
  requests: { cancel: (requestId) => call('requests.cancel', requestId) },
  workspace: {
    list: () => call('workspace.list'),
    files: {
      list: (input) => call('workspace.files.list', input),
      read: (input) => call('workspace.files.read', input),
      write: (input) => call('workspace.files.write', input),
    },
  },
  sessions: {
    listPresets: (input) => call('sessions.presets.list', input),
    getPreset: (input) => call('sessions.presets.get', input),
    list: (input) => call('sessions.list', input),
    get: (input) => call('sessions.get', input),
    create: (input) => call('sessions.create', input),
    configure: (input) => call('sessions.configure', input),
    requestPreset: (input) => call('sessions.preset.request', input),
    cancel: (input) => call('sessions.cancel', input),
  },
  runtime: {
    resolve: (input) => call('runtime.capabilities.resolve', input),
    inject: (input) => call('runtime.capabilities.inject', input),
  },
  secrets: {
    listMetadata: (input) => call('secrets.metadata.list', input),
    requestConfigure: (input) => call('secrets.configure.request', input),
  },
  tools: { register: async (id, handler) => {
    handlers.set(id, handler)
    try { await ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.TOOL_REGISTER, id) } catch (error) { handlers.delete(id); throw error }
  } },
  storage: {
    get: <T = unknown>(key: string) => ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.STORAGE_GET, key) as Promise<T | null>,
    set: (key: string, value: unknown) => ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.STORAGE_SET, key, value) as Promise<void>,
    delete: (key: string) => ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.STORAGE_DELETE, key) as Promise<void>,
  },
  window: {
    floating: {
      open: () => call('window.floating.open'),
      show: () => call('window.floating.show'),
      hide: () => call('window.floating.hide'),
      close: () => call('window.floating.close'),
      isVisible: () => call('window.floating.is-visible'),
      getBounds: () => call('window.floating.get-bounds'),
      setBounds: (bounds) => call('window.floating.set-bounds', bounds),
      setIgnoreMouseEvents: (ignore) => call('window.floating.set-ignore-mouse-events', { ignore }),
    },
  },
}

if (process.isMainFrame) contextBridge.exposeInMainWorld('profer', api)

declare global {
  interface Window {
    profer: ProferPluginHostApi
  }
}
