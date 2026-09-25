/**
 * MainArea — 主内容区域
 *
 * 组合 TabBar + TabContent。文件预览与受管浏览器都是顶栏的工作 Tab：
 * - 每文件一个预览 Tab，浏览器每会话单例；
 * - 并排统一走 Tab 组合（左侧组内成员 + 右侧组内成员）；Agent 推送浏览器状态时
 *   自动把浏览器 Tab 与对话组合（不打断对话，焦点留在对话一侧）。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useAtom } from 'jotai'
import { tabsAtom, activeTabIdAtom, activeTabAtom, tabIndicatorMapAtom } from '@/atoms/tab-atoms'
import { Panel } from '@/components/app-shell/Panel'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { browserPanelDismissedSessionIdsAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { openBrowserTabFromPush } from '@/lib/browser-tab'
import { isBrowserTab } from '@/atoms/tab-atoms'
import { shouldAutoOpenBrowserFromPush } from '@/lib/browser-auto-open'
import type { BrowserViewState } from '@profer/shared'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { PlanningView } from '@/components/planning/PlanningView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { agentSidePanelOpenAtom } from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { cn } from '@/lib/utils'
import { resolveContentTabId } from '@/lib/active-tab-content'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
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
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const [tabGroups, setTabGroups] = useAtom(tabGroupsAtom)
  const tabGroup = findTabGroup(tabGroups, activeTabId)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const appMode = useAtomValue(appModeAtom)
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()

  // 内容必须跟随同步 activeTabId 渲染。useDeferredValue 会让 TabBar 已高亮新会话时，
  // 主区域仍长期保留旧会话；昂贵子树应自行优化，不能以旧会话内容作为过渡态。
  const contentTabId = resolveContentTabId(tabs, activeTabId)

  const [agentSidePanelOpen, setAgentSidePanelOpen] = useAtom(agentSidePanelOpenAtom)

  // ===== 受管浏览器（Tab 化）=====
  const setBrowserStateMap = useSetAtom(browserStateMapAtom)
  const browserDismissed = useAtomValue(browserPanelDismissedSessionIdsAtom)
  const currentBrowserSessionIdRef = React.useRef<string | null>(null)
  const previousBrowserSessionIdRef = React.useRef<string | null>(null)
  // 浏览器仅属于 Agent 会话；必须同时满足「激活 tab 绑定了 agent 会话」（agent / 预览 / 浏览器 Tab）
  // 和「当前处于 agent 模式」。否则 toggle-mode 快捷键（只切 appMode 不切 tab）会造成
  // appMode 与 activeTab 撕裂，让浏览器状态在已切到 Chat 的界面上错误残留。
  const browserSessionId = appMode === 'agent' && activeTab && (activeTab.type === 'agent' || activeTab.type === 'preview' || activeTab.type === 'browser')
    ? activeTab.sessionId
    : null
  currentBrowserSessionIdRef.current = browserSessionId

  const publishBrowserState = React.useCallback((state: BrowserViewState, options?: { autoOpen?: boolean }) => {
    // 同步浏览器内容状态（tabs/url/标题/trace 等）。状态可以保留在后台会话，
    // 但后台会话的状态推送不能改变当前会话的浏览器 Tab。
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(state.sessionId, state); return next })
    // 只有当前激活会话收到实时状态推送时才允许自动打开。切换会话时的 getState
    // 仅用于恢复工具栏状态，不能把旧会话的浏览器 Tab 重新唤起。
    if (state.sessionId !== currentBrowserSessionIdRef.current) return
    const dismissed = browserDismissed.has(state.sessionId)
    const hasBrowserTabs = tabs.some((tab) => isBrowserTab(tab) && tab.sessionId === state.sessionId)
    // 已手动收掉且没有遗留页 Tab：不重建；仍有页 Tab 则继续同步（页面可能被 Agent 关掉）
    if (dismissed && !hasBrowserTabs) return
    const autoOpen = options?.autoOpen !== false && !dismissed
    // 只读动作推送且没有既有页 Tab：不创建（保持安静）
    if (!hasBrowserTabs && !autoOpen) return
    // Tab 化：按页 reconcile；autoOpen 时自动与对话组合并排（对话左、浏览器右，不打断对话）。
    openBrowserTabFromPush(state, { autoGroup: autoOpen })
  }, [browserDismissed, setBrowserStateMap, tabs])

  /**
   * 订阅实时状态推送。
   *
   * 不再把「收到任意浏览器状态」当作「用户需要看浏览器」：只有 Agent 真的开始展示页面
   * （存在工作标签 + 最近动作是 navigate/tab）才自动建组。用户点击浏览器按钮走 TabBar 的
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
      // 切换会话时只收起旧会话的原生视图，不销毁其浏览器状态；回到该会话时，
      // 只要用户没有主动关闭浏览器 Tab，就应恢复打开。
      void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(previousSessionId)
    }
    previousBrowserSessionIdRef.current = browserSessionId
  }, [browserSessionId])

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
          // 切回会话时重新拉起已有浏览器 Tab；用户明确关闭过的会话仍保持关闭。
          publishBrowserState(state, { autoOpen: !browserDismissed.has(browserSessionId) })
        }
      })
      // 后台会话及已删除会话会被主进程拒绝或返回空状态；无需打断当前界面。
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [browserDismissed, browserSessionId, publishBrowserState])

  // 组合视图已经明确占用主区两栏；右侧文件面板不能以"展开意图"留在后台，
  // 否则解散组合或切回会话时会把三栏状态再次拉回来。
  React.useEffect(() => {
    if (!tabGroup) return
    if (agentSidePanelOpen) setAgentSidePanelOpen(false)
  }, [agentSidePanelOpen, setAgentSidePanelOpen, tabGroup])

  // ===== 组合 tab（两个标签左右并排）=====
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
  // 分栏像素宽由实测容器宽算出，保证比例与最小宽度约束一致
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

  /** 空栏里选中一个标签（会话或工作 Tab）：放进去并把焦点交给它 */
  const fillGroupPane = React.useCallback((side: TabGroupSide, tabId: string): void => {
    if (!tabGroup) return
    const filledGroup = fillGroupSide(tabGroup, side, tabId)
    if (filledGroup) setTabGroups((previous) => replaceTabGroup(previous, tabGroup, filledGroup))
    activateGroupTab(tabId)
  }, [activateGroupTab, setTabGroups, tabGroup])

  const dissolveGroup = React.useCallback((): void => {
    setTabGroups((previous) => removeTabGroup(previous, tabGroup))
  }, [setTabGroups, tabGroup])

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
      // 指针位置代表**左栏**占比，而 tabGroupRatio 存的是右栏占比，取补。
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

  return (
    <div className="relative flex h-full min-w-0">
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
            {/* 顶栏横跨整个主区：组合分屏时两侧顶栏共用同一条基线。 */}
            <TabBar />
            <div className="relative flex flex-1 min-h-0 overflow-hidden" data-split-container>
              {/* 内容区：TabContent（单栏）+ 可选的组合右栏。
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
                style={{ flex: '1 1 auto' }}
              >
                {/* 左栏：组合激活时是组内左成员，否则是当前标签 */}
                <div
                  className="flex flex-col min-w-0 h-full relative"
                  style={{ flex: '1 1 auto' }}
                  onPointerDownCapture={() => focusGroupSide('left')}
                >
                  {/* 焦点指示：非焦点栏轻微降对比，替代已退役的 PaneHeader 说明行 */}
                  {groupViewActive && leftGroupTab && activeTabId !== leftGroupTab.id && (
                    <div className="pointer-events-none absolute inset-0 z-10 bg-foreground/[0.05]" aria-hidden="true" />
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
                      className="flex flex-col min-w-0 h-full relative"
                      style={rightPaneStyle}
                      onPointerDownCapture={() => focusGroupSide('right')}
                    >
                      {rightGroupTab && activeTabId !== rightGroupTab.id && (
                        <div className="pointer-events-none absolute inset-0 z-10 bg-foreground/[0.05]" aria-hidden="true" />
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
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}
