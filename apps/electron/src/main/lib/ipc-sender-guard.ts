/**
 * 敏感 Agent IPC 的主窗口来源校验。
 *
 * 不依赖 Electron 具体实现，主进程可注入真实窗口 getter，单测也可使用最小 fake。
 */
export interface IpcSenderLike {
  isDestroyed(): boolean
}

export interface MainWindowLike {
  isDestroyed(): boolean
  webContents: IpcSenderLike
}

export interface IpcEventLike {
  sender: IpcSenderLike
}

export type MainWindowGetter = () => MainWindowLike | null

/** sender 必须属于当前主窗口，且主窗口及 webContents 都仍然可用。 */
export function isMainWindowSender(event: IpcEventLike, getMainWindow: MainWindowGetter): boolean {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event.sender.isDestroyed() || mainWindow.webContents.isDestroyed()) return false
  return event.sender === mainWindow.webContents
}

/** 在 IPC handler 开始处拒绝非主窗口、已销毁 sender 或已销毁主窗口。 */
export function assertMainWindowSender(event: IpcEventLike, getMainWindow: MainWindowGetter): void {
  if (!isMainWindowSender(event, getMainWindow)) {
    throw new Error('仅允许 Profer 主窗口调用此 Agent IPC')
  }
}
