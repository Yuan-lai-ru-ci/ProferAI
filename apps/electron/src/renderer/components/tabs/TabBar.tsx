/**
 * TabBar — 顶部标签栏
 *
 * 显示所有打开的标签页，支持：
 * - 点击切换标签
 * - 中键关闭标签
 * - 拖拽重排序
 * - 紧凑自适应宽度（溢出时可横向滚动）
 */

import * as React from 'react'
import { useLayoutEffect } from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { Globe2, PanelRight } from 'lucide-react'
import { toast } from 'sonner'
import {
  tabsAtom,
  activeTabIdAtom,
  tabIndicatorMapAtom,
  closeTab,
  reorderTabs,
  updateTabTitle,
} from '@/atoms/tab-atoms'
import type { TabItem } from '@/atoms/tab-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  agentSessionDraftsAtom,
  agentSessionDraftHtmlAtom,
  agentSidePanelOpenAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
  workspaceFilesVersionAtom,
  seenFilesVersionAtom,
} from '@/atoms/agent-atoms'
import {
  browserPanelDismissedSessionIdsAtom,
  browserPanelOpenMapAtom,
  browserStateMapAtom,
} from '@/atoms/browser-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { openBrowserFromPush, openFilePanel } from '@/hooks/usePanelAutoLayout'
import { panelVisibilityAtom } from '@/atoms/panel-layout-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { previewPanelOpenMapAtom } from '@/atoms/preview-atoms'
import { tearOffPreviewToSplit } from '@/components/diff/preview-opener'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { TabBarItem } from './TabBarItem'
import { useCloseTab } from '@/hooks/useCloseTab'
import { detectIsWindows } from '@/lib/platform'
import { registerShortcut } from '@/lib/shortcut-registry'
import { cn } from '@/lib/utils'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'

export function TabBar({ teamMode = false }: { teamMode?: boolean } = {}): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const indicatorMap = useAtomValue(tabIndicatorMapAtom)

  // Tab 切换时同步 sidebar 状态
  const appMode = useAtomValue(appModeAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)

  // 统一关闭逻辑：关闭当前会话入口并回到 Scratch Pad，不停止后台 Agent
  const { requestClose } = useCloseTab()
  const store = useStore()

  /**
   * Tear-off：把 preview Tab 拖出 TabBar 时，转成右侧分屏预览。
   * 公共实现在 preview-opener.ts，PreviewTabContent 顶栏切换按钮共用同一份逻辑。
   */
  const handleTearOff = React.useCallback((tabId: string) => {
    tearOffPreviewToSplit(store, tabId)
  }, [store])

  const workspaceNameBySessionId = React.useMemo(() => {
    const workspaceNameMap = new Map(agentWorkspaces.map((workspace) => [workspace.id, workspace.name]))
    const sessionWorkspaceNameMap = new Map<string, string>()
    for (const session of agentSessions) {
      if (!session.workspaceId) continue
      const workspaceName = workspaceNameMap.get(session.workspaceId)
      if (workspaceName) sessionWorkspaceNameMap.set(session.id, workspaceName)
    }
    return sessionWorkspaceNameMap
  }, [agentSessions, agentWorkspaces])

  const automationSessionIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const s of agentSessions) {
      // 委派来源优先：同时带委派与定时任务来源时不算定时任务（#993）
      if (s.sourceAutomationId && !s.sourceDelegationId) ids.add(s.id)
    }
    return ids
  }, [agentSessions])

  // 点击工作区创建的项目 draft 会话不应一直占用标签栏。
  // 只有离开它、且输入框没有任何未发送文字时才移除标签入口；会话本身仍留在
  // 主进程以便下次点击同一工作区复用。用上一枚 active tab 统一覆盖顶栏、侧栏和快捷切换器。
  const previousActiveTabRef = React.useRef<TabItem | null>(null)
  React.useEffect(() => {
    const currentTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) ?? null : null
    const previousTab = previousActiveTabRef.current
    previousActiveTabRef.current = currentTab
    if (!previousTab || !currentTab || previousTab.sessionId === currentTab.sessionId) return

    const previousSession = agentSessions.find((session) => session.id === previousTab.sessionId)
    if (!previousSession?.draft) return

    // 自动关闭只在离开标签时判断一次；不要订阅输入草稿 Map，避免用户每敲一个字
    // 都让整个 TabBar（以及所有标签项）重渲染。
    const markdownDraft = store.get(agentSessionDraftsAtom).get(previousSession.id)?.trim() ?? ''
    // TipTap 的纯空段落不算输入；其余富文本按文本内容判断，避免空编辑器阻止自动收起。
    const htmlText = (store.get(agentSessionDraftHtmlAtom).get(previousSession.id) ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim()
    if (markdownDraft || htmlText) return

    setTabs((previousTabs) => {
      const sessionTab = previousTabs.find((tab) => (
        tab.type === 'agent' && tab.sessionId === previousSession.id
      ))
      if (!sessionTab) return previousTabs
      return closeTab(previousTabs, activeTabId, sessionTab.id).tabs
    })
  }, [activeTabId, agentSessions, setTabs, store, tabs])

  // 拖拽状态
  const dragState = React.useRef<{
    dragging: boolean
    tabId: string
    startX: number
    startY: number
    lastX: number
    pointerOffsetX: number
    latestX: number
  } | null>(null)
  const dragSettleCleanupRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleActivate = React.useCallback((tabId: string) => {
    setActiveTabId(tabId)
    // 点击任意 tab 都关闭定时任务编辑表单（overlay 否则会盖在内容区上）
    setAutomationForm({ open: false, draft: null })

    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    if (tab.type === 'chat') {
      setAppMode('chat')
      setCurrentConversationId(tab.sessionId)
    } else if (tab.type === 'agent' || tab.type === 'preview') {
      setAppMode('agent')
      setCurrentAgentSessionId(tab.sessionId)

      // 用户打开查看后只清除未读角标；是否完成由用户通过对勾确认。
      setUnviewedCompleted((prev) => {
        if (!prev.has(tab.sessionId)) return prev
        const next = new Set(prev)
        next.delete(tab.sessionId)
        return next
      })

      const session = agentSessions.find((s) => s.id === tab.sessionId)
      if (session?.workspaceId) {
        setCurrentAgentWorkspaceId(session.workspaceId)
        window.electronAPI.updateSettings({
          agentWorkspaceId: session.workspaceId,
        }).catch(console.error)
      }
    } else if (tab.type === 'scratch' || tab.type === 'tutorial') {
      setCurrentConversationId(null)
      // 个人 Agent 模式下保留 appMode，避免切到 Scratch 时收起右侧文件面板；
      // 团队模式必须退出 TeamWorkspaceView，否则草稿/教程标签会被团队文件页遮住。
      if (teamMode) {
        setAppMode('scratch')
        setCurrentAgentSessionId(null)
      } else if (appMode !== 'agent') {
        setCurrentAgentSessionId(null)
      }
    }
  }, [setActiveTabId, setAutomationForm, tabs, agentSessions, appMode, teamMode, setAppMode, setCurrentConversationId, setCurrentAgentSessionId, setCurrentAgentWorkspaceId, setUnviewedCompleted])

  const handleDragStart = React.useCallback((tabId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return // 只处理左键
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return

    if (dragSettleCleanupRef.current !== null) {
      clearTimeout(dragSettleCleanupRef.current)
      dragSettleCleanupRef.current = null
    }
    const tabNode = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"]`)
    const tabRect = tabNode?.getBoundingClientRect()
    dragState.current = {
      dragging: false,
      tabId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      pointerOffsetX: tabRect ? e.clientX - tabRect.left : 0,
      latestX: e.clientX,
    }

    const getNaturalTabLeft = (node: HTMLElement): number => {
      const offsetParent = node.offsetParent as HTMLElement | null
      if (!offsetParent) return node.getBoundingClientRect().left
      const parentRect = offsetParent.getBoundingClientRect()
      return parentRect.left + node.offsetLeft - offsetParent.scrollLeft
    }

    const applyDraggedTransform = (): void => {
      const current = dragState.current
      if (!current?.dragging) return
      const node = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(current.tabId)}"]`)
      if (!node) return
      const left = current.latestX - current.pointerOffsetX
      const dx = left - getNaturalTabLeft(node)
      node.dataset.tabDragging = 'true'
      node.style.transition = 'none'
      node.style.transform = `translate3d(${dx}px, 0, 0)`
      node.style.willChange = 'transform'
      node.style.zIndex = '20'
    }

    let pendingMove: PointerEvent | null = null
    let moveFrame: number | null = null

    const processMove = (me: PointerEvent): void => {
      const current = dragState.current
      if (!current) return

      const dx = Math.abs(me.clientX - current.startX)
      const dy = Math.abs(me.clientY - current.startY)
      if (!current.dragging && Math.max(dx, dy) <= 5) return
      current.dragging = true
      current.latestX = me.clientX
      me.preventDefault()
      applyDraggedTransform()

      // 只根据拖动标签的视觉中心与相邻标签中心线比较，不再用 elementFromPoint。
      // 这样拖动长标签时，即使它暂时覆盖了其他标签，也不会被自己的命中区域反复触发交换。
      const movementX = me.clientX - current.lastX
      current.lastX = me.clientX
      if (Math.abs(movementX) < 0.5) return

      const draggedNode = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(current.tabId)}"]`)
      if (!draggedNode) return
      const draggedCenter = me.clientX - current.pointerOffsetX + draggedNode.offsetWidth / 2
      const direction = movementX < 0 ? -1 : 1

      setTabs((previous) => {
        const fromIndex = previous.findIndex((tab) => tab.id === current.tabId)
        const toIndex = fromIndex + direction
        const targetTab = previous[toIndex]
        if (fromIndex === -1 || !targetTab || targetTab.id === current.tabId) return previous

        const targetNode = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(targetTab.id)}"]`)
        if (!targetNode) return previous
        const targetCenter = getNaturalTabLeft(targetNode) + targetNode.offsetWidth / 2
        const crossedTargetCenter = direction < 0
          ? draggedCenter <= targetCenter
          : draggedCenter >= targetCenter
        if (!crossedTargetCenter) return previous

        return reorderTabs(previous, fromIndex, toIndex)
      })
      // React 提交新顺序后，重新按新的自然位置计算偏移；否则长标签换位后
      // 旧 transform 会残留一帧，造成被拖标签短暂跳一下。
      applyDraggedTransform()
      requestAnimationFrame(applyDraggedTransform)
    }

    // pointermove 可能高于屏幕刷新率；每帧只处理最后一个位置，避免重复布局读写。
    const handleMove = (me: PointerEvent): void => {
      pendingMove = me
      if (moveFrame !== null) return
      moveFrame = requestAnimationFrame(() => {
        moveFrame = null
        const latestMove = pendingMove
        pendingMove = null
        if (latestMove) processMove(latestMove)
      })
    }

    const handleUp = (): void => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleUp)
      if (moveFrame !== null) {
        cancelAnimationFrame(moveFrame)
        moveFrame = null
      }
      // 松手前的最后一个 pointermove 仍需完成处理，避免鼠标刚越过中心线就松手时漏排一次。
      const latestMove = pendingMove
      pendingMove = null
      if (latestMove) processMove(latestMove)

      const current = dragState.current
      if (current?.dragging) {
        const node = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(current.tabId)}"]`)
        if (node) {
          node.style.transition = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)'
          node.style.transform = 'translate3d(0, 0, 0)'
          node.style.willChange = 'transform'
          if (dragSettleCleanupRef.current !== null) clearTimeout(dragSettleCleanupRef.current)
          dragSettleCleanupRef.current = setTimeout(() => {
            node.dataset.tabDragging = ''
            node.style.transition = ''
            node.style.transform = ''
            node.style.willChange = ''
            node.style.zIndex = ''
            dragSettleCleanupRef.current = null
          }, 200)
        }
      }
      dragState.current = null
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleUp)
  }, [setTabs, tabs])

  React.useEffect(() => {
    return () => {
      if (dragSettleCleanupRef.current !== null) {
        clearTimeout(dragSettleCleanupRef.current)
      }
    }
  }, [])

  if (tabs.length === 0) return <div className="h-[34px] titlebar-drag-region" />

  return (
    <>
      <TabBarInner
        tabs={tabs}
        activeTabId={activeTabId}
        streamingMap={indicatorMap}
        workspaceNameBySessionId={workspaceNameBySessionId}
        automationSessionIds={automationSessionIds}
        onActivate={handleActivate}
        onClose={requestClose}
        onDragStart={handleDragStart}
        onTearOff={handleTearOff}
        teamMode={teamMode}
      />
    </>
  )
}

/** 内部组件：管理全局 hover 状态，确保同一时刻只有一个预览面板 */
function TabBarInner({
  tabs,
  activeTabId,
  streamingMap,
  workspaceNameBySessionId,
  automationSessionIds,
  onActivate,
  onClose,
  onDragStart,
  onTearOff,
  teamMode,
}: {
  tabs: TabItem[]
  activeTabId: string | null
  streamingMap: Map<string, SessionIndicatorStatus>
  workspaceNameBySessionId: Map<string, string>
  automationSessionIds: Set<string>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onDragStart: (tabId: string, e: React.PointerEvent) => void
  onTearOff: (tabId: string) => void
  teamMode: boolean
}): React.ReactElement {
  const [hoveredTabId, setHoveredTabId] = React.useState<string | null>(null)
  const setTabs = useSetAtom(tabsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const enterTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  // 文件面板切换（全局共享）：活动 Tab 是 Agent 且面板关闭时，在 TabBar 右上角展示"打开"按钮。
  // 该按钮的 absolute 定位与 DiffPanelTabBar.PanelRightClose 的 mr-1 mb-[3px] 坐标耦合，
  // 若右侧关闭按钮样式变化，这里需同步调整。
  const [isPanelOpen, setSidePanelOpen] = useAtom(agentSidePanelOpenAtom)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const seenFilesVersion = useAtomValue(seenFilesVersionAtom)
  const hasFileChanges = filesVersion > seenFilesVersion
  const activeTab = React.useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId])
  const activeAgentSessionId = activeTab?.type === 'agent' ? activeTab.sessionId : null
  // 实际可见性（B = 展开意图 A && 窗口足够），由 usePanelAutoLayout 统一计算
  const visibility = useAtomValue(panelVisibilityAtom)
  const filePanelVisible = visibility.filePanel
  const browserVisible = activeAgentSessionId ? visibility.browser : false
  const previewOpenMap = useAtomValue(previewPanelOpenMapAtom)
  // 预览分栏与 TabBar 同属 MainArea。预览未被浏览器替代、且文件栏未占用窗口右缘时，
  // 它会接管窗口控制按钮；TabBar 此时不应继续留出控制区空档。
  const previewOwnsWindowControls = Boolean(
    isWindows
    && activeAgentSessionId
    && previewOpenMap.get(activeAgentSessionId)
    && !filePanelVisible
    && !browserVisible,
  )
  // 文件栏开关跨会话保留；草稿/Chat 等非 Agent 标签不会实际渲染右侧栏，
  // 不能因此让 TabBar 隐藏窗口控制按钮或预留不存在的侧栏空间。
  const rightSidePanelIsVisible = filePanelVisible && activeTab?.type === 'agent'
  const showOpenPanelButton = !filePanelVisible && activeTab?.type === 'agent'
  const filePanelForcedHidden = isPanelOpen && !filePanelVisible
  // 受管浏览器入口：仅当当前标签是 Agent 会话时展示。主进程按会话隔离浏览器。
  const browserOpenMap = useAtomValue(browserPanelOpenMapAtom)
  const setBrowserOpenMap = useSetAtom(browserPanelOpenMapAtom)
  const setBrowserStateMap = useSetAtom(browserStateMapAtom)
  const [browserDismissed, setBrowserDismissed] = useAtom(browserPanelDismissedSessionIdsAtom)
  const activeBrowserIsOpen = activeAgentSessionId ? browserOpenMap.get(activeAgentSessionId) === true : false
  // 图标在「面板实际不可见」时出现；若 A 仍为 true（被迫收起），图标高亮提示存在展开意图
  const showBrowserButton = Boolean(activeAgentSessionId && !browserVisible)
  const browserForcedHidden = Boolean(activeAgentSessionId && activeBrowserIsOpen && !browserVisible)
  // MainArea 的右边界会随着右侧文件面板或浏览器分栏提前结束；
  // 这两种情况下窗口控制按钮已经不在当前 TabBar 内，工具组应贴近 MainArea 右缘。
  const browserSidePanelVisible = browserVisible
  const hasRightSideContent = rightSidePanelIsVisible || browserSidePanelVisible || previewOwnsWindowControls
  // 窗口按钮本身已嵌入当前 TabBar。团队工作区的窗口按钮属于团队面板自身，
  // 团队模式不在这里预留 132px，避免标签区右侧出现无意义空洞。
  const topBarRightOffset = teamMode ? 9 : (isWindows && !hasRightSideContent ? 132 : 9)
  const togglePanel = React.useCallback(() => {
    if (!activeAgentSessionId) return
    if (isPanelOpen) {
      // A=true（可能被迫收起或可见）→ 点击取消展开意图
      setSidePanelOpen(false)
    } else {
      // A=false 手动收起 → 点击打开意图；窗口不足时仅不可见并 toast，A 保持 true
      openFilePanel()
    }
  }, [activeAgentSessionId, isPanelOpen, setSidePanelOpen])

  const openBrowser = React.useCallback(async () => {
    if (!activeAgentSessionId) return
    const open = (window.electronAPI as Partial<typeof window.electronAPI>).openAgentBrowser
    if (typeof open !== 'function') return
    const state = await open(activeAgentSessionId)
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(activeAgentSessionId, state); return next })
    // 用户主动重新打开浏览器，清除“已手动关闭”标记，恢复后续状态推送自动打开能力。
    setBrowserDismissed((previous) => { if (!previous.has(activeAgentSessionId)) return previous; const next = new Set(previous); next.delete(activeAgentSessionId); return next })
    // 统一落地：置展开意图 A=true；窗口不足时暂不可见并 toast（与 Agent 驱动打开行为一致）。
    openBrowserFromPush(activeAgentSessionId)
  }, [activeAgentSessionId, setBrowserDismissed, setBrowserStateMap])

  // 浏览器图标在面板不可见时出现；点击按 A 状态切换：被迫收起（A=true）→ 取消展开意图；
  // 手动收起（A=false）→ 打开。
  const toggleBrowser = React.useCallback(() => {
    if (!activeAgentSessionId) return
    if (activeBrowserIsOpen) {
      void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(activeAgentSessionId)
      setBrowserOpenMap((previous) => { const next = new Map(previous); next.set(activeAgentSessionId, false); return next })
      setBrowserDismissed((previous) => { if (previous.has(activeAgentSessionId)) return previous; const next = new Set(previous); next.add(activeAgentSessionId); return next })
    } else {
      void openBrowser()
    }
  }, [activeAgentSessionId, activeBrowserIsOpen, openBrowser, setBrowserDismissed, setBrowserOpenMap])

  const topBarTools: TopBarTool[] = [
    {
      id: 'managed-browser',
      // 工具优先于标签：浏览器分栏压窄会话区时仍保留完整入口，标签区自行滚动压缩。
      visible: !teamMode && showBrowserButton,
      label: '打开受管浏览器',
      tooltip: '打开受管浏览器',
      icon: <Globe2 className="size-3.5" />,
      onClick: toggleBrowser,
      // 被迫收起（展开意图 A=true 但窗口不足）：图标高亮提示用户当前有展开意图
      highlighted: browserForcedHidden,
    },
    {
      id: 'file-panel',
      visible: !teamMode && showOpenPanelButton,
      label: '打开文件面板',
      tooltip: `打开文件面板 (${navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})`,
      icon: <PanelRight className="size-3.5" />,
      onClick: togglePanel,
      highlighted: filePanelForcedHidden,
      badge: hasFileChanges ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse" /> : undefined,
    },
  ]
  // 每个工具按钮为 28px，工具组 gap 为 4px。滚动标签区直接从同一配置计算避让，
  // 所以新增/删除按钮不会造成布局与可见入口脱节。
  const visibleTopBarToolCount = topBarTools.filter((tool) => tool.visible).length
  const tabScrollRightPadding = topBarRightOffset + visibleTopBarToolCount * 28 + (visibleTopBarToolCount - 1) * 4

  React.useEffect(() => {
    return registerShortcut('toggle-right-panel', togglePanel)
  }, [togglePanel])

  // 滚动容器 ref
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // 整体空间不足时，工作区徽标让位给会话标题；不是按单个标签的宽度判断，
  // 避免普通未选中标签因为 hover 收缩而误隐藏徽标。
  const [isCompactTabs, setIsCompactTabs] = React.useState(false)
  // 收起前的完整布局宽度。回弹不能读取收起后的 scrollWidth，否则徽标变少后
  // scrollWidth 也随之变小，永远无法达到恢复阈值。
  const expandedScrollWidthRef = React.useRef<number | null>(null)
  const observedTabsLengthRef = React.useRef(tabs.length)

  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // Tab 数量变化后，之前记录的完整宽度已经失效；先恢复完整布局，下一轮重新测量。
    if (observedTabsLengthRef.current !== tabs.length) {
      observedTabsLengthRef.current = tabs.length
      expandedScrollWidthRef.current = null
      if (isCompactTabs) {
        setIsCompactTabs(false)
        return
      }
    }

    const measure = (): void => {
      if (!isCompactTabs) {
        const hasOverflow = el.scrollWidth > el.clientWidth + 2
        if (hasOverflow) {
          // 在完整布局仍然存在时保存基准，再切换到紧凑布局。
          expandedScrollWidthRef.current = el.scrollWidth
          setIsCompactTabs(true)
        }
        return
      }

      const expandedWidth = expandedScrollWidthRef.current
      if (expandedWidth === null) return
      // 完整布局已经能放下时立即回弹；不能再额外加回弹宽度，
      // 否则空间明明足够，标签仍会卡在紧凑态。
      setIsCompactTabs(el.clientWidth + 2 < expandedWidth)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabs.length, tabScrollRightPadding, isCompactTabs])

  // 整条 TabBar 容器 ref，用于拖拽 tear-off 时检测鼠标是否离开 TabBar 区域
  const barRef = React.useRef<HTMLDivElement>(null)

  // 拖出 TabBar 区域时给出视觉提示（仅 preview Tab 可 tear-off）
  const [tearingOff, setTearingOff] = React.useState<string | null>(null)

  // 拦截外层 handleDragStart：若拖出 TabBar 区域且是 preview Tab，触发 tear-off
  const handleDragStartWithTearOff = React.useCallback((tabId: string, e: React.PointerEvent) => {
    const tab = tabs.find((t) => t.id === tabId)
    // 仅 preview Tab 支持拖出转分屏
    if (!tab || tab.type !== 'preview') {
      onDragStart(tabId, e)
      return
    }

    if (e.button !== 0) return
    const startX = e.clientX
    let torn = false
    let sorting = false

    // 拖出 TabBar 上下边界后还需再越过这段缓冲距离才触发 tear-off，
    // 避免在水平排序过程中轻微的垂直抖动误触发转分屏。
    const TEAR_OFF_MARGIN = 24

    const handleMove = (me: PointerEvent): void => {
      if (torn) return
      const rect = barRef.current?.getBoundingClientRect()
      // 拖出 TabBar 上/下边界并越过缓冲距离才视为 tear-off
      const outOfBar = !!rect && (me.clientY < rect.top - TEAR_OFF_MARGIN || me.clientY > rect.bottom + TEAR_OFF_MARGIN)
      if (outOfBar) {
        torn = true
        setTearingOff(tabId)
        // 仅停止 move 监听，保留 pointerup 让浏览器自然结束按住状态
        document.removeEventListener('pointermove', handleMove)
        // 等下一帧再触发，避免在事件回调中同步重渲染导致 React 警告
        requestAnimationFrame(() => {
          onTearOff(tabId)
          setTearingOff(null)
        })
        return
      }
      // 在 TabBar 内水平移动 → 交给原有排序逻辑
      const dx = Math.abs(me.clientX - startX)
      if (!sorting && dx > 5) {
        sorting = true
        onDragStart(tabId, e)
      }
    }

    const handleUp = (): void => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }, [tabs, onDragStart, onTearOff])

  // 鼠标滚轮横向滚动（使用原生事件监听器以支持 preventDefault）
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      el.scrollLeft += e.deltaY || e.deltaX
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // FLIP：标签顺序变化后，从当前视觉位置平滑过渡到新位置，而不是被 Flex 布局瞬移。
  // 每次连续交换都先读取上一段动画的当前位置，避免快速拖动时动画重新跳起。
  const tabRectsRef = React.useRef(new Map<string, DOMRect>())
  const tabAnimationFrameRef = React.useRef<number | null>(null)
  const tabAnimationCleanupRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    const tabNodes = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [],
    )
    const hasPreviousLayout = tabRectsRef.current.size > 0
    const previousRects = new Map<string, DOMRect>()

    // getBoundingClientRect 会包含当前 transform，正好可以作为连续动画的真实起点。
    if (hasPreviousLayout) {
      for (const node of tabNodes) {
        const id = node.dataset.tabId
        const isDragged = node.dataset.tabDragging === 'true'
        if (id && !isDragged) previousRects.set(id, node.getBoundingClientRect())
        if (!isDragged) {
          node.style.transition = 'none'
          node.style.transform = 'none'
        }
      }
      // 清除旧 transform 后强制布局，读取这次数组顺序对应的自然位置。
      void scrollRef.current?.offsetWidth
    }

    const nextRects = new Map<string, DOMRect>()
    for (const node of tabNodes) {
      const id = node.dataset.tabId
      if (id) nextRects.set(id, node.getBoundingClientRect())
    }

    if (hasPreviousLayout) {
      let hasMovement = false
      for (const node of tabNodes) {
        const id = node.dataset.tabId
        if (node.dataset.tabDragging === 'true') continue
        const previous = id ? previousRects.get(id) : undefined
        const next = id ? nextRects.get(id) : undefined
        if (!previous || !next) continue

        const dx = previous.left - next.left
        const dy = previous.top - next.top
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
        hasMovement = true

        node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
        node.style.willChange = 'transform'
      }

      if (hasMovement) {
        if (tabAnimationFrameRef.current !== null) {
          cancelAnimationFrame(tabAnimationFrameRef.current)
        }
        if (tabAnimationCleanupRef.current !== null) {
          clearTimeout(tabAnimationCleanupRef.current)
        }
        tabAnimationFrameRef.current = requestAnimationFrame(() => {
          for (const node of tabNodes) {
            if (node.dataset.tabDragging === 'true') continue
            node.style.transition = 'transform 340ms ease-out'
            node.style.transform = 'translate3d(0, 0, 0)'
          }
          tabAnimationFrameRef.current = null
          tabAnimationCleanupRef.current = setTimeout(() => {
            for (const node of tabNodes) {
              if (node.dataset.tabDragging === 'true') continue
              node.style.transition = ''
              node.style.transform = ''
              node.style.willChange = ''
            }
            tabAnimationCleanupRef.current = null
          }, 360)
        })
      }
    }

    tabRectsRef.current = nextRects
  }, [tabs])

  React.useEffect(() => {
    return () => {
      if (tabAnimationFrameRef.current !== null) {
        cancelAnimationFrame(tabAnimationFrameRef.current)
      }
      if (tabAnimationCleanupRef.current !== null) {
        clearTimeout(tabAnimationCleanupRef.current)
      }
    }
  }, [])

  // 新增 tab 时自动滚动到最右
  const prevTabCount = React.useRef(tabs.length)
  React.useEffect(() => {
    if (tabs.length > prevTabCount.current && scrollRef.current) {
      scrollRef.current.scrollTo({ left: scrollRef.current.scrollWidth, behavior: 'smooth' })
    }
    prevTabCount.current = tabs.length
  }, [tabs.length])

  React.useEffect(() => {
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [])

  const handleRenameAgentSession = React.useCallback(async (sessionId: string, title: string) => {
    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(sessionId, title)
      setTabs((previous) => updateTabTitle(previous, updated.id, updated.title))
      setAgentSessions((previous) => replaceAgentSessionInFreshnessOrder(previous, updated))
    } catch (error) {
      console.error('[TabBar] 更新 Agent 会话标题失败:', error)
      toast.error('会话重命名失败，请重试')
      throw error
    }
  }, [setAgentSessions, setTabs])

  const handleTabHoverEnter = React.useCallback((tabId: string) => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    setIsLeaving(false)

    // 如果已经有面板打开（从一个 Tab 滑到另一个），立即切换
    if (hoveredTabId) {
      setHoveredTabId(tabId)
    } else {
      // 首次 hover，延迟 300ms
      enterTimerRef.current = setTimeout(() => setHoveredTabId(tabId), 300)
    }
  }, [hoveredTabId])

  const handleTabHoverLeave = React.useCallback(() => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    leaveTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setHoveredTabId(null)
        setIsLeaving(false)
      }, 80)
    }, 200)
  }, [])

  // 面板的 hover 进入（阻止关闭）
  const handlePanelHoverEnter = React.useCallback(() => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
  }, [])

  return (
    <div ref={barRef} className="flex items-end h-[38px] tabbar-bg relative">
      {/* 顶部 TabBar 的空白区域必须保持可拖拽，尤其是 macOS/Windows 自定义标题栏。
          注意：不要把 titlebar-no-drag 加到下面的整条 flex 容器上，否则标签右侧空白会再次失去拖拽能力。
          Windows 上背景拖拽层避开右上角 WindowControls 区域（126px），防止 hitmask 重叠。
          需要交互的单个 Tab 会在 TabBarItem 内部自己声明 titlebar-no-drag。 */}
      <div className={cn("absolute inset-0 titlebar-drag-region", isWindows && !previewOwnsWindowControls && "right-[126px]")} />

      {/* Tear-off 提示遮罩：拖出 TabBar 区域时，让 TabBar 下方出现一条高亮分割线 */}
      {tearingOff && (
        <div className="pointer-events-none absolute -bottom-px left-0 right-0 h-px bg-primary/60 shadow-[0_0_8px_rgba(0,0,0,0.2)]" />
      )}

      <div
        ref={scrollRef}
        // 工具组位于同一行的右端并优先保留空间；标签区仅消费剩余宽度，
        // 宽度不足时横向滚动而非挤压/覆盖右端工具。
        className="relative flex items-end flex-1 min-w-0 overflow-x-auto scrollbar-none pl-4 pr-1 pb-1 gap-1"
        // 右侧工具组和 Windows 窗口控制区占用空间由同一份工具定义计算，
        // 新增或移除按钮时不必再手工维护多组 absolute right 偏移。
        style={{ paddingRight: tabScrollRightPadding }}
      >
        {tabs.map((tab) => (
          <TabBarItem
            key={tab.id}
            id={tab.id}
            type={tab.type}
            title={tab.title}
            workspaceName={tab.type === 'agent' ? workspaceNameBySessionId.get(tab.sessionId) : undefined}
            hideWorkspaceName={isCompactTabs}
            hideRenameControl={isCompactTabs}
            isAutomation={tab.type === 'agent' && automationSessionIds.has(tab.sessionId)}
            onRename={tab.type === 'agent' ? (title) => handleRenameAgentSession(tab.sessionId, title) : undefined}
            isActive={tab.id === activeTabId}
            isStreaming={streamingMap.get(tab.id) ?? 'idle'}
            isHovered={hoveredTabId === tab.id}
            isLeaving={hoveredTabId === tab.id && isLeaving}
            isTearingOff={tearingOff === tab.id}
            onActivate={() => onActivate(tab.id)}
            onClose={() => onClose(tab.id)}
            onMiddleClick={() => onClose(tab.id)}
            onDragStart={(e) => handleDragStartWithTearOff(tab.id, e)}
            onHoverEnter={() => handleTabHoverEnter(tab.id)}
            onHoverLeave={handleTabHoverLeave}
            onPanelHoverEnter={handlePanelHoverEnter}
            onPanelHoverLeave={handleTabHoverLeave}
          />
        ))}
      </div>

      {/* 顶栏功能入口集中为有序工具组：浏览器 → 开屏重播 → 文件面板。
          每个条目只描述自己的可见性、行为与呈现；工具组统一负责排列和留白。 */}
      <TopBarToolGroup
        isWindows={isWindows}
        rightOffset={topBarRightOffset}
        tools={topBarTools}
      />

      {/* Windows 按钮属于 TabBar，而不是悬浮在 AppShell 上层。工具组与标签滚动区
          已为这 118px 控制区预留空间；titlebar-drag-region 也在相同边界前结束。 */}
      {/* 右侧文件栏或受管浏览器占据窗口最右缘时，控制按钮由该面板自身渲染。 */}
      <WindowControlsHost
        id="tab-bar"
        // 用实际可见性（B）判定：浏览器/文件面板被迫收起（A=true 但窗口不足）时不渲染，
        // 窗口控制按钮必须回到 TabBar；面板实际可见时才交给面板自身渲染。
        active={!teamMode && !rightSidePanelIsVisible && !browserVisible && !previewOwnsWindowControls}
        priority={10}
        className="absolute right-2 bottom-[3px]"
      />
    </div>
  )
}

interface TopBarTool {
  id: string
  visible: boolean
  label: string
  tooltip: string
  icon: React.ReactNode
  onClick: () => void
  badge?: React.ReactNode
  /** 被迫收起（有展开意图但窗口不足）：图标显示为 hover 态高亮，提示存在展开意图 */
  highlighted?: boolean
}

/**
 * 顶栏功能工具组。新入口只需向 tools 增加一项，不需要复制定位容器或手工推导 right 偏移。
 * Windows 的 132px 是 WindowControls（约 118px）与两组之间的安全间隔。
 */
function TopBarToolGroup({
  isWindows,
  rightOffset,
  tools,
}: {
  isWindows: boolean
  rightOffset: number
  tools: TopBarTool[]
}): React.ReactElement | null {
  const visibleTools = tools.filter((tool) => tool.visible)
  if (visibleTools.length === 0) return null

  return (
    <div
      className="absolute inset-y-0 z-10 flex items-end gap-1 pb-[3px] titlebar-no-drag"
      style={{ right: rightOffset }}
      role="toolbar"
      aria-label="顶栏工具"
    >
      {visibleTools.map((tool) => (
        <Tooltip key={tool.id}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn('relative h-7 w-7', tool.highlighted && 'bg-accent/70 text-accent-foreground')}
              aria-label={tool.label}
              onClick={tool.onClick}
            >
              {tool.icon}
              {tool.badge}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{tool.tooltip}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
