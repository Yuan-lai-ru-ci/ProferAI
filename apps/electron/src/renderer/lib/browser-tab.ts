/**
 * Browser Tab — 受管浏览器的顶栏 Tab 化入口
 *
 * 浏览器内部标签（每个网页）与顶栏 Tab 一一对应：`__browser__:${sessionId}:${tabId}`。
 * - reconcile：以主进程推送的 BrowserViewState 为准，增删/改标题同步顶栏 Tab；
 *   主进程会话销毁（state.tabs 为空）时该会话全部浏览器 Tab 消失。
 * - 手动打开 = 清除 dismissed 标记 + reconcile + 激活当前页 Tab；
 * - Agent 推送默认只更新已打开页面的标题/关闭状态，不新增页签或改变分屏；
 *   用户可主动打开后台页；已显示页面的新窗口链接仍能接管原 Pane。
 * - 关闭顶栏 Tab = 关闭对应网页（useCloseTab 调 closeAgentBrowserTab）；
 *   用户关掉该会话最后一个浏览器 Tab 时记入 dismissed，推送不再自动重开。
 */

import { getDefaultStore, useStore } from 'jotai'
import {
  activeTabIdAtom,
  createBrowserTabId,
  isBrowserTab,
  openTab,
  tabsAtom,
  type TabItem,
} from '@/atoms/tab-atoms'
import { browserPanelDismissedSessionIdsAtom } from '@/atoms/browser-atoms'
import { findTabGroup, groupTabIds, planAutoGroupWorkTab, planReplaceGroupMember, tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom, type ActiveView } from '@/atoms/active-view'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import type { BrowserViewState } from '@profer/shared'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

/**
 * 浏览器 Tab 同步（纯函数）：按主进程状态增删顶栏 Tab、同步标题。
 *
 * @param dismissed 为 true 时不新增 Tab（用户已手动收掉该会话的浏览器页），
 *                  但仍会移除已不存在的页并同步既有 Tab 标题。
 * @returns 同步后的 tabs（无变化时返回原数组引用）
 */
export function planBrowserTabReconcile(
  tabs: readonly TabItem[],
  sessionId: string,
  state: BrowserViewState,
  dismissed: boolean,
  newTabIds?: ReadonlySet<string>,
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
    if (dismissed || (newTabIds && !newTabIds.has(page.tabId))) continue
    const result = openTab(next, {
      type: 'browser',
      sessionId,
      title,
      browserTabId: page.tabId,
    })
    next = result.tabs
    changed = true
  }
  return changed ? next : (tabs as TabItem[])
}

/** 当前激活页对应的顶栏 Tab id；无激活页时返回 null。 */
export function activeBrowserTopTabId(sessionId: string, state: BrowserViewState): string | null {
  return state.activeTabId ? createBrowserTabId(sessionId, state.activeTabId) : null
}

/**
 * 按浏览器状态推送同步顶栏 Tab（所有推送路径共用）。
 * @returns 激活页的顶栏 Tab id（不存在时 null）
 */
export function reconcileBrowserTabs(store: JotaiStore, state: BrowserViewState, newTabIds?: ReadonlySet<string>): string | null {
  const dismissed = store.get(browserPanelDismissedSessionIdsAtom).has(state.sessionId)
  const tabs = store.get(tabsAtom)
  const next = planBrowserTabReconcile(tabs, state.sessionId, state, dismissed, newTabIds)
  if (next !== tabs) store.set(tabsAtom, next)
  return activeBrowserTopTabId(state.sessionId, state)
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

/** 只有当前可见的用户页内新窗口链接可以隐式创建对应 UI；后台新页无展示权。 */
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

/**
 * 被动同步浏览器状态。默认不新增页面、不自动建组；显式跟随才允许自动展示。
 * 用户正在查看的页面内新链接仍可接管原 Pane，但后台会话不能改变当前布局。
 */
export function openBrowserTabFromPush(
  state: BrowserViewState,
  options?: { autoOpen?: boolean; autoGroup?: boolean; previousState?: BrowserViewState | null },
): void {
  const store = getDefaultStore()
  const sessionId = state.sessionId
  // 只处理当前会话：后台会话的页面变化等切回时由 getState 恢复路径统一对账，
  // 避免非当前会话的推送动顶栏布局。
  if (store.get(appModeAtom) !== 'agent' || store.get(activeViewAtom) !== 'conversations' || sessionId !== store.get(currentAgentSessionIdAtom)) return
  // 自动组合仅发生在页面首次进入顶栏时；已有页的状态刷新不能撤销用户的解散/排序。
  const hadBrowserTabs = store.get(tabsAtom).some((tab) => isBrowserTab(tab) && tab.sessionId === sessionId)
  const previousState = options?.previousState ?? null
  const followNewPage = shouldFollowNewDisplayPage(store, state, previousState)
  const newTabIds = options?.autoOpen ? undefined : new Set(followNewPage ? [state.activeTabId] : [])
  const topTabId = reconcileBrowserTabs(store, state, newTabIds)
  if (followNewPage) followReplacedBrowserPage(store, state, previousState)
  if (!options?.autoOpen || !topTabId || options.autoGroup === false || hadBrowserTabs) return
  const next = planAutoGroupWorkTab({
    groups: store.get(tabGroupsAtom),
    agentTabId: sessionId,
    workTabId: topTabId,
    activeTabId: store.get(activeTabIdAtom),
  })
  if (next) store.set(tabGroupsAtom, next)
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

/** 手动打开/聚焦页面，保留同栏分屏；可附带发起意图，拒绝过期的异步唤起。 */
export function openBrowserTabManually(sessionId: string, state: BrowserViewState, browserTabId?: string, intent?: BrowserOpenIntent): void {
  const store = getDefaultStore()
  const targetPageId = browserTabId ?? state.activeTabId
  if (!state.tabs.some((page) => page.tabId === targetPageId)) return
  const topTabId = createBrowserTabId(sessionId, targetPageId)
  const currentActiveId = store.get(activeTabIdAtom)
  const currentGroup = findTabGroup(store.get(tabGroupsAtom), currentActiveId)
  const visibleIds = new Set([currentActiveId, ...groupTabIds(currentGroup)])
  if (intent) {
    if (store.get(appModeAtom) !== 'agent' || store.get(currentAgentSessionIdAtom) !== sessionId
      || store.get(activeViewAtom) !== intent.activeView || intent.activeView !== 'conversations') return
    // 实时推送可能已先将同一用户动作的新页接管到原栏；不把正常接管误判成过期。
    const alreadyVisible = visibleIds.has(topTabId)
    if (!alreadyVisible && (currentActiveId !== intent.activeTabId || (intent.sourceTabId && !visibleIds.has(intent.sourceTabId)))) return
  }
  store.set(browserPanelDismissedSessionIdsAtom, (prev) => {
    if (!prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.delete(sessionId)
    return next
  })
  reconcileBrowserTabs(store, state)
  if (intent?.sourceTabId && intent.sourceTabId !== topTabId) {
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
