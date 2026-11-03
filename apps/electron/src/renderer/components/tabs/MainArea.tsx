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
import { browserNativePaneTabIdsAtom, browserPanelDismissedSessionIdsAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { openBrowserTabFromPush } from '@/lib/browser-tab'
import { isBrowserTab } from '@/atoms/tab-atoms'
import { shouldAutoOpenBrowserFromPush } from '@/lib/browser-auto-open'
import type { BrowserViewState } from '@profer/shared'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
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
  type GroupCollapseIntent,
  type TabGroupSide,
} from '@/atoms/tab-group-atoms'

/**
 * 全屏视图与欢迎页按需加载。
 *
 * 它们都不是首屏（规划中心 / 技能 / 记忆 / 定时任务表单 / 无 Tab 时的欢迎页），
 * 静态 import 会把整棵子树（含 CalendarWorkspace、AgentPresetSettings 等）钉进入口 chunk。
 * 切成动态 import 后，只有真的切到那个视图才会拉对应块；本地磁盘下通常一帧内完成。
 */
const WelcomeView = React.lazy(() =>
  import('@/components/welcome/WelcomeView').then((module) => ({ default: module.WelcomeView })),
)
const AutomationFormView = React.lazy(() =>
  import('@/components/automation/AutomationFormView').then((module) => ({ default: module.AutomationFormView })),
)
const PlanningView = React.lazy(() =>
  import('@/components/planning/PlanningView').then((module) => ({ default: module.PlanningView })),
)
const AgentSkillsView = React.lazy(() =>
  import('@/components/agent-skills/AgentSkillsView').then((module) => ({ default: module.AgentSkillsView })),
)
const AgentMemoryView = React.lazy(() =>
  import('@/components/agent-skills/AgentMemoryView').then((module) => ({ default: module.AgentMemoryView })),
)

/** 懒加载视图的占位：与内容区同色、无文字，避免出现“加载中”闪烁。 */
const LAZY_VIEW_FALLBACK = <div className="h-full w-full bg-content-area" />

/**
 * 收起手势：被挤压的一栏像抽屉一样跟着指针滑出（1:1 跟手），松手才落定。
 * 滑出一半（50%）就“吸进去”：剩下的路程自动补完，松手即收起；
 * 没到一半就松手则回弹回原宽（不收起）。
 */
const GROUP_COLLAPSE_RELEASE_MS = 200
/** 滑出到整栏宽的多少比例时磁吸收起 */
const GROUP_COLLAPSE_SNAP_PROGRESS = 0.5
/** 磁吸/回弹的过渡时长（1:1 跟手的拖动段不用 transition） */
const GROUP_COLLAPSE_SNAP_MS = 160
const GROUP_COLLAPSE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

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
  // 收起手势进行中：progress 0..1 = 被挤压的一栏滑出了多少（跟随指针，可逆）。
  // 松手时 progress 满 1 才真正收起；没拉到底则回弹（releasing）。
  const [collapseSlide, setCollapseSlide] = React.useState<{
    side: TabGroupSide
    progress: number
    /** 滑出一半后磁吸到完全收起（视觉上整栏消失） */
    snapped: boolean
    releasing: boolean
  } | null>(null)
  // 上一帧是否处于磁吸态：跨越阈值那一帧要启用过渡，其余帧保持 1:1 跟手。
  const slideWasSnappedRef = React.useRef(false)
  // 收起左栏后，让原本在右栏的标签**留在右栏容器里**（右栏铺满），而不是把子树搬到左栏容器。
  // 跨父节点搬动会让预览/浏览器整棵重挂载：Tiptap 重建、滚动位置丢失、原生视图重建，
  // 表现就是收完闪一下白。这里记住「单栏由右栏承担」的那个标签，切标签/重新分栏即复位。
  const [singlePaneTabId, setSinglePaneTabId] = React.useState<string | null>(null)

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
  // 拖拽监听是原生 document 监听，拿不到每次 render 的最新几何，用 ref 传递：
  // 收起手势要按“当前栏宽”算滑出量，才能与指针 1:1。
  const groupGeometryRef = React.useRef(groupGeometry)
  groupGeometryRef.current = groupGeometry
  // 虚线投放区与真实两栏都用这一份几何：宽度只由分栏缝拖动决定，拖放落定不改宽度，
  // 所以"拖下来看到的分配虚线"就是落定后的两栏宽度（含空栏的实际比例）。
  // 当前激活标签属于某个组合时才显示该组合；其他组合保持后台状态。
  const groupViewActive = !!tabGroup && (!!leftGroupTab || !!rightGroupTab)
  // 组合已解散、且激活标签正是刚留在右栏的那个 → 单栏由右栏容器承担（不搬 DOM）。
  const singlePaneActive = !tabGroup && !automationFormOpen && !!contentTabId && contentTabId === singlePaneTabId
  const singlePaneTab = React.useMemo(
    () => (singlePaneActive ? tabs.find((tab) => tab.id === singlePaneTabId) ?? null : null),
    [singlePaneActive, singlePaneTabId, tabs],
  )
  const leftPaneTabId = groupViewActive
    ? leftGroupTab?.id ?? null
    : singlePaneActive
      ? null
      : contentTabId
  // 右栏内容：组合时是右成员；单栏右置时是刚收起左栏后留下的标签（同一个 TabContent 位置）。
  const rightPaneTab = rightGroupTab ?? singlePaneTab
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

  // 收起手势：被挤压的一栏用负外边距整体滑出视野（自身宽度不变 → 内容不重排，
  // 像抽屉被推出去），滑出量直接跟随指针越界距离，往回拖就原路滑回；
  // 另一栏同时改回 flex 自适应，跟着滑出同步长满。分栏缝宽度一起收到 0，
  // 收完解散组合时不会因为 8px 中缝消失而跳一下。
  // 原生网页视图不受 CSS overflow 裁切（滑出会画到侧栏上面），这类栏位不做滑动，
  // 只记录进度；滑出一半就磁吸收起，没到一半松手则回弹。
  const slideTab = collapseSlide
    ? (collapseSlide.side === 'left' ? leftGroupTab : rightGroupTab)
    : null
  const slideBlockedByNativePane = !!slideTab
    && slideTab.type === 'browser'
    && nativeBrowserPaneTabs.has(slideTab.id)
  const slide = collapseSlide && !slideBlockedByNativePane ? collapseSlide : null
  const slideSnapped = slide?.snapped ?? false
  const slideWasSnapped = slideWasSnappedRef.current
  // 用 effect 同步「上一帧是否磁吸」：StrictMode 下 render 会跑两遍，
  // 在 render 里直接赋值会让第二遍读到新值，丢掉磁吸/回弹那一帧的过渡。
  React.useEffect(() => {
    slideWasSnappedRef.current = slideSnapped
  }, [slideSnapped])
  // 磁吸态直接按“完全滑出”渲染；磁吸/回弹那一帧带过渡，其余帧跟手不动画。
  const slideProgress = slide ? (slideSnapped ? 1 : slide.progress) : 0
  const slideAnimated = slideSnapped || slideWasSnapped || !!slide?.releasing
  const slideDuration = slide?.releasing ? GROUP_COLLAPSE_RELEASE_MS : GROUP_COLLAPSE_SNAP_MS
  const slideTransition = slideAnimated
    ? `margin ${slideDuration}ms ${GROUP_COLLAPSE_EASING}`
    : undefined
  const leftPaneStyle: React.CSSProperties = slide?.side === 'left'
    ? {
        flex: '0 0 auto',
        width: groupGeometry.leftWidth,
        marginLeft: -(slideProgress * groupGeometry.leftWidth),
        transition: slideTransition,
      }
    : { flex: '1 1 auto' }
  const collapseRightPaneStyle: React.CSSProperties = {
    flexShrink: 0,
    width: groupGeometry.rightWidth,
    marginRight: -(slideProgress * groupGeometry.rightWidth),
    transition: slideTransition,
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
    // 焦点在右栏时让右栏原地变单栏：解散不该把预览子树搬到左栏重挂载（会闪一下）。
    setSinglePaneTabId(tabGroup?.rightTabId && activeTabId === tabGroup.rightTabId ? tabGroup.rightTabId : null)
    setTabGroups((previous) => removeTabGroup(previous, tabGroup))
  }, [activeTabId, setTabGroups, tabGroup])

  /**
   * 收起被挤压的一栏：解散组合（**不关闭标签**），另一栏独占整个主区。
   * 被收起的标签仍留在顶栏，随时可以再拖回来组分栏。
   * 宽度记忆回退到本次拖动前的值——收起只是解散分栏，不该把「极限比例」留给下一次分栏。
   */
  const collapseGroupSide = React.useCallback((side: TabGroupSide, ratioBeforeDrag: number): void => {
    if (!tabGroup) return
    const survivingTabId = side === 'left' ? tabGroup.rightTabId : tabGroup.leftTabId
    const squeezedTabId = side === 'left' ? tabGroup.leftTabId : tabGroup.rightTabId
    // 左栏被收起、且右栏有内容：让右栏原地铺满，标签不搬去左栏 → 预览/浏览器不重建。
    setSinglePaneTabId(side === 'left' ? survivingTabId : null)
    setTabGroups((previous) => removeTabGroup(previous, tabGroup))
    setTabGroupRatio(clampGroupRatio(ratioBeforeDrag))
    // 被保留的一栏若有内容就聚焦它；只有它是空栏时才回落到被挤压那一栏的标签，
    // 避免解散后留下一整屏空栏占位。
    const nextTabId = survivingTabId ?? squeezedTabId
    if (nextTabId) activateGroupTab(nextTabId)
  }, [activateGroupTab, setTabGroupRatio, setTabGroups, tabGroup])

  // 组合在拖动中途被外部解散（关标签/切视图）时立即复位，
  // 避免半截滑出样式（固定宽 + 负外边距）落在单栏布局上。
  React.useEffect(() => {
    if (!tabGroup && collapseSlide) setCollapseSlide(null)
  }, [collapseSlide, tabGroup])

  // 「单栏右置」只在刚收起左栏这一种情形下成立：切标签、重新分栏、
  // 打开自动化表单或标签被关空时都复位到常规左栏布局。
  React.useEffect(() => {
    if (!singlePaneTabId) return
    if (!tabGroup && !automationFormOpen && contentTabId === singlePaneTabId) return
    setSinglePaneTabId(null)
  }, [automationFormOpen, contentTabId, singlePaneTabId, tabGroup])

  const handleGroupDragStart = React.useCallback((e: React.MouseEvent): void => {
    const container = groupContainerRef.current
    if (!container) return
    // 回弹动画还没结束时不再开启新一轮拖动：两栏宽度正在动画里，拖拽几何会错位。
    if (collapseSlide?.releasing) return
    e.preventDefault()
    groupDragging.current = true
    const rect = container.getBoundingClientRect()
    // 收起后要还原的宽度记忆：拖动过程中比例会被 clamp 到极限，不能拿极限值当记忆。
    const ratioBeforeDrag = tabGroupRatio
    // 本次拖动内的收起进度：滑出量与指针 1:1；越过一半就磁吸到完全滑出，松手才真正收起。
    let slide: GroupCollapseIntent | null = null
    let releaseTimer = 0
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
      window.removeEventListener('blur', onWindowBlur)
      if (releaseTimer) {
        window.clearTimeout(releaseTimer)
        releaseTimer = 0
      }
    }
    const onMouseMove = (moveEvent: MouseEvent): void => {
      const pointerX = moveEvent.clientX - rect.left
      // 分栏缝到极限后不再移动，继续外拖的这段距离就是收起行程：
      // 滑出量与指针 1:1（可逆）；越过一半磁吸到完全滑出，松手之前都只是预览。
      const geometry = groupGeometryRef.current
      const intent = resolveGroupCollapseIntent({
        containerWidth: rect.width,
        pointerX,
        leftPaneWidth: geometry.leftWidth,
        rightPaneWidth: geometry.rightWidth,
      })
      if (intent) {
        slide = intent
        setCollapseSlide({
          side: intent.side,
          progress: intent.progress,
          snapped: intent.progress >= GROUP_COLLAPSE_SNAP_PROGRESS,
          releasing: false,
        })
        return
      }
      // 拉回极限以内：栏位原路滑回，恢复常规拖宽。
      if (slide) {
        slide = null
        setCollapseSlide(null)
      }
      const available = Math.max(1, rect.width - GROUP_SPLIT_GAP)
      // 指针位置代表**左栏**占比，而 tabGroupRatio 存的是右栏占比，取补。
      const pointerFraction = (pointerX - GROUP_SPLIT_GAP / 2) / available
      setTabGroupRatio(resolveGroupSplitGeometry(rect.width, 1 - pointerFraction).ratio)
    }
    const onMouseUp = (): void => {
      stopDragging()
      if (slide) {
        // 原生网页视图不参与滑动（不受 CSS 裁切），没有视觉反馈，
        // 按 1/4 栏宽判定即可；普通栏位越过一半（磁吸点）就算收起。
        const squeezedTab = slide.side === 'left' ? leftGroupTab : rightGroupTab
        const squeezedIsNativeBrowser = !!squeezedTab
          && squeezedTab.type === 'browser'
          && nativeBrowserPaneTabs.has(squeezedTab.id)
        const ready = squeezedIsNativeBrowser
          ? slide.slide >= slide.paneWidth * 0.25
          : slide.progress >= GROUP_COLLAPSE_SNAP_PROGRESS
        if (ready) {
          // 越过一半就落定：解散组合，另一栏独占。此时栏位已被磁吸到完全滑出，没有跳变。
          setCollapseSlide(null)
          collapseGroupSide(slide.side, ratioBeforeDrag)
          return
        }
        if (slide.progress > 0) {
          // 没到一半：回弹到原宽（不收起），动画结束后恢复正常拖拽样式。
          setCollapseSlide({ side: slide.side, progress: 0, snapped: false, releasing: true })
          releaseTimer = window.setTimeout(() => setCollapseSlide(null), GROUP_COLLAPSE_RELEASE_MS + 40)
          return
        }
      }
      setCollapseSlide(null)
    }
    const onWindowBlur = (): void => {
      // 失焦 = 放弃本次拖动：栏位归位、组合保持原样。
      stopDragging()
      setCollapseSlide(null)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    // 指针在窗口外松开时拿不到 mouseup：失焦就当作取消拖动，
    // 否则栏位会停在滑出状态、组合也一直不落定。
    window.addEventListener('blur', onWindowBlur)
  }, [collapseGroupSide, collapseSlide?.releasing, leftGroupTab, nativeBrowserPaneTabs, rightGroupTab, setTabGroupRatio, tabGroupRatio])

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
            <React.Suspense fallback={LAZY_VIEW_FALLBACK}>
              <AutomationFormView />
            </React.Suspense>
          ) : (
            // 规划中心视图（Task · 日历 · 定时任务）全屏取代 TabBar + TabContent
            <React.Suspense fallback={LAZY_VIEW_FALLBACK}>
              <PlanningView />
            </React.Suspense>
          )
        ) : activeView === 'agent-skills' ? (
          // Agent 技能视图：全屏取代 TabBar + TabContent
          <React.Suspense fallback={LAZY_VIEW_FALLBACK}>
            <AgentSkillsView />
          </React.Suspense>
        ) : activeView === 'agent-memory' ? (
          // Agent 记忆视图：同样全屏取代 TabBar + TabContent
          <React.Suspense fallback={LAZY_VIEW_FALLBACK}>
            <AgentMemoryView />
          </React.Suspense>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 顶栏横跨整个主区：组合分屏时两侧顶栏共用同一条基线。 */}
            <TabBar />
            <div className="relative flex flex-1 min-h-0 overflow-hidden" data-split-container>
              {/* 内容区：TabContent（单栏）+ 可选的组合右栏。
                  始终保持在同一 DOM 位置，避免 Tab 切换时 unmount。
                  注：左右区域宽度变化不用 transition——文字逐帧 reflow 会导致行末字符抖动，
                  视觉上像"内容从右向左推送"。唯一例外是拖到极限后的抽屉式收起：
                  那一段的滑出量跟随指针（可逆，不重排内容），越过一半磁吸收起、松手才解散组合。 */}
              {/* data-group-drop-split = 真实分界线（相对区域左缘的 px）：TabBar 判定左右落点
                  必须用它，不能用容器中点——比例被拖过、或空栏只占 1/3 时中点与实际分界不符。 */}
              <div
                ref={attachGroupContainer}
                data-group-drop-region="true"
                data-group-drop-split={groupGeometryReady ? Math.round(groupGeometry.leftWidth + GROUP_SPLIT_GAP / 2) : undefined}
                className={cn('flex h-full min-w-0 relative', slide && 'overflow-hidden')}
                style={{ flex: '1 1 auto' }}
              >
                {/* 左栏：组合激活时是组内左成员，否则是当前标签 */}
                <div
                  data-group-drop-left-pane="true"
                  className="flex flex-col min-w-0 h-full relative"
                  // 单栏右置时左栏完全隐藏：内容已由右栏承担，不能留一条空栏占位。
                  style={singlePaneActive ? { display: 'none' } : leftPaneStyle}
                  onPointerDownCapture={() => focusGroupSide('left')}
                >
                  {automationFormOpen ? (
                    // 兼容从会话内入口打开任务设置的场景。
                    <React.Suspense fallback={LAZY_VIEW_FALLBACK}>
                      <AutomationFormView />
                    </React.Suspense>
                  ) : tabs.length === 0 ? (
                    <React.Suspense fallback={LAZY_VIEW_FALLBACK}>
                      <WelcomeView />
                    </React.Suspense>
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

                {/* 右栏：组合内的右侧成员；可以是空栏（等用户选择）。
                    收起左栏后它还会继续承担单栏（singlePaneActive）：同一个 TabContent 原地保留，
                    不把预览/浏览器子树搬到左栏容器，避免重建导致的闪白与滚动位置丢失。 */}
                {((groupViewActive && tabGroup) || singlePaneActive) && (
                  <>
                    {groupViewActive && tabGroup && (
                      <div
                        className="panel-resize-handle-x titlebar-no-drag"
                        onMouseDown={handleGroupDragStart}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="调整组合内两栏宽度"
                        style={slide
                          ? {
                              width: GROUP_SPLIT_GAP * (1 - slideProgress),
                              opacity: 1 - slideProgress,
                              transition: slideAnimated
                                ? `width ${slideDuration}ms ${GROUP_COLLAPSE_EASING}, opacity ${slideDuration}ms linear`
                                : undefined,
                            }
                          : undefined}
                      />
                    )}
                    <div
                      data-group-drop-right-pane="true"
                      // 浏览器/预览直接把退出浮标叠在内容右下角；只有 Agent/Chat 的右栏
                      // 需要为 composer 让出 32px，避免浮标压住发送按钮。原生网页的浮标
                      // 由主进程额外绘制，DOM 按钮会被原生视图盖住，这是预期分层。
                      // 单栏右置不是“右栏”，不需要给浮标让位。
                      className={cn(
                        'flex flex-col min-w-0 h-full relative',
                        groupViewActive
                          && (rightPaneTab?.type === 'agent' || rightPaneTab?.type === 'chat')
                          && 'pb-8',
                      )}
                      style={singlePaneActive
                        ? expandingRightPaneStyle
                        : slide?.side === 'right'
                          ? collapseRightPaneStyle
                          : slide?.side === 'left'
                            ? expandingRightPaneStyle
                            : rightPaneStyle}
                      onPointerDownCapture={() => focusGroupSide('right')}
                    >
                      {rightPaneTab ? (
                        <div className="flex-1 min-h-0 titlebar-no-drag">
                          <TabContent tabId={rightPaneTab.id} />
                        </div>
                      ) : tabGroup ? (
                        <EmptyPanePlaceholder
                          excludeTabIds={groupTabIds(tabGroup)}
                          sessionId={groupSessionId(tabGroup, tabs)}
                          onPick={(tabId) => fillGroupPane('right', tabId)}
                          onDissolve={dissolveGroup}
                        />
                      ) : null}
                    </div>
                  </>
                )}

                {/* 拆分视图退出浮标：贴在右栏右下角，点击解散组合（两个标签都保留）。
                    原生网页有主进程绘制的同款浮标，这里让位，避免出现两个。 */}
                {groupViewActive && tabGroup && !rightBrowserUsesNativePane && !slide && (
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
