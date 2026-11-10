// 受管浏览器对所有 Agent 会话开放；会话来源只影响 UI 标识。

export interface BrowserGuestRequest {
  sessionId: string
  tabId: string
  partition: string
  /** 主进程一次性签发的挂载票据；与具体页面实例绑定，不是导航 URL。 */
  ticket: string
  src: string
}

export interface BrowserGuestClaim {
  sessionId: string
  tabId: string
  ticket: string
  guestId: number
}

export interface BrowserGuestVisibility {
  sessionId: string
  tabId: string
  ticket: string
  visible: boolean
}

export interface BrowserGuestFocusEvent {
  sessionId: string
  tabId: string
}

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserExecutionSource = 'user' | 'automation' | 'delegation' | 'goal'

export type BrowserTraceAction = 'navigate' | 'observe' | 'wait' | 'click' | 'fill' | 'press' | 'dom' | 'script' | 'screenshot' | 'scroll' | 'extract' | 'tab'
export type BrowserOperationStatus = 'dispatched' | 'verified' | 'failed' | 'unknown'

/** 脱敏的浏览器操作账本项；绝不含输入正文、Cookie、截图或脚本全文。 */
export interface BrowserTraceItem {
  id: string
  action: BrowserTraceAction
  summary: string
  at: number
  /** 兼容旧 UI：仅 failed/unknown 为 false。新代码应使用 status。 */
  success: boolean
  status: BrowserOperationStatus
  tabId: string
  domain: string | null
  executionSource: BrowserExecutionSource
}

/**
 * 本地文件预览标签的展示信息。
 *
 * 浏览器列里的"文件面"（HTML 直载、或非 HTML 走内置 viewer 页）都用它描述：
 * 渲染侧据此把地址栏换成「本地文件 · 只读 + 文件名」，而不是显示 profer-file token URL。
 * 不含绝对路径 —— 路径边界留在主进程。
 */
export interface BrowserLocalFileInfo {
  /** 文件名（不含目录） */
  name: string
  /** 只读预览：地址栏不可编辑、不写浏览历史 */
  readOnly: true
}

export interface BrowserShortcutBinding {
  id: string
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

export interface BrowserShortcutContext {
  scopeId: string
  revision: number
  target?: { sessionId: string; tabId: string }
  bindings: BrowserShortcutBinding[]
}

export interface BrowserShortcutEvent {
  scopeId: string
  revision: number
  sessionId: string
  tabId: string
  ticket: string
  shortcutId: string
}

export interface BrowserFindInput {
  query: string
  next?: boolean
  forward?: boolean
  matchCase?: boolean
}

export interface BrowserFindState {
  query: string
  matches: number
  activeMatchOrdinal: number
  searching: boolean
  matchCase?: boolean
}

export interface BrowserScriptDialog {
  id: string
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  origin: string
  defaultPrompt: string
  responding: boolean
}

export interface BrowserDialogResponse {
  dialogId: string
  accept: boolean
  promptText?: string
}

export interface BrowserPageInteractionState {
  find?: BrowserFindState | null
  dialog?: BrowserScriptDialog | null
}

export interface BrowserTabState extends BrowserPageInteractionState {
  tabId: string
  url: string
  title: string
  /** 本地文件预览标签的展示信息；普通网页为 null */
  localFile: BrowserLocalFileInfo | null
  loading: boolean
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 当前网页标签的独立缩放倍率，1 = 100%。 */
  zoomFactor: number
  /** 用户阅读用途：当前 tab 是否处于整页翻译态。 */
  translated: boolean
  /** 最近一次主框架加载失败的原因；成功导航或重新开始加载时清空。 */
  loadError: string | null
  trace: BrowserTraceItem[]
}

export interface BrowserTabSummary extends BrowserPageInteractionState {
  tabId: string
  url: string
  title: string
  /** 本地文件预览标签的展示信息；普通网页为 null */
  localFile: BrowserLocalFileInfo | null
  loading: boolean
  /** 当前网页标签的独立缩放倍率，1 = 100%。 */
  zoomFactor: number
  /** 此标签由 Agent 创建（与当前默认工作标签无关）。 */
  openedByAgent: boolean
  /** 每页状态供两页同时分屏；缺失仅用于兼容旧状态。 */
  visible?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  translated?: boolean
  loadError?: string | null
}

/**
 * BrowserListTabs 的专用返回结构。
 *
 * 与 BrowserViewState 的关键区别：它只描述「已经存在的浏览器会话与标签」，
 * 不代表浏览器可以被渲染。会话不存在时 exists=false、tabs 为空，
 * 读取方绝不能据此创建 session / tab 或向 renderer 广播状态，
 * 否则一次只读查询会凭空打开浏览器面板。
 */
export interface BrowserTabListResult {
  sessionId: string
  /** 该会话是否已经存在真实浏览器会话；false 时调用方不得创建。 */
  exists: boolean
  activeTabId: string | null
  /** Agent 的默认工作标签；无会话或已关闭时为 null。 */
  agentTabId: string | null
  tabs: BrowserTabSummary[]
}

export interface BrowserViewState extends BrowserPageInteractionState {
  sessionId: string
  /** 非用户触发时，面板可显示来源并提供停止当前 Agent run 的控制。 */
  executionSource: BrowserExecutionSource
  /** 用户在浏览器面板中查看的 tab。 */
  activeTabId: string
  /** Agent 的默认工作 tab；被用户关闭后为 null，绝不回退到用户标签。 */
  agentTabId: string | null
  tabs: BrowserTabSummary[]
  /** 当前 active tab 的投影，保留扁平字段方便工具和旧 renderer 使用。 */
  url: string
  title: string
  /** 当前 active tab 是本地文件预览时的展示信息；普通网页为 null */
  localFile: BrowserLocalFileInfo | null
  loading: boolean
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 当前显示网页标签的独立缩放倍率，1 = 100%。 */
  zoomFactor: number
  /** 脱敏的操作账本，始终代表当前会话，非单一显示标签。 */
  trace: BrowserTraceItem[]
  /** 最近一条 Agent 操作，用于用户未查看工作 tab 时的非阻断活动提示。 */
  activity: BrowserTraceItem | null
  /** 当前 active tab 是否处于整页翻译态（用户点击翻译按钮后）。 */
  translated: boolean
  /**
   * 当前 active tab 主框架加载失败的原因；null 表示没有失败。
   * 注意：浏览器内部错误页（chrome-error://）不会写入 url，失败原因只在这里暴露，
   * 面板据此展示可重试的错误态。
   */
  loadError: string | null
}

/**
 * Agent 动作结果：顶层页面字段属于 tabId，activeTabId 仍表示用户显示页。
 * 与 BROWSER_STATE_CHANGED 的 UI 投影分开，避免后台操作返回另一标签的 URL/导航状态。
 */
export interface BrowserActionResult extends BrowserViewState {
  /** 本次实际操作的标签，不隐式改变用户显示目标。 */
  tabId: string
}

export interface BrowserNavigateInput {
  sessionId: string
  tabId?: string
  url: string
}

export interface BrowserTabInput {
  sessionId: string
  tabId?: string
}

export interface BrowserCreateTabInput {
  sessionId: string
  url?: string
}

export type BrowserScrollDirection = 'up' | 'down' | 'left' | 'right'

export interface BrowserScrollInput {
  direction?: BrowserScrollDirection
  amount?: number
  selector?: string
}

export interface BrowserScrollResult {
  tabId: string
  url: string
  title: string
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
  atTop: boolean
  atBottom: boolean
  atLeft: boolean
  atRight: boolean
}

export type BrowserExtractMode = 'text' | 'links' | 'table' | 'attributes'

export interface BrowserExtractInput {
  selector?: string
  mode?: BrowserExtractMode
  limit?: number
}

export interface BrowserExtractItem {
  text?: string
  href?: string | null
  attributes?: Record<string, string>
  headers?: string[]
  cells?: string[][]
}

export interface BrowserExtractResult {
  tabId: string
  url: string
  title: string
  selector: string
  mode: BrowserExtractMode
  items: BrowserExtractItem[]
  truncated: boolean
}

export interface BrowserTranslateResult {
  /** 翻译操作完成后当前标签是否处于翻译态（true=已翻译，false=已恢复原文）。 */
  translated: boolean
  /** 失败原因（仅在无法翻译时给出）。 */
  error?: string
}

/** 新标签页起始页：用户收藏的站点书签。 */
export interface BrowserBookmark {
  id: string
  title: string
  url: string
  /** 站点 favicon 的 data URL（base64 内联），抓取失败时为空串。 */
  favicon: string
  createdAt: number
}

/** 新标签页起始页：最近访问记录（只用于列表展示，非完整历史页）。 */
export interface BrowserHistoryEntry {
  url: string
  title: string
  lastVisitedAt: number
}

/** 新标签页起始页聚合状态，渲染层一次性拉取。 */
export interface BrowserStartPageState {
  bookmarks: BrowserBookmark[]
  recentHistory: BrowserHistoryEntry[]
  /** 可配置默认首页 URL；空 = 显示自定义起始页。 */
  defaultHomeUrl: string | null
}

/** 新增书签入参。 */
export interface BrowserAddBookmarkInput {
  title: string
  url: string
}

/** 受管网页的下载被安全拦截后推送给渲染进程的脱敏事件。绝不含下载内容或本地路径。 */
export interface BrowserDownloadBlockedEvent {
  sessionId: string
  /** 文件建议名（来自下载项），仅用于提示展示。 */
  fileName: string
  /** 触发下载的页面 URL，仅用于“在系统浏览器打开”动作。 */
  url: string
}

/**
 * 用户在浏览器列的本地文件预览里划词。
 *
 * 那条链路跨越了进程边界：选区在**无 preload 的沙箱 viewer 页**里，
 * 页面只能把文本以哨兵 URL 回投给主进程，主进程再转给渲染进程，
 * 渲染进程把它转成一条引用插入输入框正文（`[n]` 胶囊）。
 */
export interface BrowserLocalFileSelectionEvent {
  sessionId: string
  /** 选中的文本（已按上限截断）；空串表示选区已清空，渲染进程不再插入新引用。 */
  text: string
  /** 预览中的文件绝对路径，与预览面板引用的 filePath 同口径。 */
  filePath: string
  /** 文件名，用于引用胶囊的展示名。 */
  fileName: string
}
