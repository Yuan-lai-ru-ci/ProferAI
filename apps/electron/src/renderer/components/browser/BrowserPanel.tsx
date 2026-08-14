import * as React from 'react'
import type { BrowserStartPageState, BrowserViewState } from '@profer/shared'
import { ArrowLeft, ArrowRight, Globe2, Languages, LoaderCircle, Minus, PanelRightClose, Plus, RefreshCw, ShieldAlert, Square, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { BROWSER_RISK_DISCLAIMER_VERSION } from '@/types/settings'
import { BrowserSlot } from './BrowserSlot'
import { BrowserStartPage } from './BrowserStartPage'

interface BrowserPanelProps {
  sessionId: string
  state: BrowserViewState | null
  /** 归属会话的标题，用于在悬浮面板上标识浏览器属于哪个会话。 */
  sessionTitle?: string
  /** 浏览器卡片实际位于窗口右缘时，为悬浮 WindowControls 保留空间。 */
  avoidWindowControls?: boolean
  /** 外层布局发生结构性变化时重建定位锚点，但不销毁网页标签。 */
  layoutKey?: string
  onClose: () => void
}

export function BrowserPanel({ sessionId, state, avoidWindowControls = false, layoutKey = '', onClose }: BrowserPanelProps): React.ReactElement {
  const [url, setUrl] = React.useState(state?.url ?? '')
  // 用户正在地址栏输入/聚焦时，禁止用主进程回推的 state.url 覆盖，避免被 Agent 导航顶掉输入。
  const urlDirtyRef = React.useRef(false)
  const urlInputRef = React.useRef<HTMLInputElement>(null)
  const [riskAcknowledged, setRiskAcknowledged] = React.useState<boolean | null>(null)
  const [translating, setTranslating] = React.useState(false)
  const [translated, setTranslated] = React.useState(state?.translated ?? false)
  const [startPage, setStartPage] = React.useState<BrowserStartPageState | null>(null)
  const [bookmarking, setBookmarking] = React.useState(false)
  // 阻止默认首页重复跳转：同一空标签只自动导航一次。
  const autoNavigatedTabRef = React.useRef<string | null>(null)

  React.useEffect(() => setTranslated(state?.translated ?? false), [state?.translated])

  const refreshStartPage = React.useCallback(async () => {
    try {
      const api = (window.electronAPI as Partial<typeof window.electronAPI>)
      if (typeof api.getBrowserStartPage !== 'function') return
      setStartPage(await api.getBrowserStartPage())
    } catch (error) {
      console.error('[受管浏览器] 读取起始页失败:', error)
    }
  }, [])

  // 首次加载起始页数据；activeTabId 变化时刷新（书签/历史更新后回显）。
  React.useEffect(() => { void refreshStartPage() }, [refreshStartPage])

  // 仅在用户未在编辑地址栏时同步主进程回推的 URL。
  React.useEffect(() => {
    if (urlDirtyRef.current) return
    setUrl(state?.url ?? '')
  }, [state?.url])

  // 订阅“下载被拦截”事件：受管浏览器不放行下载，但给用户可见反馈。
  React.useEffect(() => {
    const unsubscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserDownloadBlocked
      ?.((payload) => {
        if (payload.sessionId !== sessionId) return
        toast.warning('已拦截下载，受管浏览器不向本地保存文件', {
          description: payload.fileName,
          action: payload.url ? {
            label: '在系统浏览器打开',
            onClick: () => void window.electronAPI.openExternal(payload.url),
          } : undefined,
        })
      })
    return unsubscribe
  }, [sessionId])

  const toggleTranslate = React.useCallback(async () => {
    const doTranslate = (window.electronAPI as Partial<typeof window.electronAPI>).translateAgentBrowser
    if (typeof doTranslate !== 'function') return
    setTranslating(true)
    try {
      const result = await doTranslate({ sessionId, tabId: undefined })
      setTranslated(result.translated)
    } catch (error) {
      console.error('[受管浏览器] 翻译失败:', error)
    } finally {
      setTranslating(false)
    }
  }, [sessionId])
  const [savingRiskAcknowledgement, setSavingRiskAcknowledgement] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.getSettings()
      .then((settings) => {
        if (!cancelled) setRiskAcknowledged((settings.browserRiskDisclaimerVersion ?? 0) >= BROWSER_RISK_DISCLAIMER_VERSION)
      })
      .catch((error) => {
        console.error('[受管浏览器] 读取风险告知状态失败:', error)
        if (!cancelled) setRiskAcknowledged(false)
      })
    return () => { cancelled = true }
  }, [])

  const navigate = React.useCallback(async () => {
    const value = url.trim()
    const navigateBrowser = (window.electronAPI as Partial<typeof window.electronAPI>).navigateAgentBrowser
    if (!value || typeof navigateBrowser !== 'function') return
    try {
      await navigateBrowser({ sessionId, url: value })
      // 导航已提交并生效，解除脏标记并同步为提交地址；后续主进程回推状态会再次校正。
      urlDirtyRef.current = false
      setUrl(value)
    } catch (error) {
      console.error('[受管浏览器] 导航失败:', error)
      toast.error('导航失败', { description: error instanceof Error ? error.message : '无法打开该地址' })
    }
  }, [sessionId, url])

  /** 收起浏览器面板（不销毁主进程浏览器会话），与标签页的关闭按钮语义区分，避免误触销毁整个浏览器。 */
  const closeBrowserPanel = React.useCallback(() => {
    // 仅收起面板：浏览器会话仍由主进程管理，会话删除/窗口关闭时才真正销毁。
    onClose()
  }, [onClose])

  const acceptRiskDisclaimer = React.useCallback(async () => {
    setSavingRiskAcknowledgement(true)
    try {
      await window.electronAPI.updateSettings({ browserRiskDisclaimerVersion: BROWSER_RISK_DISCLAIMER_VERSION })
      setRiskAcknowledged(true)
    } catch (error) {
      console.error('[受管浏览器] 保存风险告知确认失败:', error)
    } finally {
      setSavingRiskAcknowledgement(false)
    }
  }, [])

  const stopBackgroundRun = React.useCallback(async () => {
    if (state?.executionSource === 'user') return
    try {
      await window.electronAPI.stopAgent(sessionId)
    } catch (error) {
      console.error('[受管浏览器] 停止后台 Agent 失败:', error)
    }
  }, [sessionId, state?.executionSource])

  const activeTabId = state?.activeTabId ?? ''
  const agentTabId = state?.agentTabId ?? ''
  const tabs = state?.tabs ?? []
  const riskBlocked = riskAcknowledged !== true
  const isBackgroundRun = state?.executionSource === 'automation' || state?.executionSource === 'delegation'
  const activity = state?.activity ?? null
  const activityStatus = activity?.status === 'unknown' ? '结果未知' : activity?.status === 'failed' ? '失败' : activity?.status === 'dispatched' ? '已派发' : '已完成'
  const activityDomain = activity?.domain ? ` · ${activity.domain}` : ''
  const showActivity = activity?.status === 'dispatched' || activity?.status === 'failed' || activity?.status === 'unknown'
  const zoomPercent = Math.round((state?.zoomFactor ?? 1) * 100)
  const changeZoom = (delta: number) => {
    const setZoom = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserZoom
    if (!setZoom || !state?.activeTabId) return
    void setZoom({ sessionId, tabId: state.activeTabId, zoomFactor: (state.zoomFactor ?? 1) + delta })
  }

  const selectTab = React.useCallback(async (tabId: string) => {
    const select = (window.electronAPI as Partial<typeof window.electronAPI>).selectAgentBrowserTab
    if (typeof select !== 'function') return
    try { await select({ sessionId, tabId }) } catch (error) { console.error('[受管浏览器] 切换标签失败:', error) }
  }, [sessionId])

  const createTab = React.useCallback(async () => {
    const create = (window.electronAPI as Partial<typeof window.electronAPI>).createAgentBrowserTab
    if (typeof create !== 'function') return
    try { await create({ sessionId }) } catch (error) { console.error('[受管浏览器] 新建标签失败:', error) }
  }, [sessionId])

  const closeTab = React.useCallback(async (tabId: string) => {
    const closeBrowserTab = (window.electronAPI as Partial<typeof window.electronAPI>).closeAgentBrowserTab
    if (typeof closeBrowserTab !== 'function') return
    try {
      const next = await closeBrowserTab({ sessionId, tabId })
      if (!next) onClose()
    } catch (error) { console.error('[受管浏览器] 关闭标签失败:', error) }
  }, [onClose, sessionId])

  const toggleBookmark = React.useCallback(async () => {
    if (!startPage || !state?.url) return
    const api = (window.electronAPI as Partial<typeof window.electronAPI>)
    const isBookmarked = startPage.bookmarks.some((b) => b.url === state.url)
    if (isBookmarked) {
      const target = startPage.bookmarks.find((b) => b.url === state.url)
      if (target && typeof api.removeBrowserBookmark === 'function') {
        setStartPage(await api.removeBrowserBookmark(target.id))
      }
      return
    }
    if (typeof api.addBrowserBookmark !== 'function') return
    setBookmarking(true)
    try {
      setStartPage(await api.addBrowserBookmark({ title: state.title || state.url, url: state.url }))
    } catch (error) {
      console.error('[受管浏览器] 收藏失败:', error)
      toast.error('收藏失败', { description: error instanceof Error ? error.message : '未知错误' })
    } finally {
      setBookmarking(false)
    }
  }, [startPage, state?.url, state?.title])

  const removeBookmark = React.useCallback(async (id: string) => {
    const api = (window.electronAPI as Partial<typeof window.electronAPI>)
    if (typeof api.removeBrowserBookmark !== 'function') return
    try {
      setStartPage(await api.removeBrowserBookmark(id))
    } catch (error) { console.error('[受管浏览器] 删除书签失败:', error) }
  }, [])

  const clearHistory = React.useCallback(async () => {
    const api = (window.electronAPI as Partial<typeof window.electronAPI>)
    if (typeof api.clearBrowserHistory !== 'function') return
    try {
      setStartPage(await api.clearBrowserHistory())
    } catch (error) { console.error('[受管浏览器] 清空历史失败:', error) }
  }, [])

  const navigateStartPage = React.useCallback(async (targetUrl: string) => {
    const navigateBrowser = (window.electronAPI as Partial<typeof window.electronAPI>).navigateAgentBrowser
    if (!targetUrl || typeof navigateBrowser !== 'function') return
    try {
      await navigateBrowser({ sessionId, url: targetUrl })
      urlDirtyRef.current = false
      setUrl(targetUrl)
    } catch (error) {
      console.error('[受管浏览器] 导航失败:', error)
      toast.error('导航失败', { description: error instanceof Error ? error.message : '无法打开该地址' })
    }
  }, [sessionId])

  // 默认首页：空标签且配置了默认首页时自动导航（同一标签只触发一次）。
  const isEmptyTab = !state?.url
  const activeTabIdForNav = state?.activeTabId ?? ''
  const defaultHomeUrl = startPage?.defaultHomeUrl ?? null
  React.useEffect(() => {
    if (!isEmptyTab || !defaultHomeUrl) return
    if (autoNavigatedTabRef.current === activeTabIdForNav) return
    autoNavigatedTabRef.current = activeTabIdForNav
    void navigateStartPage(defaultHomeUrl)
  }, [isEmptyTab, defaultHomeUrl, activeTabIdForNav, navigateStartPage])

  const isBookmarked = !!state?.url && (startPage?.bookmarks.some((b) => b.url === state.url) ?? false)

  const title = state?.title || '受管浏览器'
  // 会话来源标识：区分用户手动、自动任务、委派子会话，让用户一眼看出是谁在驱动这个浏览器。
  const sourceLabel = state?.executionSource === 'automation' ? '自动任务' : state?.executionSource === 'delegation' ? '委派' : null
  return (
    <div className="@container relative flex flex-1 flex-col h-full w-full min-w-0 overflow-hidden rounded-2xl bg-content-area shadow-xl dark:shadow-sm titlebar-no-drag">
      {/* 浏览器是最右侧分栏时，窗口按钮成为浏览器顶栏的一部分。 */}
      <WindowControlsHost id="browser-panel" active={avoidWindowControls} priority={20} className="absolute right-2 top-[3px] z-10" />
      <div className={`flex items-center h-[34px] gap-1 px-2 border-b border-border/40 bg-muted/20 ${avoidWindowControls ? 'pr-[126px]' : ''}`}>
        <Globe2 className="size-3.5 shrink-0 text-primary ml-1" />
        {sourceLabel && (
          <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[9px] font-medium text-primary">{sourceLabel}</span>
        )}
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6" disabled={riskBlocked || !state?.canGoBack} onClick={() => void window.electronAPI.goBackAgentBrowser?.(sessionId)}><ArrowLeft className="size-3.5" /></Button></TooltipTrigger><TooltipContent>后退</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6" disabled={riskBlocked || !state?.canGoForward} onClick={() => void window.electronAPI.goForwardAgentBrowser?.(sessionId)}><ArrowRight className="size-3.5" /></Button></TooltipTrigger><TooltipContent>前进</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6" disabled={riskBlocked} onClick={() => void window.electronAPI.reloadAgentBrowser?.(sessionId)}><RefreshCw className="size-3.5" /></Button></TooltipTrigger><TooltipContent>刷新</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className={`size-6 ${translated ? 'text-primary' : ''}`} disabled={riskBlocked || translating} onClick={() => void toggleTranslate()}>{translating ? <LoaderCircle className="size-3.5 animate-spin" /> : <Languages className="size-3.5" />}</Button></TooltipTrigger><TooltipContent>{translated ? '恢复原文' : '整页翻译'}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className={`size-6 ${isBookmarked ? 'text-amber-500' : ''}`} disabled={riskBlocked || !state?.url || bookmarking} onClick={() => void toggleBookmark()} aria-label="收藏当前页">{bookmarking ? <LoaderCircle className="size-3.5 animate-spin" /> : <Star className={`size-3.5 ${isBookmarked ? 'fill-current' : ''}`} />}</Button></TooltipTrigger><TooltipContent>{isBookmarked ? '取消收藏' : '收藏当前页'}</TooltipContent></Tooltip>
        <form className="flex-1 min-w-0" onSubmit={(event) => { event.preventDefault(); if (!riskBlocked) void navigate() }}>
          <Input
            ref={urlInputRef}
            disabled={riskBlocked}
            value={url}
            onChange={(event) => { const v = event.target.value; setUrl(v); urlDirtyRef.current = true }}
            onFocus={() => { urlDirtyRef.current = true }}
            onBlur={() => { urlDirtyRef.current = false }}
            onKeyDown={(event) => { if (event.key === 'Enter') urlDirtyRef.current = false }}
            placeholder="输入域名或 URL（默认 HTTPS，仅公共网站）"
            className="h-6 text-xs bg-background/70"
            aria-label="浏览器地址"
          />
        </form>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6" disabled={riskBlocked || zoomPercent <= 50} onClick={() => changeZoom(-0.1)} aria-label="缩小网页"><Minus className="size-3.5" /></Button></TooltipTrigger><TooltipContent>缩小网页</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><button type="button" className="min-w-9 px-1 text-[10px] text-muted-foreground hover:text-foreground" disabled={riskBlocked} onClick={() => { const setZoom = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserZoom; if (setZoom && state?.activeTabId) void setZoom({ sessionId, tabId: state.activeTabId, zoomFactor: 1 }) }} aria-label="重置网页缩放">{zoomPercent}%</button></TooltipTrigger><TooltipContent>重置网页缩放</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6" disabled={riskBlocked || zoomPercent >= 300} onClick={() => changeZoom(0.1)} aria-label="放大网页"><Plus className="size-3.5" /></Button></TooltipTrigger><TooltipContent>放大网页</TooltipContent></Tooltip>
        {state?.loading && <LoaderCircle className="size-3.5 text-muted-foreground animate-spin" />}
        {isBackgroundRun && (
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-amber-600 hover:text-amber-700" onClick={() => void stopBackgroundRun()} aria-label="停止当前后台 Agent"><Square className="size-3.5 fill-current" /></Button></TooltipTrigger><TooltipContent>停止当前{state?.executionSource === 'automation' ? '自动任务' : '委派'}运行</TooltipContent></Tooltip>
        )}
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7" onClick={() => void closeBrowserPanel()}><PanelRightClose className="size-3.5" /></Button></TooltipTrigger><TooltipContent>关闭浏览器面板（保留浏览器会话）</TooltipContent></Tooltip>
      </div>
      <div className="flex items-center h-8 gap-1 px-2 border-b border-border/30 bg-muted/10 overflow-x-auto scrollbar-none">
        {tabs.map((tab) => (
          <button
            key={tab.tabId}
            type="button"
            disabled={riskBlocked}
            onClick={() => void selectTab(tab.tabId)}
            onMouseDown={(event) => {
              // 中键关闭标签，与顶部会话标签行为一致
              if (event.button === 1) {
                event.preventDefault()
                void closeTab(tab.tabId)
              }
            }}
            className={`group flex items-center gap-1.5 h-6 min-w-[120px] max-w-[220px] px-2 rounded text-[11px] disabled:cursor-not-allowed disabled:opacity-50 ${tab.tabId === activeTabId ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
            aria-label={`切换到 ${tab.title || '新建标签页'}${tab.openedByAgent ? '（由 Agent 创建）' : ''}`}
          >
            <Globe2 className="size-3 shrink-0" />
            <span className="truncate flex-1 text-left">{tab.title || '新建标签页'}</span>
            {tab.openedByAgent && <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[9px] font-medium text-primary">Agent</span>}
            <span
              role="button"
              tabIndex={0}
              className="shrink-0 rounded p-0.5 opacity-50 hover:bg-muted hover:opacity-100"
              aria-label={`关闭 ${tab.title || '标签'}`}
              onClick={(event) => { event.stopPropagation(); void closeTab(tab.tabId) }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void closeTab(tab.tabId) } }}
            >
              <X className="size-3" />
            </span>
          </button>
        ))}
        <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" disabled={riskBlocked} onClick={() => void createTab()} aria-label="新建浏览器标签"><Plus className="size-3.5" /></Button></TooltipTrigger><TooltipContent>新建标签</TooltipContent></Tooltip>
      </div>
      {showActivity && activity && (
        <div className="flex min-h-7 items-center gap-2 border-b border-border/25 bg-primary/[0.04] px-3 py-1 text-[11px]" role="status" aria-live="polite">
          <span className="shrink-0 font-medium text-primary">Agent 活动</span>
          <span className="shrink-0 text-muted-foreground">{activityStatus}</span>
          <span className="truncate text-foreground/80">{activity.summary}{activityDomain}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{activity.tabId === agentTabId ? '工作标签' : `标签 ${activity.tabId}`}</span>
        </div>
      )}
      {riskAcknowledged === true ? (
        isEmptyTab && !defaultHomeUrl ? (
          <BrowserStartPage
            state={startPage ?? { bookmarks: [], recentHistory: [], defaultHomeUrl: null }}
            onNavigate={(url) => void navigateStartPage(url)}
            onRemoveBookmark={removeBookmark}
            onClearHistory={clearHistory}
          />
        ) : (
          <BrowserSlot key={`${activeTabId}:${layoutKey}`} sessionId={sessionId} tabId={activeTabId} />
        )
      ) : (
        <div className="flex flex-1 min-h-0 items-center justify-center bg-muted/15 px-8 text-center">
          <div className="max-w-sm space-y-2 text-muted-foreground">
            <ShieldAlert className="mx-auto size-7 text-amber-500/90" />
            <p className="text-sm font-medium text-foreground">使用前请阅读风险告知</p>
            <p className="text-xs leading-5">受管浏览器将在确认后启用，登录状态只保存在本机。</p>
          </div>
        </div>
      )}
      <AlertDialog open={riskAcknowledged === false} onOpenChange={(open) => { if (!open && !savingRiskAcknowledgement) closeBrowserPanel() }}>
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-5" />
            </div>
            <AlertDialogTitle className="text-balance">首次使用受管浏览器</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left leading-6">
                <p>Profer 可让 Agent 在浏览器中读取、搜索、点击和输入。部分平台可能将这些行为或高频操作识别为自动化活动。</p>
                <p>这可能导致验证码、限流、功能限制、账号风控，严重时可能造成账号处罚或封禁。请自行了解并遵守目标平台规则，并自行承担相应风险。</p>
                <p>受管浏览器已启用剪贴板读写权限：页面可通过系统剪贴板复制与粘贴文本，请留意剪贴板中可能存在的敏感信息。</p>
                <p className="text-xs">Profer 不会保证第三方平台接受这些操作；请避免不必要的高频互动，并在重要操作前核对页面状态。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingRiskAcknowledgement}>暂不使用</AlertDialogCancel>
            <Button type="button" disabled={savingRiskAcknowledgement} onClick={() => void acceptRiskDisclaimer()}>
              {savingRiskAcknowledgement ? '正在确认…' : '我已知悉并承担风险'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {state && state.trace.length > 0 && (
        <div className="flex items-center h-7 px-3 gap-2 border-t border-border/30 text-[11px] text-muted-foreground bg-muted/15">
          <span className="shrink-0 text-primary/80">Agent 操作</span>
          <span className="truncate">{state.trace[state.trace.length - 1]?.summary}</span>
          <span className="ml-auto shrink-0 hidden lg:inline">点击与输入目标会短暂高亮</span>
        </div>
      )}
    </div>
  )
}
