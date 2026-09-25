import { app, BrowserWindow, screen, type Display } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  PROFER_PLUGIN_ID_PATTERN,
  PROFER_PLUGIN_PAGE_ID_PATTERN,
  allowsPluginPagePlacement,
  type ProferPluginFloatingWindowBounds,
  type ProferPluginFloatingWindowConfig,
} from '@profer/plugin-api'
import { getPluginDataDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { getInstalledPlugin, resolvePluginPage } from './plugin-manager'
import { pluginRequests } from './plugin-requests'
import { ensurePluginSession } from './plugin-session'

/**
 * 悬浮窗口管理器。
 *
 * 每个「插件 + 页面」最多一个独立 BrowserWindow，与主窗口 WebContentsView 完全分离：
 * - 同一 preload（plugin-preload.cjs），插件页面只拿到受控 Plugin Host API；
 * - 不复用插件 session partition（partition 已绑定主窗口 View 的 protocol/guard，
 *   悬浮窗口页面资源经主窗口插件协议由宿主转发，见 plugin-view-manager 的 session 注册）；
 *   为隔离与最小变更，悬浮窗口复用同一 partition，使 profer-plugin:// 协议、CSP、下载/权限拒绝
 *   与主窗口插件页面保持一致。
 * - 窗口身份由宿主按 webContents 归属绑定，插件不能伪造 pluginId/pageId。
 */

const WINDOW_STATE_VERSION = 1
const MIN_VISIBLE_PX = 48
const MAX_SAVED_AGE_MS = 365 * 24 * 60 * 60 * 1000

interface FloatingWindowRecord {
  key: string
  pluginId: string
  pageId: string
  window: BrowserWindow
  webContentsId: number
  /** 是否已被宿主销毁（防止 closed 事件重复清理）。 */
  destroyed: boolean
}

interface PersistedWindowState {
  version: number
  savedAt: number
  bounds?: ProferPluginFloatingWindowBounds
}

function floatingKey(pluginId: string, pageId: string): string {
  return `${pluginId}::${pageId}`
}

function isSafeIdentity(pluginId: string, pageId: string): boolean {
  return PROFER_PLUGIN_ID_PATTERN.test(pluginId) && PROFER_PLUGIN_PAGE_ID_PATTERN.test(pageId)
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)))
}

/** 把目标矩形钳制到某台显示器的可见工作区内；多显示器时选重叠面积最大的那台。 */
export function clampBoundsToDisplays(
  bounds: ProferPluginFloatingWindowBounds,
  displays: Array<Pick<Display, 'workArea'>>,
): ProferPluginFloatingWindowBounds {
  const width = Math.max(MIN_VISIBLE_PX, Math.round(bounds.width))
  const height = Math.max(MIN_VISIBLE_PX, Math.round(bounds.height))
  let best: { display: Pick<Display, 'workArea'>; overlap: number } | null = null
  for (const display of displays) {
    const area = display.workArea
    const overlapWidth = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x)
    const overlapHeight = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y)
    const overlap = Math.max(0, overlapWidth) * Math.max(0, overlapHeight)
    if (!best || overlap > best.overlap) best = { display, overlap }
  }
  const target = best && best.overlap > 0 ? best.display : displays[0]
  if (!target) return { x: 0, y: 0, width, height }
  const area = target.workArea
  const maxWidth = Math.max(MIN_VISIBLE_PX, area.width)
  const maxHeight = Math.max(MIN_VISIBLE_PX, area.height)
  const finalWidth = Math.min(width, maxWidth)
  const finalHeight = Math.min(height, maxHeight)
  const x = clampInt(bounds.x, area.x, area.x + area.width - finalWidth)
  const y = clampInt(bounds.y, area.y, area.y + area.height - finalHeight)
  return { x, y, width: finalWidth, height: finalHeight }
}

function resolveWindowConfig(page: { floatingWindow?: ProferPluginFloatingWindowConfig }): Required<ProferPluginFloatingWindowConfig> {
  const declared = page.floatingWindow ?? {}
  return {
    width: declared.width ?? 320,
    height: declared.height ?? 240,
    minWidth: declared.minWidth ?? 48,
    minHeight: declared.minHeight ?? 48,
    maxWidth: declared.maxWidth ?? 1920,
    maxHeight: declared.maxHeight ?? 1920,
    transparent: declared.transparent ?? false,
    frame: declared.frame ?? false,
    alwaysOnTop: declared.alwaysOnTop ?? true,
    skipTaskbar: declared.skipTaskbar ?? true,
    resizable: declared.resizable ?? true,
    movable: declared.movable ?? true,
    showOnStart: declared.showOnStart ?? false,
    focusable: declared.focusable ?? true,
    visibleOnAllWorkspaces: declared.visibleOnAllWorkspaces ?? false,
    clickThrough: declared.clickThrough ?? false,
  }
}

export class PluginFloatingWindowManager {
  private readonly windows = new Map<string, FloatingWindowRecord>()
  private readonly webContentsOwners = new Map<number, { pluginId: string; pageId: string; key: string }>()
  private screenListenersInstalled = false

  /** 供 PluginViewManager.ownerFor 识别悬浮窗口页面身份；返回 undefined 表示不是悬浮窗口页面。 */
  ownerForWebContents(webContentsId: number): { pluginId: string; pageId: string; key: string } | undefined {
    return this.webContentsOwners.get(webContentsId)
  }

  isFloatingWebContents(webContentsId: number): boolean {
    return this.webContentsOwners.has(webContentsId)
  }

  private windowStateFile(pluginId: string, pageId: string): string {
    const dir = join(getPluginDataDir(), pluginId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, `floating-window-${pageId}.json`)
  }

  private readPersistedBounds(pluginId: string, pageId: string): ProferPluginFloatingWindowBounds | null {
    const parsed = readJsonFileSafe<PersistedWindowState>(this.windowStateFile(pluginId, pageId))
    if (!parsed || parsed.version !== WINDOW_STATE_VERSION || !parsed.bounds) return null
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_SAVED_AGE_MS) return null
    const { x, y, width, height } = parsed.bounds
    if (![x, y, width, height].every((value) => Number.isFinite(value))) return null
    if (width < MIN_VISIBLE_PX || height < MIN_VISIBLE_PX) return null
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  }

  private persistBounds(pluginId: string, pageId: string, bounds: ProferPluginFloatingWindowBounds): void {
    const state: PersistedWindowState = { version: WINDOW_STATE_VERSION, savedAt: Date.now(), bounds }
    try { writeJsonFileAtomic(this.windowStateFile(pluginId, pageId), state) } catch { /* 位置持久化失败不影响窗口运行 */ }
  }

  private installScreenListeners(): void {
    if (this.screenListenersInstalled) return
    this.screenListenersInstalled = true
    const reclamp = (): void => {
      const displays = screen.getAllDisplays()
      // 睡眠/锁屏/蛤壳模式下可能短暂读不到显示器；此时不动窗口，避免被钳到原点。
      if (displays.length === 0) return
      for (const record of this.windows.values()) {
        if (record.destroyed || record.window.isDestroyed()) continue
        const bounds = record.window.getBounds()
        const clamped = clampBoundsToDisplays(bounds, displays)
        if (clamped.x !== bounds.x || clamped.y !== bounds.y || clamped.width !== bounds.width || clamped.height !== bounds.height) {
          record.window.setBounds(clamped)
        }
      }
    }
    screen.on('display-removed', reclamp)
    screen.on('display-metrics-changed', reclamp)
  }

  /** 打开（或复用）悬浮窗口并显示；返回实际生效的边界。 */
  open(pluginId: string, pageId: string): ProferPluginFloatingWindowBounds {
    if (!isSafeIdentity(pluginId, pageId)) throw new Error('插件页面标识非法')
    const key = floatingKey(pluginId, pageId)
    const existing = this.windows.get(key)
    if (existing && !existing.destroyed && !existing.window.isDestroyed()) {
      if (!existing.window.isVisible()) existing.window.show()
      return existing.window.getBounds()
    }

    const { page } = resolvePluginPage(pluginId, pageId, 'floating')
    // 悬浮窗口可能是该插件的第一个页面：必须先注册协议 handler 与会话守卫，
    // 否则 loadURL(profer-plugin://) 会被默认拒绝。
    ensurePluginSession(pluginId)
    const config = resolveWindowConfig(page)
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    const persisted = this.readPersistedBounds(pluginId, pageId)

    const baseWidth = clampInt(config.width, config.minWidth, config.maxWidth)
    const baseHeight = clampInt(config.height, config.minHeight, config.maxHeight)
    const initial = persisted
      ? clampBoundsToDisplays({ ...persisted, width: clampInt(persisted.width, config.minWidth, config.maxWidth), height: clampInt(persisted.height, config.minHeight, config.maxHeight) }, displays)
      : clampBoundsToDisplays({
          x: primary.workArea.x + primary.workArea.width - baseWidth - 24,
          y: primary.workArea.y + primary.workArea.height - baseHeight - 24,
          width: baseWidth,
          height: baseHeight,
        }, displays)

    const window = new BrowserWindow({
      x: initial.x,
      y: initial.y,
      width: initial.width,
      height: initial.height,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      maxWidth: config.maxWidth,
      maxHeight: config.maxHeight,
      // 总是先隐藏创建，加载后统一 show，避免未加载窗口闪烁；showOnStart 仅作为插件声明的语义记录。
      show: false,
      frame: config.frame,
      transparent: config.transparent,
      alwaysOnTop: config.alwaysOnTop,
      skipTaskbar: config.skipTaskbar,
      resizable: config.resizable,
      movable: config.movable,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: !config.transparent,
      // 贞宠类窗口（focusable:false）不抢焦点；macOS 上接受首次点击事件。
      focusable: config.focusable,
      acceptFirstMouse: true,
      webPreferences: {
        // 与主窗口插件页面共用 partition，复用同一 profer-plugin:// 协议、CSP 与会话守卫。
        partition: `profer-plugin-${pluginId}`,
        preload: resolve(__dirname, 'plugin-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    })

    const record: FloatingWindowRecord = {
      key,
      pluginId,
      pageId,
      window,
      webContentsId: window.webContents.id,
      destroyed: false,
    }
    this.windows.set(key, record)
    this.webContentsOwners.set(window.webContents.id, { pluginId, pageId, key })
    this.installScreenListeners()

    // macOS：声明后窗口在所有 Space 及其他应用全屏时仍然可见（BongoCat 的 NSPanel 等价行为）。
    if (config.visibleOnAllWorkspaces && process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    if (config.clickThrough) window.setIgnoreMouseEvents(true, { forward: true })

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const allowPluginNavigation = (event: Electron.Event, url: string): void => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'profer-plugin:' && parsed.hostname === pluginId) return
      } catch { /* 非法 URL 一律拒绝 */ }
      event.preventDefault()
    }
    window.webContents.on('will-navigate', (event, url) => allowPluginNavigation(event, url))
    window.webContents.on('will-redirect', (event, url) => allowPluginNavigation(event, url))
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      console.error(`[插件] 悬浮页面加载失败 ${pluginId}/${pageId}: ${errorCode} ${errorDescription} ${validatedURL}`)
      this.disposeRecord(record)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[插件] 悬浮页面渲染进程退出 ${pluginId}/${pageId}: ${details.reason}`)
      this.disposeRecord(record)
    })
    window.on('moved', () => {
      if (record.destroyed || window.isDestroyed()) return
      this.persistBounds(pluginId, pageId, window.getBounds())
    })
    window.on('resized', () => {
      if (record.destroyed || window.isDestroyed()) return
      this.persistBounds(pluginId, pageId, window.getBounds())
    })
    window.on('closed', () => {
      this.webContentsOwners.delete(record.webContentsId)
      if (this.windows.get(key) === record) this.windows.delete(key)
      record.destroyed = true
    })

    void window.webContents.loadURL(`profer-plugin://${pluginId}/${page.entry}`).catch((error) => {
      console.error(`[插件] 悬浮页面加载失败 ${pluginId}/${pageId}:`, error)
      this.disposeRecord(record)
    })

    window.show()
    return window.getBounds()
  }

  show(pluginId: string, pageId: string): void {
    const record = this.windows.get(floatingKey(pluginId, pageId))
    if (!record || record.destroyed || record.window.isDestroyed()) return
    record.window.show()
  }

  hide(pluginId: string, pageId: string): void {
    const record = this.windows.get(floatingKey(pluginId, pageId))
    if (!record || record.destroyed || record.window.isDestroyed()) return
    record.window.hide()
  }

  close(pluginId: string, pageId: string): void {
    const record = this.windows.get(floatingKey(pluginId, pageId))
    if (record) this.disposeRecord(record)
  }

  isVisible(pluginId: string, pageId: string): boolean {
    const record = this.windows.get(floatingKey(pluginId, pageId))
    return Boolean(record && !record.destroyed && !record.window.isDestroyed() && record.window.isVisible())
  }

  getBounds(pluginId: string, pageId: string): ProferPluginFloatingWindowBounds | null {
    const record = this.windows.get(floatingKey(pluginId, pageId))
    if (!record || record.destroyed || record.window.isDestroyed()) return null
    return record.window.getBounds()
  }

  setBounds(pluginId: string, pageId: string, position: Partial<Pick<ProferPluginFloatingWindowBounds, 'x' | 'y'>>): ProferPluginFloatingWindowBounds {
    const record = this.windows.get(floatingKey(pluginId, pageId))
    if (!record || record.destroyed || record.window.isDestroyed()) throw new Error('悬浮窗口不存在')
    const current = record.window.getBounds()
    const next = clampBoundsToDisplays(
      {
        x: typeof position.x === 'number' && Number.isFinite(position.x) ? Math.round(position.x) : current.x,
        y: typeof position.y === 'number' && Number.isFinite(position.y) ? Math.round(position.y) : current.y,
        width: current.width,
        height: current.height,
      },
      screen.getAllDisplays(),
    )
    record.window.setBounds(next)
    this.persistBounds(pluginId, pageId, next)
    return next
  }

  setIgnoreMouseEvents(pluginId: string, pageId: string, ignore: boolean): void {
    const record = this.windows.get(floatingKey(pluginId, pageId))
    if (!record || record.destroyed || record.window.isDestroyed()) throw new Error('悬浮窗口不存在')
    // forward 让页面继续收到 mousemove，插件可自行实现“悬停退出穿透”等交互。
    record.window.setIgnoreMouseEvents(ignore, { forward: true })
  }

  /** 停用/撤权/卸载/替换安装时销毁该插件全部悬浮窗口。 */
  closePlugin(pluginId: string): void {
    for (const record of [...this.windows.values()]) {
      if (record.pluginId === pluginId) this.disposeRecord(record)
    }
  }

  private disposeRecord(record: FloatingWindowRecord): void {
    if (this.windows.get(record.key) !== record) return
    pluginRequests.cancelOwner(record.webContentsId)
    this.windows.delete(record.key)
    this.webContentsOwners.delete(record.webContentsId)
    record.destroyed = true
    // 位置记忆属于插件私有数据，仅随插件数据目录清理；窗口销毁（含撤权/停用）保留记忆，
    // 重开时经钳制后恢复，不会越过当前显示器布局。
    if (!record.window.isDestroyed()) record.window.destroy()
  }

  /** 应用退出前清理所有悬浮窗口，避免孤立窗口。 */
  dispose(): void {
    for (const record of [...this.windows.values()]) this.disposeRecord(record)
    this.windows.clear()
    this.webContentsOwners.clear()
  }
}

export const pluginFloatingWindowManager = new PluginFloatingWindowManager()

/** 校验调用方是否允许操作悬浮窗口：页面必须声明 floating placement。 */
export function assertFloatingPageAllowed(pluginId: string, pageId: string): void {
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin) throw new Error('插件不存在')
  const page = plugin.manifest.contributes.pages?.find((candidate) => candidate.id === pageId)
  if (!page || !allowsPluginPagePlacement(page, 'floating')) {
    throw new Error('插件页面未声明悬浮窗口入口')
  }
}
