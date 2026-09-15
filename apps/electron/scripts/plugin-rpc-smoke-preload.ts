/**
 * 仅供 plugin-rpc-smoke Electron 产物使用：先加载生产 plugin preload，
 * 再提供原始 RPC envelope 观测口，以验证真实 ipcRenderer → 主进程链路。
 */
import '../src/plugin-preload/index.ts'
import { contextBridge, ipcRenderer } from 'electron'
import { PROFER_PLUGIN_HOST_CHANNELS } from '@profer/plugin-api'

contextBridge.exposeInMainWorld('__pluginRpcSmoke', {
  call: (request: unknown) => ipcRenderer.invoke(PROFER_PLUGIN_HOST_CHANNELS.CALL, request),
})

declare global {
  interface Window {
    __pluginRpcSmoke: { call(request: unknown): Promise<unknown> }
  }
}
