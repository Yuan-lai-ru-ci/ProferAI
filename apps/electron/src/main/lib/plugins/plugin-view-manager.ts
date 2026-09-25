import type { ProferPluginTaskReference, ProferPluginViewInstance } from '@profer/plugin-api'
import { callPluginHost } from './plugin-host'
import { pluginViewKey } from './plugin-view-instance'
import { dispatchPluginRpc, validatePluginRpcRequest, PROTOCOL } from './plugin-host-rpc'
import { PluginRpcError, toPluginRpcFailure } from './plugin-rpc-errors'
import { pluginRequests } from './plugin-requests'
import { pluginToolBroker } from './plugin-tool-broker'
import { assertPluginPermission } from './plugin-permissions'
import { app, ipcMain, nativeTheme, View, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { resolve } from 'node:path'
import { ensurePluginSession } from './plugin-session'
import {
  PROFER_PLUGIN_HOST_CHANNELS,
  PROFER_PLUGIN_ID_PATTERN,
  PROFER_PLUGIN_PAGE_ID_PATTERN,
  type ProferPluginContext,
  type ProferPluginViewLayout,
} from '@profer/plugin-api'
import { pluginFloatingWindowManager } from './plugin-floating-window'
import { getSettings, subscribeSettingsChanges } from '../settings-service'
import { resolveBrowserViewportLayout } from '../browser-view-layout'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { getInstalledPlugin, resolveInstalledPluginRoot, resolvePluginDataFile, resolvePluginPage } from './plugin-manager'

function readPluginStorage(file: string): Record<string, unknown> {
  const parsed = readJsonFileSafe<unknown>(file)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

const MAX_STORAGE_BYTES = 512 * 1024
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RESERVED_STORAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
interface PluginViewRecord {
  key: string
  pluginId: string
  pageId: string
  hostView: View
  pageView: WebContentsView
  webContentsId: number
  partition: string
  lastRendererInstanceId: string | null
  lastLayoutSourceRevision: number
  lastRevision: number
  lastVisible: boolean
  taskContext: ProferPluginTaskReference | null
  instance: ProferPluginViewInstance
}

function pageKey(pluginId: string, pageId: string, instance: ProferPluginViewInstance = { kind: 'tab' }): string {
  return pluginViewKey(pluginId, pageId, instance)
}

function isSafePageIdentity(pluginId: string, pageId: string): boolean {
  return PROFER_PLUGIN_ID_PATTERN.test(pluginId) && PROFER_PLUGIN_PAGE_ID_PATTERN.test(pageId)
}

function validateLayout(layout: ProferPluginViewLayout): void {
  if (!isSafePageIdentity(layout.pluginId, layout.pageId)) throw new Error('插件页面标识非法')
  if (!layout.instance || !['tab', 'tool'].includes(layout.instance.kind)) throw new Error('插件页面实例非法')
  if ('task' in layout.instance) throw new Error('此插件页面实例不能绑定任务')
  if (!layout.rendererInstanceId || layout.rendererInstanceId.length > 100) throw new Error('rendererInstanceId 非法')
  if (!Number.isSafeInteger(layout.layoutSourceRevision) || layout.layoutSourceRevision <= 0) throw new Error('layoutSourceRevision 非法')
  if (!Number.isSafeInteger(layout.revision) || layout.revision <= 0) throw new Error('revision 非法')
  for (const value of Object.values(layout.bounds)) {
    if (!Number.isFinite(value)) throw new Error('插件页面边界非法')
  }
}

export class PluginViewManager {
  private owner: BrowserWindow | null = null
  private readonly views = new Map<string, PluginViewRecord>()
  private readonly webContentsOwners = new Map<number, { pluginId: string; pageId: string; key: string }>()

  setOwnerWindow(window: BrowserWindow | null): void {
    if (this.owner === window) return
    this.dispose()
    this.owner = window
  }

  private create(pluginId: string, pageId: string, instance: ProferPluginViewInstance = { kind: 'tab' }): PluginViewRecord {
    if (!this.owner || this.owner.isDestroyed()) throw new Error('主窗口尚未就绪')
    const { page } = resolvePluginPage(pluginId, pageId)
    // 协议 handler 与会话守卫由共享注册保证（悬浮窗口可能先于主窗口页面创建）。
    ensurePluginSession(pluginId)
    const partition = `profer-plugin-${pluginId}`

    const hostView = new View()
    const pageView = new WebContentsView({
      webPreferences: {
        partition,
        preload: resolve(__dirname, 'plugin-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    })
    hostView.setVisible(false)
    hostView.addChildView(pageView)
    this.owner.contentView.addChildView(hostView)
    const key = pageKey(pluginId, pageId, instance)
    const record: PluginViewRecord = {
      key,
      pluginId,
      pageId,
      hostView,
      pageView,
      webContentsId: pageView.webContents.id,
      partition,
      lastRendererInstanceId: null,
      lastLayoutSourceRevision: 0,
      lastRevision: 0,
      lastVisible: false,
      taskContext: null,
      instance,
    }
    this.views.set(key, record)
    this.webContentsOwners.set(pageView.webContents.id, { pluginId, pageId, key })

    pageView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const allowPluginNavigation = (event: Electron.Event, url: string): void => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'profer-plugin:' && parsed.hostname === pluginId) return
      } catch { /* 非法 URL 一律拒绝 */ }
      event.preventDefault()
    }
    pageView.webContents.on('will-navigate', (event, url) => allowPluginNavigation(event, url))
    pageView.webContents.on('will-redirect', (event, url) => allowPluginNavigation(event, url))
    pageView.webContents.on('will-attach-webview', (event) => event.preventDefault())
    let hasStartedNavigation = false
    pageView.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return
      if (hasStartedNavigation) { pluginToolBroker.dispose(pageView.webContents.id); pluginRequests.cancelOwner(pageView.webContents.id) }
      hasStartedNavigation = true
    })
    pageView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) console.error(`[插件] 页面加载失败 ${pluginId}/${pageId}: ${errorCode} ${errorDescription} ${validatedURL}`)
    })
    pageView.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[插件] 页面渲染进程退出 ${pluginId}/${pageId}: ${details.reason}`)
      this.disposeRecord(record)
    })
    pageView.webContents.on('destroyed', () => {
      this.webContentsOwners.delete(record.webContentsId)
      if (this.views.get(key) === record) this.disposeRecord(record)
    })
    void pageView.webContents.loadURL(`profer-plugin://${pluginId}/${page.entry}`).catch((error) => {
      console.error(`[插件] 页面加载失败 ${pluginId}/${pageId}:`, error)
    })
    return record
  }

  activate(pluginId: string, pageId: string, context: ProferPluginTaskReference | null, instance: ProferPluginViewInstance = { kind: 'tab' }): void {
    const key = pageKey(pluginId, pageId, instance)
    const record = this.views.get(key) ?? this.create(pluginId, pageId, instance)
    record.taskContext = instance.kind === 'tool' ? null : context
    record.instance = instance
    this.notifyContextChanged()
  }

  notifyContextChanged(): void {
    for (const record of this.views.values()) {
      const contents = record.pageView.webContents
      if (contents.isDestroyed()) continue
      try { contents.send(PROFER_PLUGIN_HOST_CHANNELS.CONTEXT_CHANGED, this.getContext(contents, contents.mainFrame)) } catch { /* 停用中的页面不再通知 */ }
    }
  }

  async runTool(pluginId: string, toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    assertPluginPermission(pluginId, 'agent.tools')
    const plugin = getInstalledPlugin(pluginId)
    const tool = plugin?.manifest.contributes.tools?.find((candidate) => candidate.id === toolId)
    if (!tool) throw new Error('插件工具不存在')
    const record = this.views.get(pageKey(pluginId, tool.pageId, { kind: 'tool' })) ?? this.create(pluginId, tool.pageId, { kind: 'tool' })
    return pluginToolBroker.run(pluginId, toolId, args, record.pageView.webContents, signal)
  }

  async call(sender: WebContents, frame: Electron.WebFrameMain | null, rawRequest: unknown): Promise<unknown> {
    const request = (() => {
      try { return validatePluginRpcRequest(rawRequest) } catch { return null }
    })()
    const requestId = request?.requestId ?? 'invalid-request'
    const operation = request?.operation ?? 'invalid.request'
    let owner: { pluginId: string; pageId: string; key: string }
    try {
      owner = this.ownerFor(sender, frame, true)
    } catch (error) {
      const failure = error instanceof Error && error.message.includes('页面')
        ? new PluginRpcError('PLUGIN_PAGE_CLOSED', '插件页面已关闭')
        : new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件页面上下文非法')
      return { ...toPluginRpcFailure(failure), requestId, operation }
    }
    const context = {
      pluginId: owner.pluginId,
      pageId: owner.pageId,
      ownerId: sender.id,
      requestId,
      operation,
      signal: new AbortController().signal,
    }
    return dispatchPluginRpc(rawRequest, context, (payload, requestContext) => callPluginHost(
      { protocol: PROTOCOL, requestId: requestContext.requestId, operation: requestContext.operation, payload },
      requestContext,
      this.views.get(owner.key)?.taskContext ?? null,
    ))
  }

  registerTool(sender: WebContents, frame: Electron.WebFrameMain | null, toolId: unknown): void {
    const owner = this.ownerFor(sender, frame)
    pluginToolBroker.register(owner.pluginId, owner.pageId, sender.id, toolId)
  }

  toolResult(sender: WebContents, frame: Electron.WebFrameMain | null, callId: unknown, value: unknown, error: unknown): void {
    this.ownerFor(sender, frame)
    pluginToolBroker.result(sender.id, callId, value, error)
  }

  setLayout(layout: ProferPluginViewLayout): void {
    validateLayout(layout)
    const key = pageKey(layout.pluginId, layout.pageId, layout.instance)
    if (!layout.visible && !this.views.has(key)) return
    const record = this.views.get(key) ?? this.create(layout.pluginId, layout.pageId, layout.instance)
    if (!this.owner || this.owner.isDestroyed()) return

    if (record.lastRendererInstanceId !== layout.rendererInstanceId) {
      record.lastRendererInstanceId = layout.rendererInstanceId
      record.lastLayoutSourceRevision = layout.layoutSourceRevision
      record.lastRevision = 0
    } else if (layout.layoutSourceRevision < record.lastLayoutSourceRevision) {
      return
    } else if (layout.layoutSourceRevision > record.lastLayoutSourceRevision) {
      record.lastLayoutSourceRevision = layout.layoutSourceRevision
      record.lastRevision = 0
    }
    if (layout.revision <= record.lastRevision) return
    record.lastRevision = layout.revision

    const bounds = resolveBrowserViewportLayout(
      layout.bounds,
      this.owner.webContents.getZoomFactor(),
      this.owner.contentView.getBounds(),
    )
    const visible = layout.visible && bounds.width > 4 && bounds.height > 4 && this.owner.isVisible()
    if (visible) {
      for (const other of this.views.values()) {
        if (other !== record && other.hostView.getVisible()) {
          other.hostView.setVisible(false)
          other.pageView.setVisible(false)
          other.lastVisible = false
        }
      }
      record.hostView.setBounds(bounds)
      record.hostView.setBorderRadius(Math.max(0, Math.min(32, Math.round(layout.borderRadius))))
      record.pageView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
      // 插件 View 是主窗口 contentView 的原生子视图；显示时提升到最上层，
      // 否则主 renderer 的网页层可能盖住它，只留下空的 DOM 占位区。
      this.owner.contentView.removeChildView(record.hostView)
      this.owner.contentView.addChildView(record.hostView)
    }
    if (record.hostView.getVisible() !== visible) record.hostView.setVisible(visible)
    if (record.pageView.getVisible() !== visible) record.pageView.setVisible(visible)
    if (visible && !record.lastVisible) {
      try { record.pageView.webContents.invalidate() } catch { /* 页面可能已销毁 */ }
    }
    record.lastVisible = visible
  }

  hide(pluginId: string, pageId: string, instance: ProferPluginViewInstance = { kind: 'tab' }): void {
    if (!isSafePageIdentity(pluginId, pageId)) return
    const record = this.views.get(pageKey(pluginId, pageId, instance))
    if (!record) return
    record.hostView.setVisible(false)
    record.pageView.setVisible(false)
    record.lastVisible = false
  }

  close(pluginId: string, pageId: string, instance: ProferPluginViewInstance = { kind: 'tab' }): void {
    if (!isSafePageIdentity(pluginId, pageId)) return
    const record = this.views.get(pageKey(pluginId, pageId, instance))
    if (record) this.disposeRecord(record)
  }

  closePlugin(pluginId: string): void {
    for (const record of [...this.views.values()]) {
      if (record.pluginId === pluginId) this.disposeRecord(record)
    }
  }

  /** 主 renderer 刷新或窗口失焦时立即收起所有 native View，避免旧页面覆盖新 DOM。 */
  hideAll(): void {
    for (const record of this.views.values()) {
      record.hostView.setVisible(false)
      record.pageView.setVisible(false)
      record.lastVisible = false
    }
  }

  private disposeRecord(record: PluginViewRecord): void {
    if (this.views.get(record.key) !== record) return
    pluginToolBroker.dispose(record.webContentsId)
    pluginRequests.cancelOwner(record.webContentsId)
    this.views.delete(record.key)
    this.webContentsOwners.delete(record.webContentsId)
    try { record.hostView.setVisible(false) } catch { /* 已销毁 */ }
    try { record.hostView.setBounds({ x: 0, y: 0, width: 0, height: 0 }) } catch { /* 已销毁 */ }
    try { record.hostView.removeChildView(record.pageView) } catch { /* 已销毁 */ }
    try { this.owner?.contentView.removeChildView(record.hostView) } catch { /* 已销毁 */ }
    if (!record.pageView.webContents.isDestroyed()) record.pageView.webContents.close()
  }

  dispose(): void {
    for (const record of [...this.views.values()]) this.disposeRecord(record)
    this.views.clear()
    this.webContentsOwners.clear()
    // Session protocol/guard 注册属于 Electron Session 生命周期，窗口重建后仍然存在，
    // 不可在 dispose 时清空注册标记，否则下次打开插件会重复 protocol.handle。
  }

  private ownerFor(sender: WebContents, senderFrame: Electron.WebFrameMain | null, allowDisabled = false): { pluginId: string; pageId: string; key: string } {
    if (!senderFrame || senderFrame !== sender.mainFrame) throw new Error('仅允许插件主页面访问 Plugin Host API')
    // 悬浮窗口页面的 webContents 由 PluginFloatingWindowManager 绑定，不在主窗口 View 表里。
    const floating = pluginFloatingWindowManager.ownerForWebContents(sender.id)
    const owner = this.webContentsOwners.get(sender.id) ?? floating
    if (!owner) throw new Error('拒绝非插件页面访问 Plugin Host API')
    const plugin = getInstalledPlugin(owner.pluginId)
    if (!plugin || !plugin.manifest.contributes.pages?.some((page) => page.id === owner.pageId)) throw new Error('插件页面不存在')
    if (!allowDisabled && !plugin.enabled) throw new Error('插件已停用')
    return owner
  }

  private surfaceFor(sender: WebContents): ProferPluginContext['surface'] {
    if (pluginFloatingWindowManager.isFloatingWebContents(sender.id)) return 'floating'
    const owner = this.webContentsOwners.get(sender.id)
    if (!owner) return 'tab'
    return this.views.get(owner.key)?.instance.kind === 'tool' ? 'tool' : 'tab'
  }

  getContext(sender: WebContents, senderFrame: Electron.WebFrameMain | null): ProferPluginContext {
    const owner = this.ownerFor(sender, senderFrame)
    const { plugin } = resolvePluginPage(owner.pluginId, owner.pageId)
    return {
      plugin: {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        ...(plugin.manifest.description && { description: plugin.manifest.description }),
        ...(plugin.manifest.publisher && { publisher: plugin.manifest.publisher }),
      },
      pageId: owner.pageId,
      surface: this.surfaceFor(sender),
      locale: app.getLocale() || 'zh-CN',
      theme: getSettings().themeMode === 'light' || (getSettings().themeMode === 'system' && !nativeTheme.shouldUseDarkColors)
        ? 'light'
        : 'dark',
    }
  }

  storageGet(sender: WebContents, senderFrame: Electron.WebFrameMain | null, key: unknown): unknown {
    const owner = this.ownerFor(sender, senderFrame)
    this.assertStoragePermission(owner.pluginId)
    const safeKey = this.assertStorageKey(key)
    return readPluginStorage(resolvePluginDataFile(owner.pluginId))[safeKey] ?? null
  }

  storageSet(sender: WebContents, senderFrame: Electron.WebFrameMain | null, key: unknown, value: unknown): void {
    const owner = this.ownerFor(sender, senderFrame)
    this.assertStoragePermission(owner.pluginId)
    const safeKey = this.assertStorageKey(key)
    const file = resolvePluginDataFile(owner.pluginId)
    const current = readPluginStorage(file)
    const next = { ...current, [safeKey]: value }
    let serialized: string
    try { serialized = JSON.stringify(next) } catch { throw new Error('插件存储值必须是可序列化 JSON') }
    if (Buffer.byteLength(serialized) > MAX_STORAGE_BYTES) throw new Error('插件私有存储不能超过 512 KB')
    writeJsonFileAtomic(file, next)
  }

  storageDelete(sender: WebContents, senderFrame: Electron.WebFrameMain | null, key: unknown): void {
    const owner = this.ownerFor(sender, senderFrame)
    this.assertStoragePermission(owner.pluginId)
    const safeKey = this.assertStorageKey(key)
    const file = resolvePluginDataFile(owner.pluginId)
    const current = readPluginStorage(file)
    if (!(safeKey in current)) return
    delete current[safeKey]
    writeJsonFileAtomic(file, current)
  }

  private assertStoragePermission(pluginId: string): void {
    const pageId = [...this.webContentsOwners.values()].find((value) => value.pluginId === pluginId)?.pageId
    if (!pageId) throw new Error('插件页面上下文不存在')
    const plugin = resolvePluginPage(pluginId, pageId).plugin
    if (!plugin.manifest.permissions?.includes('pluginStorage')) throw new Error('插件未声明 pluginStorage 权限')
  }

  private assertStorageKey(value: unknown): string {
    if (typeof value !== 'string' || !STORAGE_KEY_PATTERN.test(value) || RESERVED_STORAGE_KEYS.has(value)) {
      throw new Error('插件存储 key 非法')
    }
    return value
  }
}

export const pluginViewManager = new PluginViewManager()

/** 注册插件页面专属 IPC。发送者身份由 PluginViewManager 绑定，不接受页面自报 pluginId。 */
export function registerPluginHostIpc(): void {
  subscribeSettingsChanges(() => pluginViewManager.notifyContextChanged())
  nativeTheme.on('updated', () => pluginViewManager.notifyContextChanged())
  ipcMain.handle(PROFER_PLUGIN_HOST_CHANNELS.CALL, (event, request: unknown) => pluginViewManager.call(event.sender, event.senderFrame, request))
  ipcMain.handle(PROFER_PLUGIN_HOST_CHANNELS.TOOL_REGISTER, (event, toolId: unknown) => pluginViewManager.registerTool(event.sender, event.senderFrame, toolId))
  ipcMain.handle(PROFER_PLUGIN_HOST_CHANNELS.TOOL_RESULT, (event, callId: unknown, value: unknown, error: unknown) => pluginViewManager.toolResult(event.sender, event.senderFrame, callId, value, error))
  ipcMain.handle(PROFER_PLUGIN_HOST_CHANNELS.GET_CONTEXT, (event) => pluginViewManager.getContext(event.sender, event.senderFrame))
  ipcMain.handle(PROFER_PLUGIN_HOST_CHANNELS.STORAGE_GET, (event, key: unknown) => pluginViewManager.storageGet(event.sender, event.senderFrame, key))
  ipcMain.handle(PROFER_PLUGIN_HOST_CHANNELS.STORAGE_SET, (event, key: unknown, value: unknown) => pluginViewManager.storageSet(event.sender, event.senderFrame, key, value))
  ipcMain.handle(PROFER_PLUGIN_HOST_CHANNELS.STORAGE_DELETE, (event, key: unknown) => pluginViewManager.storageDelete(event.sender, event.senderFrame, key))
}
