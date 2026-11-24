import { getActiveCoreClient } from './core-target-service'
import { app, BrowserWindow, ipcMain } from 'electron'
import { getAgentSessionMeta } from './agent-session-manager'
import { getConversationMeta } from './conversation-manager'
import { IPC_CHANNELS, type MainWindowBootstrap, type OpenTabInNewWindowResult } from '@profer/shared'
import {
  createSecondaryMainWindow,
  moveSessionToThisWindow,
  replyToWindowMove,
  ackWindowTabHandoff,
  reportWindowPhase,
  reportWindowSessions,
  focusWindowForSession,
  confirmWindowBootstrap,
  getMainWindowBootstrap,
  getPrimaryMainWindow,
  getSessionWindowInitialTab,
  isMainAppWindowSender,
  isSessionWindowSender,
  normalizeInitialTab,
} from './main-app-windows'

async function isMovingChatActive(sessionId: string): Promise<boolean> {
  const match = /^core-chat:[^:]+:(.+)$/.exec(sessionId)
  if (match) {
    const client = getActiveCoreClient()
    if (!client) throw new Error('会话所属 Core 尚未就绪')
    return client.isChatGenerationActive(match[1]!)
  }
  return (await import('./chat-service')).isChatGenerationActive(sessionId)
}

export function registerWindowIpc(): void {
  ipcMain.handle(IPC_CHANNELS.WINDOW_MOVE_SESSION_HERE, (event, session: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) return { ok: false, error: '仅应用主页面可以移窗' }
    return moveSessionToThisWindow(event.sender, session, isMovingChatActive)
  })
  ipcMain.on(IPC_CHANNELS.WINDOW_MOVE_REPLY, (event, id: unknown, result: unknown) => {
    if (event.senderFrame === event.sender.mainFrame) replyToWindowMove(event.sender, id, result)
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_REPORT_PHASE, (event, phase: unknown) => reportWindowPhase(event.sender, phase))
  ipcMain.handle(IPC_CHANNELS.WINDOW_ACK_TAB_HANDOFF, (event, id: string) => ackWindowTabHandoff(event.sender, id))
  ipcMain.handle(IPC_CHANNELS.WINDOW_REPORT_SESSIONS, (event, sessions: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('仅应用主页面可以上报会话')
    reportWindowSessions(event.sender, sessions)
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_FOCUS_SESSION, (event, session: unknown) => focusWindowForSession(event.sender, session, async (target) => {
    if (/^core(?:-chat)?:[^:]+:.+$/.test(target.sessionId)) {
      const client = getActiveCoreClient()
      if (!client) return null
      const rawId = target.sessionId.replace(/^core(?:-chat)?:[^:]+:/, "")
      const values = target.type === "agent" ? await client.listSessions() : await client.chatOperation<Array<{ id: string; title: string }>>('chat:list-conversations', [])
      const meta = values.find(value => value.id === rawId)
      return meta ? { id: target.sessionId, ...target, title: meta.title } : null
    }
    const meta = target.type === 'agent' ? getAgentSessionMeta(target.sessionId) : getConversationMeta(target.sessionId)
    if (!meta) return null
    return { id: target.sessionId, ...target, title: meta.title }
  }))
  ipcMain.handle(IPC_CHANNELS.WINDOW_CONFIRM_BOOTSTRAP, (event, handoffId?: string) => confirmWindowBootstrap(event.sender, handoffId))
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
      const normalized = normalizeInitialTab(tab)
      if (normalized?.type === 'chat') {
        if (await isMovingChatActive(normalized.sessionId)) return { ok: false, error: '生成中的 Chat 暂不支持移窗' }
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
