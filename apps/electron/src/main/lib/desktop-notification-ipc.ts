import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { DESKTOP_NOTIFICATION_IPC_CHANNELS } from '../../types'

export function registerDesktopNotificationIpc(): void {
  ipcMain.handle(DESKTOP_NOTIFICATION_IPC_CHANNELS.SHOW, async (event, payload: { title: string; body: string }) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!senderWindow) return
    // macOS：Electron 的 willPresentNotification 固定返回 UNNotificationPresentationOptionSound，
    // 应用处于前台时呈现通知必然播放系统提示音，silent: true 无法阻止（macOS 26+ 实测）。
    // 前台已有应用内提示与可配置提示音，这里跳过系统通知，避免用户无法关闭的系统铃声；
    // 后台走系统投递，content.sound 为 nil，本身不会出声。
    if (process.platform === 'darwin' && app.isActive()) return
    try {
      const notification = new Notification({
        title: payload.title,
        body: payload.body.slice(0, 200),
        silent: true,
      })
      notification.on('click', () => {
        if (senderWindow.isMinimized()) senderWindow.restore()
        senderWindow.show()
        senderWindow.focus()
        if (!senderWindow.isDestroyed()) {
          senderWindow.webContents.send(DESKTOP_NOTIFICATION_IPC_CHANNELS.CLICKED)
        }
      })
      notification.show()
    } catch (error) {
      console.warn('[桌面通知] 弹出失败:', error)
    }
  })
}
