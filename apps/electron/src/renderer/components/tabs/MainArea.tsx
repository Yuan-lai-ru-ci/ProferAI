/**
 * MainArea — 主内容区域
 *
 * 组合 TabBar + TabContent。Agent 模式下若预览面板打开，则在同一个 Panel 内分屏：
 * 顶部一行：左侧 TabBar + 右侧预览顶栏（含文件名、复制按钮）
 * 主体：左侧 TabContent + 右侧预览内容
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useAtom } from 'jotai'
import { tabsAtom, activeTabIdAtom, activeTabAtom, tabIndicatorMapAtom, isPreviewTab } from '@/atoms/tab-atoms'
import { Panel } from '@/components/app-shell/Panel'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { previewPanelOpenMapAtom, previewSplitRatioAtom } from '@/atoms/preview-atoms'
import { PreviewPanel } from '@/components/diff/PreviewPanel'
import { closeInlinePreview, closeBrowserInlinePreview } from '@/components/diff/preview-opener'
import { browserPanelDismissedSessionIdsAtom, browserPanelOpenMapAtom, browserSplitRatioAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { panelVisibilityAtom } from '@/atoms/panel-layout-atoms'
import { openBrowserFromPush } from '@/hooks/usePanelAutoLayout'
import { shouldAutoOpenBrowserFromPush } from '@/lib/browser-auto-open'
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
import { resolveBrowserSplitGeometry, shouldAnimateBrowserSplitWidth } from '@/lib/browser-split-layout'
import { resolveContentTabId } from '@/lib/active-tab-content'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { PaneHeader } from './PaneHeader'
import { EmptyPanePlaceholder } from './EmptyPanePlaceholder'
import { useCloseTab } from '@/hooks/useCloseTab'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'
import {
  GROUP_SPLIT_GAP,
  fillGroupSide,
  findTabGroup,
  focusGroupMember,
  groupTabIds,
  reconcileTabGroups,
  removeTabGroup,
  replaceTabGroup,
  resolveGroupPaneFocusTarget,
  resolveGroupSplitGeometry,
  tabGroupsAtom,
  tabGroupDragAtom,
  tabGroupRatioAtom,
  type TabGroupSide,
} from '@/atoms/tab-group-atoms'

export function MainArea(): React.ReactElement {
  // 记录每个会话上次停留的视图（对话 / 预览），供切回时重建预览 Tab
  useTrackSessionView()

  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const [tabGroups, setTabGroups] = useAtom(tabGroupsAtom)
  const tabGroup = findTabGroup(tabGroups, activeTabId)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const appMode = useAtomValue(appModeAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()

  // 内容必须跟随同步 activeTabId 渲染。useDeferredValue 会让 TabBar 已高亮新会话时，
  // 主区域仍长期保留旧会话；昂贵子树应自行优化，不能以旧会话内容作为过渡态。
  const contentTabId = resolveContentTabId(tabs, activeTabId)

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

  /**
   * 订阅实时状态推送。
   *
   * 不再把「收到任意浏览器状态」当作「用户需要看浏览器」：只有 Agent 真的开始展示页面
   * （存在工作标签 + 最近动作是 navigate/tab）才自动打开。用户点击浏览器按钮走 TabBar 的
   * 本地显式打开路径，切回会话走 getAgentBrowserState 恢复路径，两者都不受此处影响。
   */
  const handleBrowserStatePush = React.useCallback((state: BrowserViewState) => {
    publishBrowserState(state, { autoOpen: shouldAutoOpenBrowserFromPush(state) })
  }, [publishBrowserState])

  React.useLayoutEffect(() => {
    // 先同步主进程的可见性所有权，再处理旧会话隐藏和新布局，
    // 防止后台 Agent 在这次会话切换的 IPC 间隙抢先显示原生 WebContentsView。
    const setForeground = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserForeground
    if (typeof setForeground === 'function') setForeground(browserSessionId)

    const previousSessionId = previousBrowserSessionIdRef.current
    if (previousSessionId && previousSessionId !== browserSessionId) {
      // 切换会话时只收起旧会话的面板，不销毁其浏览器状态；回到该会话时，
      // 只要用户没有主动关闭浏览器，就应恢复面板。
      void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(previousSessionId)
      setBrowserOpenMap((previous) => {
        if (previous.get(previousSessionId) !== true) return previous
        const next = new Map(previous)
        next.set(previousSessionId, false)
        return next
      })
    }
    previousBrowserSessionIdRef.current = browserSessionId
  }, [browserSessionId, setBrowserOpenMap])

  React.useEffect(() => {
    // Vite renderer 可在 preload 热重载前先更新；旧 bridge 时浏览器功能不可用，
    // 但绝不能让整个主界面崩溃。完整 Electron preload 就绪后会正常订阅。
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserStateChanged
    if (typeof subscribe !== 'function') return
    return subscribe(handleBrowserStatePush)
  }, [handleBrowserStatePush])

  React.useEffect(() => {
    if (!browserSessionId) return
    const getState = (window.electronAPI as Partial<typeof window.electronAPI>).getAgentBrowserState
    if (typeof getState !== 'function') return
    let cancelled = false
    void getState(browserSessionId)
      .then((state) => {
        if (!cancelled && state) {
          // 切回会话时重新拉起已有浏览器；用户明确关闭过的会话仍保持收起。
          publishBrowserState(state, { autoOpen: !browserDismissed.has(browserSessionId) })
        }
      })
      // 后台会话及已删除会话会被主进程拒绝或返回空状态；无需打断当前界面。
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [browserDismissed, browserSessionId, publishBrowserState])

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

  const previousBrowserVisibleRef = React.useRef(browserVisible)
  const [browserWidthTransitioning, setBrowserWidthTransitioning] = React.useState(false)
  const browserWidthTransitionActive = shouldAnimateBrowserSplitWidth(
    previousBrowserVisibleRef.current,
    browserVisible,
    isDraggingBrowser,
  ) || browserWidthTransitioning

  // 在本次提交完成后记录可见性，并为浏览器自身开关保留完整过渡窗口。
  // 相邻面板/窗口尺寸变化不会改 browserVisible，因此不会进入这个分支。
  React.useLayoutEffect(() => {
    const changed = previousBrowserVisibleRef.current !== browserVisible
    previousBrowserVisibleRef.current = browserVisible
    if (!changed || isDraggingBrowser) {
      if (isDraggingBrowser) setBrowserWidthTransitioning(false)
      return
    }
    setBrowserWidthTransitioning(true)
    const timeoutId = window.setTimeout(() => setBrowserWidthTransitioning(false), 300)
    return () => window.clearTimeout(timeoutId)
  }, [browserVisible, isDraggingBrowser])

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

  // 组合视图本身已经占用左右两栏，不能再把当前成员的内联预览嵌套成第三栏。
  // 这里只抑制显示意图，不清除 previewOpenMap；解散组合后原预览可以自然恢复。
  const previewOpen =
    activeTab?.type === 'agent'
    && (previewOpenMap.get(activeTab.sessionId) ?? false)
    && !showBrowserPanel
    && !tabGroup
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

  // ===== 组合 tab（两个会话左右并排）=====
  // 组合是一个叠加态：两个成员标签仍在 tabsAtom 里，只是顶栏渲染时折叠成一个条目。
  // 焦点 = activeTabId 属于哪一侧，因此"当前会话"（左侧栏高亮/右侧文件面板）
  // 通过既有的 useSyncActiveTabSideEffects 单点同步自动跟随焦点栏，不需要第二条真相。
  const [tabGroupRatio, setTabGroupRatio] = useAtom(tabGroupRatioAtom)
  const tabGroupDrag = useAtomValue(tabGroupDragAtom)
  const leftGroupTab = React.useMemo(
    () => (tabGroup ? tabs.find((tab) => tab.id === tabGroup.leftTabId) ?? null : null),
    [tabGroup, tabs],
  )
  const rightGroupTab = React.useMemo(
    () => (tabGroup ? tabs.find((tab) => tab.id === tabGroup.rightTabId) ?? null : null),
    [tabGroup, tabs],
  )
  const indicatorMap = useAtomValue(tabIndicatorMapAtom)
  const { executeClose } = useCloseTab()
  const groupContainerRef = React.useRef<HTMLDivElement>(null)
  // 分栏像素宽由实测容器宽算出（与浏览器分栏同一做法），保证比例与最小宽度约束一致
  const [groupContainerWidth, setGroupContainerWidth] = React.useState(0)
  const groupDragging = React.useRef(false)

  React.useLayoutEffect(() => {
    const element = groupContainerRef.current
    if (!element) return
    const update = (): void => setGroupContainerWidth(element.clientWidth)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [])

  const groupGeometry = resolveGroupSplitGeometry(groupContainerWidth, tabGroupRatio)
  // 当前激活标签属于某个组合时才显示该组合；其他组合保持后台状态。
  const groupViewActive = !!tabGroup && (!!leftGroupTab || !!rightGroupTab)
  const leftPaneTabId = groupViewActive ? leftGroupTab?.id ?? null : contentTabId
  // ResizeObserver 首次回调前宽度是 0。此时必须用 CSS 等分兜底，不能把右栏写成 0px；
  // 否则初次合并会只剩一条窄边界，用户也很难命中分隔条。
  const groupGeometryReady = groupContainerWidth > GROUP_SPLIT_GAP
  const rightPaneStyle: React.CSSProperties = {
    width: groupGeometryReady ? groupGeometry.rightWidth : `calc(50% - ${GROUP_SPLIT_GAP / 2}px)`,
    flexShrink: 0,
  }

  // 成员被关闭/删除（或组合指向失效标签）时自动解散对应组合。
  React.useEffect(() => {
    const reconciled = reconcileTabGroups(tabGroups, new Set(tabs.map((tab) => tab.id)))
    const unchanged = reconciled.length === tabGroups.length
      && reconciled.every((group, index) => group === tabGroups[index])
    if (!unchanged) setTabGroups(reconciled)
  }, [setTabGroups, tabGroups, tabs])

  const activateGroupTab = React.useCallback((tabId: string): void => {
    setActiveTabId(tabId)
    const target = tabs.find((tab) => tab.id === tabId)
    if (target) syncActiveTabSideEffects(target)
  }, [setActiveTabId, syncActiveTabSideEffects, tabs])

  /** 聚焦某一栏：只在组合视图激活时切换成员，组外标签不能被 pointerdown 劫持 */
  const focusGroupSide = React.useCallback((side: TabGroupSide): void => {
    const targetId = resolveGroupPaneFocusTarget(tabGroup, activeTabId, side)
    if (!targetId || !tabGroup) return
    const focused = focusGroupMember(tabGroup, targetId)
    if (focused) setTabGroups((previous) => replaceTabGroup(previous, tabGroup, focused))
    activateGroupTab(targetId)
  }, [activateGroupTab, activeTabId, setTabGroups, tabGroup])

  /** 空栏里选中一个标签（会话或预览）：放进去并把焦点交给它 */
  const fillGroupPane = React.useCallback((side: TabGroupSide, tabId: string): void => {
    if (!tabGroup) return
    const filledGroup = fillGroupSide(tabGroup, side, tabId)
    if (filledGroup) setTabGroups((previous) => replaceTabGroup(previous, tabGroup, filledGroup))
    activateGroupTab(tabId)
    // 预览成员自带"用一栏展示这个文件"的语义，关掉该会话的内联分屏，避免同一文件两处显示
    const filled = tabs.find((tab) => tab.id === tabId)
    if (filled && isPreviewTab(filled)) closeInlinePreview(filled.sessionId)
  }, [activateGroupTab, setTabGroups, tabGroup, tabs])

  const dissolveGroup = React.useCallback((): void => {
    setTabGroups((previous) => removeTabGroup(previous, tabGroup))
  }, [setTabGroups, tabGroup])

  // 右栏栏头动作：关闭该栏标签（关闭后由对账 effect 自动解散组合），焦点回到左栏
  const closeRightPane = React.useCallback((): void => {
    const group = tabGroup
    const rightTabId = group?.rightTabId
    if (!group || !rightTabId) return
    const fallbackTabId = group.leftTabId
    setTabGroups((previous) => removeTabGroup(previous, group))
    executeClose(rightTabId)
    // 右栏关掉后焦点回到左栏（若左栏也空着则保持现状，由标签列表决定激活项）
    if (fallbackTabId && activeTabId !== fallbackTabId) activateGroupTab(fallbackTabId)
  }, [activateGroupTab, activeTabId, executeClose, setTabGroups, tabGroup])

  const handleGroupDragStart = React.useCallback((e: React.MouseEvent): void => {
    const container = groupContainerRef.current
    if (!container) return
    e.preventDefault()
    groupDragging.current = true
    const rect = container.getBoundingClientRect()
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = 'none' })

    const onMouseMove = (moveEvent: MouseEvent): void => {
      const available = Math.max(1, rect.width - GROUP_SPLIT_GAP)
      // 指针位置代表**左栏**占比（与浏览器分栏同一算法），而 tabGroupRatio 存的是右栏占比，取补。
      const pointerFraction = (moveEvent.clientX - rect.left - GROUP_SPLIT_GAP / 2) / available
      setTabGroupRatio(resolveGroupSplitGeometry(rect.width, 1 - pointerFraction).ratio)
    }
    const onMouseUp = (): void => {
      groupDragging.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [setTabGroupRatio])

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

  const browserSplit = resolveBrowserSplitGeometry(browserLayoutWidth, browserSplitRatio, browserVisible, {
    resizeGap: BROWSER_SPLIT_GAP,
    minConversationWidth: CONVERSATION_MIN_WIDTH,
    minBrowserWidth: BROWSER_MIN_WIDTH,
  })
  // 对话区占满剩余（Panel flex-1），浏览器分栏以固定像素宽度占位；width 过渡形成展开/收起动画（与文件面板一致）。
  const browserWidthPx = browserSplit.browserWidth
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
        className="main-content-panel relative rounded-2xl shadow-xl dark:shadow-sm"
      >
        {/* 通用兜底宿主：凡是 TabBar 不持有窗口按钮的分支（定时任务表单、无 Tab
            空态、以及所有全屏视图）都必须能提供按钮；页面自己声明的宿主
            priority 更高时会自动接管（planning / agent-skills 均为 20）。
            priority 5 < TabBar 的 10：相同优先级会让两个宿主争抢按钮（按注册
            顺序决出），表现为按钮在两处之间跳位。兜底只在没有其他宿主时接管。
            位置：顶栏已横跨主区，兜底宿主也必须相对整个主区定位，
            否则分屏时窗口按钮会留在左栏右缘（窗口中部）。 */}
        <WindowControlsHost
          id="main-content"
          active={automationFormOpen || tabs.length === 0 || activeView !== 'conversations'}
          priority={5}
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
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 顶栏横跨整个主区：分屏时不再只覆盖左栏，预览/浏览器分屏打开时
                两侧顶栏也共用同一条基线（旧结构下预览栏只能自带两行顶栏）。 */}
            <TabBar />
            <div className="relative flex flex-1 min-h-0 overflow-hidden" data-split-container>
              {/* 左侧区域：TabContent（单栏）+ 可选的 Tab 分屏右栏。
                  始终保持在同一 DOM 位置，避免 Tab 切换时 unmount。
                  注：左右区域宽度变化不用 transition——文字逐帧 reflow 会导致行末字符抖动，
                  视觉上像"内容从右向左推送"。 */}
              {/* data-group-drop-split = 真实分界线（相对区域左缘的 px）：TabBar 判定左右落点
                  必须用它，不能用容器中点——比例被拖过、或空栏只占 1/3 时中点与实际分界不符。 */}
              <div
                ref={groupContainerRef}
                data-group-drop-region="true"
                data-group-drop-split={groupGeometryReady ? Math.round(groupGeometry.leftWidth + GROUP_SPLIT_GAP / 2) : undefined}
                className="flex h-full min-w-0 relative"
                style={leftFlexStyle}
              >
                {/* 左栏：组合激活时是组内左成员，否则是当前标签 */}
                <div
                  className="flex flex-col min-w-0 h-full relative"
                  style={{ flex: '1 1 auto' }}
                  onPointerDownCapture={() => focusGroupSide('left')}
                >
                  {groupViewActive && leftGroupTab && (
                    <PaneHeader
                      pane="left"
                      type={leftGroupTab.type}
                      title={leftGroupTab.title}
                      status={indicatorMap.get(leftGroupTab.id) ?? 'idle'}
                      focused={activeTabId === leftGroupTab.id}
                      onFocus={() => focusGroupSide('left')}
                      onDissolveGroup={dissolveGroup}
                    />
                  )}
                  {automationFormOpen ? (
                    // 兼容从会话内入口打开任务设置的场景。
                    <AutomationFormView />
                  ) : tabs.length === 0 ? (
                    <WelcomeView />
                  ) : leftPaneTabId ? (
                    <div className="flex-1 min-h-0 titlebar-no-drag">
                      <TabContent tabId={leftPaneTabId} />
                    </div>
                  ) : groupViewActive && tabGroup ? (
                    <EmptyPanePlaceholder
                      excludeTabIds={groupTabIds(tabGroup)}
                      onPick={(tabId) => fillGroupPane('left', tabId)}
                      onDissolve={dissolveGroup}
                    />
                  ) : null}
                </div>

                {/* 右栏：组合内的右侧成员；可以是空栏（等用户选择） */}
                {groupViewActive && tabGroup && (
                  <>
                    <div
                      className="panel-resize-handle-x titlebar-no-drag"
                      onMouseDown={handleGroupDragStart}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="调整组合内两栏宽度"
                    />
                    <div
                      className="flex flex-col min-w-0 h-full"
                      style={rightPaneStyle}
                      onPointerDownCapture={() => focusGroupSide('right')}
                    >
                      {rightGroupTab && (
                        <PaneHeader
                          pane="right"
                          type={rightGroupTab.type}
                          title={rightGroupTab.title}
                          status={indicatorMap.get(rightGroupTab.id) ?? 'idle'}
                          focused={activeTabId === rightGroupTab.id}
                          onFocus={() => focusGroupSide('right')}
                          onClosePane={closeRightPane}
                        />
                      )}
                      {rightGroupTab ? (
                        <div className="flex-1 min-h-0 titlebar-no-drag">
                          <TabContent tabId={rightGroupTab.id} />
                        </div>
                      ) : (
                        <EmptyPanePlaceholder
                          excludeTabIds={groupTabIds(tabGroup)}
                          onPick={(tabId) => fillGroupPane('right', tabId)}
                          onDissolve={dissolveGroup}
                        />
                      )}
                    </div>
                  </>
                )}

                {/* 合并投放区：拖动标签向下时出现，左右两半各对应一个落点。
                    位置由 TabBar 的全局 pointermove 计算（指针已被 setPointerCapture 捕获，
                    因此投放区只负责视觉，不接收事件）。 */}
                {tabGroupDrag.draggingTabId && (
                  // top-2 = TabBar 那边 GROUP_DROP_COMMIT_MARGIN（8px）：可视区必须与可提交区
                  // 完全重合，否则会出现"高亮了但松手无效"的死带。两个数值改一处要同步改另一处。
                  //
                  // 两个投放区按**真实栏宽**铺开（含空栏的实际比例），而不是对半分：
                  // 否则"拖下来看到的分配虚线"和实际会被替换的那一栏对不上。
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 top-2 z-30" data-group-drop-overlay>
                    {(['left', 'right'] as const).map((side) => (
                      <div
                        key={side}
                        className="absolute inset-y-0 px-1"
                        style={{
                          width: groupGeometryReady
                            ? side === 'left'
                              ? groupGeometry.leftWidth + GROUP_SPLIT_GAP / 2
                              : groupGeometry.rightWidth + GROUP_SPLIT_GAP / 2
                            : '50%',
                          left: side === 'left' ? 0 : undefined,
                          right: side === 'right' ? 0 : undefined,
                        }}
                      >
                        <div
                          className={cn(
                            'flex h-full w-full items-center justify-center rounded-xl border-2 border-dashed text-xs transition-colors',
                            tabGroupDrag.hoveredPosition === side
                              ? 'border-primary/70 bg-primary/10 text-foreground'
                              : 'border-border/50 bg-background/30 text-muted-foreground/70',
                          )}
                        >
                          松开后放到{side === 'left' ? '左' : '右'}栏
                        </div>
                      </div>
                    ))}
                  </div>
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
                      // 预览面板与对话区都需要明确的可拖分界；不套 overlay，保留中心细线
                      // （overlay 会隐藏 ::after 细线，8px 透明拖拽区几乎不可见，用户无从拖动）。
                      className="panel-resize-handle-x titlebar-no-drag"
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
          </div>
        )}
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
              原生 WebContentsView 由 BrowserViewport 依据容器尺寸（width 0 → visible:false）自动隐藏，不销毁会话。 */}
          <div
            className={cn(
              'flex-shrink-0 min-w-0 overflow-hidden',
              browserWidthTransitionActive && 'transition-[width] duration-300',
            )}
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
              // 侧栏切换会改变浏览器卡片的结构性位置；重建 BrowserViewport，
              // 让原生 frame 立即拿到新 rect，但不销毁网页 WebContents。
              layoutKey={filePanelVisible ? 'side-panel-open' : 'side-panel-closed'}
              onClose={() => {
                // WebContentsView 不在 React DOM 层级内；先让主进程同步隐藏，
                // 再卸载 BrowserViewport，避免 effect cleanup IPC 晚到时网页仍覆盖界面。
                void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(browserSessionId)
                closeBrowserInlinePreview(browserSessionId)
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
