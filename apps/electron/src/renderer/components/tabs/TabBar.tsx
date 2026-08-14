/**
 * TabBar — 顶部标签栏
 *
 * 显示所有打开的标签页，支持：
 * - 点击切换标签
 * - 中键关闭标签
 * - 拖拽重排序
 * - Chrome 风格等分宽度（溢出时可横向滚动）
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { Globe2, PanelRight } from 'lucide-react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  tabsAtom,
  activeTabIdAtom,
  tabIndicatorMapAtom,
  updateTabTitle,
} from '@/atoms/tab-atoms'
import type { TabItem } from '@/atoms/tab-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import { replayIntroOpenAtom } from '@/atoms/intro-atoms'
import {
  agentSessionsAtom,
  agentSidePanelOpenAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
  workspaceFilesVersionAtom,
} from '@/atoms/agent-atoms'
import {
  browserFilePanelManualRestoreSessionIdsAtom,
  browserManualOpenSessionIdsAtom,
  browserPanelDismissedSessionIdsAtom,
  browserPanelOpenMapAtom,
  browserStateMapAtom,
} from '@/atoms/browser-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { tearOffPreviewToSplit } from '@/components/diff/preview-opener'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { TabBarItem } from './TabBarItem'
import { useCloseTab } from '@/hooks/useCloseTab'
import { detectIsWindows } from '@/lib/platform'
import { registerShortcut } from '@/lib/shortcut-registry'
import { navigationController } from '@/lib/navigation-controller'
import { cn } from '@/lib/utils'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'

export function TabBar(): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
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

  // 拖拽状态
  const dragState = React.useRef<{
    dragging: boolean
    tabId: string
    startX: number
    startIndex: number
  } | null>(null)

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
      if (appMode !== 'agent') {
        setCurrentAgentSessionId(null)
      }
    }
  }, [setActiveTabId, setAutomationForm, tabs, agentSessions, appMode, setAppMode, setCurrentConversationId, setCurrentAgentSessionId, setCurrentAgentWorkspaceId, setUnviewedCompleted])

  React.useEffect(() => {
    return navigationController.register((action) => {
      const delta = action === 'previousTab' ? -1 : action === 'nextTab' ? 1 : 0
      if (delta === 0 || tabs.length === 0) return false
      const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId))
      const nextIndex = (currentIndex + delta + tabs.length) % tabs.length
      const nextTab = tabs[nextIndex]
      if (!nextTab) return false
      handleActivate(nextTab.id)
      return true
    }, 10)
  }, [activeTabId, handleActivate, tabs])

  const handleDragStart = React.useCallback((tabId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return // 只处理左键
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return

    dragState.current = {
      dragging: false,
      tabId,
      startX: e.clientX,
      startIndex: idx,
    }

    const handleMove = (me: PointerEvent): void => {
      if (!dragState.current) return
      const dx = Math.abs(me.clientX - dragState.current.startX)
      if (dx > 5) dragState.current.dragging = true
    }

    const handleUp = (): void => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      dragState.current = null
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }, [tabs])

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
  const setReplayIntroOpen = useSetAtom(replayIntroOpenAtom)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const hasFileChanges = filesVersion > 0
  const activeTab = React.useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId])
  const activeAgentSessionId = activeTab?.type === 'agent' ? activeTab.sessionId : null
  const showOpenPanelButton = !isPanelOpen && activeTab?.type === 'agent'
  // 受管浏览器入口：仅当当前标签是 Agent 会话时展示。主进程按会话隔离浏览器。
  const [browserOpenMap, setBrowserOpenMap] = useAtom(browserPanelOpenMapAtom)
  const setBrowserStateMap = useSetAtom(browserStateMapAtom)
  const [browserDismissed, setBrowserDismissed] = useAtom(browserPanelDismissedSessionIdsAtom)
  const [browserManualOpen, setBrowserManualOpen] = useAtom(browserManualOpenSessionIdsAtom)
  const [browserFilePanelManualRestoreSessionIds, setBrowserFilePanelManualRestoreSessionIds] = useAtom(browserFilePanelManualRestoreSessionIdsAtom)
  const activeBrowserIsOpen = activeAgentSessionId ? browserOpenMap.get(activeAgentSessionId) === true : false
  const showBrowserButton = Boolean(activeAgentSessionId)
  // MainArea 的右边界会随着右侧文件面板或浏览器分栏提前结束；
  // 这两种情况下窗口控制按钮已经不在当前 TabBar 内，工具组应贴近 MainArea 右缘。
  const browserSidePanelVisible = Boolean(
    activeAgentSessionId && browserOpenMap.get(activeAgentSessionId) === true,
  )
  const hasRightSideContent = isPanelOpen || browserSidePanelVisible
  // 窗口按钮本身已嵌入当前 TabBar。只有本区域真正延伸到窗口右缘时，
  // 工具组和标签才需为按钮留出 118px；有右侧分栏时无需预留。
  const topBarRightOffset = isWindows && !hasRightSideContent ? 132 : 9
  const togglePanel = React.useCallback(() => {
    if (!activeAgentSessionId) return
    // 用户手动恢复文件面板时，记录该会话不再自动收起，避免与浏览器抢占空间时反复收起。
    if (!isPanelOpen && browserOpenMap.get(activeAgentSessionId)) {
      setBrowserFilePanelManualRestoreSessionIds((previous) => (
        previous.includes(activeAgentSessionId) ? previous : [...previous, activeAgentSessionId]
      ))
    }
    setSidePanelOpen((v) => !v)
  }, [activeAgentSessionId, browserOpenMap, isPanelOpen, setBrowserFilePanelManualRestoreSessionIds, setSidePanelOpen])

  const openBrowser = React.useCallback(async () => {
    if (!activeAgentSessionId) return
    const open = (window.electronAPI as Partial<typeof window.electronAPI>).openAgentBrowser
    if (typeof open !== 'function') return
    const state = await open(activeAgentSessionId)
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(activeAgentSessionId, state); return next })
    setBrowserOpenMap((previous) => { const next = new Map(previous); next.set(activeAgentSessionId, true); return next })
    // 用户主动重新打开浏览器，清除“已手动关闭”标记，恢复后续状态推送自动打开能力。
    setBrowserDismissed((previous) => { if (!previous.has(activeAgentSessionId)) return previous; const next = new Set(previous); next.delete(activeAgentSessionId); return next })
    // 记录用户手动打开，窄屏不再被 MainArea 的 788 阈值自动收起（布局恢复宽后重置）。
    setBrowserManualOpen((previous) => { if (previous.has(activeAgentSessionId)) return previous; const next = new Set(previous); next.add(activeAgentSessionId); return next })
  }, [activeAgentSessionId, setBrowserDismissed, setBrowserManualOpen, setBrowserOpenMap, setBrowserStateMap])

  const topBarTools: TopBarTool[] = [
    {
      id: 'managed-browser',
      // 工具优先于标签：浏览器分栏压窄会话区时仍保留完整入口，标签区自行滚动压缩。
      visible: showBrowserButton,
      label: '打开受管浏览器',
      tooltip: '打开受管浏览器',
      icon: <Globe2 className="size-3.5" />,
      onClick: () => void openBrowser(),
    },
    {
      id: 'replay-intro',
      visible: true,
      label: '重播开屏动画',
      tooltip: '重播开屏动画',
      icon: <Sparkles className="size-3.5" />,
      onClick: () => setReplayIntroOpen(true),
    },
    {
      id: 'file-panel',
      visible: showOpenPanelButton,
      label: '打开文件面板',
      tooltip: `打开文件面板 (${navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})`,
      icon: <PanelRight className="size-3.5" />,
      onClick: togglePanel,
      badge: hasFileChanges ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse" /> : undefined,
    },
  ]
  // 每个工具按钮为 28px，工具组 gap 为 4px。滚动标签区直接从同一配置计算避让，
  // 所以新增/删除按钮不会造成布局与可见入口脱节。
  const visibleTopBarToolCount = topBarTools.filter((tool) => tool.visible).length
  const tabScrollRightPadding = topBarRightOffset + visibleTopBarToolCount * 28 + (visibleTopBarToolCount - 1) * 4

  // 某些会话打开浏览器（agent 驱动的 BrowserObserve 等会先于用户点击触发），
  // 此时若文件面板仍展开会挤压浏览器宽度：自动收起一次，除非用户手动恢复过。
  const priorBrowserStateRef = React.useRef<{ sessionId: string | null; open: boolean }>({ sessionId: null, open: false })
  React.useEffect(() => {
    const sessionId = activeAgentSessionId
    const previous = priorBrowserStateRef.current
    const shouldAutoCollapse = Boolean(
      sessionId &&
      previous.sessionId === sessionId &&
      !previous.open &&
      activeBrowserIsOpen &&
      isPanelOpen &&
      !browserFilePanelManualRestoreSessionIds.includes(sessionId),
    )
    priorBrowserStateRef.current = { sessionId, open: activeBrowserIsOpen }

    if (!shouldAutoCollapse) return
    setSidePanelOpen(false)
    toast.message('已收起右侧文件面板，便于浏览网页', {
      description: '按 ⌘⇧B（Windows / Linux：Ctrl+Shift+B）可重新打开；手动打开后，本会话不再自动收起。',
    })
  }, [activeAgentSessionId, activeBrowserIsOpen, browserFilePanelManualRestoreSessionIds, isPanelOpen, setSidePanelOpen])

  React.useEffect(() => {
    return registerShortcut('toggle-right-panel', togglePanel)
  }, [togglePanel])

  // 滚动容器 ref
  const scrollRef = React.useRef<HTMLDivElement>(null)

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
    <div ref={barRef} className="flex items-end h-[34px] tabbar-bg relative">
      {/* 顶部 TabBar 的空白区域必须保持可拖拽，尤其是 macOS/Windows 自定义标题栏。
          注意：不要把 titlebar-no-drag 加到下面的整条 flex 容器上，否则标签右侧空白会再次失去拖拽能力。
          Windows 上背景拖拽层避开右上角 WindowControls 区域（126px），防止 hitmask 重叠。
          需要交互的单个 Tab 会在 TabBarItem 内部自己声明 titlebar-no-drag。 */}
      <div className={cn("absolute inset-0 titlebar-drag-region", isWindows && "right-[126px]")} />

      {/* Tear-off 提示遮罩：拖出 TabBar 区域时，让 TabBar 下方出现一条高亮分割线 */}
      {tearingOff && (
        <div className="pointer-events-none absolute -bottom-px left-0 right-0 h-px bg-primary/60 shadow-[0_0_8px_rgba(0,0,0,0.2)]" />
      )}

      <div
        ref={scrollRef}
        // 工具组位于同一行的右端并优先保留空间；标签区仅消费剩余宽度，
        // 宽度不足时横向滚动而非挤压/覆盖右端工具。
        className="relative flex items-end flex-1 min-w-0 overflow-x-auto scrollbar-none"
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
        active={!isPanelOpen && !activeBrowserIsOpen}
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
              className="relative h-7 w-7"
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
