import { app, BrowserWindow, View, WebContentsView, session as electronSession, clipboard as electronClipboard, type Session } from 'electron'
import type { BrowserDownloadBlockedEvent, BrowserExecutionSource, BrowserOperationStatus, BrowserTraceAction, BrowserTraceItem, BrowserTranslateResult, BrowserViewLayout, BrowserViewState, BrowserTabState } from '@profer/shared'
import { AGENT_IPC_CHANNELS } from '@profer/shared'
import { assertSafeBrowserDestination, assertSafeBrowserUrl } from './browser-policy'
import { createAuthorizedPreviewUrl, isAuthorizedPreviewProtocol } from './browser-preview-service'
import { handleProferFileRequest } from './local-file-protocol'
import { BrowserCdpTimeoutError, BrowserOperationAbortedError, BROWSER_OBSERVE_TIMEOUT_MS, resolveBrowserObserveAxDepth, throwIfBrowserOperationAborted, withBrowserCdpTimeout } from './browser-cdp'
import { parseBrowserPressAction } from './browser-key-policy'
import { browserObservationNameLimit, prioritizeBrowserObservationCandidates, resolveBrowserObserveMaxElements } from './browser-observation-policy'
import { buildPersistentBrowserPartition, resolveBrowserProfileKey } from './browser-profile-policy'
import { hasAcknowledgedBrowserRiskDisclaimer } from './browser-risk-disclaimer'
import { buildPromaBrowserUserAgent } from './browser-identity'
import { assertBrowserScript, buildBrowserDomActionExpression, type BrowserDomActionInput, BUILD_READ_ELEMENT_VALUE_FUNCTION, BUILD_WRITE_ELEMENT_VALUE_FUNCTION, normalizeFilledText } from './browser-script-policy'
import { getSettings } from './settings-service'
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

/** 受管网页使用与 Profer 一致的细滚动条；仅影响展示，不修改页面滚动行为或内容。 */
const PROFER_BROWSER_SCROLLBAR_CSS = `
  html, body, * { scrollbar-width: thin !important; scrollbar-color: rgba(113, 113, 122, .42) transparent !important; }
  ::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
  ::-webkit-scrollbar-track { background: transparent !important; }
  ::-webkit-scrollbar-thumb { background: rgba(113, 113, 122, .42) !important; border-radius: 999px !important; border: 1px solid transparent !important; background-clip: padding-box !important; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(113, 113, 122, .62) !important; }
  ::-webkit-scrollbar-button, ::-webkit-scrollbar-corner { display: none !important; }
`

type CdpResponse = Record<string, unknown>
type RefEntry = { backendNodeId: number; generation: number; label: string; editable: boolean }
type BrowserTabRecord = {
  tabId: string
  view: WebContentsView
  state: BrowserTabState
  refs: Map<string, RefEntry>
  /** 页面文档/观察代际；导航、关闭、调试器恢复后即失效。 */
  generation: number
  /** 防止 UI 与 Agent 在同一 Tab 上交错下发命令。 */
  commandTail: Promise<void>
  isLocalPreview: boolean
  /** 仅表示来源：由 Agent 创建的标签始终保留标识，不随当前工作标签切换而丢失。 */
  openedByAgent: boolean
  /** 用于在超限时优先回收最久未使用的 Agent 标签。 */
  lastActivityAt: number
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
  lastLayoutRevision: number
  /** 窗口级原生宿主；所有 WebContentsView 均作为它的子 View。 */
  hostView: View
  /** 宿主（整张浏览器卡片）在原生窗口坐标系中的最后边界。 */
  lastHostBounds?: BrowserViewLayout['bounds']
  /** 网页在原生宿主局部坐标系中的最后边界。 */
  lastTabBounds?: BrowserViewLayout['bounds']
  /** 上次布局应用后的实际可见状态；隐藏→显示过渡时强制重绘，避免 WebContentsView 白屏。 */
  lastVisible: boolean
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

function emptyTabState(tabId: string): BrowserTabState {
  return { tabId, url: '', title: '新建标签页', loading: false, visible: false, canGoBack: false, canGoForward: false, zoomFactor: 1, translated: false, trace: [] }
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
  private readonly sessions = new Map<string, BrowserSessionRecord>()
  private readonly configurations = new Map<string, BrowserSessionConfiguration>()
  /** Electron persistent partition 生命周期长于 Agent session；同一 Session 只安装一次 guard。 */
  private readonly guardedSessions = new WeakSet<Session>()
  /** 自定义 partition 不继承 default session 的协议处理器，必须单独注册本地预览协议。 */
  private readonly previewProtocolSessions = new WeakSet<Session>()

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
    this.owner = window
  }

  /**
   * 同步当前前台 Agent 会话。后台 Agent 仍可创建、导航和操作自己的网页，
   * 但它们的原生 WebContentsView 不得显示或抢占主窗口。
   */
  setForegroundSession(sessionId: string | null): void {
    if (sessionId === null) {
      this.hideAll()
      return
    }
    this.foregroundSessionId = sessionId
    this.hideOtherBrowserSessions(sessionId)
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return
    // 仅切换所有权，不在这里显示视图；显示必须等待当前 renderer 的布局 IPC。
    browserSession.hostView.setVisible(false)
    browserSession.lastVisible = false
    for (const tab of browserSession.tabs.values()) {
      tab.view.setVisible(false)
      tab.state.visible = false
    }
  }

  private emit(browserSession: BrowserSessionRecord): void {
    if (!this.owner || this.owner.isDestroyed()) return
    this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_STATE_CHANGED, this.buildState(browserSession))
  }

  private buildState(browserSession: BrowserSessionRecord): BrowserViewState {
    const active = browserSession.tabs.get(browserSession.activeTabId)
    if (!active) throw new Error('受管浏览器没有有效标签。')
    const trace = browserSession.ledger.slice(-MAX_TRACE_ITEMS)
    return {
      sessionId: browserSession.sessionId,
      executionSource: browserSession.executionSource,
      activeTabId: active.tabId,
      agentTabId: browserSession.agentTabId,
      tabs: [...browserSession.tabs.values()].map((tab) => ({
        tabId: tab.tabId,
        url: tab.state.url,
        title: tab.state.title,
        loading: tab.state.loading,
        zoomFactor: tab.zoomFactor,
        openedByAgent: tab.openedByAgent,
      })),
      url: active.state.url,
      title: active.state.title,
      loading: active.state.loading,
      visible: active.state.visible,
      canGoBack: active.state.canGoBack,
      canGoForward: active.state.canGoForward,
      zoomFactor: active.zoomFactor,
      translated: active.state.translated,
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
    if (browserSession.tabs.get(tab.tabId) !== tab || tab.view.webContents.isDestroyed()) return
    const contents = tab.view.webContents
    tab.state.url = contents.getURL()
    tab.state.title = contents.getTitle() || '未命名页面'
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
      return task(operationSignal)
    })
  }

  private assertCurrentDocument(tab: BrowserTabRecord, generation: number, signal?: AbortSignal): void {
    throwIfBrowserOperationAborted(signal)
    if (tab.generation !== generation || tab.view.webContents.isDestroyed()) {
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
        this.invalidateTabDocument(tab)
        try { tab.view.webContents.stop() } catch { /* WebContents 已销毁 */ }
        this.trace(browserSession, tab, 'tab', 'Agent 已停止浏览器操作；已发送指令的结果未知，请重新观察页面。', 'unknown')
      }
    }
  }

  private installSessionGuards(browserSession: Session): void {
    if (this.guardedSessions.has(browserSession)) return
    this.guardedSessions.add(browserSession)
    browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
      // 放开剪贴板读写（用户已确认）：页面可通过 navigator.clipboard 复制/粘贴。
      // Chromium 中 clipboard-read 同时覆盖读取与净化写入；clipboard-sanitized-write 另加兜底。
      // 其余权限（摄像头、地理位置、通知、midi 等）一律拒绝。
      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        callback(true)
        return
      }
      callback(false)
    })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      let protocol = ''
      try { protocol = new URL(details.url).protocol } catch { callback({ cancel: true }); return }
      if (protocol !== 'http:' && protocol !== 'https:') {
        callback({ cancel: false })
        return
      }
      void assertSafeBrowserDestination(details.url)
        .then(() => callback({ cancel: false }))
        .catch(() => callback({ cancel: true }))
    })
    browserSession.on('will-download', (event, item) => {
      // 安全边界：受管浏览器不向本地任意路径落盘。但用户点了下载链接不能无声无息，
      // 推送脱敏事件给面板，让用户知道被拦截，并可选择在系统浏览器打开。
      event.preventDefault()
      item.cancel()
      const sessionId = [...this.sessions.entries()].find(([, record]) => record.browserSession === browserSession)?.[0]
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
    // 默认 UA 会暴露 Electron；受管网页改为诚实的 Proma 标识，并保留 Chromium token 保证站点兼容。
    browserSession.setUserAgent(buildPromaBrowserUserAgent(browserSession.getUserAgent(), app.getVersion()))
    const record: BrowserSessionRecord = {
      sessionId,
      partition,
      browserSession,
      tabs: new Map(),
      activeTabId: '',
      agentTabId: null,
      agentAbortController: new AbortController(),
      allowedRoots: [...new Set((allowedRoots.length > 0 ? allowedRoots : configuration?.allowedRoots ?? []).filter(Boolean))],
      executionSource: configuration?.executionSource ?? 'user',
      ledger: [],
      userOpenedAt: null,
      lastLayoutRevision: 0,
      hostView: new View(),
      lastVisible: false,
    }
    record.hostView.setBorderRadius(16)
    record.hostView.setVisible(false)
    this.owner.contentView.addChildView(record.hostView)
    this.installSessionGuards(browserSession)
    this.installPreviewProtocol(browserSession)
    this.sessions.set(sessionId, record)
    return record
  }

  private createTab(browserSession: BrowserSessionRecord, isLocalPreview = false, claimAsAgent = false): BrowserTabRecord {
    if (!this.owner || this.owner.isDestroyed()) throw new Error('主窗口尚未就绪，无法创建浏览器标签。')
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const view = new WebContentsView({
      webPreferences: {
        partition: browserSession.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    const tab: BrowserTabRecord = {
      tabId,
      view,
      state: emptyTabState(tabId),
      refs: new Map(),
      generation: 0,
      commandTail: Promise.resolve(),
      isLocalPreview,
      openedByAgent: claimAsAgent,
      lastActivityAt: Date.now(),
      zoomFactor: 1,
    }
    browserSession.hostView.addChildView(view)
    // 网页内容区域保持直角；圆角只属于外层浏览器卡片。
    view.setVisible(false)
    // WebContentsView 不应放任 target=_blank 创建脱离主窗口的 BrowserWindow；此前直接 deny
    // 也导致用户和 Agent 点击站外链接没有任何反应。将安全的 HTTP(S) 目标转为当前受管浏览器的新标签。
    view.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalLinkInDisplayTab(browserSession, tab, url)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => {
      // 在校验及真正导航前失效，避免 Observe 后在新页面按旧坐标操作。
      this.invalidateTabDocument(tab)
      try {
        if (isAuthorizedPreviewProtocol(url) && tab.isLocalPreview) return
        assertSafeBrowserUrl(url)
      } catch {
        event.preventDefault()
        this.trace(browserSession, tab, 'navigate', '已阻止不安全的页面跳转', 'failed')
      }
    })
    view.webContents.on('did-start-loading', () => {
      // 新文档会重建 DOM，翻译标记与原文备份随之丢失，翻译态复位。
      tab.state.translated = false
      this.invalidateTabDocument(tab)
      this.updateNavigationState(browserSession, tab)
    })
    view.webContents.on('did-stop-loading', () => {
      // 导航会重建文档，因而在每次加载完成后重新注入展示层滚动条样式。
      void view.webContents.insertCSS(PROFER_BROWSER_SCROLLBAR_CSS).catch(() => undefined)
      this.updateNavigationState(browserSession, tab)
    })
    view.webContents.on('page-title-updated', () => this.updateNavigationState(browserSession, tab))
    view.webContents.on('did-navigate', () => { this.invalidateTabDocument(tab); this.updateNavigationState(browserSession, tab) })
    view.webContents.on('did-navigate-in-page', () => { this.invalidateTabDocument(tab); this.updateNavigationState(browserSession, tab) })
    view.webContents.on('destroyed', () => {
      if (!browserSession.tabs.has(tab.tabId)) return
      const closingIndex = [...browserSession.tabs.keys()].indexOf(tab.tabId)
      browserSession.tabs.delete(tab.tabId)
      if (browserSession.tabs.size === 0) {
        this.sessions.delete(browserSession.sessionId)
        return
      }
      if (browserSession.activeTabId === tab.tabId) this.selectAdjacentActiveTab(browserSession, closingIndex)
      if (browserSession.agentTabId === tab.tabId) browserSession.agentTabId = null
      this.emit(browserSession)
    })
    try { view.webContents.debugger.attach('1.3') } catch (error) { console.warn('[受管浏览器] CDP attach 失败:', error) }
    browserSession.tabs.set(tabId, tab)
    if (!browserSession.activeTabId) browserSession.activeTabId = tabId
    if (claimAsAgent) browserSession.agentTabId = tabId
    return tab
  }

  private getOrCreateSession(sessionId: string, allowedRoots: string[] = [], createAgentTab = true): BrowserSessionRecord {
    const browserSession = this.sessions.get(sessionId) ?? this.createSession(sessionId, allowedRoots)
    if (allowedRoots.length > 0) this.setAllowedRoots(sessionId, allowedRoots)
    if (browserSession.tabs.size === 0) this.createTab(browserSession, false, createAgentTab)
    // 每个 Browser* 调用都先发布可渲染状态：即使后续操作失败，当前激活会话也能立即展示浏览器。
    this.emit(browserSession)
    return browserSession
  }

  /**
   * CDP 在页面进程卡死时可能永久不返回。超时后重连 debugger，避免一个 Observe
   * 卡住整个 Agent turn，也让下一次 Browser* 调用能使用新的通道继续工作。
   */
  private async cdp(tab: BrowserTabRecord, method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<CdpResponse> {
    throwIfBrowserOperationAborted(signal)
    const debuggerClient = tab.view.webContents.debugger
    if (!debuggerClient.isAttached()) throw new Error('浏览器调试通道不可用。')
    try {
      return await withBrowserCdpTimeout(
        () => debuggerClient.sendCommand(method, params) as Promise<CdpResponse>,
        method,
        timeoutMs,
        signal,
      )
    } catch (error) {
      if (error instanceof BrowserCdpTimeoutError) this.recoverDebugger(tab, method)
      throw error
    }
  }

  private recoverDebugger(tab: BrowserTabRecord, timedOutMethod: string): void {
    // 重连会使所有 backend node/ref 的有效性不可判定。
    this.invalidateTabDocument(tab)
    const debuggerClient = tab.view.webContents.debugger
    try {
      if (debuggerClient.isAttached()) debuggerClient.detach()
      debuggerClient.attach('1.3')
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
    // 前台会话所有权由 renderer 的 setAgentBrowserForeground 同步维护；
    // 这里不能再次切换所有权，否则旧会话迟到的 open IPC 可能抢回主窗口。
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
   * 跨会话互斥：隐藏除 activeSessionId 外所有会话的原生浏览器视图。
   * 所有会话的 hostView/tab.view 都被 addChildView 在同一个 owner 主窗口上且盖在
   * renderer DOM 之上，只有随时保持“最多一个浏览器会话可见”，才能避免别的会话
   * 切到前台后旧会话网页“杵在界面上”的残留。
   */
  private hideOtherBrowserSessions(activeSessionId: string): void {
    for (const [otherSessionId, otherSession] of this.sessions) {
      if (otherSessionId === activeSessionId) continue
      if (otherSession.hostView.getVisible()) otherSession.hostView.setVisible(false)
      otherSession.lastVisible = false
      for (const otherTab of otherSession.tabs.values()) {
        if (otherTab.view.getVisible()) otherTab.view.setVisible(false)
        if (otherTab.state.visible) otherTab.state.visible = false
      }
    }
  }

  listTabs(sessionId: string): BrowserViewState {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    return structuredClone(this.buildState(browserSession))
  }

  setZoom(sessionId: string, tabId: string, zoomFactor: number): BrowserViewState {
    const browserSession = this.getSession(sessionId)
    const tab = browserSession.tabs.get(tabId)
    if (!tab) throw new Error(`浏览器标签不存在: ${tabId}`)
    const clamped = Math.max(0.5, Math.min(3, Math.round(zoomFactor * 20) / 20))
    tab.zoomFactor = clamped
    tab.view.webContents.setZoomFactor(clamped)
    this.emit(browserSession)
    return structuredClone(this.buildState(browserSession))
  }

  setLayout(layout: BrowserViewLayout): void {
    const browserSession = this.sessions.get(layout.sessionId)
    if (!browserSession) return
    // React effect cleanup 和新 slot 的 IPC 可以交错到达。只采纳最新一代布局，
    // 避免已卸载 tab 的晚到 visible=false/true 覆盖当前 tab。
    if (!Number.isSafeInteger(layout.revision) || layout.revision <= browserSession.lastLayoutRevision) return
    browserSession.lastLayoutRevision = layout.revision
    const tab = browserSession.tabs.get(layout.tabId ?? browserSession.activeTabId)
    // BrowserSlot 卸载与 tab 关闭可交错，晚到布局不应让 renderer 报错。
    if (!tab) return
    const bounds = layout.bounds
    const hasValidBounds = bounds.width > 4 && bounds.height > 4
    const visible = layout.visible
      && browserSession.sessionId === this.foregroundSessionId
      && hasValidBounds
      && !!this.owner
      && !this.owner.isDestroyed()
      && this.owner.isVisible()
    const zoomFactor = this.owner?.webContents.getZoomFactor() ?? 1
    const scaleBounds = (value: BrowserViewLayout['bounds']) => ({
      x: Math.round(value.x * zoomFactor),
      y: Math.round(value.y * zoomFactor),
      width: Math.max(0, Math.round(value.width * zoomFactor)),
      height: Math.max(0, Math.round(value.height * zoomFactor)),
    })
    const rawBounds = scaleBounds(bounds)
    // 原生 View 的 bounds 是窗口 contentView 坐标，不能允许异常/过渡布局把网页画出窗口。
    const contentBounds = this.owner?.contentView.getBounds()
    const constrainToWindow = (value: BrowserViewLayout['bounds']) => {
      const x = Math.max(0, value.x)
      const y = Math.max(0, value.y)
      return {
        x,
        y,
        width: Math.min(value.width, Math.max(0, (contentBounds?.width ?? value.width) - x)),
        height: Math.min(value.height, Math.max(0, (contentBounds?.height ?? value.height) - y)),
      }
    }
    // WebContentsView 无法由 renderer 的 overflow-hidden 裁剪；将带圆角的原生
    // hostView 扩展至整张浏览器卡片，并让网页在其中按局部坐标定位，才能裁掉底部露角。
    const adjustedBounds = constrainToWindow(scaleBounds(layout.hostBounds ?? bounds))
    const localX = Math.max(0, rawBounds.x - adjustedBounds.x)
    const localY = Math.max(0, rawBounds.y - adjustedBounds.y)
    const tabLayoutBounds = {
      x: localX,
      y: localY,
      width: Math.min(rawBounds.width, Math.max(0, adjustedBounds.width - localX)),
      height: Math.min(rawBounds.height, Math.max(0, adjustedBounds.height - localY)),
    }
    // 隐藏→显示过渡：即使边界未变也必须重写 bounds 并请求重绘。
    // 仅 setVisible(true) 时 Chromium 不会重新合成 WebContentsView 表面，网页会停留在空白。
    const wasVisible = browserSession.lastVisible
    const boundsChanged = !browserSession.lastHostBounds
      || Object.entries(adjustedBounds).some(([key, value]) => browserSession.lastHostBounds?.[key as keyof typeof adjustedBounds] !== value)
    if (visible && (boundsChanged || !wasVisible)) {
      browserSession.hostView.setBounds(adjustedBounds)
      browserSession.lastHostBounds = { ...adjustedBounds }
    }
    // 标签页只使用宿主的局部坐标，永远不会携带会话区的窗口绝对坐标。
    // 拖拽时通常只改变宿主 x/width；避免每一帧重复写入未变化的子视图 bounds/visible，
    // 否则 Chromium 会反复触发原生视图重排，造成网页跟手但不丝滑。
    for (const other of browserSession.tabs.values()) {
      const shouldBeVisible = visible && other.tabId === tab.tabId
      if (other.view.getVisible() !== shouldBeVisible) other.view.setVisible(shouldBeVisible)
    }
    const tabBounds = tab.view.getBounds()
    if (tabBounds.x !== tabLayoutBounds.x || tabBounds.y !== tabLayoutBounds.y
      || tabBounds.width !== tabLayoutBounds.width || tabBounds.height !== tabLayoutBounds.height) {
      tab.view.setBounds(tabLayoutBounds)
    }
    browserSession.lastTabBounds = { ...tabLayoutBounds }
    if (visible) {
      // 跨会话互斥：本会话浏览器被激活显示时，立即隐藏其他所有会话的原生视图。
      // 原生 View 全部 addChildView 在同一个主窗口 contentView 上且盖在 renderer DOM 之上。
      this.hideOtherBrowserSessions(layout.sessionId)
    }
    if (browserSession.hostView.getVisible() !== visible) browserSession.hostView.setVisible(visible)
    if (visible && !wasVisible) {
      // 重新合成被隐藏过的原生视图表面，避免恢复显示后网页空白。
      try { tab.view.webContents.invalidate() } catch { /* 页面可能已销毁 */ }
    }
    browserSession.lastVisible = visible
    if (tab.state.visible !== visible) { tab.state.visible = visible; this.emit(browserSession) }
  }

  /** 将指定标签置于前台；复用当前显示区域，避免等待 renderer layout 往返时仍显示旧页面。 */
  private activateDisplayTab(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): void {
    tab.lastActivityAt = Date.now()
    browserSession.activeTabId = tab.tabId
    for (const other of browserSession.tabs.values()) {
      if (other.tabId !== tab.tabId) other.view.setVisible(false)
    }
    const hostBounds = browserSession.lastHostBounds
    const tabBounds = browserSession.lastTabBounds
    if (tabBounds) tab.view.setBounds(tabBounds)
    tab.view.webContents.setZoomFactor(tab.zoomFactor)
    const visible = browserSession.sessionId === this.foregroundSessionId
      && !!hostBounds
      && !!this.owner
      && !this.owner.isDestroyed()
      && this.owner.isVisible()
    if (visible) this.hideOtherBrowserSessions(browserSession.sessionId)
    browserSession.hostView.setVisible(visible)
    tab.view.setVisible(visible)
    if (tab.state.visible !== visible) tab.state.visible = visible
    this.emit(browserSession)
  }

  private disposeTab(browserSession: BrowserSessionRecord, tab: BrowserTabRecord): void {
    browserSession.tabs.delete(tab.tabId)
    this.clearAgentTargetHighlight(tab)
    try { if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach() } catch { /* 已销毁 */ }
    try { browserSession.hostView.removeChildView(tab.view) } catch { /* 宿主已销毁 */ }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
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

  /**
   * 达到上限时回收最久未使用的 Agent 标签。用户创建的标签、当前前台标签和 Agent 当前工作标签
   * 一律保留；若没有安全候选，宁可暂时超过限制也不擅自关闭用户内容。
   */
  private reclaimExcessAgentTabs(browserSession: BrowserSessionRecord): number {
    const candidates = [...browserSession.tabs.values()]
      .filter((tab) => tab.openedByAgent && tab.tabId !== browserSession.activeTabId && tab.tabId !== browserSession.agentTabId)
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

  /** Agent 新建工作 tab，并立即切到该标签让用户能看到接下来的操作。 */
  async createNewTab(sessionId: string, url?: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.createTab(browserSession, false, true)
    browserSession.agentTabId = tab.tabId
    this.activateDisplayTab(browserSession, tab)
    const reclaimed = this.reclaimExcessAgentTabs(browserSession)
    this.trace(browserSession, tab, 'tab', reclaimed > 0
      ? `Agent 新建并打开工作标签；已回收 ${reclaimed} 个最久未使用的 Agent 标签`
      : `Agent 新建并打开工作标签 ${tab.tabId}`)
    if (url?.trim()) return this.navigate(sessionId, url, tab.tabId)
    return structuredClone(this.buildState(browserSession))
  }

  /** 用户在浏览器面板中新建 tab；不会抢占 Agent 的工作 tab。 */
  async createDisplayTab(sessionId: string, url?: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId, [], false)
    this.assertRiskDisclaimerAcknowledged()
    this.markUserBrowserContext(browserSession)
    const tab = this.createTab(browserSession)
    this.activateDisplayTab(browserSession, tab)
    const reclaimed = this.reclaimExcessAgentTabs(browserSession)
    if (reclaimed > 0) this.trace(browserSession, tab, 'tab', `标签超过 ${MAX_BROWSER_TABS} 个上限，已回收 ${reclaimed} 个最久未使用的 Agent 标签`)
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

  /** Agent 显式切换工作 tab，并同步激活用户可见的前台标签。 */
  selectAgentTab(sessionId: string, tabId: string): BrowserViewState {
    const browserSession = this.getSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    browserSession.agentTabId = tab.tabId
    this.activateDisplayTab(browserSession, tab)
    this.trace(browserSession, tab, 'tab', `Agent 切换并打开工作标签 ${tab.tabId}`)
    return structuredClone(this.buildState(browserSession))
  }

  async closeTab(sessionId: string, tabId: string): Promise<BrowserViewState | null> {
    const browserSession = this.getSession(sessionId)
    const tab = this.getDisplayTab(browserSession, tabId)
    const closingIndex = [...browserSession.tabs.keys()].indexOf(tab.tabId)
    this.disposeTab(browserSession, tab)
    if (browserSession.tabs.size === 0) {
      this.sessions.delete(sessionId)
      return null
    }
    if (browserSession.activeTabId === tab.tabId) this.selectAdjacentActiveTab(browserSession, closingIndex)
    if (browserSession.agentTabId === tab.tabId) browserSession.agentTabId = null
    this.emit(browserSession)
    return structuredClone(this.buildState(browserSession))
  }

  async previewOpen(sessionId: string, inputPath: string, tabId: string | undefined, allowedRoots: string[], baseDir?: string, signal?: AbortSignal): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId, allowedRoots)
    this.assertRiskDisclaimerAcknowledged()
    // 先校验路径，避免无效路径遗留一个空白的 Agent 预览标签。
    const preview = createAuthorizedPreviewUrl(inputPath, browserSession.allowedRoots, baseDir)
    const tab = tabId ? this.getAgentTab(browserSession, tabId) : this.createTab(browserSession, true, true)
    browserSession.agentTabId = tab.tabId
    this.activateDisplayTab(browserSession, tab)
    const reclaimed = this.reclaimExcessAgentTabs(browserSession)
    if (reclaimed > 0) this.trace(browserSession, tab, 'tab', `已回收 ${reclaimed} 个最久未使用的 Agent 标签以保持最多 ${MAX_BROWSER_TABS} 个标签`)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      tab.isLocalPreview = true
      try {
        await this.loadUrl(tab, preview.url, operationSignal)
        this.trace(browserSession, tab, 'navigate', `预览本地文件 ${preview.filePath.split(/[\\/]/).pop() ?? preview.filePath}`, 'verified')
        this.updateNavigationState(browserSession, tab)
        return structuredClone(this.buildState(browserSession))
      } catch (error) {
        this.trace(browserSession, tab, 'navigate', error instanceof BrowserOperationAbortedError ? '本地预览已停止，结果未知' : '本地预览加载失败', error instanceof BrowserOperationAbortedError ? 'unknown' : 'failed')
        throw error
      }
    })
  }

  private async loadUrl(tab: BrowserTabRecord, url: string, signal?: AbortSignal): Promise<void> {
    throwIfBrowserOperationAborted(signal)
    await withBrowserCdpTimeout(() => tab.view.webContents.loadURL(url), 'Page.navigate', BROWSER_OBSERVE_TIMEOUT_MS + 3_000, signal)
  }

  async navigate(sessionId: string, url: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId, [])
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    const safeUrl = await assertSafeBrowserDestination(url)
    const host = new URL(safeUrl).host
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      tab.isLocalPreview = false
      this.trace(browserSession, tab, 'navigate', `正在打开 ${host}`, 'dispatched')
      try {
        await this.loadUrl(tab, safeUrl, operationSignal)
        this.trace(browserSession, tab, 'navigate', `已打开 ${host}`, 'verified')
        this.updateNavigationState(browserSession, tab)
        return structuredClone(this.buildState(browserSession))
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

    const tab = this.createTab(browserSession)
    this.activateDisplayTab(browserSession, tab)
    const host = new URL(safeUrl).host
    try {
      await this.runTabOperation(browserSession, tab, undefined, async () => {
        tab.isLocalPreview = false
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
    const host = new URL(safeUrl).host
    return this.runTabOperation(browserSession, tab, undefined, async () => {
      tab.isLocalPreview = false
      this.trace(browserSession, tab, 'navigate', `正在打开 ${host}`, 'dispatched')
      try {
        await this.loadUrl(tab, safeUrl)
        this.trace(browserSession, tab, 'navigate', `已打开 ${host}`, 'verified')
        this.updateNavigationState(browserSession, tab)
        return structuredClone(this.buildState(browserSession))
      } catch (error) {
        this.trace(browserSession, tab, 'navigate', `无法打开 ${host}`, 'failed')
        throw error
      }
    })
  }

  async goBack(sessionId: string, tabId?: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    if (tab.view.webContents.canGoBack()) tab.view.webContents.goBack()
    this.updateNavigationState(browserSession, tab)
    return structuredClone(this.buildState(browserSession))
  }

  async goBackDisplay(sessionId: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    return this.goBack(sessionId, this.getDisplayTab(browserSession).tabId)
  }

  async goForward(sessionId: string, tabId?: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    if (tab.view.webContents.canGoForward()) tab.view.webContents.goForward()
    this.updateNavigationState(browserSession, tab)
    return structuredClone(this.buildState(browserSession))
  }

  async goForwardDisplay(sessionId: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    return this.goForward(sessionId, this.getDisplayTab(browserSession).tabId)
  }

  async reload(sessionId: string, tabId?: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    tab.view.webContents.reload()
    this.updateNavigationState(browserSession, tab)
    return structuredClone(this.buildState(browserSession))
  }

  async reloadDisplay(sessionId: string): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    return this.reload(sessionId, this.getDisplayTab(browserSession).tabId)
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

  async click(sessionId: string, ref: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> {
    const browserSession = this.getOrCreateSession(sessionId)
    this.assertRiskDisclaimerAcknowledged()
    const tab = this.getAgentTab(browserSession, tabId)
    return this.runTabOperation(browserSession, tab, signal ?? browserSession.agentAbortController.signal, async (operationSignal) => {
      const generation = tab.generation
      const target = this.resolveRef(tab, ref)
      const { x, y } = await this.centerForRef(tab, ref, operationSignal, generation)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.highlightAgentTarget(tab, target.backendNodeId)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, undefined, operationSignal)
      this.assertCurrentDocument(tab, generation, operationSignal)
      await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, undefined, operationSignal)
      this.trace(browserSession, tab, 'click', `点击 ${target.label}`, 'dispatched')
      return structuredClone(this.buildState(browserSession))
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

  async fill(sessionId: string, ref: string, text: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> {
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
      return structuredClone(this.buildState(browserSession))
    })
  }

  async press(sessionId: string, key: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> {
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
      return structuredClone(this.buildState(browserSession))
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
      const image = await withBrowserCdpTimeout(() => tab.view.webContents.capturePage(), 'Page.captureScreenshot', BROWSER_OBSERVE_TIMEOUT_MS + 3_000, operationSignal)
      throwIfBrowserOperationAborted(operationSignal)
      const buffer = image.toPNG()
      if (buffer.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('截图过大，请缩小页面或改用 browser_observe。')
      this.trace(browserSession, tab, 'screenshot', '截取当前页面', 'verified')
      return { tabId: tab.tabId, url: tab.state.url, mimeType: 'image/png', base64: buffer.toString('base64') }
    })
  }

  /**
   * 立即隐藏会话的全部原生视图，但不销毁网页、Cookie 或标签状态。
   * BrowserSlot 的 effect cleanup 是异步 IPC：在 React 卸载前，WebContentsView 仍会盖在
   * renderer 上。面板关闭动作必须同步走这条主进程路径，避免页面视觉残留。
   */
  hide(sessionId: string): void {
    // 隐藏是当前会话的面板动作，不等于失去前台所有权；保留 ownership，
    // 这样用户再次点击打开时，新的 BrowserSlot layout 可以正常显示视图。
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return
    browserSession.lastVisible = false
    browserSession.hostView.setVisible(false)
    for (const tab of browserSession.tabs.values()) {
      tab.view.setVisible(false)
      tab.state.visible = false
    }
  }

  /**
   * 隐藏所有会话的原生浏览器视图，但不销毁网页/标签/Cookie。
   * 用于 renderer 刷新（Ctrl/Cmd+R）等场景：此时 renderer 即将重建，内存 atom 会清空，
   * 不再有 BrowserSlot 去 setLayout 定位/隐藏原生 view；若不在此刻隐藏，主窗口重新显示后
   * 旧会话的网页会裸奔在旧位置，脱离浏览器容器、不再受控。
   */
  hideAll(): void {
    this.foregroundSessionId = null
    for (const browserSession of this.sessions.values()) {
      browserSession.lastVisible = false
      browserSession.hostView.setVisible(false)
      for (const tab of browserSession.tabs.values()) {
        tab.view.setVisible(false)
        tab.state.visible = false
      }
    }
  }

  async close(sessionId: string): Promise<void> {
    if (this.foregroundSessionId === sessionId) this.foregroundSessionId = null
    const browserSession = this.sessions.get(sessionId)
    if (!browserSession) return
    this.sessions.delete(sessionId)
    for (const tab of browserSession.tabs.values()) {
      this.clearAgentTargetHighlight(tab)
      try { if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach() } catch { /* 已销毁 */ }
      try { browserSession.hostView.removeChildView(tab.view) } catch { /* 宿主已销毁 */ }
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    try { this.owner?.contentView.removeChildView(browserSession.hostView) } catch { /* owner 已销毁 */ }
    browserSession.tabs.clear()
  }

  dispose(): void {
    this.foregroundSessionId = null
    for (const sessionId of [...this.sessions.keys()]) void this.close(sessionId)
    this.configurations.clear()
    this.owner = null
  }
}

export const browserController = new BrowserController()
