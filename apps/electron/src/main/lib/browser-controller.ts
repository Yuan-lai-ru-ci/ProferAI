import { app, BrowserWindow, session as electronSession, clipboard as electronClipboard, shell, type Session, type WebContents } from 'electron'
import type { BrowserGuestClaim, BrowserGuestRequest, BrowserGuestVisibility, BrowserActionResult, BrowserDownloadBlockedEvent, BrowserExecutionSource, BrowserExtractInput, BrowserExtractResult, BrowserOperationStatus, BrowserScrollInput, BrowserScrollResult, BrowserTraceAction, BrowserTraceItem, BrowserTranslateResult, BrowserViewState, BrowserTabListResult, BrowserTabState } from '@profer/shared'
import {
  AGENT_IPC_CHANNELS,
  BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL,
  BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX,
  parseBrowserLocalFileSelection,
  promoteMru,
  removeMruId,
  selectMruFallbackId,
} from '@profer/shared'
import { assertSafeBrowserDestination, assertSafeBrowserSubresourceDestination, assertSafeBrowserUrl } from './browser-policy'
import { installDistrustedCertificateGuard } from './browser-certificate-policy'
import { basename, extname } from 'node:path'
import { createAuthorizedPreviewUrl, createViewerPreviewUrl, isAuthorizedPreviewProtocol, viewerPreviewThemeSignature, type ViewerPreviewTheme } from './browser-preview-service'
import { resolveAppThemeIsDark } from './app-theme-service'
import { handleProferFileRequest } from './local-file-protocol'
import { BrowserCdpTimeoutError, BrowserOperationAbortedError, BROWSER_OBSERVE_TIMEOUT_MS, resolveBrowserObserveAxDepth, throwIfBrowserOperationAborted, withBrowserCdpTimeout } from './browser-cdp'
import { parseBrowserPressAction } from './browser-key-policy'
import { BrowserActionGuard, type BrowserActionGuardKey } from './browser-action-guards'
import { browserActionSnapshotChanged, classifyBrowserClickRisk, createBrowserActionSnapshot, resolveBrowserActionStatus, type BrowserActionSnapshot } from './browser-action-verification'
import { BrowserStabilityProbe } from './browser-stabilization'
import { browserObservationNameLimit, prioritizeBrowserObservationCandidates, resolveBrowserObserveMaxElements } from './browser-observation-policy'
import { buildPersistentBrowserPartition, resolveBrowserProfileKey } from './browser-profile-policy'
import { hasAcknowledgedBrowserRiskDisclaimer } from './browser-risk-disclaimer'
import { buildProferBrowserUserAgent } from './browser-identity'
import { assertBrowserScript, buildBrowserDomActionExpression, type BrowserDomActionInput, BUILD_READ_ELEMENT_VALUE_FUNCTION, BUILD_WRITE_ELEMENT_VALUE_FUNCTION, normalizeFilledText } from './browser-script-policy'
import { getSettings } from './settings-service'
import { matchBrowserShortcut } from './browser-shortcut-policy'
import { BrowserPageInteractions } from './browser-page-interactions'
import { BrowserDialogFrameScripts } from './browser-dialog-frame-scripts'
import { BROWSER_DIALOG_SCHEME, BrowserDialogProtocol } from './browser-dialog-protocol'
import { BrowserGuestManager } from './browser-guest-manager'
import { recordHistory } from './browser-start-page-store'
import {
  BUILD_COLLECT_SCRIPT,
  BUILD_RESTORE_SCRIPT,
  buildWriteScript,
  translateTexts,
} from './browser-translate'

const MAX_TRACE_ITEMS = 30
/** 总数超限时只回收 Agent 创建且未在使用的标签，绝不自动关闭用户标签。 */
const MAX_BROWSER_TABS = 20
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024
const ACTION_HIGHLIGHT_DURATION_MS = 900
const MAX_BROWSER_SCRIPT_RESULT_CHARS = 64_000
/** 受管网页使用与 Profer 一致的滚动条；仅影响展示，不修改页面滚动行为或内容。
 * 与渲染进程同一套平台差异（见 docs/design/2026-10-27-scrollbar-spec.md）：
 * Windows 给 12px 命中区 + 3px 透明 border（视觉 4px），悬停展开；macOS 保持 6px overlay 尺寸。
 * 这里不能用 scrollbar-width: thin——Chromium 会改走 Fluent overlay，后面的伪元素宽度全部失效。 */
const PROFER_BROWSER_IS_WINDOWS = process.platform === 'win32'
const PROFER_BROWSER_SCROLLBAR_CSS = `
  html, body, * { scrollbar-width: auto !important; scrollbar-color: auto !important; }
  ::-webkit-scrollbar { width: ${PROFER_BROWSER_IS_WINDOWS ? 12 : 6}px !important; height: ${PROFER_BROWSER_IS_WINDOWS ? 12 : 6}px !important; }
  ::-webkit-scrollbar-track { background: transparent !important; }
  ::-webkit-scrollbar-thumb { background: rgba(113, 113, 122, .42) !important; border-radius: 999px !important; border: ${PROFER_BROWSER_IS_WINDOWS ? 3 : 0}px solid transparent !important; background-clip: content-box !important; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(113, 113, 122, .62) !important;${PROFER_BROWSER_IS_WINDOWS ? ' border-width: 2px !important;' : ''} }
  ::-webkit-scrollbar-button, ::-webkit-scrollbar-corner { display: none !important; }
`

type CdpResponse = Record<string, unknown>
type RefEntry = { backendNodeId: number; generation: number; label: string; editable: boolean }
type BrowserTabRecord = {
  tabId: string
  contents: WebContents | null
  ready?: Promise<void>
  interactions?: BrowserPageInteractions
  dialogEndpoint?: { dispose: () => void }
  dialogScripts?: BrowserDialogFrameScripts
  debuggerReady?: Promise<void>
  state: BrowserTabState
  refs: Map<string, RefEntry>
  /** 页面文档/观察代际；导航、关闭、调试器恢复后即失效。 */
  generation: number
  /** 当前页面 frame 树中可观测的 frame 数量。 */
  frameCount: number
  /** 尚未完成的网络请求 ID，用于动作后的稳态判断。 */
  pendingNetworkRequestIds: Set<string>
  /** 当前文档已见的 frame ID，用于跨 frame 稳态判断。 */
  frameIds: Set<string>
  /** 防止 UI 与 Agent 在同一 Tab 上交错下发命令。 */
  commandTail: Promise<void>
  isLocalPreview: boolean
  /** 本地预览文件的绝对路径。**主进程私有**：只服务于「用默认应用打开」，不下发给渲染进程。 */
  localFilePath: string | null
  /**
   * 本地预览打开时**烘进 URL** 的主题参数签名（`viewerPreviewThemeSignature`）。
   * viewer 页无 preload，主题只能活在 URL 里；换成新主题只能重新生成 URL 并重载，
   * 所以重载前用这个签名判断"当前 URL 里的是不是已经是新主题"，避免无谓重载。
   *
   * `null` = **主题不参与这个标签的 URL**：HTML 本地预览直接加载文件本身，页面配色由文件
   * 自己决定（与受管浏览器里的普通网页同理），因此主题变化不该重载它 —— 白重载会平白丢掉
   * 页面状态（表单/滚动），而换不到任何东西。viewer 预览的签名恒为非空串。
   */
  localPreviewThemeSignature: string | null
  /** 本地预览的相对路径基准目录（重载时要复用同一套授权解析口径）。 */
  localPreviewBaseDir: string | null
  /** 仅表示来源：由 Agent 创建的标签始终保留标识，不随当前工作标签切换而丢失。 */
  openedByAgent: boolean
  /** 用于在超限时优先回收最久未使用的 Agent 标签。 */
  lastActivityAt: number
  /** 最近一次已通过策略的主框架导航目标；错误页不应污染地址栏和 Agent 状态。 */
  lastRequestedUrl: string | null
  /** guest/renderer 丢失后，仅在重建绑定时恢复最后一个已校验页面。 */
  restoreOnGuestAttach: boolean
  zoomFactor: number
  highlightTimer?: ReturnType<typeof setTimeout>
}
export interface BrowserUserContextSnapshot {
  activeTabId: string
  url: string
  title: string
  openedAt: number
}

type BrowserSessionRecord = {
  sessionId: string
  partition: string
  browserSession: Session
  tabs: Map<string, BrowserTabRecord>
  /** 用户当前在面板中查看的标签。 */
  activeTabId: string
  /** 当前会话内用户激活标签的 MRU 顺序，主进程状态为真实数据源。 */
  tabMru: string[]
  /** Agent 未显式传 tabId 时继续操作的工作标签；被关闭后必须显式新建/选择。 */
  agentTabId: string | null
  /** 当前 Agent run 的取消源；UI 操作不接入此 signal。 */
  agentAbortController: AbortController
  allowedRoots: string[]
  executionSource: BrowserExecutionSource
  /** 全会话的脱敏账本，避免仅显示 Agent 当前 tab 的最后 30 条。 */
  ledger: BrowserTraceItem[]
  /** 用户在面板中主动打开/操作过浏览器；用于下一条消息的实时上下文。 */
  userOpenedAt: number | null

}

type BrowserSessionConfiguration = {
  profileKey: string
  allowedRoots: string[]
  executionSource: BrowserExecutionSource
}

export interface ConfigureBrowserSessionInput {
  profileKey: string
  allowedRoots?: string[]
  executionSource?: BrowserExecutionSource
}

export interface BrowserObservation {
  tabId: string
  url: string
  title: string
  generation: number
  elements: Array<{ ref: string; role: string; name: string; editable: boolean }>
}

/**
 * 本地预览的主题来源优先级。
 *
 * 1. 调用方显式给的（用户从 app 里打开文件时，渲染进程能算出真实生效的 token）；
 * 2. 渲染进程最近一次同步过来的（主进程会记住，覆盖 Agent 打开等没有渲染进程上下文的入口）；
 * 3. 都没有时按 settings 现算明暗 —— 只保证明暗正确，皮肤配色仍需渲染进程给。
 *
 * `resolveFallbackTheme` 做成惰性：命中前两档时不该去读设置/扫皮肤目录。
 */
export function resolvePreviewTheme(
  explicit: ViewerPreviewTheme | undefined,
  remembered: ViewerPreviewTheme | null,
  resolveFallbackTheme: () => 'light' | 'dark',
): ViewerPreviewTheme {
  return explicit ?? remembered ?? { theme: resolveFallbackTheme() }
}

function emptyTabState(tabId: string): BrowserTabState {
  return { tabId, url: '',
    localFile: null, title: '新建标签页', loading: false, visible: false, canGoBack: false, canGoForward: false, zoomFactor: 1, translated: false, loadError: null, trace: [] }
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && 'value' in value && typeof value.value === 'string') return value.value.trim()
  return ''
}

function booleanValue(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'value' in value && value.value === true)
}

function axPropertyBoolean(ax: Record<string, unknown>, propertyName: string): boolean {
  const properties = Array.isArray(ax.properties) ? ax.properties : []
  return properties.some((property) => (
    property
    && typeof property === 'object'
    && (property as Record<string, unknown>).name === propertyName
    && booleanValue((property as Record<string, unknown>).value)
  ))
}

/** Chromium 把 contenteditable 表示为 editable=true，也可能是 token: richtext/plaintext。 */
function axPropertyEditable(ax: Record<string, unknown>): boolean {
  const properties = Array.isArray(ax.properties) ? ax.properties : []
  return properties.some((property) => {
    if (!property || typeof property !== 'object') return false
    const record = property as Record<string, unknown>
    if (record.name !== 'editable' || !record.value || typeof record.value !== 'object') return false
    const value = (record.value as Record<string, unknown>).value
    return value === true || (typeof value === 'string' && value !== '' && value !== 'false')
  })
}

function isEditableAxNode(ax: Record<string, unknown>): boolean {
  const role = textValue(ax.role).toLowerCase()
  return role === 'textbox' || role === 'searchbox' || axPropertyEditable(ax)
}

function normalizeBrowserScriptResult(value: unknown): unknown {
  if (value === undefined) return null
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return null
    if (serialized.length > MAX_BROWSER_SCRIPT_RESULT_CHARS) {
      return {
        truncated: true,
        preview: serialized.slice(0, MAX_BROWSER_SCRIPT_RESULT_CHARS),
        totalChars: serialized.length,
      }
    }
    return JSON.parse(serialized) as unknown
  } catch {
    return String(value).slice(0, MAX_BROWSER_SCRIPT_RESULT_CHARS)
  }
}

function describeBrowserScriptException(response: CdpResponse): string {
  const details = response.exceptionDetails
  if (!details || typeof details !== 'object') return '页面 JavaScript 执行失败。'
  const record = details as Record<string, unknown>
  return textValue(record.exception) || textValue(record.text) || '页面 JavaScript 执行失败。'
}

export class BrowserController {
  private owner: BrowserWindow | null = null
  private foregroundSessionId: string | null = null
  /** 正在执行 Agent 指令的页面；其派生 popup 不获得用户展示权。 */
  private readonly agentOperatingTabs = new Map<string, number>()
  private readonly sessions = new Map<string, BrowserSessionRecord>()
  /** 已派发但结果未知的不可逆动作，按 session/tab/ref 隔离，禁止隐式重复执行。 */
  private readonly actionGuards = new BrowserActionGuard()
  private readonly configurations = new Map<string, BrowserSessionConfiguration>()
  /** Electron persistent partition 生命周期长于 Agent session；同一 Session 只安装一次 guard。 */
  private readonly guardedSessions = new WeakSet<Session>()
  /** 自定义 partition 不继承 default session 的协议处理器，必须单独注册本地预览协议。 */
  private readonly previewProtocolSessions = new WeakSet<Session>()
  private readonly dialogProtocols = new WeakMap<Session, BrowserDialogProtocol>()
  /**
   * 渲染进程最近同步过来的主题参数。
   *
   * 用途：Agent 的 `BrowserPreviewOpen` 工具没有渲染进程上下文、拿不到主题；
   * 用最近一次同步值补上，可以让这些预览也跟随当前皮肤（而不是永远浅色/默认色）。
   */
  private lastKnownPreviewTheme: ViewerPreviewTheme | null = null
  private guestManager: BrowserGuestManager | null = null
  private guestHostGeneration = 0
  private ownerMainFrameReady = false
  private shortcutContext: (import('@profer/shared').BrowserShortcutContext & { ticket?: string }) | null = null
  private readonly resettingGuestIds = new Set<number>()
  private readonly guestRequests = new Map<string, BrowserGuestRequest>()

  configureSession(sessionId: string, input: ConfigureBrowserSessionInput): void {
    const previous = this.configurations.get(sessionId)
    const allowedRoots = input.allowedRoots ?? previous?.allowedRoots ?? []
    const executionSource = input.executionSource ?? previous?.executionSource ?? 'user'
    this.configurations.set(sessionId, {
      profileKey: input.profileKey,
      allowedRoots: [...new Set(allowedRoots.filter(Boolean))],
      executionSource,
    })
    const browserSession = this.sessions.get(sessionId)
    if (browserSession) {
      browserSession.allowedRoots = [...new Set(allowedRoots.filter(Boolean))]
      browserSession.executionSource = executionSource
    }
  }

  setAllowedRoots(sessionId: string, allowedRoots: string[]): void {
    const previous = this.configurations.get(sessionId)
    this.configureSession(sessionId, {
      profileKey: previous?.profileKey ?? resolveBrowserProfileKey(undefined, sessionId),
      allowedRoots,
      executionSource: previous?.executionSource,
    })
  }

  setOwnerWindow(window: BrowserWindow): void {
    if (this.owner === window && this.guestManager) return
    if (this.owner && !this.owner.isDestroyed()) {
      this.resetGuestHost()
      this.owner.webContents.removeListener('before-input-event', this.onOwnerShortcutInput)
      this.owner.webContents.removeListener('did-start-navigation', this.onOwnerDidStartNavigation)
      this.owner.webContents.removeListener('did-finish-load', this.onOwnerDidFinishLoad)
      this.owner.webContents.removeListener('render-process-gone', this.onOwnerRenderProcessGone)
    }
    this.guestManager?.dispose()
    this.owner = window
    this.ownerMainFrameReady = false
    this.guestRequests.clear()
    this.guestManager = new BrowserGuestManager(window.webContents, (request) => {
      this.guestRequests.set(this.guestKey(request.sessionId, request.tabId), request)
      this.publishGuestRequests()
    }, partition => electronSession.fromPartition(partition), 15_000, false)
    window.webContents.prependListener('before-input-event', this.onOwnerShortcutInput)
    window.webContents.on('did-start-navigation', this.onOwnerDidStartNavigation)
    window.webContents.on('did-finish-load', this.onOwnerDidFinishLoad)
    window.webContents.on('render-process-gone', this.onOwnerRenderProcessGone)
  }

  setShortcutContext(context: import('@profer/shared').BrowserShortcutContext): void {
    const current = this.shortcutContext
    if (current?.scopeId === context.scopeId && current.revision >= context.revision) return
    const request = context.target ? this.guestRequests.get(this.guestKey(context.target.sessionId, context.target.tabId)) : undefined
    this.shortcutContext = { ...context, ticket: request?.ticket }
  }

  private readonly onOwnerShortcutInput = (event: Electron.Event, input: Electron.Input): void => {
    const context = this.shortcutContext
    const binding = context ? matchBrowserShortcut(input, context.bindings) : undefined
    if (!binding || !['browser-reload', 'browser-zoom-in', 'browser-zoom-out', 'browser-zoom-reset'].includes(binding.id)) return
    if (this.forwardShortcut(input)) event.preventDefault()
  }

  private forwardShortcut(input: Electron.Input, sourceGuestId?: number): boolean {
    const context = this.shortcutContext
    const target = context?.target
    if (!context || !target || !this.owner || this.owner.isDestroyed() || !this.owner.isFocused() || !this.owner.isVisible()) return false
    const session = this.sessions.get(target.sessionId)
    const tab = session?.tabs.get(target.tabId)
    const request = this.guestRequests.get(this.guestKey(target.sessionId, target.tabId))
    if (!tab?.state.visible || !tab.contents || tab.contents.isDestroyed() || !request || request.ticket !== context.ticket
      || (sourceGuestId !== undefined && tab.contents.id !== sourceGuestId)
      || target.sessionId !== this.foregroundSessionId || this.agentOperatingTabs.has(`${target.sessionId}:${target.tabId}`)) return false
    const binding = matchBrowserShortcut(input, context.bindings)
    if (!binding) return false
    if (!input.isAutoRepeat) this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_SHORTCUT, {
      scopeId: context.scopeId, revision: context.revision, sessionId: target.sessionId,
      tabId: target.tabId, ticket: request.ticket, shortcutId: binding.id,
    })
    return true
  }

  private readonly onOwnerDidStartNavigation = (details: Electron.WebContentsDidStartNavigationEventParams): void => {
    if (!details.isMainFrame || details.isSameDocument || !this.ownerMainFrameReady) return
    this.ownerMainFrameReady = false
    this.resetGuestHost(true)
  }

  private readonly onOwnerDidFinishLoad = (): void => {
    this.ownerMainFrameReady = true
    this.guestManager?.completeHostReset()
  }

  private readonly onOwnerRenderProcessGone = (): void => {
    this.ownerMainFrameReady = false
    this.resetGuestHost(true)
  }

  private resetGuestHost(deferGuestClose = false): void {
    this.guestHostGeneration += 1
    this.shortcutContext = null
    for (const binding of this.guestManager?.listBindings() ?? []) {
      const id = binding.guest.id
      this.resettingGuestIds.add(id)
      binding.guest.once('destroyed', () => this.resettingGuestIds.delete(id))
    }
    this.guestManager?.resetHost(deferGuestClose)
    this.guestRequests.clear()
    for (const browserSession of this.sessions.values()) {
      for (const tab of browserSession.tabs.values()) {
        this.invalidateTabDocument(tab)
        tab.frameIds.clear()
        tab.pendingNetworkRequestIds.clear()
        tab.dialogScripts?.dispose()
        tab.dialogScripts = undefined
        tab.debuggerReady = undefined
        tab.dialogEndpoint?.dispose()
        tab.dialogEndpoint = undefined
        tab.interactions?.dispose()
        tab.interactions = undefined
        tab.contents = null
        tab.ready = undefined
        tab.restoreOnGuestAttach = true
        tab.state.visible = false
        tab.state.loading = false
        tab.state.loadError = null
      }
      this.emit(browserSession)
    }
  }

  private guestKey(sessionId: string, tabId: string): string { return JSON.stringify([sessionId, tabId]) }

  private publishGuestRequests(): void {
    if (!this.owner || this.owner.isDestroyed()) return
    this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_GUESTS_CHANGED, this.getGuestRequests())
  }

  getGuestRequests(): BrowserGuestRequest[] { return [...this.guestRequests.values()].map(request => ({ ...request })) }

  connectGuestHost(): BrowserGuestRequest[] {
    if (!this.guestManager) throw new Error('浏览器宿主尚未就绪。')
    this.guestManager.setHostReady()
    for (const browserSession of this.sessions.values()) {
      for (const tab of browserSession.tabs.values()) void this.prepareTab(browserSession, tab).catch(() => undefined)
    }
    return this.getGuestRequests()
  }

  bindGuest(claim: BrowserGuestClaim): void {
    if (!this.sessions.get(claim.sessionId)?.tabs.has(claim.tabId)) throw new Error('浏览器页面已关闭。')
    if (!this.guestManager) throw new Error('浏览器宿主尚未就绪。')
    this.guestManager.bindGuest(claim)
  }

  /** DOM 是可见性权威；这里只记录页状态，不控制主窗口、焦点或原生几何。 */
  setGuestVisibility(pages: BrowserGuestVisibility[]): void {
    const changed = new Set<BrowserSessionRecord>()
    for (const page of pages) {
      const browserSession = this.sessions.get(page.sessionId)
      const tab = browserSession?.tabs.get(page.tabId)
      const request = this.guestRequests.get(this.guestKey(page.sessionId, page.tabId))
      if (!browserSession || !tab || request?.ticket !== page.ticket || tab.state.visible === page.visible) continue
      tab.state.visible = page.visible
      changed.add(browserSession)
    }
    for (const browserSession of changed) this.emit(browserSession)
  }

  setForegroundSession(sessionId: string | null): void { this.foregroundSessionId = sessionId }

  private contents(tab: BrowserTabRecord): WebContents {
    if (!tab.contents || tab.contents.isDestroyed()) throw new Error('浏览器页面尚未就绪或已关闭，请刷新页面后重试。')
    return tab.contents
  }

  private emit(browserSession: BrowserSessionRecord): void {
    if (!this.owner || this.owner.isDestroyed()) return
    this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_STATE_CHANGED, this.buildState(browserSession))
  }

  private buildState(browserSession: BrowserSessionRecord): BrowserViewState {
    const active = browserSession.tabs.get(browserSession.activeTabId)
    if (!active) throw new Error('受管浏览器没有有效标签。')
    return this.buildPageProjection(browserSession, active)
  }

  /** 动作结果只投影实际操作页；UI 广播仍使用 buildState 的显示语义。 */
  private buildActionResult(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): BrowserActionResult {
    return structuredClone({ ...this.buildPageProjection(browserSession, tab), tabId: tab.tabId })
  }

  private buildPageProjection(browserSession: BrowserSessionRecord, active: BrowserTabRecord): BrowserViewState {
    const trace = browserSession.ledger.slice(-MAX_TRACE_ITEMS)
    return {
      sessionId: browserSession.sessionId,
      executionSource: browserSession.executionSource,
      activeTabId: browserSession.activeTabId,
      agentTabId: browserSession.agentTabId,
      tabs: [...browserSession.tabs.values()].map((tab) => ({
        tabId: tab.tabId,
        url: tab.state.url,
        title: tab.state.title,
        localFile: tab.state.localFile,
        loading: tab.state.loading,
        zoomFactor: tab.zoomFactor,
        openedByAgent: tab.openedByAgent,
        visible: tab.state.visible,
        canGoBack: tab.state.canGoBack,
        canGoForward: tab.state.canGoForward,
        translated: tab.state.translated,
        loadError: tab.state.loadError,
        ...tab.interactions?.snapshot(),
      })),
      url: active.state.url,
      title: active.state.title,
      localFile: active.state.localFile,
      loading: active.state.loading,
      visible: active.state.visible,
      canGoBack: active.state.canGoBack,
      canGoForward: active.state.canGoForward,
      zoomFactor: active.zoomFactor,
      translated: active.state.translated,
      loadError: active.state.loadError,
      ...active.interactions?.snapshot(),
      trace,
      activity: trace.at(-1) ?? null,
    }
  }

  private getSession(sessionId: string): BrowserSessionRecord {
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) throw new Error('受管浏览器会话不存在。')
    return browserSession
  }

  /**
   * 用户打开浏览器、切换标签或从地址栏导航都视为明确的页面上下文信号。
   * 不记录页面正文，下一条消息仅带入当前标签的标题和 URL，Agent 如有必要再主动 Observe。
   */
  private markUserBrowserContext(browserSession: BrowserSessionRecord): void {
    browserSession.userOpenedAt ??= Date.now()
  }

  getUserContext(sessionId: string): BrowserUserContextSnapshot | null {
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession?.userOpenedAt) return null
    const active = browserSession.tabs.get(browserSession.activeTabId)
    if (!active?.state.url) return null
    return {
      activeTabId: active.tabId,
      url: active.state.url,
      title: active.state.title,
      openedAt: browserSession.userOpenedAt,
    }
  }

  /** 用户面板的当前标签；仅 renderer 操作及原生 View layout 使用。 */
  private getDisplayTab(browserSession: BrowserSessionRecord, tabId?: string): BrowserTabRecord {
    const resolvedTabId = tabId ?? browserSession.activeTabId
    const tab = browserSession.tabs.get(resolvedTabId)
    if (!tab) throw new Error(`浏览器标签不存在: ${resolvedTabId}`)
    return tab
  }

  /** Agent 的当前工作标签；用户在 UI 切换标签不会影响这里。 */
  private getAgentTab(browserSession: BrowserSessionRecord, tabId?: string): BrowserTabRecord {
    const resolvedTabId = tabId ?? browserSession.agentTabId
    if (!resolvedTabId) throw new Error('Agent 工作标签已被关闭。请先使用 BrowserNewTab 新建工作标签，或用 BrowserSelectTab 显式选择已有标签。')
    const tab = browserSession.tabs.get(resolvedTabId)
    if (!tab) throw new Error(`浏览器标签不存在: ${resolvedTabId}`)
    return tab
  }

  /**
   * 在首次确认前，仍先创建并发布浏览器状态，以便渲染进程展示风险告知；
   * 但不允许实际读取、导航或操作第三方网页。
   */
  private assertRiskDisclaimerAcknowledged(): void {
    if (hasAcknowledgedBrowserRiskDisclaimer(getSettings())) return
    throw new Error('首次使用受管浏览器前，请在浏览器面板阅读并确认平台账号风险告知后重试。')
  }

  private updateNavigationState(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): void {
    // WebContents.close() 不会同步取消已排队的导航事件。关闭标签后，迟到的
    // did-stop-loading / page-title-updated 仍可能触发；此时标签已从 Map 移除，
    // 再 emit 会因 activeTabId 指向已关闭标签而让主进程抛出未捕获异常。
    if (browserSession.tabs.get(tab.tabId) !== tab || !tab.contents || tab.contents.isDestroyed()) return
    const contents = this.contents(tab)
    const currentUrl = contents.getURL()
    if ((!currentUrl || currentUrl === 'about:blank') && !tab.lastRequestedUrl) return
    // 导航失败时 Chromium 可能把 WebContents URL 改成 chrome-error://chromewebdata/；
    // 这不是可操作的用户地址，保留上一次合法目标，防止状态回推污染地址栏。
    if (!currentUrl.startsWith('chrome-error://')) tab.state.url = currentUrl
    if (!tab.state.url && tab.lastRequestedUrl) tab.state.url = tab.lastRequestedUrl
    tab.state.title = contents.getTitle() || (currentUrl.startsWith('chrome-error://') ? '页面加载失败' : '未命名页面')
    tab.state.loading = contents.isLoading()
    try {
      tab.state.canGoBack = contents.canGoBack()
      tab.state.canGoForward = contents.canGoForward()
    } catch {
      tab.state.canGoBack = false
      tab.state.canGoForward = false
    }
    // 记录“最近访问”历史：仅合法的 HTTP(S) 页面，且跳过本地预览标签。
    // updateNavigationState 在导航完成、标题更新、加载结束等节点都被调用，
    // recordHistory 内部按 host+path 去重，避免重复写入。
    if (!tab.isLocalPreview && tab.state.url) {
      try {
        const protocol = new URL(tab.state.url).protocol
        if (protocol === 'http:' || protocol === 'https:') {
          recordHistory(tab.state.url, tab.state.title)
        }
      } catch { /* 非完整 URL，跳过 */ }
    }
    this.emit(browserSession)
  }

  private trace(browserSession: BrowserSessionRecord, tab: BrowserTabRecord, action: BrowserTraceAction, summary: string, status: BrowserOperationStatus = 'verified'): void {
    tab.lastActivityAt = Date.now()
    let domain: string | null = null
    try { domain = new URL(tab.state.url).host || null } catch { /* 新建标签页或本地预览 */ }
    const item: BrowserTraceItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      action,
      summary,
      at: Date.now(),
      success: status === 'dispatched' || status === 'verified',
      status,
      tabId: tab.tabId,
      domain,
      executionSource: browserSession.executionSource,
    }
    tab.state.trace = [...tab.state.trace, item].slice(-MAX_TRACE_ITEMS)
    browserSession.ledger = [...browserSession.ledger, item].slice(-100)
    this.emit(browserSession)
  }

  /**
   * 应用主题变化：把各会话里**仍然打开着**的本地预览按新主题重载，并记住这次的主题。
   *
   * 为什么是重载而不是改样式：viewer 页跑在无 preload 的沙箱里，主进程只能靠导航与它通信；
   * OFV 的 theme 又是 createViewer 时定死的，画布类格式（psd/图片等）不会跟着 CSS 变量变。
   * 重载是唯一对所有格式都成立的做法，代价是丢缩放/滚动位置 —— 换主题不是高频动作，可接受。
   *
   * 主题 = 明暗 + token 值，判重按「烘进 URL 的参数签名」：皮肤之间色调相同也能判出差异。
   * 记住它是为了之后由 Agent 打开、没有渲染进程上下文的预览（`BrowserPreviewOpen`）。
   */
  async refreshLocalPreviewThemes(previewTheme: ViewerPreviewTheme): Promise<number> {
    // 渲染进程是"当前主题"的唯一权威：它每次换主题都会同步过来，顺便给**之后**新建的
    // 本地预览（例如 Agent 的 BrowserPreviewOpen）留下可用的主题，那些入口自己没有主题来源。
    this.lastKnownPreviewTheme = previewTheme
    const signature = viewerPreviewThemeSignature(previewTheme)
    let refreshed = 0
    for (const browserSession of this.sessions.values()) {
      for (const tab of browserSession.tabs.values()) {
        if (!tab.isLocalPreview || !tab.localFilePath) continue
        // null = HTML 本地预览（主题不在它的 URL 里）；签名相同 = 已经烘的就是这套主题
        if (!tab.localPreviewThemeSignature || tab.localPreviewThemeSignature === signature) continue
        try {
          const preview = createViewerPreviewUrl(
            tab.localFilePath,
            browserSession.allowedRoots,
            tab.localPreviewBaseDir ?? undefined,
            previewTheme,
          )
          await this.prepareTab(browserSession, tab)
          await this.loadUrl(tab, preview.url)
          tab.localPreviewThemeSignature = signature
          refreshed += 1
        } catch (error) {
          this.trace(browserSession, tab, 'navigate', `按新主题重载预览失败：${error instanceof Error ? error.message : '未知错误'}`, 'failed')
        }
      }
    }
    return refreshed
  }

  /** 用系统默认应用打开当前标签的本地文件；非本地预览 / 无路径时忽略并留痕。 */
  private openLocalFileWithDefaultApp(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): void {
    if (!tab.isLocalPreview || !tab.localFilePath) {
      this.trace(browserSession, tab, 'navigate', '已忽略非本地预览的打开请求', 'failed')
      return
    }
    const filePath = tab.localFilePath
    void shell.openPath(filePath).then((errorMessage) => {
      if (errorMessage) {
        this.trace(browserSession, tab, 'navigate', `用默认应用打开失败：${errorMessage}`, 'failed')
        return
      }
      this.trace(browserSession, tab, 'navigate', `已用默认应用打开 ${basename(filePath)}`, 'verified')
    })
  }

  /**
   * 把 viewer 页回投的划词转给渲染进程，由渲染进程写成对话引用。
   *
   * 三道闸：只认本地预览标签、只取该标签**自己**的文件路径、文本按上限截断；
   * 其余一律忽略并留痕（页面被注入时也只能往这里塞文本，拿不到别的能力）。
   */
  private forwardLocalFileSelection(browserSession: BrowserSessionRecord, tab: BrowserTabRecord, url: string): void {
    if (!tab.isLocalPreview || !tab.localFilePath) {
      this.trace(browserSession, tab, 'navigate', '已忽略非本地预览的划词回投', 'failed')
      return
    }
    const text = parseBrowserLocalFileSelection(url)
    if (text === null) {
      this.trace(browserSession, tab, 'navigate', '已忽略畸形的划词回投', 'failed')
      return
    }
    if (!this.owner || this.owner.isDestroyed()) return
    this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_LOCAL_FILE_SELECTION, {
      sessionId: browserSession.sessionId,
      text,
      filePath: tab.localFilePath,
      fileName: basename(tab.localFilePath),
    })
    this.trace(
      browserSession,
      tab,
      'navigate',
      text ? `已引用 ${basename(tab.localFilePath)} 中选中的 ${text.length} 字` : `已清空 ${basename(tab.localFilePath)} 的划词引用`,
      'verified',
    )
  }

  private invalidateTabDocument(tab: BrowserTabRecord): void {
    tab.refs.clear()
    tab.generation++
  }

  /** 将同一 tab 的 UI/Agent 指令顺序化；一个失败不会卡死后续命令。 */
  private enqueueTab<T>(tab: BrowserTabRecord, task: () => Promise<T>): Promise<T> {
    const next = tab.commandTail.then(task, task)
    tab.commandTail = next.then(() => undefined, () => undefined)
    return next
  }

  private agentSignal(browserSession: BrowserSessionRecord, signal?: AbortSignal): AbortSignal {
    if (browserSession.agentAbortController.signal.aborted) browserSession.agentAbortController = new AbortController()
    if (!signal) return browserSession.agentAbortController.signal
    if (signal.aborted) return signal
    const merged = new AbortController()
    const abort = () => merged.abort()
    signal.addEventListener('abort', abort, { once: true })
    browserSession.agentAbortController.signal.addEventListener('abort', abort, { once: true })
    return merged.signal
  }

  private runTabOperation<T>(browserSession: BrowserSessionRecord, tab: BrowserTabRecord, signal: AbortSignal | undefined, task: (operationSignal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    // 只有 Agent 工具传入 signal；renderer 操作只排队，不会被 Stop Agent 取消。
    const operationSignal = signal ? this.agentSignal(browserSession, signal) : undefined
    return this.enqueueTab(tab, async () => {
      throwIfBrowserOperationAborted(operationSignal)
      await withBrowserCdpTimeout(() => this.prepareTab(browserSession, tab), 'Guest.ready', 15_000, operationSignal)
      if (tab.debuggerReady) await withBrowserCdpTimeout(() => tab.debuggerReady!, 'Guest.debuggerReady', 8_000, operationSignal)
      throwIfBrowserOperationAborted(operationSignal)
      if (this.sessions.get(browserSession.sessionId) !== browserSession || browserSession.tabs.get(tab.tabId) !== tab) throw new Error('浏览器页面已关闭。')
      if (tab.interactions?.snapshot().dialog) throw new Error('网页正在等待确认。请在对应浏览器页面回应提示，或停止该页操作后再继续。')
      if (!signal) return task(operationSignal)
      const key = `${browserSession.sessionId}:${tab.tabId}`
      this.agentOperatingTabs.set(key, (this.agentOperatingTabs.get(key) ?? 0) + 1)
      try {
        return await task(operationSignal)
      } finally {
        const remaining = (this.agentOperatingTabs.get(key) ?? 1) - 1
        if (remaining > 0) this.agentOperatingTabs.set(key, remaining)
        else this.agentOperatingTabs.delete(key)
      }
    })
  }

  private assertCurrentDocument(tab: BrowserTabRecord, generation: number, signal?: AbortSignal): void {
    throwIfBrowserOperationAborted(signal)
    if (tab.generation !== generation || this.contents(tab).isDestroyed()) {
      throw new Error('页面已变化或标签已关闭，请先重新调用 BrowserObserve。')
    }
  }

  /** Stop Agent 时调用：停止等待，并阻断尚未下发的页面命令。 */
  cancelSession(sessionId: string): void {
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return
    browserSession.agentAbortController.abort()
    browserSession.agentAbortController = new AbortController()
    const agentTabId = browserSession.agentTabId
    if (agentTabId) {
      const tab = browserSession.tabs.get(agentTabId)
      if (tab) {
        tab.interactions?.cancelDialog()
        this.invalidateTabDocument(tab)
        try { this.contents(tab).stop() } catch { /* WebContents 已销毁 */ }
        this.trace(browserSession, tab, 'tab', 'Agent 已停止浏览器操作；已发送指令的结果未知，请重新观察页面。', 'unknown')
      }
    }
  }

  /**
   * 按 webContents id 定位「持有该视图的会话 + 标签」。
   *
   * 不能先按 `record.browserSession === browserSession` 挑一个 record 再在它内部找标签：全局单一
   * profile 下所有会话共用同一个 Electron Session 对象，该条件恒真，只会命中最早创建的那个
   * record。后续会话的标签因此永远定位不到，子资源校验会退化成「一律拒绝」，页面只剩裸 HTML
   * （CSS/图片/脚本全部加载失败，主文档却正常）。
   */
  private findTabEntryByWebContentsId(webContentsId: number | undefined): { sessionId: string; tab: BrowserTabRecord } | undefined {
    if (typeof webContentsId !== 'number') return undefined
    for (const [sessionId, record] of this.sessions.entries()) {
      for (const tab of record.tabs.values()) {
        try {
          if (this.contents(tab).id === webContentsId) return { sessionId, tab }
        } catch {
          // 视图已销毁：跳过它，但不能因此中断对其它标签的查找。
        }
      }
    }
    return undefined
  }

  private installSessionGuards(browserSession: Session): void {
    if (this.guardedSessions.has(browserSession)) return
    this.guardedSessions.add(browserSession)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      // 安全边界：受管网页不获得任何浏览器权限（摄像头、地理位置、通知、midi 等）。
      // 剪贴板曾经放行 clipboard-read / clipboard-sanitized-write，但任意页面可借此读取
      // 用户刚复制的密码、验证码与私钥；2026-10-22 起一律拒绝。
      // 用户自己的 Ctrl+C / 右键复制走浏览器默认行为，不经过权限 API，不受影响。
      callback(false)
    })
    // Electron 收不到 Chrome 的 CRLSet 推送，泄露 CA 的拉黑必须自己做。
    installDistrustedCertificateGuard(browserSession, { cacheDir: app.getPath('userData') })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      if (this.guestManager?.isProvisional(details.webContentsId)) {
        callback({ cancel: details.url !== 'about:blank' })
        return
      }
      let protocol = ''
      try { protocol = new URL(details.url).protocol } catch { callback({ cancel: true }); return }
      if (protocol === `${BROWSER_DIALOG_SCHEME}:`) {
        callback({ cancel: !this.dialogProtocols.get(browserSession)?.authorize(details) })
        return
      }
      if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'ws:' && protocol !== 'wss:') {
        callback({ cancel: false })
        return
      }
      const tab = this.findTabEntryByWebContentsId(details.webContentsId)?.tab
      // 顶层 URL 决定「公网页面不得访问私网子资源」的判定基准。定位不到标签时传 null，
      // 由校验函数退化为「只拦私网子资源」——绝不能在这里把整页子资源一律 cancel。
      const topLevelUrl = tab?.lastRequestedUrl ?? tab?.state.url ?? null
      if (details.resourceType !== 'mainFrame') {
        // 本地开发顶层页面需要完整加载本地脚本、接口和 WebSocket；公网顶层页面则不能借此访问私网。
        void assertSafeBrowserSubresourceDestination(details.url, topLevelUrl)
          .then(() => callback({ cancel: false }))
          .catch(() => callback({ cancel: true }))
        return
      }
      void assertSafeBrowserDestination(details.url)
        .then(() => callback({ cancel: false }))
        .catch(() => callback({ cancel: true }))
    })
    browserSession.on('will-download', (event, item, webContents) => {
      // 安全边界：受管浏览器不向本地任意路径落盘。但用户点了下载链接不能无声无息，
      // 推送脱敏事件给面板，让用户知道被拦截，并可选择在系统浏览器打开。
      event.preventDefault()
      item.cancel()
      const sessionId = this.findTabEntryByWebContentsId(webContents?.id)?.sessionId
        ?? [...this.sessions.keys()][0]
      const url = (typeof item.getURL?.() === 'string' && item.getURL()) || (Array.isArray(item.getURLChain?.()) && item.getURLChain().find(Boolean)) || ''
      if (!sessionId || !this.owner || this.owner.isDestroyed()) return
      const payload: BrowserDownloadBlockedEvent = {
        sessionId,
        fileName: item.getFilename() || '未知文件',
        url,
      }
      this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_DOWNLOAD_BLOCKED, payload)
    })
  }

  private installPreviewProtocol(browserSession: Session): void {
    if (this.previewProtocolSessions.has(browserSession)) return
    browserSession.protocol.handle('profer-file', handleProferFileRequest)
    this.previewProtocolSessions.add(browserSession)
  }

  private createSession(sessionId: string, allowedRoots: string[] = []): BrowserSessionRecord {
    if (!this.owner || this.owner.isDestroyed()) throw new Error('主窗口尚未就绪，无法创建内置浏览器。')
    const configuration = this.configurations.get(sessionId)
    const profileKey = configuration?.profileKey ?? resolveBrowserProfileKey(undefined, sessionId)
    const partition = buildPersistentBrowserPartition(profileKey)
    const browserSession = electronSession.fromPartition(partition)
    // 默认 UA 会暴露 Electron；受管网页改为诚实的 Profer 标识，并保留 Chromium token 保证站点兼容。
    browserSession.setUserAgent(buildProferBrowserUserAgent(browserSession.getUserAgent(), app.getVersion()))
    const record: BrowserSessionRecord = {
      sessionId,
      partition,
      browserSession,
      tabs: new Map(),
      activeTabId: '',
      tabMru: [],
      agentTabId: null,
      agentAbortController: new AbortController(),
      allowedRoots: [...new Set((allowedRoots.length > 0 ? allowedRoots : configuration?.allowedRoots ?? []).filter(Boolean))],
      executionSource: configuration?.executionSource ?? 'user',
      ledger: [],
      userOpenedAt: null,
    }
    this.installSessionGuards(browserSession)
    this.installPreviewProtocol(browserSession)
    if (!this.dialogProtocols.has(browserSession)) this.dialogProtocols.set(browserSession, new BrowserDialogProtocol(browserSession))
    this.sessions.set(sessionId, record)
    return record
  }

  private createTab(browserSession: BrowserSessionRecord, isLocalPreview = false, claimAsAgent = false): BrowserTabRecord {
    if (!this.owner || this.owner.isDestroyed()) throw new Error('主窗口尚未就绪，无法创建浏览器标签。')
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const tab: BrowserTabRecord = {
      tabId,
      contents: null,
      state: emptyTabState(tabId),
      refs: new Map(),
      generation: 0,
      frameCount: 0,
      frameIds: new Set<string>(),
      pendingNetworkRequestIds: new Set<string>(),
      commandTail: Promise.resolve(),
      isLocalPreview,
      localFilePath: null,
      localPreviewThemeSignature: null,
      localPreviewBaseDir: null,
      openedByAgent: claimAsAgent,
      lastActivityAt: Date.now(),
      lastRequestedUrl: null,
      restoreOnGuestAttach: false,
      zoomFactor: 1,
    }
    browserSession.tabs.set(tabId, tab)
    if (!browserSession.activeTabId) {
      browserSession.activeTabId = tabId
      browserSession.tabMru = promoteMru(browserSession.tabMru, tabId)
    }
    if (claimAsAgent) browserSession.agentTabId = tabId
    void this.prepareTab(browserSession, tab).catch(() => undefined)
    return tab
  }

  private async prepareTab(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): Promise<void> {
    if (tab.ready) return tab.ready
    if (tab.contents && !tab.contents.isDestroyed()) return
    const manager = this.guestManager
    if (!manager) throw new Error('浏览器宿主尚未就绪。')
    const generation = this.guestHostGeneration
    const restorePage = tab.restoreOnGuestAttach
    const requestedUrl = tab.state.url && tab.state.url !== 'about:blank' ? tab.state.url : tab.lastRequestedUrl
    const ready = manager.requestGuest(browserSession.sessionId, tab.tabId, browserSession.partition).then(async ({ guest }) => {
      if (generation !== this.guestHostGeneration
        || this.sessions.get(browserSession.sessionId) !== browserSession
        || browserSession.tabs.get(tab.tabId) !== tab) {
        guest.close()
        throw new Error('页面在接入前已关闭或宿主已重载。')
      }
      tab.contents = guest
      await this.installTabContents(browserSession, tab, guest)
      if (!restorePage || !requestedUrl || requestedUrl === 'about:blank') return
      let restoreUrl: string | null
      if (tab.isLocalPreview && tab.localFilePath) {
        const extension = extname(tab.localFilePath).toLowerCase()
        const preview = extension === '.html' || extension === '.htm'
          ? createAuthorizedPreviewUrl(tab.localFilePath, browserSession.allowedRoots, tab.localPreviewBaseDir ?? undefined)
          : createViewerPreviewUrl(
              tab.localFilePath,
              browserSession.allowedRoots,
              tab.localPreviewBaseDir ?? undefined,
              resolvePreviewTheme(undefined, this.lastKnownPreviewTheme, () => resolveAppThemeIsDark() ? 'dark' : 'light'),
            )
        restoreUrl = preview.url
        tab.state.localFile = { name: basename(preview.filePath), readOnly: true }
      } else {
        restoreUrl = await assertSafeBrowserDestination(requestedUrl)
      }
      if (!restoreUrl) throw new Error('页面地址已失效，请重新打开该页面。')
      if (generation !== this.guestHostGeneration || tab.ready !== ready || tab.contents !== guest) throw new Error('浏览器页面实例已更新。')
      await this.loadUrl(tab, restoreUrl)
      if (generation !== this.guestHostGeneration || tab.ready !== ready || tab.contents !== guest) throw new Error('浏览器页面实例已更新。')
      tab.restoreOnGuestAttach = false
      this.updateNavigationState(browserSession, tab)
    }).catch((error: unknown) => {
      if (generation !== this.guestHostGeneration || tab.ready !== ready
        || this.sessions.get(browserSession.sessionId) !== browserSession || browserSession.tabs.get(tab.tabId) !== tab) throw error
      tab.ready = undefined
      {
        tab.dialogScripts?.dispose()
        tab.dialogEndpoint?.dispose()
        tab.interactions?.dispose()
        const failedGuest = tab.contents
        tab.contents = null
        tab.restoreOnGuestAttach = true
        if (failedGuest && !failedGuest.isDestroyed()) {
          const guestReleased = this.guestManager?.release(browserSession.sessionId, tab.tabId) ?? false
          if (!guestReleased) failedGuest.close()
        }
      }
      this.guestRequests.delete(this.guestKey(browserSession.sessionId, tab.tabId))
      if (browserSession.tabs.get(tab.tabId) === tab) {
        if (!tab.contents || tab.state.loadError === null) tab.state.loadError = error instanceof Error ? error.message : '浏览器页面接入失败。'
        this.emit(browserSession)
      }
      this.publishGuestRequests()
      throw error
    })
    tab.ready = ready
    return ready
  }

  private installTabContents(browserSession: BrowserSessionRecord, tab: BrowserTabRecord, contents: WebContents): Promise<void> {
    const debuggerClient = contents.debugger
    const contentsId = contents.id
    const isCurrentGuest = (): boolean => tab.contents === contents
      && this.sessions.get(browserSession.sessionId) === browserSession
      && browserSession.tabs.get(tab.tabId) === tab
    const interactions = new BrowserPageInteractions(contents, () => { if (isCurrentGuest()) this.emit(browserSession) })
    const protocol = this.dialogProtocols.get(browserSession.browserSession)
    const dialogEndpoint = protocol?.register({ contents, current: isCurrentGuest, request: (input, alive, signal) => interactions.requestDialog(input, alive, signal) })
    tab.interactions = interactions
    tab.dialogEndpoint = dialogEndpoint
    const dialogScripts = dialogEndpoint ? new BrowserDialogFrameScripts(debuggerClient, dialogEndpoint.source, (error) => {
      if (!isCurrentGuest()) return
      console.warn('[受管浏览器] 无法安装网页提示通道，已停止此页面:', error)
      dialogScripts?.dispose()
      dialogEndpoint.dispose()
      interactions.dispose()
      tab.contents = null
      tab.ready = undefined
      tab.debuggerReady = undefined
      tab.restoreOnGuestAttach = true
      tab.state.visible = false
      tab.state.loading = false
      tab.state.loadError = '网页提示通道未能安全接入。点击重试可重新打开页面。'
      this.guestRequests.delete(this.guestKey(browserSession.sessionId, tab.tabId))
      const released = this.guestManager?.release(browserSession.sessionId, tab.tabId)
      if (!released && !contents.isDestroyed()) contents.close()
      this.publishGuestRequests()
      this.emit(browserSession)
    }) : undefined
    tab.dialogScripts = dialogScripts
    contents.setWindowOpenHandler(({ url }) => {
      if (url === BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL) {
        this.openLocalFileWithDefaultApp(browserSession, tab)
        return { action: 'deny' }
      }
      if (url.startsWith(BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX)) {
        this.forwardLocalFileSelection(browserSession, tab, url)
        return { action: 'deny' }
      }
      void this.openExternalLinkInDisplayTab(browserSession, tab, url)
      return { action: 'deny' }
    })
    const onDebuggerMessage = (_event: Electron.Event, method: string, rawParams: unknown): void => {
      if (!isCurrentGuest()) return
      const params = rawParams && typeof rawParams === 'object' ? rawParams as Record<string, unknown> : {}
      const requestId = typeof params.requestId === 'string' ? params.requestId : null
      if (method === 'Network.requestWillBeSent' && requestId) tab.pendingNetworkRequestIds.add(requestId)
      if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && requestId) tab.pendingNetworkRequestIds.delete(requestId)
      if (method === 'Page.frameAttached' || method === 'Page.frameNavigated') {
        const frame = params.frame && typeof params.frame === 'object' ? params.frame as Record<string, unknown> : null
        const frameId = typeof params.frameId === 'string' ? params.frameId : typeof frame?.id === 'string' ? frame.id : null
        if (frameId) tab.frameIds.add(frameId)
      }
      if (method === 'Page.frameDetached' && typeof params.frameId === 'string') tab.frameIds.delete(params.frameId)
    }
    contents.debugger.on('message', onDebuggerMessage)
    const acknowledgeUserInput = (): void => {
      const binding = this.guestManager?.getBinding(contentsId)
      if (!isCurrentGuest() || interactions.snapshot().dialog || !binding || this.agentOperatingTabs.has(`${binding.sessionId}:${binding.tabId}`)
        || !tab.state.visible || browserSession.sessionId !== this.foregroundSessionId
        || !this.owner || this.owner.isDestroyed() || !this.owner.isVisible() || !this.owner.isFocused()) return
      this.markUserBrowserContext(browserSession)
      if (browserSession.activeTabId !== tab.tabId) this.activateDisplayTab(browserSession, tab)
      this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_GUEST_FOCUSED, {
        sessionId: binding.sessionId, tabId: binding.tabId,
      })
    }
    // 页面脚本 focus 不授予 UI 展示权；只接收窗口内真实输入，Agent 的 CDP 输入在操作期间被隔离。
    contents.on('before-mouse-event', (_event, input) => { if (input.type === 'mouseDown') acknowledgeUserInput() })
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      acknowledgeUserInput()
      if (isCurrentGuest() && this.forwardShortcut(input, contentsId)) event.preventDefault()
    })
    contents.on('will-navigate', (event, url) => {
      if (!isCurrentGuest()) { event.preventDefault(); return }
      // 在校验及真正导航前失效，避免 Observe 后在新页面按旧坐标操作。
      this.invalidateTabDocument(tab)
      tab.frameIds.clear()
      tab.pendingNetworkRequestIds.clear()
      try {
        if (url === BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL) {
          this.openLocalFileWithDefaultApp(browserSession, tab)
          event.preventDefault()
          return
        }
        if (url.startsWith(BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX)) {
          this.forwardLocalFileSelection(browserSession, tab, url)
          event.preventDefault()
          return
        }
        if (isAuthorizedPreviewProtocol(url) && tab.isLocalPreview) return
        tab.lastRequestedUrl = assertSafeBrowserUrl(url)
      } catch {
        event.preventDefault()
        this.trace(browserSession, tab, 'navigate', '已阻止不安全的页面跳转', 'failed')
      }
    })
    contents.on('did-start-navigation', (details) => {
      if (isCurrentGuest() && details.isMainFrame && !details.isSameDocument) interactions.resetDocument()
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || !isCurrentGuest()) return
      // Chromium 失败页的 chrome-error:// URL 不属于受管浏览器地址；只保留导航前
      // 已通过策略的目标，让用户可以直接重试，也避免内部协议进入 BrowserNavigate。
      tab.state.loading = false
      // -3（ERR_ABORTED）是“旧导航被新导航/停止取代”的正常取消，不是页面失败；
      // 把它当成错误态会让快速导航和点 Stop 时面板弹出假的失败提示。
      tab.state.loadError = errorCode === -3
        ? null
        : `${errorDescription || '页面加载失败'}（${errorCode}）`
      this.emit(browserSession)
    })
    contents.on('did-start-loading', () => {
      if (!isCurrentGuest()) return
      // 新文档会重建 DOM，翻译标记与原文备份随之丢失，翻译态复位。
      tab.state.translated = false
      // 重新开始加载意味着用户已重试或发起了新导航，旧的失败态不应继续遮住页面。
      tab.state.loadError = null
      this.invalidateTabDocument(tab)
      tab.frameIds.clear()
      tab.pendingNetworkRequestIds.clear()
      this.updateNavigationState(browserSession, tab)
    })
    contents.on('did-stop-loading', () => {
      if (!isCurrentGuest()) return
      // 导航会重建文档，因而在每次加载完成后重新注入展示层滚动条样式。
      void contents.insertCSS(PROFER_BROWSER_SCROLLBAR_CSS).catch(() => undefined)
      this.updateNavigationState(browserSession, tab)
    })
    contents.on('page-title-updated', () => { if (isCurrentGuest()) this.updateNavigationState(browserSession, tab) })
    contents.on('did-navigate', () => { if (!isCurrentGuest()) return; tab.state.loadError = null; this.invalidateTabDocument(tab); this.updateNavigationState(browserSession, tab) })
    contents.on('did-navigate-in-page', () => { if (!isCurrentGuest()) return; this.invalidateTabDocument(tab); this.updateNavigationState(browserSession, tab) })
    contents.on('render-process-gone', () => {
      if (tab.contents !== contents || browserSession.tabs.get(tab.tabId) !== tab) return
      dialogScripts?.dispose()
      dialogEndpoint?.dispose()
      interactions.dispose()
      this.invalidateTabDocument(tab)
      tab.contents = null
      tab.ready = undefined
      tab.restoreOnGuestAttach = true
      tab.state.loading = false
      tab.state.visible = false
      tab.state.loadError = '网页进程已退出。点击重试可重新打开；未保存的页面状态无法恢复。'
      this.guestRequests.delete(this.guestKey(browserSession.sessionId, tab.tabId))
      this.guestManager?.release(browserSession.sessionId, tab.tabId)
      this.publishGuestRequests()
      this.emit(browserSession)
    })
    contents.on('destroyed', () => {
      dialogScripts?.dispose()
      dialogEndpoint?.dispose()
      interactions.dispose()
      debuggerClient.removeListener('message', onDebuggerMessage)
      if (this.resettingGuestIds.delete(contentsId)) return
      if (this.sessions.get(browserSession.sessionId) !== browserSession || browserSession.tabs.get(tab.tabId) !== tab || tab.contents !== contents) return
      this.actionGuards.clearTab(browserSession.sessionId, tab.tabId)
      tab.contents = null
      tab.ready = undefined
      tab.restoreOnGuestAttach = true
      tab.state.visible = false
      tab.state.loading = false
      tab.state.loadError = '浏览器页面已结束。点击刷新可重新打开；未保存的页面状态无法恢复。'
      this.guestRequests.delete(this.guestKey(browserSession.sessionId, tab.tabId))
      this.publishGuestRequests()
      this.emit(browserSession)
    })
    try {
      debuggerClient.attach('1.3')
      return Promise.all([debuggerClient.sendCommand('Network.enable'), dialogScripts ? dialogScripts.start() : debuggerClient.sendCommand('Page.enable')]).then(() => undefined)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private getOrCreateSession(
    sessionId: string,
    allowedRoots: string[] = [],
    createAgentTab = true,
    /**
     * 新会话是否预建一个空标签。默认 true —— `navigate` / `observe` / `click` 这类操作都假定
     * 「已有一个标签」。但**自己会紧接着 createTab** 的调用方（createNewTab / createDisplayTab /
     * previewOpen）必须传 false：否则一次请求会落下两个标签（用户点一次「新建标签页」
     * 看到两个空白标签），回归测试见 browser-controller-fresh-session-tab.test.ts。
     */
    ensureInitialTab = true,
  ): BrowserSessionRecord {
    const browserSession = this.sessions.get(sessionId) ?? this.createSession(sessionId, allowedRoots)
    if (allowedRoots.length > 0) this.setAllowedRoots(sessionId, allowedRoots)
    if (ensureInitialTab && browserSession.tabs.size === 0) this.createTab(browserSession, false, createAgentTab)
    // 自己会紧接着 createTab 的冷会话不能提前广播：此时 activeTabId 为空，buildState 会抛错。
    // 已有标签或默认预建标签时才发布当前状态；冷会话的调用方在建完首 tab 后自行返回/发布状态。
    if (browserSession.tabs.size > 0) this.emit(browserSession)
    return browserSession
  }

  /**
   * CDP 在页面进程卡死时可能永久不返回。超时后重连 debugger，避免一个 Observe
   * 卡住整个 Agent turn，也让下一次 Browser* 调用能使用新的通道继续工作。
   */
  private async cdp(tab: BrowserTabRecord, method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<CdpResponse> {
    throwIfBrowserOperationAborted(signal)
    if (tab.debuggerReady) await withBrowserCdpTimeout(() => tab.debuggerReady!, 'Guest.debuggerReady', 8_000, signal)
    const debuggerClient = this.contents(tab).debugger
    if (!debuggerClient.isAttached()) throw new Error('浏览器调试通道不可用。')
    try {
      return await withBrowserCdpTimeout(
        () => debuggerClient.sendCommand(method, params) as Promise<CdpResponse>,
        method,
        timeoutMs,
        signal,
      )
    } catch (error) {
      // 同步网页提示不是调试器卡死。让当前工具返回“待回应”，保留UI等待，绝不重连/取消用户的选择。
      if (error instanceof BrowserCdpTimeoutError && tab.interactions?.snapshot().dialog) throw new Error('网页正在等待确认。请在对应浏览器页面回应提示，或停止该页操作后再继续。')
      if (error instanceof BrowserCdpTimeoutError) this.recoverDebugger(tab, method)
      if (error instanceof BrowserOperationAbortedError) tab.interactions?.cancelDialog()
      throw error
    }
  }

  private recoverDebugger(tab: BrowserTabRecord, timedOutMethod: string): void {
    // 重连会使所有 backend node/ref 的有效性不可判定。
    this.invalidateTabDocument(tab)
    tab.interactions?.cancelDialog()
    const contents = this.contents(tab)
    const debuggerClient = contents.debugger
    try {
      if (debuggerClient.isAttached()) debuggerClient.detach()
      debuggerClient.attach('1.3')
      tab.frameIds.clear()
      tab.pendingNetworkRequestIds.clear()
      const ready = withBrowserCdpTimeout(() => Promise.all([
        debuggerClient.sendCommand('Network.enable'),
        tab.dialogScripts ? tab.dialogScripts.start() : debuggerClient.sendCommand('Page.enable'),
      ]), 'Guest.reconnect', 8_000).then(() => undefined)
      tab.debuggerReady = ready
      void ready.catch((error: unknown) => {
        if (tab.contents !== contents || contents.isDestroyed()) return
        console.warn('[受管浏览器] 调试通道恢复失败，已结束页面:', error)
        contents.close()
      }).finally(() => { if (tab.debuggerReady === ready) tab.debuggerReady = undefined })
      console.warn(`[受管浏览器] CDP ${timedOutMethod} 超时，已重连调试通道。`)
    } catch (error) {
      console.warn(`[受管浏览器] CDP ${timedOutMethod} 超时后无法重连调试通道:`, error)
    }
  }

  /** 通过 CDP Overlay 渲染临时高亮，不向第三方页面注入脚本或修改 DOM。 */
  private async highlightAgentTarget(tab: BrowserTabRecord, backendNodeId: number): Promise<void> {
    if (tab.highlightTimer) clearTimeout(tab.highlightTimer)
    try {
      await this.cdp(tab, 'Overlay.enable')
      await this.cdp(tab, 'Overlay.highlightNode', {
        backendNodeId,
        highlightConfig: {
          showInfo: false,
          contentColor: { r: 59, g: 130, b: 246, a: 0.16 },
          borderColor: { r: 59, g: 130, b: 246, a: 0.95 },
        },
      })
      tab.highlightTimer = setTimeout(() => {
        tab.highlightTimer = undefined
        void this.cdp(tab, 'Overlay.hideHighlight').catch(() => undefined)
      }, ACTION_HIGHLIGHT_DURATION_MS)
    } catch (error) {
      console.warn('[受管浏览器] 无法渲染 Agent 操作高亮:', error)
    }
  }

  private clearAgentTargetHighlight(tab: BrowserTabRecord): void {
    if (tab.highlightTimer) clearTimeout(tab.highlightTimer)
    tab.highlightTimer = undefined
  }

  open(sessionId: string): BrowserViewState {
    // 用户从界面手动打开浏览器时，初始标签不应伪装成 Agent 标签。
    // 前台所有权由 IPC 层的 SET_BROWSER_FOREGROUND 序号统一仲裁；这里仅创建/读取
    // 当前浏览器状态，避免 open 的异步鉴权晚于 Chat/其他会话切换时重新抢回前台。
    const browserSession = this.getOrCreateSession(sessionId, [], false)
    this.markUserBrowserContext(browserSession)
    this.emit(browserSession)
    return structuredClone(this.buildState(browserSession))
  }

  getState(sessionId: string): BrowserViewState | null {
    // getState 只读取状态，不改变前台所有权。前台会话由 renderer 通过
    // setAgentBrowserForeground 同步设置，避免旧会话迟到的异步读取结果夺回所有权。
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return null
    return structuredClone(this.buildState(browserSession))
  }

  /**
   * 列出当前会话**已经存在**的标签页。
   *
   * 这是严格只读查询：没有会话时返回 exists=false 的空结果，绝不创建 session / tab、
   * 不检查风险告知、也不向 renderer 广播状态。模型即使误用 BrowserListTabs，
   * 也不会凭空产生空白标签或打开浏览器面板。
   */
  listTabs(sessionId: string): BrowserTabListResult {
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) {
      return { sessionId, exists: false, activeTabId: null, agentTabId: null, tabs: [] }
    }
    return structuredClone({
      sessionId,
      exists: true,
      // activeTabId 理论上始终有效；标签被销毁的窗口期内仍要给出可判定的空值。
      activeTabId: browserSession.tabs.has(browserSession.activeTabId) ? browserSession.activeTabId : null,
      agentTabId: browserSession.agentTabId,
      tabs: [...browserSession.tabs.values()].map((tab) => ({
        tabId: tab.tabId,
        url: tab.state.url,
        title: tab.state.title,
        localFile: tab.state.localFile,
        loading: tab.state.loading,
        zoomFactor: tab.zoomFactor,
        openedByAgent: tab.openedByAgent,
        visible: tab.state.visible,
        canGoBack: tab.state.canGoBack,
        canGoForward: tab.state.canGoForward,
        translated: tab.state.translated,
        loadError: tab.state.loadError,
      })),
    })
  }

  setZoom(sessionId: string, tabId: string, zoomFactor: number): BrowserViewState {
    const browserSession = this.getSession(sessionId)
    const tab = browserSession.tabs.get(tabId)
    if (!tab) throw new Error(`浏览器标签不存在: ${tabId}`)
    const clamped = Math.max(0.5, Math.min(3, Math.round(zoomFactor * 20) / 20))
    tab.zoomFactor = clamped
    tab.contents?.setZoomFactor(clamped)
    this.emit(browserSession)
    return structuredClone(this.buildState(browserSession))
  }

  private activateDisplayTab(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): void {
    tab.lastActivityAt = Date.now()
    browserSession.activeTabId = tab.tabId
    browserSession.tabMru = promoteMru(browserSession.tabMru, tab.tabId)
    tab.contents?.setZoomFactor(tab.zoomFactor)
    this.emit(browserSession)
  }

  private disposeTab(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): void {
    browserSession.tabs.delete(tab.tabId)
    tab.dialogScripts?.dispose()
    tab.dialogEndpoint?.dispose()
    tab.interactions?.dispose()
    this.clearAgentTargetHighlight(tab)
    const contents = tab.contents
    try { if (contents?.debugger.isAttached()) contents.debugger.detach() } catch { /* 已销毁 */ }
    this.guestRequests.delete(this.guestKey(browserSession.sessionId, tab.tabId))
    const guestReleased = this.guestManager?.release(browserSession.sessionId, tab.tabId) ?? false
    if (!guestReleased && contents && !contents.isDestroyed()) contents.close()
    this.publishGuestRequests()
  }

  /**
   * 关闭激活标签后选取新的激活标签：优先右侧相邻标签，关闭最后一个时回退到左侧相邻。
   * 与 Chrome 的标签关闭行为一致，避免跳到最早创建的标签。
   * closingIndex 为被关闭标签在关闭前 tabs 插入顺序中的下标。
   */
  private selectAdjacentActiveTab(browserSession: BrowserSessionRecord, closingIndex: number): void {
    const remainingIds = [...browserSession.tabs.keys()]
    const nextActive = remainingIds[closingIndex] ?? remainingIds[closingIndex - 1]
    if (nextActive) browserSession.activeTabId = nextActive
  }

  /** 关闭当前标签后优先回到最近访问且仍存在的标签；无历史时才使用相邻标签兜底。 */
  private selectMruActiveTab(browserSession: BrowserSessionRecord, closingTabId: string, closingIndex: number): void {
    browserSession.tabMru = removeMruId(browserSession.tabMru, closingTabId)
    const targetId = selectMruFallbackId(browserSession.tabMru, closingTabId, browserSession.tabs.keys())
    if (targetId) {
      const target = browserSession.tabs.get(targetId)
      if (target) {
        this.activateDisplayTab(browserSession, target)
        return
      }
    }
    this.selectAdjacentActiveTab(browserSession, closingIndex)
    if (browserSession.activeTabId) browserSession.tabMru = promoteMru(browserSession.tabMru, browserSession.activeTabId)
  }

  /**
   * 达到上限时回收最久未使用的 Agent 标签。用户创建的标签、当前前台标签和 Agent 当前工作标签
   * 一律保留；若没有安全候选，宁可暂时超过限制也不擅自关闭用户内容。
   */
  private reclaimExcessAgentTabs(browserSession: BrowserSessionRecord, protectedTabId?: string): number {
    const candidates = [...browserSession.tabs.values()]
      .filter((tab) => tab.openedByAgent && tab.tabId !== browserSession.activeTabId && tab.tabId !== browserSession.agentTabId && tab.tabId !== protectedTabId && !tab.state.visible)
      .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
    let reclaimed = 0
    while (browserSession.tabs.size > MAX_BROWSER_TABS && candidates.length > 0) {
      const tab = candidates.shift()
      if (!tab || !browserSession.tabs.has(tab.tabId)) continue
      this.disposeTab(browserSession, tab)
      reclaimed += 1
    }
    return reclaimed
  }

  /** Agent 新建后台工作 tab。显示目标只由用户操作或显式跟随策略决定。 */
  async createNewTab(sessionId: string, url?: string): Promise<BrowserActionResult> {
    // 自己下面就会 createTab，不能让 getOrCreateSession 再补一个空标签
    const browserSession = this.getOrCreateSession(sessionId, [], true, false)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.createTab(browserSession, false, true)
    browserSession.agentTabId = tab.tabId
    const reclaimed = this.reclaimExcessAgentTabs(browserSession)
    this.trace(browserSession, tab, 'tab', reclaimed > 0
      ? `Agent 新建后台工作标签；已回收 ${reclaimed} 个最久未使用的 Agent 标签`
      : `Agent 新建后台工作标签 ${tab.tabId}`)
    if (url?.trim()) return this.navigate(sessionId, url, tab.tabId)
    return this.buildActionResult(browserSession, tab)
  }

  /** 用户在浏览器面板中新建 tab；不会抢占 Agent 的工作 tab。 */
  async createDisplayTab(sessionId: string, url?: string): Promise<BrowserViewState> {
    // 同上：新建标签的调用方自己建标签，不然新会话会一次落两个空白标签
    const browserSession = this.getOrCreateSession(sessionId, [], false, false)
    this.assertRiskDisclaimerAcknowledged()
    this.markUserBrowserContext(browserSession)
    const tab = this.createTab(browserSession)
    this.activateDisplayTab(browserSession, tab)
    const reclaimed = this.reclaimExcessAgentTabs(browserSession)
    if (reclaimed > 0) this.trace(browserSession, tab, 'tab', `标签超过 ${MAX_BROWSER_TABS} 个上限，已回收 ${reclaimed} 个最久未使用的 Agent 标签`)
    // 创建/激活完成后广播最新状态；冷会话原先只有调用方拿到返回值，BrowserPanel 不会同步到新 tab。
    this.emit(browserSession)
    if (url?.trim()) return this.navigateDisplay(sessionId, url)
    return structuredClone(this.buildState(browserSession))
  }

  /** 用户 UI 的 tab 选择只控制显示，不影响 Agent 之后的默认操作目标。 */
  selectTab(sessionId: string, tabId: string): BrowserViewState {
    const browserSession = this.getSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    this.markUserBrowserContext(browserSession)
    const tab = this.getDisplayTab(browserSession, tabId)
    this.activateDisplayTab(browserSession, tab)
    return structuredClone(this.buildState(browserSession))
  }

  /** Agent 显式切换工作 tab，不改变用户正在查看的页面或布局。 */
  selectAgentTab(sessionId: string, tabId: string): BrowserActionResult {
    const browserSession = this.getSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    browserSession.agentTabId = tab.tabId
    tab.lastActivityAt = Date.now()
    this.trace(browserSession, tab, 'tab', `Agent 切换后台工作标签 ${tab.tabId}`)
    return this.buildActionResult(browserSession, tab)
  }

  /** Agent 关闭标签的显式入口；UI 关闭使用 closeTab，不应绕过浏览器风险告知。 */
  async closeAgentTab(sessionId: string, tabId: string): Promise<BrowserViewState | null> {
    this.assertRiskDisclaimerAcknowledged()
    return this.closeTab(sessionId, tabId)
  }

  async closeTab(sessionId: string, tabId: string): Promise<BrowserViewState | null> {
    const browserSession = this.getSession(sessionId)
    const tab = this.getDisplayTab(browserSession, tabId)
    const closingIndex = [...browserSession.tabs.keys()].indexOf(tab.tabId)
    this.actionGuards.clearTab(browserSession.sessionId, tab.tabId)
    this.disposeTab(browserSession, tab)
    if (browserSession.tabs.size === 0) {
      this.disposeSession(browserSession)
      return null
    }
    if (browserSession.activeTabId === tab.tabId) this.selectMruActiveTab(browserSession, tab.tabId, closingIndex)
    browserSession.tabMru = removeMruId(browserSession.tabMru, tab.tabId)
    if (browserSession.agentTabId === tab.tabId) browserSession.agentTabId = null
    this.emit(browserSession)
    return structuredClone(this.buildState(browserSession))
  }

  async previewOpen(
    sessionId: string,
    inputPath: string,
    tabId: string | undefined,
    allowedRoots: string[],
    baseDir?: string,
    signal?: AbortSignal,
    previewTheme?: ViewerPreviewTheme,
  ): Promise<BrowserActionResult> {
    return this.openPreview(sessionId, inputPath, tabId, allowedRoots, baseDir, signal, previewTheme, false)
  }

  /** UI 显式打开本地文件：使用用户标签，不认领或改动 Agent 工作目标。 */
  async previewOpenDisplay(sessionId: string, inputPath: string, allowedRoots: string[], previewTheme?: ViewerPreviewTheme): Promise<BrowserViewState> {
    await this.openPreview(sessionId, inputPath, undefined, allowedRoots, undefined, undefined, previewTheme, true)
    return structuredClone(this.buildState(this.getSession(sessionId)))
  }

  private async openPreview(
    sessionId: string,
    inputPath: string,
    tabId: string | undefined,
    allowedRoots: string[],
    baseDir: string | undefined,
    signal: AbortSignal | undefined,
    previewTheme: ViewerPreviewTheme | undefined,
    display: boolean,
  ): Promise<BrowserActionResult> {
    // 同上：下面会按需 createTab（本地预览标签），不再让新会话先补一个空白标签
    const browserSession = this.getOrCreateSession(sessionId, allowedRoots, !display, false)
    this.assertRiskDisclaimerAcknowledged()
    const resolvedPreviewTheme = resolvePreviewTheme(previewTheme, this.lastKnownPreviewTheme, () =>
      resolveAppThemeIsDark() ? 'dark' : 'light',
    )
    // 先校验路径，避免无效路径遗留一个空白的 Agent 预览标签。
    // HTML 直接加载文件本身（可加载同目录相对资源）；其它扩展名交给内置 viewer 页
    // （Open File Viewer 渲染，文件以 token URL 作为 ?src= 传入，主题以 ?theme=/?tokens= 传入）。
    const extension = extname(inputPath).toLowerCase()
    const usesViewerPage = extension !== '.html' && extension !== '.htm'
    const preview = usesViewerPage
      ? createViewerPreviewUrl(inputPath, browserSession.allowedRoots, baseDir, resolvedPreviewTheme)
      : createAuthorizedPreviewUrl(inputPath, browserSession.allowedRoots, baseDir)
    const tab = tabId ? this.getAgentTab(browserSession, tabId) : this.createTab(browserSession, true, !display)
    if (display) {
      this.markUserBrowserContext(browserSession)
      this.activateDisplayTab(browserSession, tab)
    } else {
      browserSession.agentTabId = tab.tabId
    }
    const reclaimed = this.reclaimExcessAgentTabs(browserSession)
    if (reclaimed > 0) this.trace(browserSession, tab, 'tab', `已回收 ${reclaimed} 个最久未使用的 Agent 标签以保持最多 ${MAX_BROWSER_TABS} 个标签`)
    const operationSignal = display ? undefined : signal ?? browserSession.agentAbortController.signal
    return this.runTabOperation(browserSession, tab, operationSignal, async (operationSignal) => {
      tab.isLocalPreview = true
      tab.localFilePath = preview.filePath
      // HTML 直接加载文件本身，主题不在它的 URL 里 —— 写 null 表示"这个标签不跟随主题"
      tab.localPreviewThemeSignature = usesViewerPage ? viewerPreviewThemeSignature(resolvedPreviewTheme) : null
      tab.localPreviewBaseDir = baseDir ?? null
      // 渲染侧据此把地址栏换成「本地文件 · 只读 + 文件名」（不显示 token URL）
      tab.state.localFile = { name: basename(preview.filePath), readOnly: true }
      try {
        await this.loadUrl(tab, preview.url, operationSignal)
        this.trace(browserSession, tab, 'navigate', `预览本地文件 ${preview.filePath.split(/[\\/]/).pop() ?? preview.filePath}`, 'verified')
        this.updateNavigationState(browserSession, tab)
        return this.buildActionResult(browserSession, tab)
      } catch (error) {
        this.trace(browserSession, tab, 'navigate', error instanceof BrowserOperationAbortedError ? '本地预览已停止，结果未知' : '本地预览加载失败', error instanceof BrowserOperationAbortedError ? 'unknown' : 'failed')
        throw error
      }
    })
  }

  private async loadUrl(tab: BrowserTabRecord, url: string, signal?: AbortSignal): Promise<void> {
    throwIfBrowserOperationAborted(signal)
    const contents = this.contents(tab)
    // 对话框等待时不让旧脚本阻塞明确的新导航；取消不是接受。
    tab.interactions?.cancelDialog()
    // loadURL 的 Promise 可能要等到子资源全部完成；页面主框架已经可用时就应
    // 立即结束 BrowserNavigate，否则一个慢字体/CDN 会被误报为协议或导航失败。
    await withBrowserCdpTimeout(() => new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        contents.removeListener('did-navigate', onNavigate)
        contents.removeListener('did-fail-load', onFail)
      }
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const onNavigate = (): void => {
        // Electron 的 did-navigate 只针对主框架触发；子框架应使用 did-frame-navigate。
        finish(resolve)
      }
      const onFail = (_event: Electron.Event, errorCode: number, description: string, validatedURL: string, isMainFrame: boolean): void => {
        // Stop/新导航的旧ERR_ABORTED可能迟到；loadURL自身Promise负责本次取消。
        // 共享did-fail-load只能消费属于本目标的失败，不能误伤紧接着打开的新页面。
        if (!isMainFrame || errorCode === -3 || (validatedURL && validatedURL !== url)) return
        finish(() => reject(new Error(`页面导航失败（${errorCode}）：${description}`)))
      }
      contents.on('did-navigate', onNavigate)
      contents.on('did-fail-load', onFail)
      void contents.loadURL(url).catch((error: unknown) => finish(() => reject(error)))
    }), 'Page.navigate', BROWSER_OBSERVE_TIMEOUT_MS + 3_000, signal)
  }

  async navigate(sessionId: string, url: string, tabId?: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const browserSession = this.getOrCreateSession(sessionId, [])
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    const safeUrl = await assertSafeBrowserDestination(url)
    tab.lastRequestedUrl = safeUrl
    tab.restoreOnGuestAttach = false
    const host = new URL(safeUrl).host
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      tab.isLocalPreview = false
      tab.localFilePath = null
      tab.localPreviewThemeSignature = null
      tab.localPreviewBaseDir = null
      tab.state.localFile = null
      this.trace(browserSession, tab, 'navigate', `正在打开 ${host}`, 'dispatched')
      try {
        await this.loadUrl(tab, safeUrl, operationSignal)
        this.trace(browserSession, tab, 'navigate', `已打开 ${host}`, 'verified')
        this.updateNavigationState(browserSession, tab)
        return this.buildActionResult(browserSession, tab)
      } catch (error) {
        this.trace(browserSession, tab, 'navigate', error instanceof BrowserOperationAbortedError ? `打开 ${host} 已停止，结果未知` : `无法打开 ${host}`, error instanceof BrowserOperationAbortedError ? 'unknown' : 'failed')
        throw error
      }
    })
  }

  /**
   * 将 target=_blank / window.open 的公共站外链接保留在受管浏览器里。
   * Electron 的 window.open handler 是同步的，因此先拒绝原生弹窗，再异步完成 DNS 安全校验并新建标签。
   */
  private async openExternalLinkInDisplayTab(browserSession: BrowserSessionRecord, sourceTab: BrowserTabRecord, url: string): Promise<void> {
    const sourceWasDisplayed = !this.agentOperatingTabs.has(`${browserSession.sessionId}:${sourceTab.tabId}`)
      && browserSession.activeTabId === sourceTab.tabId
      && sourceTab.state.visible
      && browserSession.sessionId === this.foregroundSessionId
      && !!this.owner && !this.owner.isDestroyed() && this.owner.isVisible() && this.owner.isFocused()
    let safeUrl: string
    try {
      safeUrl = await assertSafeBrowserDestination(url)
    } catch {
      // about:blank、私网和非 HTTP(S) popup 都不能转为新标签；保留简短账本供排查。
      this.trace(browserSession, sourceTab, 'navigate', '已阻止不安全或不受支持的新窗口链接', 'failed')
      return
    }
    // 链接点击后标签/会话可能已被用户关闭，不能在已销毁的上下文中创建 view。
    if (this.sessions.get(browserSession.sessionId) !== browserSession || !browserSession.tabs.has(sourceTab.tabId)) return

    const shouldDisplay = sourceWasDisplayed
      && !this.agentOperatingTabs.has(`${browserSession.sessionId}:${sourceTab.tabId}`)
      && browserSession.activeTabId === sourceTab.tabId
      && sourceTab.state.visible
      && browserSession.sessionId === this.foregroundSessionId
      && !!this.owner && !this.owner.isDestroyed() && this.owner.isVisible() && this.owner.isFocused()
    // 后台页的新窗口链接继承后台来源，但不改变工作指针或用户显示目标。
    const previousAgentTabId = browserSession.agentTabId
    const tab = this.createTab(browserSession, false, !shouldDisplay)
    browserSession.agentTabId = previousAgentTabId
    if (shouldDisplay) this.activateDisplayTab(browserSession, tab)
    this.reclaimExcessAgentTabs(browserSession, tab.tabId)
    tab.lastRequestedUrl = safeUrl
    const host = new URL(safeUrl).host
    try {
      await this.runTabOperation(browserSession, tab, undefined, async () => {
        tab.isLocalPreview = false
        tab.localFilePath = null
        tab.localPreviewThemeSignature = null
        tab.localPreviewBaseDir = null
        tab.state.localFile = null
        await this.loadUrl(tab, safeUrl)
        this.updateNavigationState(browserSession, tab)
      })
    } catch {
      // 载入失败时保留新标签，用户仍可修改地址或返回原标签；不要静默丢失点击结果。
      this.trace(browserSession, tab, 'navigate', `无法打开新窗口链接 ${host}`, 'failed')
    }
  }

  /** 用户地址栏导航当前显示 tab，不会改变 Agent 的工作 tab。 */
  async navigateDisplay(sessionId: string, url: string, tabId?: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId, [])
    this.assertRiskDisclaimerAcknowledged()
    this.markUserBrowserContext(browserSession)
    const tab = this.getDisplayTab(browserSession, tabId)
    const safeUrl = await assertSafeBrowserDestination(url)
    tab.lastRequestedUrl = safeUrl
    tab.restoreOnGuestAttach = false
    const host = new URL(safeUrl).host
    tab.interactions?.cancelDialog()
    return this.runTabOperation(browserSession, tab, undefined, async () => {
      tab.isLocalPreview = false
      tab.localFilePath = null
      tab.localPreviewThemeSignature = null
      tab.localPreviewBaseDir = null
      tab.state.localFile = null
      this.trace(browserSession, tab, 'navigate', `正在打开 ${host}`, 'dispatched')
      try {
        await this.loadUrl(tab, safeUrl)
        this.trace(browserSession, tab, 'navigate', `已打开 ${host}`, 'verified')
        this.updateNavigationState(browserSession, tab)
        return structuredClone(this.buildPageProjection(browserSession, tab))
      } catch (error) {
        this.trace(browserSession, tab, 'navigate', `无法打开 ${host}`, 'failed')
        throw error
      }
    })
  }

  async goBack(sessionId: string, tabId?: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      throwIfBrowserOperationAborted(operationSignal)
      if (!this.contents(tab).canGoBack()) throw new Error('当前标签没有可后退的导航记录。')
      this.contents(tab).goBack()
      this.updateNavigationState(browserSession, tab)
      this.trace(browserSession, tab, 'navigate', 'Agent 后退页面', 'dispatched')
      return this.buildActionResult(browserSession, tab)
    })
  }

  async goBackDisplay(sessionId: string, tabId?: string): Promise<BrowserViewState> {
    return this.navigateDisplayHistory(sessionId, 'back', tabId)
  }

  async goForward(sessionId: string, tabId?: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      throwIfBrowserOperationAborted(operationSignal)
      if (!this.contents(tab).canGoForward()) throw new Error('当前标签没有可前进的导航记录。')
      this.contents(tab).goForward()
      this.updateNavigationState(browserSession, tab)
      this.trace(browserSession, tab, 'navigate', 'Agent 前进页面', 'dispatched')
      return this.buildActionResult(browserSession, tab)
    })
  }

  async goForwardDisplay(sessionId: string, tabId?: string): Promise<BrowserViewState> {
    return this.navigateDisplayHistory(sessionId, 'forward', tabId)
  }

  async reload(sessionId: string, tabId?: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      throwIfBrowserOperationAborted(operationSignal)
      this.contents(tab).reload()
      this.updateNavigationState(browserSession, tab)
      this.trace(browserSession, tab, 'navigate', 'Agent 刷新页面', 'dispatched')
      return this.buildActionResult(browserSession, tab)
    })
  }

  /** 查找、停止与对话框响应不排入 Agent 页面命令队列，避免网页等待确认时无法操作 UI。 */
  async findDisplay(sessionId: string, tabId: string, input: import('@profer/shared').BrowserFindInput): Promise<void> {
    const browserSession = this.getSession(sessionId)
    const tab = this.getDisplayTab(browserSession, tabId)
    if (!tab.isLocalPreview) this.assertRiskDisclaimerAcknowledged()
    await this.prepareTab(browserSession, tab)
    if (!tab.interactions) throw new Error('页面查找暂不可用。')
    tab.interactions.find(input)
  }

  clearFindDisplay(sessionId: string, tabId: string): void {
    this.getDisplayTab(this.getSession(sessionId), tabId).interactions?.clearFind()
  }

  stopDisplay(sessionId: string, tabId: string): BrowserViewState {
    const browserSession = this.getSession(sessionId)
    const tab = this.getDisplayTab(browserSession, tabId)
    tab.interactions?.cancelDialog()
    if (tab.contents && !tab.contents.isDestroyed()) tab.contents.stop()
    tab.state.loading = false
    this.invalidateTabDocument(tab)
    this.emit(browserSession)
    return structuredClone(this.buildPageProjection(browserSession, tab))
  }

  /**
   * 读取展示标签已落定的地址，供「在系统浏览器打开」使用。
   * 严格只读：不创建会话、不改变前台所有权；空标签、about:blank 与本地文件预览（非 HTTP(S)）返回 null。
   */
  getDisplayUrl(sessionId: string, tabId?: string): string | null {
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return null
    const tab = tabId ? browserSession.tabs.get(tabId) : browserSession.tabs.get(browserSession.activeTabId)
    const url = tab?.state.url?.trim()
    if (!url || !/^https?:\/\//i.test(url)) return null
    return url
  }

  async respondToDialog(sessionId: string, tabId: string, input: import('@profer/shared').BrowserDialogResponse): Promise<void> {
    const tab = this.getDisplayTab(this.getSession(sessionId), tabId)
    if (!tab.isLocalPreview) this.assertRiskDisclaimerAcknowledged()
    if (!tab.state.visible || sessionId !== this.foregroundSessionId || !this.owner || this.owner.isDestroyed() || !this.owner.isVisible()) throw new Error('请先打开对应网页面板，再回应网页提示。')
    if (!tab.interactions) throw new Error('网页对话框已结束。')
    await tab.interactions.respond(input)
  }

  async reloadDisplay(sessionId: string, tabId?: string): Promise<BrowserViewState> {
    return this.navigateDisplayHistory(sessionId, 'reload', tabId)
  }

  /** 用户历史导航不接入 Agent 的取消源，也不冒充 Agent popup/操作来源。 */
  private async navigateDisplayHistory(sessionId: string, action: 'back' | 'forward' | 'reload', tabId?: string): Promise<BrowserViewState> {
    const browserSession = this.getSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    this.markUserBrowserContext(browserSession)
    const tab = this.getDisplayTab(browserSession, tabId)
    // 用户明确导航须先取消旧提示，再排队；不能等到被旧脚本阻塞的命令队列内部。
    tab.interactions?.cancelDialog()
    return this.runTabOperation(browserSession, tab, undefined, async () => {
      const contents = this.contents(tab)
      if (action === 'back') {
        if (!contents.canGoBack()) throw new Error('当前标签没有可后退的导航记录。')
        contents.goBack()
      } else if (action === 'forward') {
        if (!contents.canGoForward()) throw new Error('当前标签没有可前进的导航记录。')
        contents.goForward()
      } else contents.reload()
      this.updateNavigationState(browserSession, tab)
      this.trace(browserSession, tab, 'navigate', action === 'back' ? '用户后退页面' : action === 'forward' ? '用户前进页面' : '用户刷新页面', 'dispatched')
      return structuredClone(this.buildPageProjection(browserSession, tab))
    })
  }

  /**
   * 用户阅读用途：整页翻译当前展示 tab（toggle）。
   * 已翻译 → 从 data-profer-original 恢复原文；未翻译 → 采集文本->批量翻译->写回。
   * 返回新翻译态；失败时返回 error 供前端提示（不抛出）。
   */
  async translatePage(sessionId: string, tabId?: string): Promise<BrowserTranslateResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    let browserSessionForState = browserSession
    try {
      this.assertRiskDisclaimerAcknowledged()
    } catch (error) {
      return { translated: false, error: error instanceof Error ? error.message : '翻译不可用。' }
    }
    const tab = this.getDisplayTab(browserSession, tabId)
    return this.enqueueTab(tab, async () => {
      await this.prepareTab(browserSession, tab)
      try {
        if (tab.state.translated) {
          await this.evalPage(tab, BUILD_RESTORE_SCRIPT)
          tab.state.translated = false
          this.emit(browserSessionForState)
          return { translated: false }
        }

        const collected = await this.evalPage(tab, BUILD_COLLECT_SCRIPT) as { ok?: boolean; total?: number; items?: Array<{ tid: string; pieces: string[] }> } | null
        const items = Array.isArray(collected?.items) ? collected.items : []
        if (items.length === 0) {
          return { translated: false, error: '当前页面没有可翻译的文本。' }
        }

        // 展平文本，记录每段的 tid 映射，保持顺序。
        const flat: string[] = []
        const traceMap: Array<{ tid: string; start: number; count: number }> = []
        for (const item of items) {
          const pieces = (item.pieces ?? []).filter(Boolean)
          if (pieces.length === 0) continue
          traceMap.push({ tid: item.tid, start: flat.length, count: pieces.length })
          for (const piece of pieces) flat.push(piece)
        }
        if (flat.length === 0) return { translated: false, error: '当前页面没有可翻译的文本。' }

        const translated = await translateTexts(flat)
        const entries = traceMap.map(({ tid, start, count }) => ({
          pid: tid,
          translated: translated.slice(start, start + count).filter((text): text is string => typeof text === 'string' && text.length > 0),
        }))
        const writeResult = await this.evalPage(tab, buildWriteScript(entries)) as { ok?: boolean; applied?: number } | null
        const applied = typeof writeResult?.applied === 'number' ? writeResult.applied : 0
        if (applied === 0) return { translated: false, error: '页面已变化，未写入任何译文，请刷新后重试。' }
        tab.state.translated = true
        this.trace(browserSessionForState, tab, 'script', `整页翻译已完成（${items.length} 个文本块）`, 'verified')
        this.emit(browserSessionForState)
        return { translated: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : '翻译失败。'
        console.warn('[受管浏览器] 翻译失败:', error)
        return { translated: tab.state.translated, error: message }
      }
    })
  }

  /** 在主进程内求值页面脚本并返回结构化结果；专用于翻译流程，不受 Agent 结果长度截断影响。 */
  private async evalPage(tab: BrowserTabRecord, expression: string): Promise<unknown> {
    const response = await this.cdp(tab, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (response.exceptionDetails) throw new Error(describeBrowserScriptException(response))
    const result = response.result
    if (!result || typeof result !== 'object') return null
    const remote = result as Record<string, unknown>
    if ('value' in remote) return remote.value
    return null
  }

  async scroll(sessionId: string, input: BrowserScrollInput, tabId?: string, signal?: AbortSignal): Promise<BrowserScrollResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    const direction = input.direction ?? 'down'
    const amount = Number.isFinite(input.amount) ? Math.max(1, Math.min(Math.abs(input.amount as number), 20_000)) : undefined
    const selector = typeof input.selector === 'string' ? input.selector.trim() : ''
    if (selector.length > 1_000) throw new Error('滚动 selector 不能超过 1000 个字符。')
    const payload = JSON.stringify({ direction, amount, selector }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    const expression = `(() => {
      const input = ${payload};
      const root = input.selector ? document.querySelector(input.selector) : document.scrollingElement;
      if (!root) return { ok: false, error: '未找到滚动目标。' };
      const amount = input.amount ?? Math.max(120, Math.floor((root.clientHeight || window.innerHeight || 720) * 0.8));
      const dx = input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0;
      const dy = input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0;
      root.scrollBy({ left: dx, top: dy, behavior: 'auto' });
      const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
      const maxLeft = Math.max(0, root.scrollWidth - root.clientWidth);
      return { ok: true, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth, clientHeight: root.clientHeight, clientWidth: root.clientWidth, atTop: root.scrollTop <= 0, atBottom: root.scrollTop >= maxTop, atLeft: root.scrollLeft <= 0, atRight: root.scrollLeft >= maxLeft };
    })()`
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const result = await this.executePageExpression(tab, expression, operationSignal) as Record<string, unknown> | null
      if (!result || result.ok !== true) {
        this.trace(browserSession, tab, 'scroll', typeof result?.error === 'string' ? result.error : '滚动目标不可用', 'failed')
        throw new Error(typeof result?.error === 'string' ? result.error : '滚动目标不可用。')
      }
      const scrollResult = { tabId: tab.tabId, url: tab.state.url, title: tab.state.title, scrollTop: Number(result.scrollTop) || 0, scrollLeft: Number(result.scrollLeft) || 0, scrollHeight: Number(result.scrollHeight) || 0, scrollWidth: Number(result.scrollWidth) || 0, clientHeight: Number(result.clientHeight) || 0, clientWidth: Number(result.clientWidth) || 0, atTop: result.atTop === true, atBottom: result.atBottom === true, atLeft: result.atLeft === true, atRight: result.atRight === true }
      this.trace(browserSession, tab, 'scroll', `滚动页面 ${direction}${selector ? `（${selector.slice(0, 60)}）` : ''}`)
      return scrollResult
    })
  }

  async extract(sessionId: string, input: BrowserExtractInput, tabId?: string, signal?: AbortSignal): Promise<BrowserExtractResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    const mode = input.mode ?? 'text'
    const selector = typeof input.selector === 'string' && input.selector.trim() ? input.selector.trim() : mode === 'links' ? 'a' : mode === 'table' ? 'table' : 'body'
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(Math.floor(input.limit as number), 100)) : 50
    if (selector.length > 1_000) throw new Error('提取 selector 不能超过 1000 个字符。')
    const payload = JSON.stringify({ mode, selector, limit }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    const expression = `(() => {
      const input = ${payload};
      const nodes = Array.from(document.querySelectorAll(input.selector));
      const items = nodes.slice(0, input.limit).map((element) => {
        if (input.mode === 'links') return { text: (element.textContent || '').trim().slice(0, 8000), href: element instanceof HTMLAnchorElement ? element.href : element.getAttribute('href') };
        if (input.mode === 'attributes') { const attributes = {}; for (const attribute of element.attributes) attributes[attribute.name] = attribute.value.slice(0, 1000); return { attributes }; }
        if (input.mode === 'table') { const rows = Array.from(element.querySelectorAll('tr')); const headers = Array.from(element.querySelectorAll('thead th')).map((cell) => (cell.textContent || '').trim().slice(0, 1000)); return { headers, cells: rows.map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => (cell.textContent || '').trim().slice(0, 2000))) }; }
        return { text: (element.textContent || '').trim().slice(0, 8000) };
      });
      return { items, truncated: nodes.length > input.limit };
    })()`
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const result = await this.executePageExpression(tab, expression, operationSignal) as { items?: unknown[]; truncated?: boolean } | null
      const items = Array.isArray(result?.items) ? result.items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object').map((item) => ({ text: typeof item.text === 'string' ? item.text : undefined, href: typeof item.href === 'string' || item.href === null ? item.href : undefined, attributes: item.attributes && typeof item.attributes === 'object' ? item.attributes as Record<string, string> : undefined, headers: Array.isArray(item.headers) ? item.headers.filter((value): value is string => typeof value === 'string') : undefined, cells: Array.isArray(item.cells) ? item.cells.flatMap((row) => Array.isArray(row) ? [row.filter((value): value is string => typeof value === 'string')] : []) : undefined })) : []
      this.trace(browserSession, tab, 'extract', `提取 ${mode} 内容 ${items.length} 项${result?.truncated ? '（已截断）' : ''}`)
      return { tabId: tab.tabId, url: tab.state.url, title: tab.state.title, selector, mode, items, truncated: result?.truncated === true }
    })
  }

  async observe(sessionId: string, tabId?: string, requestedMaxElements?: number, signal?: AbortSignal): Promise<BrowserObservation> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, (operationSignal) => this.observeInternal(browserSession, tab, requestedMaxElements, operationSignal))
  }

  private async observeInternal(browserSession: BrowserSessionRecord, tab: BrowserTabRecord, requestedMaxElements?: number, signal?: AbortSignal): Promise<BrowserObservation> {
    try {
      throwIfBrowserOperationAborted(signal)
      const maxElements = resolveBrowserObserveMaxElements(requestedMaxElements)
      // 全量 AX tree 在富文本编辑器、长列表和复杂 SPA 中会非常大；限制深度以保留主页面交互层，
      // 同时避免 Chromium 为整棵树做序列化而长时间阻塞。
      const observeDepth = resolveBrowserObserveAxDepth(maxElements)
      const response = await this.cdp(tab, 'Accessibility.getFullAXTree', { depth: observeDepth }, BROWSER_OBSERVE_TIMEOUT_MS, signal)
      throwIfBrowserOperationAborted(signal)
      const nodes = Array.isArray(response.nodes) ? response.nodes : []
      const candidates: Array<{ backendNodeId: number; role: string; name: string; editable: boolean }> = []
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const ax = node as Record<string, unknown>
        const backendNodeId = typeof ax.backendDOMNodeId === 'number' ? ax.backendDOMNodeId : 0
        const role = textValue(ax.role)
        const name = textValue(ax.name)
        const editable = isEditableAxNode(ax)
        if (!backendNodeId || !role || (!name && !editable && !['button', 'textbox', 'link', 'checkbox', 'combobox'].includes(role))) continue
        candidates.push({ backendNodeId, role, name: name.slice(0, browserObservationNameLimit(role)), editable })
      }

      const selected = prioritizeBrowserObservationCandidates(candidates, maxElements)
      tab.generation++
      tab.refs.clear()
      const elements: BrowserObservation['elements'] = []
      for (const candidate of selected) {
        const ref = `r${tab.generation}-${elements.length + 1}`
        tab.refs.set(ref, {
          backendNodeId: candidate.backendNodeId,
          generation: tab.generation,
          label: candidate.name ? `${candidate.role}「${candidate.name.slice(0, 80)}」` : candidate.role,
          editable: candidate.editable,
        })
        elements.push({ ref, role: candidate.role, name: candidate.name, editable: candidate.editable })
      }
      // 新快照代表调用方已经重新看过页面，允许它基于新 ref 再次决定是否执行动作。
      this.actionGuards.clearTab(browserSession.sessionId, tab.tabId)
      this.updateNavigationState(browserSession, tab)
      this.trace(browserSession, tab, 'observe', `读取到 ${elements.length}/${maxElements} 个元素（可交互优先，AX 深度 ${observeDepth}）`)
      return { tabId: tab.tabId, url: tab.state.url, title: tab.state.title, generation: tab.generation, elements }
    } catch (error) {
      this.trace(browserSession, tab, 'observe', error instanceof BrowserCdpTimeoutError ? '页面观察超时，可重试或重新加载页面' : error instanceof BrowserOperationAbortedError ? '页面观察已停止' : '页面观察失败', error instanceof BrowserOperationAbortedError ? 'unknown' : 'failed')
      throw error
    }
  }

  private resolveRef(tab: BrowserTabRecord, ref: string): RefEntry {
    const entry = tab.refs.get(ref)
    if (!entry || entry.generation !== tab.generation) throw new Error('元素引用已失效，请先重新调用 browser_observe。')
    return entry
  }

  /**
   * 主进程内回读某个已 resolve 的 DOM 节点当前值（input/textarea => value，contenteditable => textContent）。
   * 使用固定函数体经 Runtime.callFunctionOn 求值，不拼接页面文本为代码。
   */
  private async readElementValue(tab: BrowserTabRecord, backendNodeId: number, generation: number, signal?: AbortSignal): Promise<string> {
    this.assertCurrentDocument(tab, generation, signal)
    const resolved = await this.cdp(tab, 'DOM.resolveNode', { backendNodeId }, undefined, signal)
    this.assertCurrentDocument(tab, generation, signal)
    const remote = resolved.object as Record<string, unknown> | undefined
    const objectId = typeof remote?.objectId === 'string' ? remote.objectId : undefined
    if (!objectId) return ''
    const valueResponse = await this.cdp(tab, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: BUILD_READ_ELEMENT_VALUE_FUNCTION,
      returnByValue: true,
    }, undefined, signal)
    this.assertCurrentDocument(tab, generation, signal)
    const valueResult = valueResponse.result as Record<string, unknown> | undefined
    const value = valueResult && typeof valueResult === 'object' && 'value' in valueResult ? valueResult.value : undefined
    return typeof value === 'string' ? value : ''
  }

  /** 通过 Runtime.callFunctionOn 对已 resolve 节点用固定函数写入值并派发 input/change（fill 降级）。 */
  private async writeElementValue(tab: BrowserTabRecord, backendNodeId: number, text: string, generation: number, signal?: AbortSignal): Promise<boolean> {
    this.assertCurrentDocument(tab, generation, signal)
    const resolved = await this.cdp(tab, 'DOM.resolveNode', { backendNodeId }, undefined, signal)
    this.assertCurrentDocument(tab, generation, signal)
    const remote = resolved.object as Record<string, unknown> | undefined
    const objectId = typeof remote?.objectId === 'string' ? remote.objectId : undefined
    if (!objectId) return false
    const writeResponse = await this.cdp(tab, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: BUILD_WRITE_ELEMENT_VALUE_FUNCTION,
      arguments: [{ value: text }],
      returnByValue: true,
    }, undefined, signal)
    const writeResult = writeResponse.result as Record<string, unknown> | undefined
    const ok = writeResult && typeof writeResult === 'object' && 'value' in writeResult
      ? (writeResult.value as Record<string, unknown> | undefined)?.ok === true
      : false
    return !writeResponse.exceptionDetails && ok
  }

  private async centerForRef(tab: BrowserTabRecord, ref: string, signal?: AbortSignal, generation = tab.generation): Promise<{ x: number; y: number }> {
    this.assertCurrentDocument(tab, generation, signal)
    const { backendNodeId } = this.resolveRef(tab, ref)
    // AX ref 可能来自懒加载列表的视口外节点。滚动后重新读取 box，不能复用旧坐标。
    await this.cdp(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }, undefined, signal)
    this.assertCurrentDocument(tab, generation, signal)
    const box = await this.cdp(tab, 'DOM.getBoxModel', { backendNodeId }, undefined, signal)
    this.assertCurrentDocument(tab, generation, signal)
    const model = box.model as Record<string, unknown> | undefined
    const quad = Array.isArray(model?.content) ? model.content : []
    if (quad.length < 8 || !quad.every((value) => typeof value === 'number')) throw new Error('目标元素当前不可点击，请重新观察页面。')
    return { x: ((quad[0] as number) + (quad[2] as number) + (quad[4] as number) + (quad[6] as number)) / 4, y: ((quad[1] as number) + (quad[3] as number) + (quad[5] as number) + (quad[7] as number)) / 4 }
  }

  private async readBrowserActionSnapshot(tab: BrowserTabRecord, signal?: AbortSignal): Promise<BrowserActionSnapshot | null> {
    try {
      const result = await this.executePageExpression(tab, '(() => ({ url: location.href, title: document.title, text: (document.body?.innerText || "").slice(0, 20000) }))()', signal)
      if (!result || typeof result !== 'object') return null
      const record = result as Record<string, unknown>
      return createBrowserActionSnapshot({
        url: typeof record.url === 'string' ? record.url : tab.state.url,
        title: typeof record.title === 'string' ? record.title : tab.state.title,
        text: typeof record.text === 'string' ? record.text : '',
        loading: tab.state.loading,
        pendingNetworkRequests: tab.pendingNetworkRequestIds.size,
        frameCount: tab.frameIds.size,
        generation: tab.generation,
      })
    } catch {
      // 导航刚开始或页面暂时不可观测时，调用方仍可用地址栏状态和 trace 判断未知结果。
      return null
    }
  }

  private async waitForBrowserActionStabilization(tab: BrowserTabRecord, signal?: AbortSignal): Promise<BrowserActionSnapshot | null> {
    const probe = new BrowserStabilityProbe({ requiredUnchangedSamples: 2 })
    let lastSnapshot: BrowserActionSnapshot | null = null
    const deadline = Date.now() + 1_500
    while (Date.now() <= deadline) {
      throwIfBrowserOperationAborted(signal)
      const snapshot = await this.readBrowserActionSnapshot(tab, signal)
      if (!snapshot) return lastSnapshot
      lastSnapshot = snapshot
      if (probe.push({ snapshot }).stable) return snapshot
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, 150)
        const onAbort = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(new BrowserOperationAbortedError())
        }
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    return lastSnapshot
  }

  /** 优先用 DOM 原生 click；只有明确允许重试时才进入一次 CDP 坐标 fallback。 */
  private async dispatchSyntheticClick(tab: BrowserTabRecord, target: RefEntry, generation: number, signal?: AbortSignal): Promise<boolean> {
    this.assertCurrentDocument(tab, generation, signal)
    const resolved = await this.cdp(tab, 'DOM.resolveNode', { backendNodeId: target.backendNodeId }, undefined, signal)
    this.assertCurrentDocument(tab, generation, signal)
    const remote = resolved.object as Record<string, unknown> | undefined
    const objectId = typeof remote?.objectId === 'string' ? remote.objectId : undefined
    if (!objectId) return false
    const response = await this.cdp(tab, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { if (!(this instanceof HTMLElement)) return false; this.click(); return true; }',
      returnByValue: true,
      userGesture: true,
    }, undefined, signal)
    const result = response.result as Record<string, unknown> | undefined
    return result?.value === true && !response.exceptionDetails
  }

  async click(sessionId: string, ref: string, tabId?: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    const guard: BrowserActionGuardKey = { sessionId, tabId: tab.tabId, ref, action: 'click' }
    if (this.actionGuards.isBlocked(guard)) {
      throw new Error('上一次点击已发送但结果未知；请先重新调用 BrowserObserve，确认页面状态后再决定是否操作。')
    }
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const generation = tab.generation
      const target = this.resolveRef(tab, ref)
      const risk = classifyBrowserClickRisk(target.label)
      const before = await this.readBrowserActionSnapshot(tab, operationSignal)
      await this.highlightAgentTarget(tab, target.backendNodeId)
      let dispatched = false
      let effect: 'none' | 'url-changed' = 'none'

      try {
        dispatched = await this.dispatchSyntheticClick(tab, target, generation, operationSignal)
      } catch (error) {
        if (risk === 'non-retryable') {
          this.trace(browserSession, tab, 'click', `点击 ${target.label} 未完成，未自动重试`, 'failed')
          throw error
        }
      }

      const afterSynthetic = await this.waitForBrowserActionStabilization(tab, operationSignal)
      if (before && afterSynthetic && browserActionSnapshotChanged(before, afterSynthetic)) effect = 'url-changed'
      if (before && tab.state.url !== before.url) effect = 'url-changed'

      if (effect === 'none' && risk === 'safe-retry') {
        // 只允许一次 fallback；第一次 DOM click 可能已触发副作用，但低风险分类才允许承担该不确定性。
        const { x, y } = await this.centerForRef(tab, ref, operationSignal, generation)
        this.assertCurrentDocument(tab, generation, operationSignal)
        await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, undefined, operationSignal)
        dispatched = true
        this.assertCurrentDocument(tab, generation, operationSignal)
        await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, undefined, operationSignal)
        const afterFallback = await this.waitForBrowserActionStabilization(tab, operationSignal)
        if (before && afterFallback && browserActionSnapshotChanged(before, afterFallback)) effect = 'url-changed'
        if (before && tab.state.url !== before.url) effect = 'url-changed'
      }

      const status = resolveBrowserActionStatus('click', { dispatched, effect, rejected: !dispatched && risk === 'non-retryable' })
      if (status === 'unknown') this.actionGuards.markUncertain(guard)
      this.trace(browserSession, tab, 'click', status === 'verified'
        ? `点击 ${target.label} 已确认页面发生变化`
        : status === 'unknown'
          ? `点击 ${target.label} 结果未知，请重新观察`
          : `点击 ${target.label} 未发送`, status)
      return this.buildActionResult(browserSession, tab)
    })
  }

  private async assertEditableFocus(tab: BrowserTabRecord, target: RefEntry, signal?: AbortSignal): Promise<void> {
    const response = await this.cdp(tab, 'Accessibility.getPartialAXTree', {
      backendNodeId: target.backendNodeId,
      fetchRelatives: false,
    }, undefined, signal)
    const nodes = Array.isArray(response.nodes) ? response.nodes : []
    const current = nodes.find((node) => (
      node
      && typeof node === 'object'
      && (node as Record<string, unknown>).backendDOMNodeId === target.backendNodeId
    )) as Record<string, unknown> | undefined
    if (!current || !isEditableAxNode(current)) throw new Error('目标字段已不可编辑，请重新观察页面后重试。')
    if (!axPropertyBoolean(current, 'focused')) throw new Error('无法聚焦目标字段，请重新观察页面后重试。')
  }

  async fill(sessionId: string, ref: string, text: string, tabId?: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (text.length > 10_000) throw new Error('单次输入不能超过 10000 个字符。')
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const generation = tab.generation
      const target = this.resolveRef(tab, ref)
      if (!target.editable) throw new Error('目标元素不是可编辑字段，请重新观察后选择 input、textarea 或 contenteditable。')
      await this.highlightAgentTarget(tab, target.backendNodeId)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.cdp(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, undefined, operationSignal)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.cdp(tab, 'DOM.focus', { backendNodeId: target.backendNodeId }, undefined, operationSignal)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.assertEditableFocus(tab, target, operationSignal)
      const selectAllModifier = process.platform === 'darwin' ? 4 : 2
      await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: selectAllModifier }, undefined, operationSignal)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: selectAllModifier }, undefined, operationSignal)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.cdp(tab, 'Input.insertText', { text }, undefined, operationSignal)
      this.assertCurrentDocument(tab, generation, operationSignal)

      // 回读校验：部分受控组件（React/Vue）可能吞掉 insertText。
      const expected = normalizeFilledText(text)
      let current = normalizeFilledText(await this.readElementValue(tab, target.backendNodeId, generation, operationSignal))
      let usedFallback = false
      if (current !== expected) {
        // 降级：用固定函数直接写值 + 派发 input/change，再回读。
        usedFallback = await this.writeElementValue(tab, target.backendNodeId, text, generation, operationSignal)
        this.assertCurrentDocument(tab, generation, operationSignal)
        current = normalizeFilledText(await this.readElementValue(tab, target.backendNodeId, generation, operationSignal))
      }
      const charCount = Array.from(text).length
      if (current !== expected) {
        this.trace(browserSession, tab, 'fill', `在 ${target.label} 输入 ${charCount} 个字符但未生效（已脱敏），请重新观察或改用 DOM 操作`, 'failed')
        throw new Error(`输入未完全生效：目标字段当前值为「${current.slice(0, 40)}」（已脱敏），期望「${expected.slice(0, 40)}」。已尝试回写，请重新观察页面后重试。`)
      }
      this.trace(browserSession, tab, 'fill', `在 ${target.label} 输入 ${charCount} 个字符（已脱敏）${usedFallback ? '，已通过回写生效' : ''}`, 'verified')
      return this.buildActionResult(browserSession, tab)
    })
  }

  async press(sessionId: string, key: string, tabId?: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    const action = parseBrowserPressAction(key)
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      if (action.kind === 'key') {
        await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: action.key }, undefined, operationSignal)
        await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: action.key }, undefined, operationSignal)
        this.trace(browserSession, tab, 'press', `按下 ${action.key}`, 'dispatched')
      } else {
        await this.cdp(tab, 'Input.insertText', { text: action.text }, undefined, operationSignal)
        this.trace(browserSession, tab, 'press', `输入 ${Array.from(action.text).length} 个字符（已脱敏）`, 'dispatched')
      }
      return this.buildActionResult(browserSession, tab)
    })
  }

  private async executePageExpression(tab: BrowserTabRecord, expression: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.cdp(tab, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, undefined, signal)
    if (response.exceptionDetails) throw new Error(describeBrowserScriptException(response))
    const result = response.result
    if (!result || typeof result !== 'object') return null
    const remote = result as Record<string, unknown>
    if ('value' in remote) return normalizeBrowserScriptResult(remote.value)
    return {
      type: textValue(remote.type) || 'unknown',
      description: textValue(remote.description) || null,
    }
  }

  async waitFor(sessionId: string, condition: { kind: 'url' | 'text' | 'selector'; value: string }, timeoutMs = 10_000, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; title: string; matched: boolean }> {
    if (!condition.value.trim()) throw new Error('等待条件不能为空。')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) throw new Error('等待超时必须在 250 到 30000 毫秒之间。')
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const startedAt = Date.now()
      const payload = JSON.stringify(condition).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
      const expression = `(() => { const condition = ${payload}; try { if (condition.kind === 'url') return location.href.includes(condition.value); if (condition.kind === 'text') return (document.body?.innerText || '').includes(condition.value); return !!document.querySelector(condition.value); } catch { return false; } })()`
      while (Date.now() - startedAt <= timeoutMs) {
        throwIfBrowserOperationAborted(operationSignal)
        const result = await this.executePageExpression(tab, expression, operationSignal)
        if (result === true) {
          this.trace(browserSession, tab, 'wait', `已满足${condition.kind}等待条件`, 'verified')
          return { tabId: tab.tabId, url: tab.state.url, title: tab.state.title, matched: true }
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            operationSignal?.removeEventListener('abort', abort)
            resolve()
          }, 250)
          const abort = () => { clearTimeout(timer); reject(new BrowserOperationAbortedError()) }
          operationSignal?.addEventListener('abort', abort, { once: true })
        })
      }
      this.trace(browserSession, tab, 'wait', `等待${condition.kind}条件超时`, 'failed')
      return { tabId: tab.tabId, url: tab.state.url, title: tab.state.title, matched: false }
    })
  }

  /**
   * 执行固定的 selector DOM 操作，优先用于 AX 无法稳定定位的富文本编辑器。
   * 表达式由主进程生成，selector/text 均按数据而非代码传入。
   */
  async domAction(sessionId: string, input: BrowserDomActionInput, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const result = await this.executePageExpression(tab, buildBrowserDomActionExpression(input), operationSignal)
      this.trace(browserSession, tab, 'dom', `DOM ${input.action}：${input.selector.slice(0, 100)}`, 'dispatched')
      return { tabId: tab.tabId, url: tab.state.url, result }
    })
  }

  /**
   * 用户面板显式触发：读取系统剪贴板文本并输入到当前显示 tab 的聚焦字段。
   * 仅由用户主动调用（工具栏粘贴按钮），不向 Agent 工具面暴露读剪贴板能力。
   */
  async pasteClipboard(sessionId: string, tabId?: string): Promise<BrowserTranslateResult> {
    const browserSession = this.getOrCreateSession(sessionId)
    let browserSessionForState = browserSession
    try {
      this.assertRiskDisclaimerAcknowledged()
    } catch (error) {
      return { translated: false, error: error instanceof Error ? error.message : '粘贴不可用。' }
    }
    const tab = this.getDisplayTab(browserSession, tabId)
    return this.enqueueTab(tab, async () => {
      await this.prepareTab(browserSession, tab)
      try {
        const text = electronClipboard.readText()
        if (!text) return { translated: false, error: '系统剪贴板当前没有文本。' }
        if (Array.from(text).length > 10_000) return { translated: false, error: '剪贴板文本超过 10000 个字符上限，无法一次性粘贴。' }
        await this.cdp(tab, 'Input.insertText', { text })
        this.trace(browserSessionForState, tab, 'press', `面板粘贴 ${Array.from(text).length} 个字符（已脱敏）`, 'verified')
        this.emit(browserSessionForState)
        return { translated: false, error: undefined }
      } catch (error) {
        const message = error instanceof Error ? error.message : '粘贴失败。'
        console.warn('[受管浏览器] 粘贴失败:', error)
        return { translated: tab.state.translated, error: message }
      }
    })
  }

  /**
   * 在当前页面上下文执行用户目标所需的 JavaScript。页面与结果仍停留在受管 WebContents/CDP 通道，
   * 不暴露 Electron/Node 能力；页面文本不可据此改变用户目标或诱导执行无关脚本。
   */
  async evaluate(sessionId: string, script: string, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> {
    assertBrowserScript(script)
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const result = await this.executePageExpression(tab, script, operationSignal)
      this.trace(browserSession, tab, 'script', `执行页面 JavaScript（${script.length} 字符）`, 'dispatched')
      return { tabId: tab.tabId, url: tab.state.url, result }
    })
  }

  async screenshot(sessionId: string, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; mimeType: string; base64: string }> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      throwIfBrowserOperationAborted(operationSignal)
      const image = await withBrowserCdpTimeout(() => this.contents(tab).capturePage(undefined, { stayHidden: true }), 'Page.captureScreenshot', BROWSER_OBSERVE_TIMEOUT_MS + 3_000, operationSignal)
      throwIfBrowserOperationAborted(operationSignal)
      // 视图隐藏/零尺寸/尚未渲染时 capturePage 会「成功」返回空 NativeImage。
      // 空图一旦作为成功结果进入会话历史，部分模型上游收到带空 data 的 image part 会挂起直到
      // 客户端超时（实测 kimi-k3 每次 ~105s 无响应后被自动重试，表现为“模型连不上”式死循环），
      // 所以空截图必须在这里显式失败，绝不能写进工具结果。
      if (image.isEmpty()) {
        this.trace(browserSession, tab, 'screenshot', '截取失败：capturePage 返回空图像（页面可能不可见或尚未渲染）', 'failed')
        throw new Error('截图为空：页面可能尚未渲染完成或浏览器面板当前不可见。请改用 BrowserObserve 获取页面信息，或确认页面在浏览器面板中可见后重试。')
      }
      const buffer = image.toPNG()
      if (buffer.byteLength === 0) {
        this.trace(browserSession, tab, 'screenshot', '截取失败：PNG 编码结果为空', 'failed')
        throw new Error('截图为空：图像编码失败。请改用 BrowserObserve 获取页面信息。')
      }
      if (buffer.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('截图过大，请缩小页面或改用 BrowserObserve。')
      this.trace(browserSession, tab, 'screenshot', '截取当前页面', 'verified')
      return { tabId: tab.tabId, url: tab.state.url, mimeType: 'image/png', base64: buffer.toString('base64') }
    })
  }

  hide(sessionId: string): void {
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return
    for (const tab of browserSession.tabs.values()) tab.state.visible = false
  }

  /** 宿主刷新时 guest 会由 Electron 销毁；保留标签元数据，重开按公开生命周期重建。 */
  hideAll(_invalidateLayoutSources = true): void {
    this.foregroundSessionId = null
    for (const browserSession of this.sessions.values()) this.hide(browserSession.sessionId)
  }

  private disposeSession(browserSession: BrowserSessionRecord): void {
    if (this.sessions.get(browserSession.sessionId) !== browserSession) return
    this.sessions.delete(browserSession.sessionId)
    this.actionGuards.clearSession(browserSession.sessionId)
    for (const tab of [...browserSession.tabs.values()]) this.disposeTab(browserSession, tab)
  }

  async close(sessionId: string): Promise<void> {
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return
    this.disposeSession(browserSession)
  }

  dispose(): void {
    this.foregroundSessionId = null
    for (const sessionId of [...this.sessions.keys()]) void this.close(sessionId)
    this.configurations.clear()
    this.agentOperatingTabs.clear()
    if (this.owner && !this.owner.isDestroyed()) {
      this.resetGuestHost()
      this.owner.webContents.removeListener('before-input-event', this.onOwnerShortcutInput)
      this.owner.webContents.removeListener('did-start-navigation', this.onOwnerDidStartNavigation)
      this.owner.webContents.removeListener('did-finish-load', this.onOwnerDidFinishLoad)
      this.owner.webContents.removeListener('render-process-gone', this.onOwnerRenderProcessGone)
    }
    this.guestManager?.dispose()
    this.guestManager = null
    this.guestRequests.clear()
    this.owner = null
  }
}

export const browserController = new BrowserController()
