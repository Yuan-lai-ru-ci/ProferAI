import { contextBridge, ipcRenderer } from 'electron'

const request = (type: 'alert' | 'confirm' | 'prompt', message: unknown = '', defaultPrompt: unknown = ''): unknown => {
  return ipcRenderer.sendSync('smoke:guest-dialog', { type, message: String(message).slice(0, 8000), defaultPrompt: String(defaultPrompt).slice(0, 10_000) }) as unknown
}
contextBridge.executeInMainWorld({ func: () => {
  for (const key of ['alert', 'confirm', 'prompt']) Reflect.deleteProperty(globalThis, key)
} })
contextBridge.exposeInMainWorld('alert', (message?: unknown): void => { request('alert', message) })
contextBridge.exposeInMainWorld('confirm', (message?: unknown): boolean => request('confirm', message) === true)
contextBridge.exposeInMainWorld('prompt', (message?: unknown, defaultPrompt?: unknown): string | null => {
  const result = request('prompt', message, defaultPrompt)
  return typeof result === 'string' ? result : null
})
