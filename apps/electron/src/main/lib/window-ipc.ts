import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS, type MainWindowBootstrap, type OpenTabInNewWindowResult } from '@profer/shared'
import {
  createSecondaryMainWindow,
  getMainWindowBootstrap,
  getPrimaryMainWindow,
  getSessionWindowInitialTab,
  isMainAppWindowSender,
  isSessionWindowSender,
  normalizeInitialTab,
} from './main-app-windows'

export function registerWindowIpc(): void {
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.minimize()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (process.platform === 'darwin') {
      win.setFullScreen(!win.isFullScreen())
      return
    }
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.close()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win.isMaximized() : false
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_FULL_SCREEN, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win.isFullScreen() : false
  })

  // 窗口引导：renderer 据此判断自己是不是主窗口、是否需要恢复被拆出来的 Tab。
  ipcMain.handle(IPC_CHANNELS.WINDOW_GET_BOOTSTRAP, async (event): Promise<MainWindowBootstrap> => {
    const bootstrap = getMainWindowBootstrap(event.sender)
    if (!bootstrap) throw new Error('仅 Profer 主应用窗口可以读取窗口引导信息')
    return bootstrap
  })

  // 在新窗口打开：只接受会话 Tab，创建成功后由 renderer 负责把原窗口的 Tab 移除。
  ipcMain.handle(
    IPC_CHANNELS.WINDOW_OPEN_TAB_IN_NEW_WINDOW,
    async (event, tab: unknown): Promise<OpenTabInNewWindowResult> => {
      if (!isMainAppWindowSender(event.sender)) {
        throw new Error('仅 Profer 主应用窗口可以创建新窗口')
      }
      const sourceWindow = BrowserWindow.fromWebContents(event.sender)
      return createSecondaryMainWindow(tab, sourceWindow)
    },
  )

  // 独立会话窗口回归主窗口：把当前 Tab（含最新草稿）交还主 renderer 后关闭自身。
  ipcMain.handle(
    IPC_CHANNELS.WINDOW_RETURN_TO_MAIN,
    async (event, tab: unknown): Promise<OpenTabInNewWindowResult> => {
      if (!isSessionWindowSender(event.sender)) {
        return { ok: false, error: '只有独立会话窗口可以移回主窗口' }
      }
      const primary = getPrimaryMainWindow()
      if (!primary || primary.isDestroyed()) {
        return { ok: false, error: '主窗口不存在或已关闭' }
      }
      const payload = normalizeInitialTab(tab) ?? getSessionWindowInitialTab(event.sender)
      if (!payload) return { ok: false, error: '会话信息缺失' }

      if (primary.isMinimized()) primary.restore()
      primary.show()
      primary.focus()
      if (process.platform === 'darwin') app.focus({ steal: true })
      primary.webContents.send(IPC_CHANNELS.WINDOW_REATTACH_TAB, payload)

      const source = BrowserWindow.fromWebContents(event.sender)
      if (source && !source.isDestroyed()) source.close()
      return { ok: true }
    },
  )
}
