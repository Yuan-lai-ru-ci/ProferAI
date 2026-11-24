import { AsyncLocalStorage } from 'node:async_hooks'

/** 仅主进程注册的完整窗口能获得请求 scope，后台调用保持默认上下文。 */
const requests = new AsyncLocalStorage<number>()
const windows = new Set<number>()
export function registerCoreWindow(id: number): void { windows.add(id) }
export function unregisterCoreWindow(id: number): void { windows.delete(id) }
export function currentCoreWindow(): number | undefined { return requests.getStore() }
export function runCoreWindow<T>(id: number | undefined, fn: () => T): T {
  return id === undefined ? requests.exit(fn) : requests.run(id, fn)
}
export function runCoreSender<T>(event: { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }, fn: () => T): T {
  return runCoreWindow(windows.has(event.sender.id) && (!event.sender.mainFrame || event.senderFrame === event.sender.mainFrame) ? event.sender.id : undefined, fn)
}
