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
import { browserPanelDismissedSessionIdsAtom, browserPanelOpenMapAtom, browserSplitRatioAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { panelVisibilityAtom } from '@/atoms/panel-layout-atoms'
import { openBrowserFromPush } from '@/hooks/usePanelAutoLayout'
import { BrowserPanel } from '@/components/browser/BrowserPanel'
import type { BrowserViewState } from '@profer/shared'
import { useTrackSessionView } from '@/hooks/useTrackSessionView'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { PlanningView } from '@/components/planning/PlanningView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { automationFormAtom } from '@/atoms/automation-atoms'
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
  const currentBrowserSessionIdRef = React.useRef<string | null>(null)
  const previousBrowserSessionIdRef = React.useRef<string | null>(null)
  // 拖拽期间禁用浏览器分栏的 width 过渡：过渡动画用于展开/收起，拖拽时若保留会让面板宽度滞后于拖拽条，视觉不跟手。
  const [isDraggingBrowser, setIsDraggingBrowser] = React.useState(false)
  const [browserDismissed, setBrowserDismissed] = useAtom(browserPanelDismissedSessionIdsAtom)
  // 浏览器面板仅属于 Agent 会话；必须同时满足「激活 tab 是 agent」和「当前处于 agent 模式」。
  // 否则 toggle-mode 快捷键（只切 appMode 不切 tab）会造成 appMode 与 activeTab.type 撕裂，
  // 让浏览器面板在已切到 Chat 的界面上错误残留。
  const browserSessionId = appMode === 'agent' && activeTab?.type === 'agent' ? activeTab.sessionId : null
  currentBrowserSessionIdRef.current = browserSessionId

  const publishBrowserState = React.useCallback((state: BrowserViewState, options?: { autoOpen?: boolean }) => {
    // 同步浏览器内容状态（tabs/url/标题/trace 等）。状态可以保留在后台会话，
    // 但后台会话的状态推送不能改变当前会话的面板可见性。
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(state.sessionId, state); return next })
    // 只有当前激活会话收到实时状态推送时才允许自动打开。切换会话时的 getState
    // 仅用于恢复工具栏状态，不能把旧会话的浏览器预览重新唤起。
    if (options?.autoOpen !== false && state.sessionId === currentBrowserSessionIdRef.current && !browserDismissed.has(state.sessionId)) {
      openBrowserFromPush(state.sessionId)
    }
  }, [browserDismissed, browserSessionId, setBrowserStateMap])

  React.useLayoutEffect(() => {
    // 先同步主进程的可见性所有权，再处理旧会话隐藏和新布局，
    // 防止后台 Agent 在这次会话切换的 IPC 间隙抢先显示原生 WebContentsView。
    const setForeground = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserForeground
    if (typeof setForeground === 'function') setForeground(browserSessionId)

    const previousSessionId = previousBrowserSessionIdRef.current
    if (previousSessionId && previousSessionId !== browserSessionId) {
      // 浏览器是当前会话的临时面板，不跨会话恢复。先隐藏主进程中的原生
      // WebContentsView，再让 renderer 的 BrowserSlot 卸载，避免网页脱离容器残留。
      void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(previousSessionId)
      setBrowserOpenMap((previous) => {
        if (previous.get(previousSessionId) !== true) return previous
        const next = new Map(previous)
        next.set(previousSessionId, false)
        return next
      })
      // 切走期间即使旧会话仍有状态推送，也不能在后台重新打开面板。
      setBrowserDismissed((previous) => {
        if (previous.has(previousSessionId)) return previous
        const next = new Set(previous)
        next.add(previousSessionId)
        return next
      })
    }
    // 切入任何会话都从“浏览器面板关闭”开始。即使该会话之前有浏览器状态，
    // 也不能因为切回会话而恢复面板；用户需要明确点击浏览器按钮。保留 dismissed
    // 标记，避免切回瞬间旧会话的迟到状态推送又把面板唤起。
    if (browserSessionId) {
      setBrowserOpenMap((previous) => {
        if (previous.get(browserSessionId) !== true) return previous
        const next = new Map(previous)
        next.set(browserSessionId, false)
        return next
      })
    }
    previousBrowserSessionIdRef.current = browserSessionId
  }, [browserSessionId, setBrowserDismissed, setBrowserOpenMap])

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
        if (!cancelled && state) publishBrowserState(state, { autoOpen: false })
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

  // ===== 统一可见性（以窗口宽度为基准，由 usePanelAutoLayout 计算）=====
  // 浏览器可见 = 展开意图 A 为 true 且窗口宽足够；窄窗只隐藏显示，A 保持不变。
  const visibility = useAtomValue(panelVisibilityAtom)
  const browserVisible = !!browserSessionId && visibility.browser
  const filePanelVisible = visibility.filePanel

  // 以 MainArea 实际可用宽度决定浏览器分栏比例 clamp（与自适应判定正交，保留现有拖拽行为）。
  React.useLayoutEffect(() => {
    const element = browserLayoutRef.current
    if (!element) return
    const update = () => setBrowserLayoutWidth(element.clientWidth)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [])

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
  // 对话区占满剩余（Panel flex-1），浏览器分栏以固定像素宽度占位；width 过渡形成展开/收起动画（与文件面板一致）。
  const browserWidthPx = browserVisible
    ? Math.max(1, browserAvailableWidth * (1 - clampedBrowserSplitRatio))
    : 0
  const handleBrowserDragStart = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const container = browserLayoutRef.current
    if (!container) return
    browserDragging.current = true
    setIsDraggingBrowser(true)
    const rect = container.getBoundingClientRect()
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = 'none' })
    const onMouseMove = (moveEvent: MouseEvent) => {
      const available = Math.max(1, rect.width - BROWSER_SPLIT_GAP)
      // 分隔条本身占据 8px 中缝，比例以可用内容宽度计算；减半个中缝，
      // 使指针位于细线中心时与两栏实际边界精确对齐。
      const rawRatio = (moveEvent.clientX - rect.left - BROWSER_SPLIT_GAP / 2) / available
      const minRatio = CONVERSATION_MIN_WIDTH / available
      const maxRatio = 1 - BROWSER_MIN_WIDTH / available
      setBrowserSplitRatio(Math.max(minRatio, Math.min(maxRatio, rawRatio)))
    }
    const onMouseUp = () => {
      browserDragging.current = false
      setIsDraggingBrowser(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [setBrowserSplitRatio, setIsDraggingBrowser])

  return (
    <div ref={browserLayoutRef} className="relative flex h-full min-w-0">
      <Panel
        variant="grow"
        className="bg-content-area rounded-2xl shadow-xl dark:shadow-sm"
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
                  className="panel-resize-handle-x panel-resize-handle-overlay titlebar-no-drag"
                  onMouseDown={handlePreviewDragStart}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整会话与预览宽度"
                />
              )}
              <div className="flex-1 min-w-0 h-full overflow-hidden">
                <PreviewPanel sessionId={previewSessionId} />
              </div>
            </div>
          )}
        </div>
      </Panel>

      {browserSessionId && (
        <>
          {browserVisible && (
            <div
              className="panel-resize-handle-x panel-resize-handle-overlay titlebar-no-drag"
              onMouseDown={handleBrowserDragStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整会话与浏览器宽度"
            />
          )}
          {/* 浏览器分栏常驻渲染：width 过渡形成展开/收起动画；隐藏时内容 opacity 淡出且不可交互，
              原生 WebContentsView 由 BrowserSlot 依据容器尺寸（width 0 → visible:false）自动隐藏，不销毁会话。 */}
          <div
            className={cn('flex-shrink-0 min-w-0 overflow-hidden', isDraggingBrowser ? '' : 'transition-[width] duration-300')}
            style={{ width: browserWidthPx }}
          >
            <div className={cn('h-full transition-[opacity,visibility] duration-300', browserVisible ? 'opacity-100 visible' : 'opacity-0 pointer-events-none invisible')}>
              <BrowserPanel
              sessionId={browserSessionId}
              state={browserState}
              sessionTitle={activeTab?.title ?? ''}
              // WindowControls 只会覆盖窗口最右缘。右侧文件栏实际可见时，浏览器卡片的右缘
              // 已被侧栏隔开；继续预留 126px 会无端压扁地址栏，并在顶栏末端留下空白。
              // （用可见性 B 而非意图 A：文件面板被迫收起时不渲染，浏览器回到窗口最右缘，需重新预留。）
              avoidWindowControls={!filePanelVisible}
              // 侧栏切换会改变浏览器卡片的结构性位置；重建空的 BrowserSlot，
              // 让原生 hostView 立即拿到新 rect，但不销毁网页 WebContents。
              layoutKey={filePanelVisible ? 'side-panel-open' : 'side-panel-closed'}
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
          </div>
        </>
      )}
    </div>
  )
}
