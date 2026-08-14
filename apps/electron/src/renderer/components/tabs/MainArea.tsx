/**
 * MainArea — 主内容区域
 *
 * 组合 TabBar + TabContent。Agent 模式下若预览面板打开，则在同一个 Panel 内分屏：
 * 顶部一行：左侧 TabBar + 右侧预览顶栏（含文件名、复制按钮）
 * 主体：左侧 TabContent + 右侧预览内容
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useAtom } from 'jotai'
import { tabsAtom, activeTabIdAtom, activeTabAtom } from '@/atoms/tab-atoms'
import { Panel } from '@/components/app-shell/Panel'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { previewPanelOpenMapAtom, previewSplitRatioAtom } from '@/atoms/preview-atoms'
import { PreviewPanel } from '@/components/diff/PreviewPanel'
import { browserManualOpenSessionIdsAtom, browserPanelDismissedSessionIdsAtom, browserPanelOpenMapAtom, browserSplitRatioAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { BrowserPanel } from '@/components/browser/BrowserPanel'
import type { BrowserViewState } from '@profer/shared'
import { useTrackSessionView } from '@/hooks/useTrackSessionView'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { PlanningView } from '@/components/planning/PlanningView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { agentSidePanelOpenAtom } from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { interfaceVariantAtom } from '@/atoms/theme'
import { cn } from '@/lib/utils'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'

export function MainArea(): React.ReactElement {
  // 记录每个会话上次停留的视图（对话 / 预览），供切回时重建预览 Tab
  useTrackSessionView()

  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const appMode = useAtomValue(appModeAtom)
  const sidePanelOpen = useAtomValue(agentSidePanelOpenAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'

  // Tab 内容渲染降级为非紧急：TabBar 立即高亮新 tab，主区域昂贵渲染（含 PreviewPanel 中
  // DiffTabContent → ProseMirror editor mount + Shiki tokenize）让出主线程，避免点击 tab
  // 后必须等主区域渲染完才能看到 tab 切换效果。
  //
  // 注意：关闭 tab 时 deferredActiveTabId 可能还指向已删除的 tab，导致 TabContent 找不到对应
  // tab 而显示"标签页不存在"。通过 safeTabId 兜底：若 deferred 值已不在 tabs 中，回退到同步
  // activeTabId（后者通过 useAtomValue 实时同步，始终有效）。
  const deferredActiveTabId = React.useDeferredValue(activeTabId)
  const safeTabId = React.useMemo(() => {
    if (deferredActiveTabId && tabs.some((t) => t.id === deferredActiveTabId)) {
      return deferredActiveTabId
    }
    return activeTabId
  }, [deferredActiveTabId, activeTabId, tabs])

  const previewOpenMap = useAtomValue(previewPanelOpenMapAtom)
  const [splitRatio, setSplitRatio] = useAtom(previewSplitRatioAtom)
  const previewDragging = React.useRef(false)

  // ===== 受管浏览器 =====
  const [browserOpenMap, setBrowserOpenMap] = useAtom(browserPanelOpenMapAtom)
  const [browserStateMap, setBrowserStateMap] = useAtom(browserStateMapAtom)
  const [browserSplitRatio, setBrowserSplitRatio] = useAtom(browserSplitRatioAtom)
  const browserLayoutRef = React.useRef<HTMLDivElement>(null)
  const [browserLayoutWidth, setBrowserLayoutWidth] = React.useState(0)
  const browserDragging = React.useRef(false)
  const [browserDismissed, setBrowserDismissed] = useAtom(browserPanelDismissedSessionIdsAtom)
  const [browserManualOpen, setBrowserManualOpen] = useAtom(browserManualOpenSessionIdsAtom)
  // 浏览器面板仅属于 Agent 会话；必须同时满足「激活 tab 是 agent」和「当前处于 agent 模式」。
  // 否则 toggle-mode 快捷键（只切 appMode 不切 tab）会造成 appMode 与 activeTab.type 撕裂，
  // 让浏览器面板在已切到 Chat 的界面上错误残留。
  const browserSessionId = appMode === 'agent' && activeTab?.type === 'agent' ? activeTab.sessionId : null

  const publishBrowserState = React.useCallback((state: BrowserViewState) => {
    // 同步浏览器内容状态（tabs/url/标题/trace 等）。
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(state.sessionId, state); return next })
    // 仅当用户没有显式关闭过该会话的面板时才自动打开；用户在浏览器面板右上角手动收起后，
    // 主进程后续的 BROWSER_STATE_CHANGED 推送不能把它强制重新弹出来。
    setBrowserOpenMap((previous) => {
      const shouldOpen = previous.get(state.sessionId) !== false && !browserDismissed.has(state.sessionId)
      if (!shouldOpen) return previous
      const next = new Map(previous); next.set(state.sessionId, true); return next
    })
  }, [browserDismissed, setBrowserOpenMap, setBrowserStateMap])

  React.useEffect(() => {
    // Vite renderer 可在 preload 热重载前先更新；旧 bridge 时浏览器功能不可用，
    // 但绝不能让整个主界面崩溃。完整 Electron preload 就绪后会正常订阅。
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserStateChanged
    if (typeof subscribe !== 'function') return
    return subscribe(publishBrowserState)
  }, [publishBrowserState])

  React.useEffect(() => {
    if (!browserSessionId) return
    const getState = (window.electronAPI as Partial<typeof window.electronAPI>).getAgentBrowserState
    if (typeof getState !== 'function') return
    let cancelled = false
    void getState(browserSessionId)
      .then((state) => {
        if (!cancelled && state) publishBrowserState(state)
      })
      // 后台会话及已删除会话会被主进程拒绝或返回空状态；无需打断当前界面。
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [browserSessionId, publishBrowserState])

  const showBrowserPanel = !!browserSessionId && (browserOpenMap.get(browserSessionId) ?? false)
  const browserState = browserSessionId ? browserStateMap.get(browserSessionId) ?? null : null
  const BROWSER_MIN_WIDTH = 360
  const CONVERSATION_MIN_WIDTH = 420
  // 与 AppShell 的 p-2 面板缝隙保持一致，避免侧边栏收起时出现额外空白。
  const BROWSER_SPLIT_GAP = 8
  // 用户手动打开浏览器后，窄屏不再自动收起（补齐与文件面板 userOverrode 对等的保护）。
  const browserManuallyOpened = browserSessionId ? browserManualOpen.has(browserSessionId) : false
  const browserAutoHidden = showBrowserPanel
    && !browserManuallyOpened
    && browserLayoutWidth > 0
    && browserLayoutWidth < CONVERSATION_MIN_WIDTH + BROWSER_MIN_WIDTH + BROWSER_SPLIT_GAP
  const browserVisible = showBrowserPanel && !browserAutoHidden

  // 以 MainArea 实际可用宽度决定是否可并排，避免右侧文件栏改变布局后仍错误挤压双栏。
  React.useLayoutEffect(() => {
    const element = browserLayoutRef.current
    if (!element) return
    const update = () => setBrowserLayoutWidth(element.clientWidth)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [])

  // 窄屏时必须同时收起 renderer 面板和原生 WebContentsView。
  // 只调用 hideAgentBrowser 会留下 browserOpenMap=true；在布局重排或状态推送时，
  // BrowserPanel 工具栏可能重新挂到对话内容上。这里仅收起显示，不销毁浏览器会话、标签页或登录状态。
  React.useEffect(() => {
    if (!browserAutoHidden || !browserSessionId) return
    void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(browserSessionId)
    setBrowserOpenMap((previous) => {
      if (previous.get(browserSessionId) !== true) return previous
      const next = new Map(previous)
      next.set(browserSessionId, false)
      return next
    })
  }, [browserAutoHidden, browserSessionId, setBrowserOpenMap])
  // 布局恢复（MainArea 足以并排）后，重置当前会话的「手动打开」标记，恢复后续自动收起能力，
  // 与文件面板在窗口 ≥ 阈值时重置 userOverride 的行为对齐。
  React.useEffect(() => {
    if (!browserSessionId) return
    const wideEnough = browserLayoutWidth >= CONVERSATION_MIN_WIDTH + BROWSER_MIN_WIDTH + BROWSER_SPLIT_GAP
    if (!wideEnough) return
    setBrowserManualOpen((previous) => {
      if (!previous.has(browserSessionId)) return previous
      const next = new Set(previous)
      next.delete(browserSessionId)
      return next
    })
  }, [browserLayoutWidth, browserSessionId, setBrowserManualOpen])

  const previewOpen =
    activeTab?.type === 'agent' && (previewOpenMap.get(activeTab.sessionId) ?? false) && !showBrowserPanel
  const previewSessionId = activeTab?.type === 'agent' ? activeTab.sessionId : null

  // 关闭动画状态：当 previewOpen 从 true → false 时，播放退出动画再移除 DOM
  // 在 render 阶段同步派生 closing，避免中间帧出现 flex: 1 1 auto 导致左侧瞬间跳到 100% 宽
  // （flex-basis: auto 与 calc() 之间无法插值，transition 不生效，视觉上会被解读为"重新渲染"）
  const [closingState, setClosingState] = React.useState(false)
  const prevPreviewStateRef = React.useRef({ open: previewOpen, sessionId: previewSessionId })

  let closing = closingState
  const prev = prevPreviewStateRef.current
  if (prev.open && !previewOpen && prev.sessionId === previewSessionId) {
    closing = true
  }
  if (previewOpen || prev.sessionId !== previewSessionId) {
    closing = false
  }
  if (closing !== closingState) {
    setClosingState(closing)
  }

  React.useEffect(() => {
    prevPreviewStateRef.current = { open: previewOpen, sessionId: previewSessionId }
  }, [previewOpen, previewSessionId])

  const showPreview = (previewOpen || closing) && previewSessionId

  const handlePreviewDragStart = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    previewDragging.current = true
    const startX = e.clientX
    const startRatio = splitRatio
    const containerEl = (e.currentTarget as HTMLElement).closest('[data-split-container]') as HTMLElement | null
    const containerWidth = containerEl?.clientWidth ?? 1
    let rafId = 0

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = 'none' })

    const onMouseMove = (ev: MouseEvent) => {
      if (!previewDragging.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = ev.clientX - startX
        const newRatio = Math.max(0.3, Math.min(0.8, startRatio + delta / containerWidth))
        setSplitRatio(newRatio)
      })
    }
    const onMouseUp = () => {
      previewDragging.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitRatio, setSplitRatio])

  React.useEffect(() => {
    if (tabs.length === 0) {
      console.warn('[FLASH-DEBUG] MainArea: tabs.length === 0, showing WelcomeView!', new Error().stack)
    }
  }, [tabs.length])

  React.useEffect(() => {
    if (tabs.length > 0 && !activeTabId) {
      setActiveTabId(tabs[0]!.id)
    }
  }, [tabs, activeTabId, setActiveTabId])

  // 关闭动画期间右侧面板的定位样式（脱离 flex 流，保持原宽度，translateX 向右滑出）
  const closingOverlayStyle: React.CSSProperties | undefined = closing
    ? {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: `${splitRatio * 100}%`,
        width: `${(1 - splitRatio) * 100}%`,
        zIndex: 1,
        display: 'flex',
        pointerEvents: 'none',
      }
    : undefined

  // 左侧容器宽度：预览打开时固定占 splitRatio；其他情况（含 closing 动画期间）
  // 直接 1 1 auto 占满——closing 时右侧 absolute 脱离 flex 流，所以左侧自然占 100%。
  const leftFlexStyle: React.CSSProperties = (previewOpen && previewSessionId)
    ? { flex: `0 0 calc(${splitRatio * 100}% - 4px)` }
    : { flex: '1 1 auto' }

  const browserAvailableWidth = Math.max(1, browserLayoutWidth - BROWSER_SPLIT_GAP)
  const minConversationRatio = CONVERSATION_MIN_WIDTH / browserAvailableWidth
  const maxConversationRatio = 1 - BROWSER_MIN_WIDTH / browserAvailableWidth
  const clampedBrowserSplitRatio = Math.max(minConversationRatio, Math.min(maxConversationRatio, browserSplitRatio))
  const mainPanelStyle: React.CSSProperties | undefined = browserVisible
    ? { flex: `0 0 calc(${clampedBrowserSplitRatio * 100}% - ${BROWSER_SPLIT_GAP / 2}px)` }
    : undefined
  const browserDividerStyle: React.CSSProperties | undefined = browserVisible
    ? { left: `${clampedBrowserSplitRatio * 100}%` }
    : undefined

  const handleBrowserDragStart = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const container = browserLayoutRef.current
    if (!container) return
    browserDragging.current = true
    const rect = container.getBoundingClientRect()
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = 'none' })
    const onMouseMove = (moveEvent: MouseEvent) => {
      const available = Math.max(1, rect.width - BROWSER_SPLIT_GAP)
      const rawRatio = (moveEvent.clientX - rect.left) / available
      const minRatio = CONVERSATION_MIN_WIDTH / available
      const maxRatio = 1 - BROWSER_MIN_WIDTH / available
      setBrowserSplitRatio(Math.max(minRatio, Math.min(maxRatio, rawRatio)))
    }
    const onMouseUp = () => {
      browserDragging.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [setBrowserSplitRatio])

  return (
    <div ref={browserLayoutRef} className="relative flex h-full min-w-0 gap-2">
      <Panel
        variant="grow"
        className="bg-content-area rounded-2xl shadow-xl dark:shadow-sm"
        style={mainPanelStyle}
      >
        <div className="flex flex-1 min-h-0 relative overflow-hidden" data-split-container>
          {/* 左侧：TabBar + TabContent（始终保持在同一 DOM 位置，避免 Tab 切换时 unmount）
              注：宽度变化不用 transition——文字逐帧 reflow 会导致行末字符抖动，
              视觉上像"内容从右向左推送"。让左侧瞬间变宽，由右侧 absolute 滑出动画
              覆盖期内呈现"被剥离"的视觉效果。 */}
          <div
            className="flex flex-col min-w-0 h-full relative"
            style={leftFlexStyle}
          >
            {/* 无 TabBar 的全屏/空状态视图使用通用主内容宿主；右侧分栏打开时由其更高优先级接管。 */}
            <WindowControlsHost
              id="main-content"
              active={activeView === 'planning' || activeView === 'agent-skills' || automationFormOpen || tabs.length === 0}
              priority={10}
              className="absolute right-2 top-[3px] z-20"
            />
            {activeView === 'planning' ? (
              automationFormOpen ? (
                // 规划中心内的定时任务设置页：与列表同层级替换中间区，不经过 TabBar。
                <AutomationFormView />
              ) : (
                // 规划中心视图（Task · 日历 · 定时任务）全屏取代 TabBar + TabContent
                <PlanningView />
              )
            ) : activeView === 'agent-skills' ? (
              // Agent 技能视图：全屏取代 TabBar + TabContent
              <AgentSkillsView />
            ) : (
              <>
                <TabBar />
                {automationFormOpen ? (
                  // 兼容从会话内入口打开任务设置的场景。
                  <AutomationFormView />
                ) : tabs.length === 0 ? (
                  <WelcomeView />
                ) : safeTabId ? (
                  <div className="flex-1 min-h-0 titlebar-no-drag">
                    <TabContent tabId={safeTabId} />
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* 右侧：预览面板。关闭动画期间脱离 flex 流，向右滑出 */}
          {showPreview && (
            <div
              className={closing ? 'animate-preview-slide-out' : 'flex flex-1 min-w-0'}
              style={closingOverlayStyle}
              onAnimationEnd={(e) => {
                if (closing && e.target === e.currentTarget) setClosingState(false)
              }}
            >
              {!closing && (
                <div
                  className="w-[8px] cursor-col-resize bg-border/40 hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0 self-stretch"
                  onMouseDown={handlePreviewDragStart}
                />
              )}
              <div className="flex-1 min-w-0 h-full overflow-hidden">
                <PreviewPanel sessionId={previewSessionId} />
              </div>
            </div>
          )}
        </div>
      </Panel>

      {browserVisible && browserSessionId && (
        <>
          <div
            className="absolute z-10 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize rounded transition-colors hover:bg-primary/10 active:bg-primary/20"
            style={browserDividerStyle}
            onMouseDown={handleBrowserDragStart}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整会话与浏览器宽度"
          />
          <div className="flex flex-1 min-w-0">
            <BrowserPanel
            sessionId={browserSessionId}
            state={browserState}
            sessionTitle={activeTab?.title ?? ''}
            // WindowControls 只会覆盖窗口最右缘。右侧文件栏展开时，浏览器卡片的右缘
            // 已被侧栏隔开；继续预留 126px 会无端压扁地址栏，并在顶栏末端留下空白。
            avoidWindowControls={!sidePanelOpen}
            // 侧栏切换会改变浏览器卡片的结构性位置；重建空的 BrowserSlot，
            // 让原生 hostView 立即拿到新 rect，但不销毁网页 WebContents。
            layoutKey={sidePanelOpen ? 'side-panel-open' : 'side-panel-closed'}
            onClose={() => {
              // WebContentsView 不在 React DOM 层级内；先让主进程同步隐藏，
              // 再卸载 BrowserSlot，避免 effect cleanup IPC 晚到时网页仍覆盖界面。
              void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(browserSessionId)
              setBrowserOpenMap((previous) => { const next = new Map(previous); next.set(browserSessionId, false); return next })
              setBrowserStateMap((previous) => { const next = new Map(previous); next.delete(browserSessionId); return next })
              setBrowserDismissed((previous) => { const next = new Set(previous); next.add(browserSessionId); return next })
            }}
            />
          </div>
        </>
      )}
    </div>
  )
}
