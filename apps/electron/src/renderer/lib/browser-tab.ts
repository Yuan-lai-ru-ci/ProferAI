/**
 * Browser Tab — 受管浏览器的顶栏 Tab 化入口
 *
 * 浏览器内部标签（每个网页）与顶栏 Tab 一一对应：`__browser__:${sessionId}:${tabId}`。
 * - reconcile：以主进程推送的 BrowserViewState 为准，增删/改标题同步顶栏 Tab；
 *   主进程会话销毁（state.tabs 为空）时该会话全部浏览器 Tab 消失。
 * - Agent 的真实网页始终有独立页签；页签同步与焦点、分屏互不绑定。
 * - 用户点击已有可见页的新窗口链接时，新页可沿用原栏；关闭页签关闭实际网页。
 */

import { getDefaultStore, useStore } from 'jotai'
import {
  activeTabIdAtom,
  createBrowserTabId,
  closeTab,
  tabMruAtom,
  isBrowserTab,
  openTab,
  tabsAtom,
  type TabItem,
} from '@/atoms/tab-atoms'
import { findTabGroup, groupTabIds, planReplaceGroupMember, tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom, type ActiveView } from '@/atoms/active-view'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import type { BrowserViewState } from '@profer/shared'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

/**
 * 浏览器 Tab 同步（纯函数）：按主进程状态增删顶栏 Tab、同步标题。
 *
 * @returns 同步后的 tabs（无变化时返回原数组引用）
 */
export function planBrowserTabReconcile(
  tabs: readonly TabItem[],
  sessionId: string,
  state: BrowserViewState,
): TabItem[] {
  const desired = new Map(state.tabs.map((tab) => [createBrowserTabId(sessionId, tab.tabId), tab]))
  let next = tabs.filter((tab) => {
    if (!isBrowserTab(tab) || tab.sessionId !== sessionId) return true
    return !!tab.browserTabId && desired.has(tab.id)
  })
  let changed = next.length !== tabs.length

  const existingIds = new Set(next.map((tab) => tab.id))
  for (const page of state.tabs) {
    const topId = createBrowserTabId(sessionId, page.tabId)
    const title = page.title || '新建标签页'
    if (existingIds.has(topId)) {
      const current = next.find((tab) => tab.id === topId)
      if (current && current.title !== title) {
        next = next.map((tab) => (tab.id === topId ? { ...tab, title } : tab))
        changed = true
      }
      continue
    }
    next = openTab(next, {
      type: 'browser',
      sessionId,
      title,
      browserTabId: page.tabId,
    }).tabs
    changed = true
  }
  return changed ? next : (tabs as TabItem[])
}

function reconcileBrowserTabs(store: JotaiStore, state: BrowserViewState): void {
  const tabs = store.get(tabsAtom)
  const next = planBrowserTabReconcile(tabs, state.sessionId, state)
  if (next === tabs) return
  store.set(tabsAtom, next)
  const activeId = store.get(activeTabIdAtom)
  const removed = tabs.find(tab => tab.id === activeId && isBrowserTab(tab) && tab.sessionId === state.sessionId)
  if (removed && !next.some(tab => tab.id === activeId)) {
    // 正在看的页被关闭时不能留一个悬空的 activeId；优先回到用户原本看到的另一栏。
    const otherPane = groupTabIds(findTabGroup(store.get(tabGroupsAtom), activeId)).find(id => next.some(tab => tab.id === id))
    const fallback = otherPane ?? next.find(tab => tab.id === state.sessionId)?.id
      ?? closeTab([...next, removed], activeId, removed.id, store.get(tabMruAtom)).activeTabId
    store.set(activeTabIdAtom, fallback)
  }
}

/**
 * 浏览器页内打开新页（target=_blank / 新建标签）时，让新页接管原来的分屏栏。
 *
 * 主进程会新建并激活内部页；顶栏对应会多出一个页签。如果不跟随，原顶栏页会变成
 * “激活此页面”占位，用户点了链接反而看不到新页面。这里只在“新页确实是旧状态里
 * 没有的页”时触发；用户切到已有页仍走顶栏 Tab 的正常语义。
 */
function followReplacedBrowserPage(
  store: JotaiStore,
  state: BrowserViewState,
  previousState: BrowserViewState | null,
): void {
  if (!previousState || previousState.sessionId !== state.sessionId) return
  if (!previousState.activeTabId || !state.activeTabId) return
  if (previousState.activeTabId === state.activeTabId) return
  if (previousState.tabs.some((tab) => tab.tabId === state.activeTabId)) return

  const previousTopTabId = createBrowserTabId(state.sessionId, previousState.activeTabId)
  const nextTopTabId = createBrowserTabId(state.sessionId, state.activeTabId)
  const tabs = store.get(tabsAtom)
  // 原页/新页任一不在顶栏（用户已关闭，或 reconcile 尚未落定）时不改布局。
  if (!tabs.some((tab) => tab.id === previousTopTabId) || !tabs.some((tab) => tab.id === nextTopTabId)) return

  const groups = store.get(tabGroupsAtom)
  const activeTabId = store.get(activeTabIdAtom)
  const plan = planReplaceGroupMember({ groups, previousTabId: previousTopTabId, nextTabId: nextTopTabId, activeTabId })
  if (!plan) return
  if (plan.groups !== groups) store.set(tabGroupsAtom, plan.groups)
  if (plan.activeTabId !== activeTabId) store.set(activeTabIdAtom, plan.activeTabId)
}

/** 只有当前可见的用户页内新窗口链接可以接管原栏；Agent 新页只新增顶栏页签。 */
function shouldFollowNewDisplayPage(store: JotaiStore, state: BrowserViewState, previousState: BrowserViewState | null): boolean {
  if (!previousState || previousState.sessionId !== state.sessionId) return false
  if (!previousState.activeTabId || previousState.activeTabId === state.activeTabId) return false
  if (previousState.tabs.some((tab) => tab.tabId === state.activeTabId)) return false
  const newPage = state.tabs.find((tab) => tab.tabId === state.activeTabId)
  if (!newPage || newPage.openedByAgent) return false
  const previousTopId = createBrowserTabId(state.sessionId, previousState.activeTabId)
  if (!store.get(tabsAtom).some((tab) => tab.id === previousTopId)) return false
  const activeTabId = store.get(activeTabIdAtom)
  return activeTabId === previousTopId
    || groupTabIds(findTabGroup(store.get(tabGroupsAtom), activeTabId)).includes(previousTopId)
}

/** 所有实际页面（含其他会话的页面）都可在顶栏找到；新增页签不等于选中或分屏。 */
export function openBrowserTabFromPush(
  state: BrowserViewState,
  previousState: BrowserViewState | null = null,
): void {
  const store = getDefaultStore()
  const followUserLink = store.get(appModeAtom) === 'agent' && store.get(activeViewAtom) === 'conversations'
    && state.sessionId === store.get(currentAgentSessionIdAtom) && shouldFollowNewDisplayPage(store, state, previousState)
  reconcileBrowserTabs(store, state)
  if (followUserLink) followReplacedBrowserPage(store, state, previousState)
}

/** 用户动作发起时的界面位置；异步结果不能将用户从后来切换到的界面拉回。 */
export interface BrowserOpenIntent {
  activeTabId: string | null
  activeView: ActiveView
  sourceTabId?: string
}

export function captureBrowserOpenIntent(sessionId: string, sourcePageId?: string): BrowserOpenIntent {
  const store = getDefaultStore()
  return {
    activeTabId: store.get(activeTabIdAtom),
    activeView: store.get(activeViewAtom),
    sourceTabId: sourcePageId ? createBrowserTabId(sessionId, sourcePageId) : undefined,
  }
}

/** 手动打开/聚焦页面，保留同栏分屏；必须校验发起意图，拒绝过期的异步唤起。 */
export function openBrowserTabManually(sessionId: string, state: BrowserViewState, browserTabId: string | undefined, intent: BrowserOpenIntent): void {
  const store = getDefaultStore()
  const targetPageId = browserTabId ?? state.activeTabId
  if (!state.tabs.some((page) => page.tabId === targetPageId)) return
  const topTabId = createBrowserTabId(sessionId, targetPageId)
  const currentActiveId = store.get(activeTabIdAtom)
  const currentGroup = findTabGroup(store.get(tabGroupsAtom), currentActiveId)
  const visibleIds = new Set([currentActiveId, ...groupTabIds(currentGroup)])
  // open/create/select 均先推送页签，再返回结果。旧回包不能重建已关闭的页面。
  if (!store.get(tabsAtom).some(tab => tab.id === topTabId)) return
  if (store.get(appModeAtom) !== 'agent' || store.get(currentAgentSessionIdAtom) !== sessionId
    || store.get(activeViewAtom) !== intent.activeView || intent.activeView !== 'conversations') return
  // 实时推送可能已先将同一用户动作的新页接管到原栏；不把正常接管误判成过期。
  const alreadyVisible = visibleIds.has(topTabId)
  if (!alreadyVisible && (currentActiveId !== intent.activeTabId || (intent.sourceTabId && !visibleIds.has(intent.sourceTabId)))) return
  if (intent.sourceTabId && intent.sourceTabId !== topTabId) {
    const groups = store.get(tabGroupsAtom)
    const plan = planReplaceGroupMember({ groups, previousTabId: intent.sourceTabId, nextTabId: topTabId, activeTabId: currentActiveId })
    if (plan) {
      if (plan.groups !== groups) store.set(tabGroupsAtom, plan.groups)
      if (plan.activeTabId !== currentActiveId) store.set(activeTabIdAtom, plan.activeTabId)
      return
    }
  }
  if (!visibleIds.has(topTabId)) store.set(activeTabIdAtom, topTabId)
}
