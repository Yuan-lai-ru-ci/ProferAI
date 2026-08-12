// 受管浏览器对所有 Agent 会话开放；会话来源只影响 UI 标识。

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViewLayout {
  sessionId: string
  tabId?: string
  /** Renderer 全局单调递增代际；主进程忽略晚到的旧布局 IPC。 */
  revision: number
  visible: boolean
  bounds: BrowserViewBounds
}

export type BrowserExecutionSource = 'user' | 'automation' | 'delegation'

export type BrowserTraceAction = 'navigate' | 'observe' | 'wait' | 'click' | 'fill' | 'press' | 'dom' | 'script' | 'screenshot' | 'tab'
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

export interface BrowserTabState {
  tabId: string
  url: string
  title: string
  loading: boolean
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 当前网页标签的独立缩放倍率，1 = 100%。 */
  zoomFactor: number
  /** 用户阅读用途：当前 tab 是否处于整页翻译态。 */
  translated: boolean
  trace: BrowserTraceItem[]
}

export interface BrowserTabSummary {
  tabId: string
  url: string
  title: string
  loading: boolean
  /** 当前网页标签的独立缩放倍率，1 = 100%。 */
  zoomFactor: number
  /** 此标签由 Agent 创建（与当前默认工作标签无关）。 */
  openedByAgent: boolean
}

export interface BrowserViewState {
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
