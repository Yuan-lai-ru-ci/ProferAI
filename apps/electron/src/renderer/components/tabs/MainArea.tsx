/**
 * MainArea — 主内容区域
 *
 * 组合 TabBar + TabContent。文件预览与受管浏览器都是顶栏的工作 Tab：
 * - 每文件一个预览 Tab，浏览器每会话单例；
 * - 并排统一走 Tab 组合（左侧组内成员 + 右侧组内成员）；Agent 推送浏览器状态时
 *   自动把浏览器 Tab 与对话组合（不打断对话，焦点留在对话一侧）。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useAtom, useStore } from 'jotai'
import { tabsAtom, activeTabIdAtom, activeTabAtom, tabIndicatorMapAtom, createBrowserTabId } from '@/atoms/tab-atoms'
import { Panel } from '@/components/app-shell/Panel'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { browserNativePaneTabIdsAtom, browserPanelDismissedSessionIdsAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { openBrowserTabFromPush } from '@/lib/browser-tab'
import { isBrowserTab } from '@/atoms/tab-atoms'
import { shouldAutoOpenBrowserFromPush } from '@/lib/browser-auto-open'
import type { BrowserViewState } from '@profer/shared'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { PlanningView } from '@/components/planning/PlanningView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { AgentMemoryView } from '@/components/agent-skills/AgentMemoryView'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { cn } from '@/lib/utils'
import { resolveContentTabId } from '@/lib/active-tab-content'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { EmptyPanePlaceholder } from './EmptyPanePlaceholder'
import { SplitViewCloseButton } from './SplitViewCloseButton'
import { useCloseTab } from '@/hooks/useCloseTab'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'
import {
  GROUP_SPLIT_GAP,
  clampGroupRatio,
  fillGroupSide,
  findTabGroup,
  focusGroupMember,
  groupSessionId,
  groupTabIds,
  isSessionConsistentGroup,
  reconcileTabGroups,
  removeTabGroup,
  replaceTabGroup,
  resolveGroupCollapseIntent,
  resolveGroupPaneFocusTarget,
  resolveGroupSplitGeometry,
  tabGroupsAtom,
  tabGroupDragAtom,
  tabGroupRatioAtom,
  type TabGroupSide,
} from '@/atoms/tab-group-atoms'

/**
 * 分栏收起的抽屉动画时长与缓动：与左侧栏/抽屉的收起动画（300ms + cubic-bezier(0.32,0.72,0,1)）
 * 保持一致，手感和系统里的抽屉一致；时长同时用于 transition 与真正解散组合的定时器。
 */
const GROUP_COLLAPSE_ANIMATION_MS = 300
const GROUP_COLLAPSE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
/** 动画结束后再多等一帧再解散，避免“最后一帧还没画完就切布局”的微跳 */
const GROUP_COLLAPSE_SETTLE_MS = GROUP_COLLAPSE_ANIMATION_MS + 32

export function MainArea(): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  // 浏览器订阅只随会话变化；标签排序/标题更新不能重新触发状态恢复。
  const tabsRef = React.useRef(tabs)
  tabsRef.current = tabs
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const store = useStore()
  const [tabGroups, setTabGroups] = useAtom(tabGroupsAtom)
  const nativeBrowserPaneTabs = useAtomValue(browserNativePaneTabIdsAtom)
  const tabGroup = findTabGroup(tabGroups, activeTabId)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const appMode = useAtomValue(appModeAtom)
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()

  // 内容必须跟随同步 activeTabId 渲染。useDeferredValue 会让 TabBar 已高亮新会话时，
  // 主区域仍长期保留旧会话；昂贵子树应自行优化，不能以旧会话内容作为过渡态。
  const contentTabId = resolveContentTabId(tabs, activeTabId)

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
  // 当前布局里是否真的有一栏在展示浏览器页。组合两栏都算，后台组合不算。
  const browserPaneVisible = activeTab?.type === 'browser'
    || (tabGroup ? groupTabIds(tabGroup).some((id) => tabs.find((tab) => tab.id === id)?.type === 'browser') : false)

  const publishBrowserState = React.useCallback((state: BrowserViewState, options?: { autoOpen?: boolean; autoGroup?: boolean }) => {
    // 先取旧状态：页内新开页需要在 reconcile 后判断“新页接管原分屏栏”。
    const previousState = store.get(browserStateMapAtom).get(state.sessionId) ?? null
    // 同步浏览器内容状态（tabs/url/标题/trace 等）。状态可以保留在后台会话，
    // 但后台会话的状态推送不能改变当前会话的浏览器 Tab。
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(state.sessionId, state); return next })
    // 只有当前激活会话收到实时状态推送时才允许自动打开。切换会话时的 getState
    // 仅用于恢复工具栏状态，不能把旧会话的浏览器 Tab 重新唤起。
    if (state.sessionId !== currentBrowserSessionIdRef.current) return
    const dismissed = browserDismissed.has(state.sessionId)
    const hasBrowserTabs = tabsRef.current.some((tab) => isBrowserTab(tab) && tab.sessionId === state.sessionId)
    // 已手动收掉且没有遗留页 Tab：不重建；仍有页 Tab 则继续同步（页面可能被 Agent 关掉）
    if (dismissed && !hasBrowserTabs) return
    const autoOpen = options?.autoOpen !== false && !dismissed
    // 只读动作推送且没有既有页 Tab：不创建（保持安静）
    if (!hasBrowserTabs && !autoOpen) return
    // Tab 化：按页 reconcile；autoOpen 时自动与对话组合并排（对话左、浏览器右，不打断对话）。
    openBrowserTabFromPush(state, {
      autoGroup: autoOpen && options?.autoGroup !== false,
      previousState,
    })
  }, [browserDismissed, setBrowserStateMap, store])

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
    // 依赖含 activeTabId：同会话内的标签切换（对话 ↔ 预览 ↔ 浏览器）即使不改变
    // browserSessionId，也要重新断言前台所有权——顶栏激活处理器先行写入的所有权
    // 可能有瞬时值，这里作为最终口径兜底纠正。
    const setForeground = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserForeground
    if (typeof setForeground === 'function') setForeground(browserSessionId)

    const previousSessionId = previousBrowserSessionIdRef.current
    if (previousSessionId && previousSessionId !== browserSessionId) {
      // 切换会话时只收起旧会话的原生视图，不销毁其浏览器状态；回到该会话时，
      // 只要用户没有主动关闭浏览器 Tab，就应恢复打开。
      void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(previousSessionId)
    }
    previousBrowserSessionIdRef.current = browserSessionId
  }, [activeTabId, browserSessionId])

  React.useLayoutEffect(() => {
    // 原生 WebContentsView 盖在 DOM 之上。页内新页接管分屏后立即解散时，新页的原生视图
    // 可能已被主进程先行显示，而对应 BrowserViewport 还没来得及挂载并发布可见性，
    // 卸载清理就不会发生，旧网页会盖在已经激活的对话上。当前布局没有任何浏览器页时
    // 同步收起原生视图；分屏仍保留浏览器栏时不动，避免正常分屏闪黑。
    if (!browserSessionId || browserPaneVisible) return
    const hide = (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser
    if (typeof hide === 'function') void hide(browserSessionId)
  }, [browserPaneVisible, browserSessionId])

  React.useEffect(() => {
    // Vite renderer 可在 preload 热重载前先更新；旧 bridge 时浏览器功能不可用，
    // 但绝不能让整个主界面崩溃。完整 Electron preload 就绪后会正常订阅。
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserStateChanged
    if (typeof subscribe !== 'function') return
    return subscribe(handleBrowserStatePush)
  }, [handleBrowserStatePush])

  React.useEffect(() => {
    // 原生网页上的退出浮标由主进程绘制（DOM 盖不住 WebContentsView），点击通过 IPC 回来。
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onSplitViewCloseClicked
    if (typeof subscribe !== 'function') return
    return subscribe(({ sessionId, tabId }) => {
      const topTabId = createBrowserTabId(sessionId, tabId)
      const groups = store.get(tabGroupsAtom)
      const group = findTabGroup(groups, topTabId)
      if (group) store.set(tabGroupsAtom, removeTabGroup(groups, group))
    })
  }, [store])

  React.useEffect(() => {
    if (!browserSessionId) return
    const getState = (window.electronAPI as Partial<typeof window.electronAPI>).getAgentBrowserState
    if (typeof getState !== 'function') return
    let cancelled = false
    void getState(browserSessionId)
      .then((state) => {
        if (!cancelled && state) {
          // 切回会话只恢复浏览器标签，保留用户的组合/解散选择。
          publishBrowserState(state, { autoOpen: !browserDismissed.has(browserSessionId), autoGroup: false })
        }
      })
      // 后台会话及已删除会话会被主进程拒绝或返回空状态；无需打断当前界面。
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [browserDismissed, browserSessionId, publishBrowserState])

  // 文件面板可见性由 usePanelAutoLayout 按主区栏数和窗口宽度统一计算；
  // 组合视图不能回写用户的展开意图，否则会与顶栏打开动作冲突。

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
  const groupContainerRef = React.useRef<HTMLDivElement | null>(null)
  const groupContainerObserverRef = React.useRef<ResizeObserver | null>(null)
  // 分栏像素宽由实测容器宽算出，保证比例与最小宽度约束一致
  const [groupContainerWidth, setGroupContainerWidth] = React.useState(0)
  const groupDragging = React.useRef(false)
  // 分栏缝拖到极限后继续外拖时，被挤压的那一栏：用于显示「继续拖动收起该栏」提示。
  const [collapseHint, setCollapseHint] = React.useState<TabGroupSide | null>(null)
  // 抽屉式收起：closed=false 先让两栏停在原宽度，closed=true 才触发滑出动画，
  // 动画结束后再真正解散组合——避免一帧内整块内容消失。
  const [collapseAnim, setCollapseAnim] = React.useState<{ side: TabGroupSide; closed: boolean } | null>(null)
  const collapseRatioRef = React.useRef(0.5)

  // 分栏容器只在「对话视图」渲染（规划中心 / Agent 技能视图整屏取代 TabBar + 内容），
  // 切回来时是**新节点**。所以观察者必须跟着元素出现/消失挂载，不能写成 [] 依赖的
  // 一次性 useLayoutEffect：那一刻容器不在 DOM 里就永远测不到宽度（groupGeometryReady
  // 恒为 false → 右栏被钉在 CSS 等分，表现为分栏缝能拖、两栏不动）；换成新节点后
  // 观察者还会留在已卸载的旧节点上，窗口缩放/面板让位都不再更新宽度。
  const attachGroupContainer = React.useCallback((element: HTMLDivElement | null): void => {
    groupContainerRef.current = element
    groupContainerObserverRef.current?.disconnect()
    groupContainerObserverRef.current = null
    if (!element) {
      setGroupContainerWidth(0)
      return
    }
    const observer = new ResizeObserver(() => setGroupContainerWidth(element.clientWidth))
    observer.observe(element)
    groupContainerObserverRef.current = observer
    setGroupContainerWidth(element.clientWidth)
  }, [])

  const groupGeometry = resolveGroupSplitGeometry(groupContainerWidth, tabGroupRatio)
  // 虚线投放区与真实两栏都用这一份几何：宽度只由分栏缝拖动决定，拖放落定不改宽度，
  // 所以"拖下来看到的分配虚线"就是落定后的两栏宽度（含空栏的实际比例）。
  // 当前激活标签属于某个组合时才显示该组合；其他组合保持后台状态。
  const groupViewActive = !!tabGroup && (!!leftGroupTab || !!rightGroupTab)
  const leftPaneTabId = groupViewActive ? leftGroupTab?.id ?? null : contentTabId
  // ResizeObserver 首次回调前宽度是 0。此时必须用 CSS 等分兜底，不能把右栏写成 0px；
  // 否则初次合并会只剩一条窄边界，用户也很难命中分隔条。
  const groupGeometryReady = groupContainerWidth > GROUP_SPLIT_GAP
  // 右栏是已挂载原生网页的浏览器 Tab 时，退出按钮由主进程的原生浮标承担；
  // 这里必须隐藏 DOM 按钮，否则网页下方会再露出一个，形成重复。
  const rightBrowserUsesNativePane = rightGroupTab?.type === 'browser'
    && nativeBrowserPaneTabs.has(rightGroupTab.id)
  const rightPaneStyle: React.CSSProperties = {
    width: groupGeometryReady ? groupGeometry.rightWidth : `calc(50% - ${GROUP_SPLIT_GAP / 2}px)`,
    flexShrink: 0,
  }

  // 收起动画：被挤压的一栏用负外边距整体滑出视野（自身宽度不变 → 内容不重排，
  // 像抽屉被推出去），另一栏改回 flex 自适应，跟着滑出同步长满。
  // 分栏缝宽度同时收到 0：收完解散组合时不会因为 8px 中缝消失而跳一下。
  const collapsingSide = collapseAnim?.side ?? null
  const collapseClosed = collapseAnim?.closed ?? false
  const collapseTransition = `margin ${GROUP_COLLAPSE_ANIMATION_MS}ms ${GROUP_COLLAPSE_EASING}`
  const leftPaneStyle: React.CSSProperties = collapsingSide === 'left'
    ? {
        flex: '0 0 auto',
        width: groupGeometry.leftWidth,
        marginLeft: collapseClosed ? -groupGeometry.leftWidth : 0,
        transition: collapseTransition,
      }
    : { flex: '1 1 auto' }
  const collapseRightPaneStyle: React.CSSProperties = {
    flexShrink: 0,
    width: groupGeometry.rightWidth,
    marginRight: collapseClosed ? -groupGeometry.rightWidth : 0,
    transition: collapseTransition,
  }
  const expandingRightPaneStyle: React.CSSProperties = { flex: '1 1 auto', width: 'auto' }

  // 成员被关闭/删除（或组合指向失效标签）时自动解散对应组合。
  React.useEffect(() => {
    // 再叠加「同一会话」边界：跨会话组合（旧持久化或异常状态）直接解散，
    // 顶栏 Tab 属于同一会话，组合只允许同会话成员并排。
    const reconciled = reconcileTabGroups(tabGroups, new Set(tabs.map((tab) => tab.id)))
      .filter((group) => isSessionConsistentGroup(group, tabs))
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

  /** 空栏里选中一个标签（会话或工作 Tab）：放进去并把焦点交给它；跨会话标签一律拒绝 */
  const fillGroupPane = React.useCallback((side: TabGroupSide, tabId: string): void => {
    if (!tabGroup) return
    const filledGroup = fillGroupSide(tabGroup, side, tabId)
    if (!filledGroup || !isSessionConsistentGroup(filledGroup, tabs)) return
    setTabGroups((previous) => replaceTabGroup(previous, tabGroup, filledGroup))
    activateGroupTab(tabId)
  }, [activateGroupTab, setTabGroups, tabGroup, tabs])

  const dissolveGroup = React.useCallback((): void => {
    setTabGroups((previous) => removeTabGroup(previous, tabGroup))
  }, [setTabGroups, tabGroup])

  /**
   * 收起被挤压的一栏：解散组合（**不关闭标签**），另一栏独占整个主区。
   * 被收起的标签仍留在顶栏，随时可以再拖回来组分栏。
   * 宽度记忆回退到本次拖动前的值——收起只是解散分栏，不该把「极限比例」留给下一次分栏。
   */
  const collapseGroupSide = React.useCallback((side: TabGroupSide, ratioBeforeDrag: number): void => {
    if (!tabGroup) return
    const survivingTabId = side === 'left' ? tabGroup.rightTabId : tabGroup.leftTabId
    const squeezedTabId = side === 'left' ? tabGroup.leftTabId : tabGroup.rightTabId
    setTabGroups((previous) => removeTabGroup(previous, tabGroup))
    setTabGroupRatio(clampGroupRatio(ratioBeforeDrag))
    // 被保留的一栏若有内容就聚焦它；只有它是空栏时才回落到被挤压那一栏的标签，
    // 避免解散后留下一整屏空栏占位。
    const nextTabId = survivingTabId ?? squeezedTabId
    if (nextTabId) activateGroupTab(nextTabId)
  }, [activateGroupTab, setTabGroupRatio, setTabGroups, tabGroup])

  // 动画收尾的定时器只依赖 collapseAnim：tabs 在流式输出时会频繁换引用，
  // 如果把它当依赖，定时器会被反复清掉重建，收起就永远落不了地。解散逻辑用 ref 取最新一版。
  const collapseGroupSideRef = React.useRef(collapseGroupSide)
  collapseGroupSideRef.current = collapseGroupSide

  React.useEffect(() => {
    if (!collapseAnim?.closed) return
    const timer = window.setTimeout(() => {
      setCollapseAnim(null)
      collapseGroupSideRef.current(collapseAnim.side, collapseRatioRef.current)
    }, GROUP_COLLAPSE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [collapseAnim])

  // 组合在动画中途被外部解散（关标签/切视图）时立即复位，
  // 避免半截收起样式（固定宽 + 负外边距）落在单栏布局上。
  React.useEffect(() => {
    if (!tabGroup && collapseAnim) setCollapseAnim(null)
  }, [collapseAnim, tabGroup])

  const handleGroupDragStart = React.useCallback((e: React.MouseEvent): void => {
    const container = groupContainerRef.current
    if (!container) return
    // 收起动画进行中不再开启新一轮拖动：此时两栏宽度在动画里，拖拽几何会错位。
    if (collapseAnim) return
    e.preventDefault()
    groupDragging.current = true
    const rect = container.getBoundingClientRect()
    // 收起后要还原的宽度记忆：拖动过程中比例会被 clamp 到极限，不能拿极限值当记忆。
    const ratioBeforeDrag = tabGroupRatio
    let collapsed = false
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = 'none' })

    const stopDragging = (): void => {
      groupDragging.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((frame) => { (frame as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    const onMouseMove = (moveEvent: MouseEvent): void => {
      if (collapsed) return
      const pointerX = moveEvent.clientX - rect.left
      // 分栏缝到极限后不再移动，继续外拖的这段距离判定为「收起被挤压的一栏」。
      // 先给提示，越过阈值立即收起（不等松手，符合“再拖一点就独占”的直觉）。
      const intent = resolveGroupCollapseIntent({ containerWidth: rect.width, pointerX })
      setCollapseHint(intent ? intent.side : null)
      if (intent?.ready) {
        collapsed = true
        setCollapseHint(null)
        stopDragging()
        // 原生网页视图不受 CSS overflow 裁切：滑出时会画到侧栏上面，
        // 所以含原生 pane 的浏览器栏位不做滑动，直接切布局（与之前的观感一致）。
        const squeezedTab = intent.side === 'left' ? leftGroupTab : rightGroupTab
        const squeezedUsesNativePane = squeezedTab?.type === 'browser'
          && nativeBrowserPaneTabs.has(squeezedTab.id)
        if (squeezedUsesNativePane) {
          collapseGroupSide(intent.side, ratioBeforeDrag)
          return
        }
        collapseRatioRef.current = ratioBeforeDrag
        // 抽屉式收起：先把被挤压的一栏滑出视野，动画结束再真正解散组合。
        setCollapseAnim({ side: intent.side, closed: false })
        // 双 rAF：先让「未收起」这一帧真正上屏，transition 才有起点，否则会直接跳到位。
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setCollapseAnim((previous) => (previous ? { ...previous, closed: true } : previous))
          })
        })
        return
      }
      const available = Math.max(1, rect.width - GROUP_SPLIT_GAP)
      // 指针位置代表**左栏**占比，而 tabGroupRatio 存的是右栏占比，取补。
      const pointerFraction = (pointerX - GROUP_SPLIT_GAP / 2) / available
      setTabGroupRatio(resolveGroupSplitGeometry(rect.width, 1 - pointerFraction).ratio)
    }
    const onMouseUp = (): void => {
      setCollapseHint(null)
      stopDragging()
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [collapseAnim, collapseGroupSide, leftGroupTab, nativeBrowserPaneTabs, rightGroupTab, setTabGroupRatio, tabGroupRatio])

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

  // 对话区表面必须显式上色（bg-content-area）：皮肤把 --content-area 定义为「比侧栏浅」
  // 的内容区色，缺这层底色时面板会透出外层 .shell-bg 缝隙渐变（比侧栏更深），
  // 云朵舞者等浅色皮肤就会呈现「侧栏与对话区颜色颠倒」。
  return (
    <div className="relative flex h-full min-w-0">
      <Panel
        variant="grow"
        className="main-content-panel relative rounded-2xl bg-content-area shadow-xl dark:shadow-sm"
      >
        {/* 通用兜底宿主：凡是 TabBar 不持有窗口按钮的分支（定时任务表单、无 Tab
            空态、以及所有全屏视图）都必须能提供按钮；页面自己声明的宿主
            priority 更高时会自动接管（planning / agent-skills / agent-memory 均为 20）。
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
        ) : activeView === 'agent-memory' ? (
          // Agent 记忆视图：同样全屏取代 TabBar + TabContent
          <AgentMemoryView />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 顶栏横跨整个主区：组合分屏时两侧顶栏共用同一条基线。 */}
            <TabBar />
            <div className="relative flex flex-1 min-h-0 overflow-hidden" data-split-container>
              {/* 内容区：TabContent（单栏）+ 可选的组合右栏。
                  始终保持在同一 DOM 位置，避免 Tab 切换时 unmount。
                  注：左右区域宽度变化不用 transition——文字逐帧 reflow 会导致行末字符抖动，
                  视觉上像"内容从右向左推送"。唯一例外是拖到极限后的抽屉式收起：
                  那是一次性 300ms 的滑出动画（不是用户逐帧控宽），结束即解散组合。 */}
              {/* data-group-drop-split = 真实分界线（相对区域左缘的 px）：TabBar 判定左右落点
                  必须用它，不能用容器中点——比例被拖过、或空栏只占 1/3 时中点与实际分界不符。 */}
              <div
                ref={attachGroupContainer}
                data-group-drop-region="true"
                data-group-drop-split={groupGeometryReady ? Math.round(groupGeometry.leftWidth + GROUP_SPLIT_GAP / 2) : undefined}
                className={cn('flex h-full min-w-0 relative', collapsingSide && 'overflow-hidden')}
                style={{ flex: '1 1 auto' }}
              >
                {/* 左栏：组合激活时是组内左成员，否则是当前标签 */}
                <div
                  data-group-drop-left-pane="true"
                  className="flex flex-col min-w-0 h-full relative"
                  style={leftPaneStyle}
                  onPointerDownCapture={() => focusGroupSide('left')}
                >
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
                      sessionId={groupSessionId(tabGroup, tabs)}
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
                      style={collapsingSide
                        ? {
                            width: collapseClosed ? 0 : GROUP_SPLIT_GAP,
                            opacity: collapseClosed ? 0 : 1,
                            transition: `width ${GROUP_COLLAPSE_ANIMATION_MS}ms ${GROUP_COLLAPSE_EASING}, opacity ${GROUP_COLLAPSE_ANIMATION_MS}ms linear`,
                          }
                        : undefined}
                    />
                    <div
                      data-group-drop-right-pane="true"
                      // 浏览器/预览直接把退出浮标叠在内容右下角；只有 Agent/Chat 的右栏
                      // 需要为 composer 让出 32px，避免浮标压住发送按钮。原生网页的浮标
                      // 由主进程额外绘制，DOM 按钮会被原生视图盖住，这是预期分层。
                      className={cn(
                        'flex flex-col min-w-0 h-full relative',
                        (rightGroupTab?.type === 'agent' || rightGroupTab?.type === 'chat') && 'pb-8',
                      )}
                      style={collapsingSide === 'right'
                        ? collapseRightPaneStyle
                        : collapsingSide === 'left'
                          ? expandingRightPaneStyle
                          : rightPaneStyle}
                      onPointerDownCapture={() => focusGroupSide('right')}
                    >
                      {rightGroupTab ? (
                        <div className="flex-1 min-h-0 titlebar-no-drag">
                          <TabContent tabId={rightGroupTab.id} />
                        </div>
                      ) : (
                        <EmptyPanePlaceholder
                          excludeTabIds={groupTabIds(tabGroup)}
                          sessionId={groupSessionId(tabGroup, tabs)}
                          onPick={(tabId) => fillGroupPane('right', tabId)}
                          onDissolve={dissolveGroup}
                        />
                      )}
                    </div>
                  </>
                )}

                {/* 收起提示：分栏缝拖到极限后继续外拖时，被挤压的一栏上盖一层遮罩并给出
                    “继续拖动收起该栏”的提示；越过阈值即自动收起（不等松手）。
                    遮罩只负责视觉（pointer-events-none），不参与拖拽命中。 */}
                {collapseHint && (
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-y-0 z-20 flex items-center justify-center bg-background/60',
                      collapseHint === 'left' ? 'left-0' : 'right-0',
                    )}
                    style={{
                      width: groupGeometryReady
                        ? (collapseHint === 'left' ? groupGeometry.leftWidth : groupGeometry.rightWidth)
                        : `calc(50% - ${GROUP_SPLIT_GAP / 2}px)`,
                    }}
                  >
                    <span className="rounded-full border border-border/60 bg-background/90 px-3 py-1 text-[11px] text-muted-foreground shadow-sm">
                      继续拖动，收起{collapseHint === 'left' ? '左' : '右'}栏
                    </span>
                  </div>
                )}

                {/* 拆分视图退出浮标：贴在右栏右下角，点击解散组合（两个标签都保留）。
                    原生网页有主进程绘制的同款浮标，这里让位，避免出现两个。 */}
                {groupViewActive && tabGroup && !rightBrowserUsesNativePane && !collapsingSide && (
                  <SplitViewCloseButton onClose={dissolveGroup} />
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
