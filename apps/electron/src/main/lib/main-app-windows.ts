import { getIsQuitting } from './app-lifecycle'
import { setMainWindow } from './main-window-state'
import { logLifecycle } from './lifecycle-diagnostics'
import { beginWindowHandoff, finishWindowHandoff } from './window-handoff-buffer'
import { registerCoreWindow, unregisterCoreWindow, runCoreWindow } from './core-window-scope'
import { initializeWindowCore, disposeWindowCore, listCoreTargets } from './core-target-service'
/** 完整主应用窗口注册表、会话关联与可靠的跨窗口草稿交接。 */

import { app, BrowserWindow, screen, shell } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  AcceptWindowSessionMove,
  AppWindowSession,
  PrepareWindowSessionMove,
  WindowMoveCore,
  WindowMoveResult,
  AppWindowSummary,
  MainWindowBootstrap,
  MainWindowKind,
  MainWindowTabPayload,
  OpenTabInNewWindowResult,
  WindowTabHandoffEvent,
} from '@profer/shared'
import { IPC_CHANNELS } from '@profer/shared'
import { resolveAppWindowIconPath } from './app-window-icon'
import { VITE_DEV_SERVER_URL } from './config-paths'
import { getWindowFrameColor, updateWindowFrameAppearance } from './titlebar-overlay'
import {
  DEFAULT_MAIN_WINDOW_ZOOM_FACTOR,
  DEFAULT_TRAFFIC_LIGHT_POSITION,
  installMacTrafficLightZoomSync,
} from './mac-traffic-light'
import { resolveSecondaryWindowBounds } from './main-window-geometry'

export const PRIMARY_WINDOW_ID = 'primary'

interface MainAppWindowRecord {
  id: string
  kind: MainWindowKind
  isPrimary: boolean
  initialTab: MainWindowTabPayload | null
  sessions: AppWindowSession[]
  handoffId?: string
  /** 首次开窗计时关联，commit 后保留；不参与交接权限判断。 */
  timingHandoffId?: string
  createdAt?: number
  phases?: Set<string>
  bootstrapReady?: boolean
  sessionsReported?: boolean
  completeBootstrap?: (result: OpenTabInNewWindowResult) => void
}

/** 以 webContents.id 为键：窗口重建后 id 变化，不会误命中旧记录。 */
const records = new Map<number, MainAppWindowRecord>()
const pending = new Map<string, { id: string; windowId: string; sourceId?: number; tab: MainWindowTabPayload }>()
const recoverable = new Map<string, WindowTabHandoffEvent>()


function getRecordBySender(sender: WebContents | undefined | null): MainAppWindowRecord | null {
  if (!sender || sender.isDestroyed()) return null
  return records.get(sender.id) ?? null
}

/** 注册一个主应用窗口；必须在创建后、加载 renderer 前调用。 */
export function registerMainAppWindow(
  win: BrowserWindow,
  options: { isPrimary: boolean; kind?: MainWindowKind; initialTab?: MainWindowTabPayload | null },
): MainAppWindowRecord {
  const record: MainAppWindowRecord = {
    id: options.isPrimary ? PRIMARY_WINDOW_ID : randomUUID(),
    kind: options.kind ?? 'main',
    isPrimary: options.isPrimary,
    initialTab: options.initialTab ?? null,
    sessions: [],
  }
  const webContentsId = win.webContents.id
  records.set(webContentsId, record)
  registerCoreWindow(webContentsId)
  if (options.isPrimary) void initializeWindowCore(webContentsId, undefined, true)
  if (options.isPrimary) setMainWindow(win)
  notifyMainAppWindowsChanged()
  win.on?.('close', event => {
    if (record.isPrimary && !getIsQuitting() && !shouldClosePrimaryWindow(win)) event.preventDefault()
  })
  win.once('closed', () => {
    record.completeBootstrap?.({ ok: false, error: '目标窗口已关闭' })
    disposeWindowCore(webContentsId)
    unregisterCoreWindow(webContentsId)
    records.delete(webContentsId)
    if (record.isPrimary) {
      const successor = getIsQuitting() ? null : findPrimaryWindowSuccessor(win)
      if (successor) {
        const next = records.get(successor.webContents.id)!
        next.isPrimary = true
        next.kind = 'main'
      }
      setMainWindow(successor)
      primaryWindowChangedHandler?.(successor)
    }
    notifyMainAppWindowsChanged()
  })
  return record
}

/** IPC 来源校验：任意已注册的主应用窗口都算合法来源。 */
export function isMainAppWindowSender(sender: WebContents | undefined | null): boolean {
  return getRecordBySender(sender) !== null
}

/** 当前发送方是否是独立会话窗口。 */
export function isSessionWindowSender(sender: WebContents | undefined | null): boolean {
  return getRecordBySender(sender)?.kind === 'session'
}

/** 独立会话窗口的初始 Tab 快照（草稿可能已被首次引导消费）。 */
export function getSessionWindowInitialTab(sender: WebContents | undefined | null): MainWindowTabPayload | null {
  const record = getRecordBySender(sender)
  return record?.kind === 'session' && record.initialTab ? { ...record.initialTab } : null
}

/** 主窗口（完整主界面）实例；会话窗口不算。 */
export function getPrimaryMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((win) => {
    if (win.isDestroyed()) return false
    return records.get(win.webContents.id)?.isPrimary === true
  }) ?? null
}

export interface SessionWindowSummary {
  id: string
  title: string
  minimized: boolean
}

/** 当前打开的独立会话窗口，供 macOS Window 菜单/主进程入口恢复定位。 */
export function getSessionWindowSummaries(): SessionWindowSummary[] {
  const summaries: SessionWindowSummary[] = []
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const record = records.get(win.webContents.id)
    if (!record || record.isPrimary) continue
    summaries.push({
      id: record.id,
      title: win.getTitle() || record.initialTab?.title || '会话窗口',
      minimized: win.isMinimized(),
    })
  }
  return summaries
}

/** 恢复/聚焦指定会话窗口；最小化会先 restore。 */
export function focusSessionWindow(id: string): boolean {
  const win = BrowserWindow.getAllWindows().find((candidate) => {
    if (candidate.isDestroyed()) return false
    return records.get(candidate.webContents.id)?.id === id
  })
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}

let mainAppWindowsChangedHandler: (() => void) | null = null
let primaryWindowChangedHandler: ((win: BrowserWindow | null) => void) | null = null

export function setPrimaryWindowChangedHandler(handler: typeof primaryWindowChangedHandler): void {
  primaryWindowChangedHandler = handler
}

/** 可见且 bootstrap 已确认的完整窗口优先；交接中的窗口不接任。 */
export function findPrimaryWindowSuccessor(closing: BrowserWindow): BrowserWindow | null {
  const candidates = BrowserWindow.getAllWindows().filter(win => {
    if (win === closing || win.isDestroyed()) return false
    const record = records.get(win.webContents.id)
    return !!record && !record.handoffId
  })
  return candidates.find(win => win.isVisible() && records.get(win.webContents.id)?.bootstrapReady)
    ?? candidates.find(win => win.isVisible())
    ?? candidates.find(win => records.get(win.webContents.id)?.bootstrapReady)
    ?? candidates[0] ?? null
}

let primaryWindowCloseHandler: ((win: BrowserWindow) => boolean) | null = null

/** 应用层处理主窗口关闭：返回 true 表示当前窗口应真正关闭并交接主角色。 */
export function setPrimaryWindowCloseHandler(handler: typeof primaryWindowCloseHandler): void {
  primaryWindowCloseHandler = handler
}

/** 主窗口关闭策略由应用生命周期决定，完整窗口保持可测且不绑定平台细节。 */
export function shouldClosePrimaryWindow(win: BrowserWindow): boolean {
  return primaryWindowCloseHandler?.(win) ?? false
}

/** 应用层注册窗口集合变化回调（用于重建动态 Window 菜单）。 */
export function setMainAppWindowsChangedHandler(handler: (() => void) | null): void {
  mainAppWindowsChangedHandler = handler
}

/** 通知菜单等宿主窗口集合已变化。 */
let windowsNotificationQueued = false
export function notifyMainAppWindowsChanged(): void {
  // 同一轮建窗的注册与 pending 更新合并，菜单构建不阻塞首次 loadRenderer。
  if (windowsNotificationQueued) return
  windowsNotificationQueued = true
  setImmediate(() => {
    windowsNotificationQueued = false
    mainAppWindowsChangedHandler?.()
    const snapshot = getAppWindowSummaries()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && records.has(win.webContents.id)) win.webContents.send(IPC_CHANNELS.WINDOW_APP_WINDOWS_CHANGED, snapshot)
    }
  })
}

/** 读取当前窗口的引导信息；非主应用窗口返回 null。 */
export function getMainWindowBootstrap(sender: WebContents | undefined | null): MainWindowBootstrap | null {
  const record = getRecordBySender(sender)
  if (!record) return null
  // 草稿只交付一次：刷新后不把用户已清空的旧草稿重新写回编辑器。
  const initialTab = record.initialTab ? { ...record.initialTab } : null
  if (!record.handoffId && (record.initialTab?.draft || record.initialTab?.draftHtml)) {
    const rest = { ...record.initialTab }
    delete rest.draft
    delete rest.draftHtml
    record.initialTab = rest
  }
  return {
    windowId: record.id,
    openWindows: getAppWindowSummaries(),
    kind: record.kind,
    isPrimary: record.isPrimary,
    initialTab,
    handoffId: record.handoffId,
    recoverableHandoffs: (record.isPrimary ? [...recoverable.values()] : []).map(event => ({ ...event, tab: { ...event.tab } })),
  }
}

/** 是否还有其他可见的主应用窗口（用于 macOS 关闭主窗口时决定是否隐藏整个 App）。 */
export function hasOtherVisibleMainWindow(win: BrowserWindow): boolean {
  return BrowserWindow.getAllWindows().some((other) => (
    other !== win
    && !other.isDestroyed()
    && other.isVisible()
    && records.has(other.webContents.id)
  ))
}

/** 只接受会话类 Tab；避免 renderer 把任意对象塞进新窗口。 */
export function normalizeInitialTab(input: unknown): MainWindowTabPayload | null {
  if (!input || typeof input !== 'object') return null
  const tab = input as Partial<MainWindowTabPayload>
  if (tab.type !== 'chat' && tab.type !== 'agent') return null
  if (typeof tab.sessionId !== 'string' || tab.sessionId.length === 0 || tab.sessionId.length > 200) return null
  if (typeof tab.title !== 'string' || tab.title.length === 0 || tab.title.length > 300) return null
  const id = typeof tab.id === 'string' && tab.id.length > 0 && tab.id.length <= 200 ? tab.id : tab.sessionId
  return {
    id,
    type: tab.type,
    sessionId: tab.sessionId,
    title: tab.title,
    ...(typeof tab.parentSessionId === 'string' && tab.parentSessionId.length > 0 && tab.parentSessionId.length <= 200
      ? { parentSessionId: tab.parentSessionId }
      : {}),
    ...(typeof tab.draft === 'string' && tab.draft.length > 0 && tab.draft.length <= 100_000
      ? { draft: tab.draft }
      : {}),
    ...(typeof tab.draftHtml === 'string' && tab.draftHtml.length > 0 && tab.draftHtml.length <= 500_000
      ? { draftHtml: tab.draftHtml }
      : {}),
  }
}

export function buildSessionTitleBarOptions(platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  if (platform === 'darwin') {
    // 完整 App 使用自绘交通灯，hiddenInset 会拦截自绘按钮的点击区域。
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: DEFAULT_TRAFFIC_LIGHT_POSITION,
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
    }
  }
  if (platform === 'win32') {
    // Windows 没有原生交通灯：用自绘 WindowControls，保留 thickFrame 以支持拖动缩放、
    // Win+方向键贴边和最大化。不要启用 titleBarOverlay，否则会和自绘按钮重叠。
    return { titleBarStyle: 'hidden', thickFrame: true }
  }
  return {}
}

/** Windows 自绘最大化按钮需要跟随每个窗口的真实最大化状态，而不是只监听主窗口。 */
export function installSessionWindowMaximizeNotifications(
  win: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return
  const notify = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, win.isMaximized())
  }
  win.on('maximize', notify)
  win.on('unmaximize', notify)
  win.on('restore', notify)
}

/** 会话窗口的窗口级平台适配：Windows 最大化推送 + Windows/Linux 隐藏原生菜单栏。 */
export function installSessionWindowChrome(
  win: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  installSessionWindowMaximizeNotifications(win, platform)
  // 完整 App 已绘制 MacTrafficLights，与 primary 保持唯一窗口按钮契约。
  if (platform === 'darwin') win.setWindowButtonVisibility(false)
  // 会话窗口没有标签栏，Windows/Linux 的全局菜单栏会压住自绘标题条；
  // 快捷键（含 Ctrl+W）由应用菜单加速器和 SessionWindowShortcuts 处理。
  if (platform !== 'darwin') win.setMenuBarVisibility(false)
}

function installWindowsZoomInFallback(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return
    const key = input.key.toLowerCase()
    if (!['=', '+', 'numadd', 'add'].includes(key)) return
    event.preventDefault()
    win.webContents.setZoomLevel(Math.min(win.webContents.getZoomLevel() + 0.5, 9))
  })
}

function installNavigationHandlers(win: BrowserWindow): void {
  const isDev = !app.isPackaged
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(VITE_DEV_SERVER_URL)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })
  // 与主窗口一致：内联可视化只能运行 srcDoc，阻止脚本 location 导航。
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && (event.frame?.url === 'about:srcdoc' || event.frame?.name.startsWith('profer-visualization:'))) {
      event.preventDefault()
    }
  })
}

function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  if (app.isPackaged) {
    void win.loadFile(join(__dirname, 'renderer', 'index.html'), query ? { query } : undefined)
    return
  }
  const url = query ? `${VITE_DEV_SERVER_URL}?${new URLSearchParams(query).toString()}` : VITE_DEV_SERVER_URL
  void win.loadURL(url)
}

/**
 * 创建独立会话窗口。
 *
 * 加载同一完整 App；会话和草稿由一次性 bootstrap 交付，等待 renderer 确认才完成移动。
 */
export function createSecondaryMainWindow(
  inputTab: unknown,
  sourceWindow?: BrowserWindow | null,
): Promise<OpenTabInNewWindowResult> {
  const initialTab = normalizeInitialTab(inputTab)
  if (!initialTab) return Promise.resolve({ ok: false, error: '不支持的标签类型' })

  const createdAt = Date.now()
  const sourceState = runCoreWindow(sourceWindow?.webContents.id, listCoreTargets)
  const sourceCore = { targetId: sourceState.currentId, coreId: sourceState.targets.find(target => target.id === sourceState.currentId)?.coreId }
  const key = `${sourceCore.coreId ?? sourceCore.targetId}:${initialTab.type}:${initialTab.sessionId}`
  const existing = pending.get(key)
  if (existing) {
    focusSessionWindow(existing.windowId)
    if (existing.sourceId !== sourceWindow?.webContents.id || JSON.stringify(existing.tab) !== JSON.stringify(initialTab)) return Promise.resolve({ ok: false, error: '此会话已有待完成交接，请保留当前草稿' })
    return Promise.resolve({ ok: true, accepted: true, handoffId: existing.id })
  }
  if (movingSessions.has(key)) return Promise.resolve({ ok: false, error: '会话正在移窗' })
  const owner = findOtherOwners(sourceWindow?.webContents, initialTab)[0]
  if (owner && focusSessionWindow(records.get(owner.webContents.id)!.id)) {
    // 只聚焦不代表草稿交付；不能返回 ok 触发源 renderer 清除标签和草稿。
    return Promise.resolve({ ok: false, error: '会话已在其他窗口打开，当前草稿已保留' })
  }
  const handoffId = randomUUID()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  // 最大化 / 全屏时用还原尺寸；会话窗口不照搬整个屏幕，限制在更适合阅读的尺寸。
  const sourceBounds = sourceWindow && !sourceWindow.isDestroyed()
    ? (sourceWindow.isMaximized() || sourceWindow.isFullScreen()
        ? sourceWindow.getNormalBounds()
        : sourceWindow.getBounds())
    : undefined
  const sourceSize = sourceBounds
    ? { width: sourceBounds.width, height: sourceBounds.height }
    : undefined
  const bounds = resolveSecondaryWindowBounds({
    cursor,
    workArea: display.workArea,
    sourceSize,
  })

  logLifecycle('window.handoff-phase', { handoffId, phase: 'before-create', elapsedMs: Date.now() - createdAt })
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    title: initialTab.title,
    icon: resolveAppWindowIconPath(),
    backgroundColor: getWindowFrameColor(),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // 与主窗口一致：隐藏/遮挡时仍要接收 Agent 实时事件，不能降频定时器。
      backgroundThrottling: false,
    },
    ...buildSessionTitleBarOptions(),
  })

  logLifecycle('window.handoff-phase', { handoffId, phase: 'window-constructed', elapsedMs: Date.now() - createdAt })
  const coreReady = initializeWindowCore(win.webContents.id, sourceWindow?.webContents.id)
  const record = registerMainAppWindow(win, { isPrimary: false, kind: 'main', initialTab })
  beginWindowHandoff(win.webContents.id, initialTab.sessionId)
  record.createdAt = createdAt
  record.phases = new Set()
  record.handoffId = handoffId
  record.timingHandoffId = handoffId
  // main 托管归属：在目标首次上报前也不允许其他窗口抢走会话。
  record.sessions = [{ type: initialTab.type, sessionId: initialTab.sessionId }]
  pending.set(key, { id: handoffId, windowId: record.id, sourceId: sourceWindow?.webContents.id, tab: { ...initialTab } })
  notifyMainAppWindowsChanged()
  const timer = setTimeout(() => record.completeBootstrap?.({ ok: false, error: '目标窗口初始化超时' }), 30_000)
  record.completeBootstrap = value => {
    if (pending.get(key)?.id !== handoffId) return
    clearTimeout(timer)
    pending.delete(key)
    record.completeBootstrap = undefined
    record.handoffId = undefined
    const event: WindowTabHandoffEvent = { sourceCore, status: value.ok ? 'committed' : 'failed', handoffId, tab: { ...initialTab }, ...(value.error ? { error: value.error } : {}) }
    if (!value.ok) recoverable.set(handoffId, event)
    const source = sourceWindow?.webContents
    if (source && !source.isDestroyed()) source.send(IPC_CHANNELS.WINDOW_TAB_HANDOFF, event)
    finishWindowHandoff(win.webContents, value.ok)
    if (value.ok) {
      if (record.initialTab) { delete record.initialTab.draft; delete record.initialTab.draftHtml }
      logWindowPhase(record, handoffId, 'confirmed')
    } else if (!win.isDestroyed()) win.destroy()
    notifyMainAppWindowsChanged()
  }
  win.webContents.once('render-process-gone', () => { logWindowPhase(record, handoffId, 'render-process-gone'); record.completeBootstrap?.({ ok: false, error: '目标窗口渲染进程退出' }) })
  win.webContents.once('did-start-loading', () => logWindowPhase(record, handoffId, 'did-start-loading'))
  win.webContents.once('did-finish-load', () => logWindowPhase(record, handoffId, 'did-finish-load'))
  win.webContents.once('dom-ready', () => logWindowPhase(record, handoffId, 'dom-ready'))
  installSessionWindowChrome(win)

  win.webContents.setZoomFactor(DEFAULT_MAIN_WINDOW_ZOOM_FACTOR)
  installWindowsZoomInFallback(win)
  installMacTrafficLightZoomSync(win)
  updateWindowFrameAppearance(win)
  installNavigationHandlers(win)



  // 会话窗口同样支持 ⌘/Ctrl+R 刷新；刷新后重新拉取会话与流状态。
  win.webContents.on('before-input-event', (event, input) => {
    const isRefresh = input.type === 'keyDown'
      && input.key.toLowerCase() === 'r'
      && (input.control || input.meta)
      && !input.alt
    if (!isRefresh) return
    event.preventDefault()
    win.webContents.reload()
  })

  win.once('ready-to-show', () => {
    logWindowPhase(record, handoffId, 'ready-to-show')
    if (!win.isDestroyed()) win.show()
  })
  win.on('enter-full-screen', () => win.webContents.send(IPC_CHANNELS.WINDOW_FULL_SCREEN_CHANGED, true))
  win.on('leave-full-screen', () => win.webContents.send(IPC_CHANNELS.WINDOW_FULL_SCREEN_CHANGED, false))
  win.on('page-title-updated', () => notifyMainAppWindowsChanged())
  win.on('minimize', () => notifyMainAppWindowsChanged())
  win.on('restore', () => notifyMainAppWindowsChanged())
  let loadRetries = 0
  // 兜底：renderer 加载异常时 ready-to-show 可能不触发，不能让窗口永远隐身。
  const revealFallback = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 3000)
  win.once('show', () => clearTimeout(revealFallback))
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[窗口] 会话窗口加载失败 code=${code} ${description}: ${url}`)
    // 开发态 dev server 端口抖动时有限次退避重试，避免新窗口停在错误页。
    if (!app.isPackaged && (code === -102 || code === -105) && loadRetries < 5) {
      loadRetries += 1
      setTimeout(() => {
        if (!win.isDestroyed()) loadRenderer(win)
      }, 500 * loadRetries)
    } else {
      record.completeBootstrap?.({ ok: false, error: `目标窗口加载失败: ${description}` })
    }
  })
  win.on('closed', () => {
    clearTimeout(revealFallback)
    console.log(`[窗口] 会话窗口已关闭: ${initialTab.sessionId}`)
  })

  // context 已同步继承，网络握手与 bundle 加载并行；交接仍由 renderer 确认。
  void coreReady.then(() => logWindowPhase(record, handoffId, 'core-ready')).catch(error => { logWindowPhase(record, handoffId, 'core-failed'); record.completeBootstrap?.({ ok: false, error: String(error) }) })
  loadRenderer(win)
  console.log(`[窗口] 已创建会话窗口: type=${initialTab.type} session=${initialTab.sessionId}`)
  logWindowPhase(record, handoffId, 'created')
  return Promise.resolve({ ok: true, accepted: true, handoffId })
}

/** 仅发布注册的完整应用窗口，不包含插件和预览。 */
export function getAppWindowSummaries(): AppWindowSummary[] {
  return [...records.values()].map(record => ({
    windowId: record.id, isPrimary: record.isPrimary,
    sessions: record.sessions.map(session => ({ ...session })),
  }))
}

export function normalizeWindowSessions(input: unknown): AppWindowSession[] {
  if (!Array.isArray(input)) throw new Error('窗口会话列表无效')
  const unique = new Map<string, AppWindowSession>()
  for (const item of input) {
    if (!item || (item.type !== 'chat' && item.type !== 'agent')
      || typeof item.sessionId !== 'string' || !item.sessionId.length || item.sessionId.length > 200) {
      throw new Error('窗口会话信息无效')
    }
    unique.set(`${item.type}:${item.sessionId}`, { type: item.type, sessionId: item.sessionId })
  }
  return [...unique.values()]
}

export function reportWindowSessions(sender: WebContents, input: unknown): void {
  const record = getRecordBySender(sender)
  if (!record) throw new Error('仅 Profer 主应用窗口可以上报会话')
  record.sessions = normalizeWindowSessions(input)
  record.sessionsReported = true
  if (!record.handoffId && record.initialTab && !ownsSession(record, record.initialTab)) record.initialTab = null
  // 源窗口收到 commit 后必须确实摘除标签；保留新编辑/新挂载的子树不能谎报搬迁成功。
  for (const move of pendingDetaches.values()) {
    if (move.source === sender && !ownsSession(record, move.session)) move.done()
  }
  notifyMainAppWindowsChanged()
}

export function confirmWindowBootstrap(sender: WebContents, handoffId?: string): void {
  const record = getRecordBySender(sender)
  if (!record) throw new Error('仅 Profer 主应用窗口可以确认引导')
  if (handoffId && !record.handoffId) throw new Error('窗口交接已结束')
  if (record.handoffId) {
    if (handoffId !== record.handoffId) throw new Error('窗口交接标识不匹配')
    const state = runCoreWindow(sender.id, listCoreTargets)
    if (state.startup === 'restoring' || state.startup === 'offline') throw new Error('目标 Core 尚未就绪')
    const tab = record.initialTab
    if (!record.sessionsReported || !tab || !record.sessions.some(item => item.type === tab.type && item.sessionId === tab.sessionId)) throw new Error('目标会话尚未注册')
  }
  const tab = record.initialTab
  if (record.handoffId && tab?.type === 'agent' && !tab.sessionId.startsWith('core:')) {
    // 同步恢复时临时去掉 pending 标记，让既有 backlog 回放完成后再 commit。
    const id = record.handoffId
    record.handoffId = undefined
    try { localHandoffRestore?.(sender, tab.sessionId) } finally { record.handoffId = id }
  }
  record.bootstrapReady = true
  record.completeBootstrap?.({ ok: true })
}

function ownsSession(record: MainAppWindowRecord | null | undefined, session: AppWindowSession): boolean {
  return !!record?.sessions.some(item => item.type === session.type && item.sessionId === session.sessionId)
}

/** 不使用过期上报把实际窗口切到另一个 Core；原始（无 namespace）ID 只属于本机。 */
function sessionRoute(sender: WebContents, session: AppWindowSession): WindowMoveCore | undefined {
  if (!getRecordBySender(sender)) return
  const state = runCoreWindow(sender.id, listCoreTargets)
  const target = state.targets.find(item => item.id === state.currentId)
  if (!target || state.startup === 'restoring' || state.startup === 'offline') return
  if (/^core(?:-chat)?:/.test(session.sessionId)) {
    const match = /^(core|core-chat):([^:]+):(.+)$/.exec(session.sessionId)
    if (!match || (match[1] === 'core') !== (session.type === 'agent') || target.status !== 'connected') return
    try { if (decodeURIComponent(match[2]!) !== target.coreId) return } catch { return }
  } else if (target.id !== 'local') return
  return { targetId: target.id, coreId: target.coreId, generation: state.generation }
}

function sameRoute(current: WindowMoveCore | undefined, expected: WindowMoveCore): boolean {
  return !!current && current.targetId === expected.targetId && current.coreId === expected.coreId && current.generation === expected.generation
}

function findOtherOwners(sender: WebContents | undefined, session: AppWindowSession): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(win => {
    if (win.isDestroyed() || win.webContents === sender) return false
    const record = getRecordBySender(win.webContents)
    return !!record && !record.handoffId && ownsSession(record, session) && !!sessionRoute(win.webContents, session)
  })
}

export async function focusWindowForSession(
  sender: WebContents, input: unknown,
  resolveTab: (session: AppWindowSession) => MainWindowTabPayload | null | Promise<MainWindowTabPayload | null>,
): Promise<boolean> {
  if (!getRecordBySender(sender)) throw new Error('仅 Profer 主应用窗口可以聚焦会话')
  const [session] = normalizeWindowSessions([input])
  if (!session) return false
  const origin = sessionRoute(sender, session)
  if (!origin) return false
  for (const win of findOtherOwners(sender, session)) {
    const target = win.webContents
    const route = sessionRoute(target, session)!
    const payload = await runCoreWindow(target.id, () => resolveTab(session))
    if (!sameRoute(sessionRoute(sender, session), origin)) return false
    if (!payload || win.isDestroyed() || !sameRoute(sessionRoute(target, session), route)) continue
    const record = getRecordBySender(target)
    if (!record || !ownsSession(record, session) || !focusSessionWindow(record.id)) continue
    target.send(IPC_CHANNELS.WINDOW_REATTACH_TAB, payload)
    return true
  }
  return false
}

const movingSessions = new Set<string>()
const incomingMoves = new Map<number, string>()
const pendingDetaches = new Map<string, { source: WebContents; session: AppWindowSession; done: () => void }>()
const moveReplies = new Map<string, { sender: WebContents; reply: (value: unknown) => void }>()

export function replyToWindowMove(sender: WebContents, id: unknown, value: unknown): void {
  if (typeof id !== 'string' || !getRecordBySender(sender)) return
  const waiting = moveReplies.get(id)
  if (waiting?.sender === sender) waiting.reply(value)
}

/** 仅指定窗口可答复；reload、关闭、崩溃和超时都清理待决请求。 */
function askMoveWindow(sender: WebContents, channel: string, request: PrepareWindowSessionMove | AcceptWindowSessionMove, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      moveReplies.delete(request.handoffId)
      fn()
    }
    const abort = (): void => finish(() => reject(new Error('交接窗口已关闭或重新加载')))
    const timer = setTimeout(() => finish(() => reject(new Error('窗口未及时确认交接'))), 10_000)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    moveReplies.set(request.handoffId, { sender, reply: value => finish(() => resolve(value)) })
    try { sender.send(channel, request) } catch (error) { finish(() => reject(error)) }
  })
}

/** 源窗口持有原标签直到目标明确接受并上报归属；旧响应和其他窗口无权提交。 */
export async function moveSessionToThisWindow(
  destination: WebContents, input: unknown,
  isChatActive: (sessionId: string) => Promise<boolean> | boolean,
): Promise<WindowMoveResult> {
  try {
    const [session] = normalizeWindowSessions([input])
    const destRecord = getRecordBySender(destination)
    if (!session || !destRecord || destRecord.handoffId) throw new Error('目标窗口不可用')
    if (ownsSession(destRecord, session)) throw new Error('此会话已在当前窗口打开')
    const destCore = sessionRoute(destination, session)
    if (!destCore) throw new Error('目标窗口 Core 不匹配或尚未就绪')
    const owners = findOtherOwners(destination, session)
    if (owners.length !== 1) throw new Error(owners.length ? '会话在多个窗口中打开，无法确定草稿来源' : '源窗口已关闭或不再持有会话')
    const source = owners[0]!.webContents
    const sourceCore = sessionRoute(source, session)!
    if (sourceCore.targetId !== destCore.targetId || sourceCore.coreId !== destCore.coreId) throw new Error('交接窗口的 Core 不匹配')
    const key = `${sourceCore.coreId ?? sourceCore.targetId}:${session.type}:${session.sessionId}`
    if (movingSessions.has(key) || incomingMoves.has(destination.id) || pending.has(key)) throw new Error('会话正在移窗')
    const handoffId = randomUUID()
    const controller = new AbortController()
    let sourceGone = false
    const abortSource = (): void => { sourceGone = true; controller.abort() }
    const abortTarget = (): void => controller.abort()
    const stopSource = watchMoveWindow(source, abortSource)
    const stopTarget = watchMoveWindow(destination, abortTarget)
    const guard = (): void => {
      if (controller.signal.aborted || !sameRoute(sessionRoute(destination, session), destCore)
        || !sameRoute(sessionRoute(source, session), sourceCore) || !ownsSession(getRecordBySender(source), session)) {
        throw new Error('窗口、会话归属或 Core 已变更，未完成交接')
      }
    }
    const guardStream = async (): Promise<void> => {
      if (session.type === 'chat' && await runCoreWindow(source.id, () => isChatActive(session.sessionId))) throw new Error('生成中的 Chat 暂不支持移窗')
      guard()
    }
    let tab: MainWindowTabPayload | null = null
    movingSessions.add(key)
    incomingMoves.set(destination.id, session.sessionId)
    let buffered = false
    let releaseSent = false
    try {
      await guardStream()
      const snapshot = await askMoveWindow(source, IPC_CHANNELS.WINDOW_MOVE_PREPARE, { handoffId, session, core: sourceCore }, controller.signal)
      if (!snapshot || typeof snapshot !== 'object' || !('tab' in snapshot)) throw new Error(moveError(snapshot, '源窗口无法交付会话'))
      const raw = snapshot.tab
      tab = normalizeInitialTab(raw)
      if (!raw || typeof raw !== 'object' || !tab || tab.type !== session.type || tab.sessionId !== session.sessionId
        || !('id' in raw) || raw.id !== tab.id || ('draft' in raw && raw.draft !== '' && raw.draft !== tab.draft)
        || ('draftHtml' in raw && raw.draftHtml !== '' && raw.draftHtml !== tab.draftHtml) || ('parentSessionId' in raw && raw.parentSessionId !== tab.parentSessionId)) {
        tab = null
        throw new Error('无法完整移交此标签或草稿，已保留源标签')
      }
      await guardStream()
      if (ownsSession(destRecord, session)) throw new Error('目标窗口已打开此会话')
      beginWindowHandoff(destination.id, session.sessionId)
      buffered = true
      const result = await askMoveWindow(destination, IPC_CHANNELS.WINDOW_MOVE_ACCEPT, { handoffId, tab, core: destCore }, controller.signal)
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error(moveError(result, '目标窗口未接受会话'))
      await guardStream()
      if (!ownsSession(destRecord, session)) throw new Error('目标窗口未确认会话归属')
      const event: WindowTabHandoffEvent = { handoffId, sourceCore, sourceGeneration: sourceCore.generation, existingWindowMove: true, tab, status: 'committed' }
      releaseSent = true
      await confirmSourceDetach(source, event, controller.signal)
      if (!sameRoute(sessionRoute(destination, session), destCore) || !ownsSession(destRecord, session)) throw new Error('目标窗口或 Core 已变化')
      incomingMoves.delete(destination.id)
      if (tab.type === 'agent' && !tab.sessionId.startsWith('core:')) {
        runCoreWindow(destination.id, () => localHandoffRestore?.(destination, session.sessionId))
      }
      finishWindowHandoff(destination, true)
      buffered = false
      return { ok: true }
    } catch (error) {
      // 源已关/刷新且目标未确认时仍托管最后一次完整草稿，复用既有恢复通道。
      if (tab && (sourceGone || source.isDestroyed() || (releaseSent && !ownsSession(getRecordBySender(source), session))
        || (releaseSent && controller.signal.aborted))) {
        recoverable.set(handoffId, { handoffId, sourceCore, tab, status: 'failed', error: '窗口状态已改变，交接未完成' })
      }
      throw error
    } finally {
      if (buffered) finishWindowHandoff(destination, false)
      incomingMoves.delete(destination.id)
      stopSource()
      stopTarget()
      movingSessions.delete(key)
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '移窗失败' }
  }
}

function confirmSourceDetach(source: WebContents, event: WindowTabHandoffEvent, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      pendingDetaches.delete(event.handoffId)
      callback()
    }
    const abort = (): void => finish(() => reject(new Error('交接窗口已关闭或重新加载')))
    const timer = setTimeout(() => finish(() => reject(new Error('目标已收到会话，但源标签未移除；请检查是否有新草稿或子会话'))), 5_000)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    pendingDetaches.set(event.handoffId, { source, session: event.tab, done: () => finish(resolve) })
    try { source.send(IPC_CHANNELS.WINDOW_TAB_HANDOFF, event) } catch (error) { finish(() => reject(error)) }
  })
}

function watchMoveWindow(contents: WebContents, abort: () => void): () => void {
  contents.once('destroyed', abort)
  contents.once('render-process-gone', abort)
  contents.once('did-start-loading', abort)
  return () => {
    contents.removeListener('destroyed', abort)
    contents.removeListener('render-process-gone', abort)
    contents.removeListener('did-start-loading', abort)
  }
}

function moveError(value: unknown, fallback: string): string {
  return value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
    ? value.error.slice(0, 300) || fallback : fallback
}

/** 活着的次级窗口是否仍实际承载指定会话（不消费 bootstrap 草稿）。 */
export function isSecondaryWindowSessionOwner(sender: WebContents | null, session: AppWindowSession): boolean {
  const record = getRecordBySender(sender)
  return !!record && !record.isPrimary && record.sessions.some(item => (
    item.type === session.type && item.sessionId === session.sessionId
  ))
}

/** 恢复请求先安装 listener，但 pending 本机流只在确认时回放一次。 */
export function isWindowTabHandoffPending(sender: WebContents, sessionId: string): boolean {
 const record = getRecordBySender(sender)
 return incomingMoves.get(sender.id) === sessionId || (!!record?.handoffId && record.initialTab?.sessionId === sessionId)
}

let localHandoffRestore: ((sender: WebContents, sessionId: string) => void) | undefined
export function setLocalHandoffRestore(handler: typeof localHandoffRestore): void { localHandoffRestore = handler }

export function ackWindowTabHandoff(sender: WebContents, handoffId: string): void {
 if (!getRecordBySender(sender)) throw new Error('仅完整应用窗口可以确认恢复')
 const event = recoverable.get(handoffId)
 if (!event) throw new Error('不存在可恢复的失败交接')
 const state = runCoreWindow(sender.id, listCoreTargets)
 const coreId = state.targets.find(target => target.id === state.currentId)?.coreId
 if (state.startup === 'restoring' || state.startup === 'offline' || state.currentId !== event.sourceCore.targetId || coreId !== event.sourceCore.coreId) throw new Error('恢复窗口 Core 不匹配或尚未就绪')
 recoverable.delete(handoffId)
}

const RENDERER_WINDOW_PHASES = new Set(['app-ready', 'target-meta-ready', 'target-interactive'])
function logWindowPhase(record: MainAppWindowRecord, handoffId: string, phase: string): void {
 if (record.phases?.has(phase)) return
 record.phases?.add(phase)
 logLifecycle('window.handoff-phase', { handoffId, windowId: record.id, phase, elapsedMs: Date.now() - (record.createdAt ?? Date.now()) })
}
export function reportWindowPhase(sender: WebContents, phase: unknown): void {
 const record = getRecordBySender(sender)
 if (!record) throw new Error('仅完整应用窗口可以上报阶段')
 if (typeof phase !== 'string' || !RENDERER_WINDOW_PHASES.has(phase)) throw new Error('无效窗口阶段')
 // 不接收 Renderer 提交的 ID、时间或任意数据。
 // 只记录首次开窗；刷新沿用 phases 去重，不重置时间或重新开放交接权限。
 if (record.timingHandoffId) logWindowPhase(record, record.timingHandoffId, phase)
}
