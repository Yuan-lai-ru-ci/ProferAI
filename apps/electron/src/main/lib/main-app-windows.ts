/**
 * 主应用窗口注册表与独立会话窗口创建。
 *
 * - 主窗口：完整 Profer 主界面，负责全局 Tab 持久化与启动闪屏；
 * - 会话窗口：只渲染一个被拆出的 chat / agent 会话，不复制侧边栏和全局初始化器；
 * - 浏览器 / 插件页依赖主窗口原生 View，文件预览属于会话工作 Tab，暂不迁移。
 */

import { app, BrowserWindow, screen, shell } from 'electron'
import type { WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  MainWindowBootstrap,
  MainWindowKind,
  MainWindowTabPayload,
  OpenTabInNewWindowResult,
} from '@profer/shared'
import { IPC_CHANNELS } from '@profer/shared'
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
}

/** 以 webContents.id 为键：窗口重建后 id 变化，不会误命中旧记录。 */
const records = new Map<number, MainAppWindowRecord>()

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
    kind: options.kind ?? (options.isPrimary ? 'main' : 'session'),
    isPrimary: options.isPrimary,
    initialTab: options.initialTab ?? null,
  }
  const webContentsId = win.webContents.id
  records.set(webContentsId, record)
  notifyMainAppWindowsChanged()
  win.once('closed', () => {
    records.delete(webContentsId)
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
    if (!record || record.kind !== 'session') continue
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
      && records.get(candidate.webContents.id)?.kind === 'session'
  })
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}

let mainAppWindowsChangedHandler: (() => void) | null = null

/** 应用层注册窗口集合变化回调（用于重建动态 Window 菜单）。 */
export function setMainAppWindowsChangedHandler(handler: (() => void) | null): void {
  mainAppWindowsChangedHandler = handler
}

/** 通知菜单等宿主窗口集合已变化。 */
export function notifyMainAppWindowsChanged(): void {
  mainAppWindowsChangedHandler?.()
}

/** 读取当前窗口的引导信息；非主应用窗口返回 null。 */
export function getMainWindowBootstrap(sender: WebContents | undefined | null): MainWindowBootstrap | null {
  const record = getRecordBySender(sender)
  if (!record) return null
  // 草稿只交付一次：刷新后不把用户已清空的旧草稿重新写回编辑器。
  const initialTab = record.initialTab ? { ...record.initialTab } : null
  if (record.initialTab?.draft || record.initialTab?.draftHtml) {
    const rest = { ...record.initialTab }
    delete rest.draft
    delete rest.draftHtml
    record.initialTab = rest
  }
  return {
    windowId: record.id,
    kind: record.kind,
    isPrimary: record.isPrimary,
    initialTab,
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

function getIconPath(): string | undefined {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
  const iconPath = process.platform === 'darwin'
    ? join(resourcesDir, 'icon.icns')
    : process.platform === 'win32'
      ? join(resourcesDir, 'icon.ico')
      : join(resourcesDir, 'icon.png')
  return existsSync(iconPath) ? iconPath : undefined
}

export function buildSessionTitleBarOptions(platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  if (platform === 'darwin') {
    // 独立会话窗口保留原生交通灯：轻量壳只需要一条拖拽条，不必再自绘窗口按钮。
    return {
      titleBarStyle: 'hiddenInset',
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
 * 窗口只渲染被拆出的 chat / agent 会话（`window=session`），不加载完整主界面；
 * 会话元数据、草稿和初始标题通过窗口引导信息与 URL query 传入。
 */
export function createSecondaryMainWindow(
  inputTab: unknown,
  sourceWindow?: BrowserWindow | null,
): OpenTabInNewWindowResult {
  const initialTab = normalizeInitialTab(inputTab)
  if (!initialTab) return { ok: false, error: '不支持的标签类型' }

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  // 最大化 / 全屏时用还原尺寸；会话窗口不照搬整个屏幕，限制在更适合阅读的尺寸。
  const sourceBounds = sourceWindow && !sourceWindow.isDestroyed()
    ? (sourceWindow.isMaximized() || sourceWindow.isFullScreen()
        ? sourceWindow.getNormalBounds()
        : sourceWindow.getBounds())
    : undefined
  const sourceSize = sourceBounds
    ? { width: Math.min(sourceBounds.width, 1100), height: Math.min(sourceBounds.height, 900) }
    : undefined
  const bounds = resolveSecondaryWindowBounds({
    cursor,
    workArea: display.workArea,
    sourceSize,
  })

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 560,
    minHeight: 480,
    title: initialTab.title,
    icon: getIconPath(),
    backgroundColor: getWindowFrameColor(),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 与主窗口一致：隐藏/遮挡时仍要接收 Agent 实时事件，不能降频定时器。
      backgroundThrottling: false,
    },
    ...buildSessionTitleBarOptions(),
  })

  registerMainAppWindow(win, { isPrimary: false, kind: 'session', initialTab })
  installSessionWindowChrome(win)

  win.webContents.setZoomFactor(DEFAULT_MAIN_WINDOW_ZOOM_FACTOR)
  installWindowsZoomInFallback(win)
  installMacTrafficLightZoomSync(win)
  updateWindowFrameAppearance(win)
  installNavigationHandlers(win)

  const windowQuery = {
    window: 'session',
    sessionId: initialTab.sessionId,
    sessionType: initialTab.type,
  }

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
    if (!win.isDestroyed()) win.show()
  })
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
        if (!win.isDestroyed()) loadRenderer(win, windowQuery)
      }, 500 * loadRetries)
    }
  })
  win.on('closed', () => {
    clearTimeout(revealFallback)
    console.log(`[窗口] 会话窗口已关闭: ${initialTab.sessionId}`)
  })

  loadRenderer(win, windowQuery)
  console.log(`[窗口] 已创建会话窗口: type=${initialTab.type} session=${initialTab.sessionId}`)
  return { ok: true }
}
