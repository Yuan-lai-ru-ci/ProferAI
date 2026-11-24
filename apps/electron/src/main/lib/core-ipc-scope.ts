import { ipcMain } from 'electron'
import { runCoreSender } from './core-window-scope'

/** 集中包装注册入口，保持原有 IPC 授权逻辑不变。 */
export function installCoreIpcScope(ipc: Pick<typeof ipcMain, 'handle' | 'on'>): void {
  const handle = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) => handle(channel, (event, ...args) => runCoreSender(event, () => listener(event, ...args)))
  const on = ipc.on.bind(ipc)
  ipc.on = (channel, listener) => on(channel, (event, ...args) => runCoreSender(event, () => listener(event, ...args)))
}

// 在任何业务 handler 注册之前安装；await 和嵌套路由继承同一 scope。
installCoreIpcScope(ipcMain)
