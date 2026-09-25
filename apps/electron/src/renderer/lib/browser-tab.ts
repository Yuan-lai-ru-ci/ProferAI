/**
 * Browser Tab — 受管浏览器的顶栏 Tab 化入口
 *
 * 浏览器内部标签（每个网页）与顶栏 Tab 一一对应：`__browser__:${sessionId}:${tabId}`。
 * - reconcile：以主进程推送的 BrowserViewState 为准，增删/改标题同步顶栏 Tab；
 *   主进程会话销毁（state.tabs 为空）时该会话全部浏览器 Tab 消失。
 * - 手动打开 = 清除 dismissed 标记 + reconcile + 激活当前页 Tab；
 * - Agent 推送（自动打开区）= reconcile 后自动与对话组合并排（对话左、浏览器右，
 *   焦点留在对话），后续新页面只在顶栏后台出现；
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
import { planAutoGroupWorkTab, tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { appModeAtom } from '@/atoms/app-mode'
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
    if (dismissed) continue
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
export function reconcileBrowserTabs(store: JotaiStore, state: BrowserViewState): string | null {
  const dismissed = store.get(browserPanelDismissedSessionIdsAtom).has(state.sessionId)
  const tabs = store.get(tabsAtom)
  const next = planBrowserTabReconcile(tabs, state.sessionId, state, dismissed)
  if (next !== tabs) store.set(tabsAtom, next)
  return activeBrowserTopTabId(state.sessionId, state)
}

/**
 * Agent 推送驱动的浏览器 Tab 打开：
 * - reconcile 同步页签（会话存在顶栏浏览器 Tab 时必经此路径保持同步）；
 * - 用户正看着该会话对话、对话与该页都未入组时，自动组合并排（对话左、浏览器右），
 *   焦点留在对话——复刻旧「侧边面板自动可见但不打断对话」的体验；
 * - 用户自己摆过布局（已有组合）时不动布局，页面 Tab 仍出现在顶栏。
 *
 * dismissed 守卫由 reconcile 内部处理；autoOpen 判定在调用方（MainArea）。
 */
export function openBrowserTabFromPush(state: BrowserViewState, options?: { autoGroup?: boolean }): void {
  const store = getDefaultStore()
  const sessionId = state.sessionId
  // 只处理当前会话：后台会话的页面变化等切回时由 getState 恢复路径统一对账，
  // 避免非当前会话的推送动顶栏布局。
  if (store.get(appModeAtom) !== 'agent' || sessionId !== store.get(currentAgentSessionIdAtom)) return
  const topTabId = reconcileBrowserTabs(store, state)
  if (!topTabId || options?.autoGroup === false) return
  const next = planAutoGroupWorkTab({
    groups: store.get(tabGroupsAtom),
    agentTabId: sessionId,
    workTabId: topTabId,
    activeTabId: store.get(activeTabIdAtom),
  })
  if (next) store.set(tabGroupsAtom, next)
}

/** 手动打开/聚焦某页浏览器 Tab：清除 dismissed，reconcile 并激活指定页（默认激活页）。 */
export function openBrowserTabManually(sessionId: string, state: BrowserViewState, browserTabId?: string): void {
  const store = getDefaultStore()
  store.set(browserPanelDismissedSessionIdsAtom, (prev) => {
    if (!prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.delete(sessionId)
    return next
  })
  reconcileBrowserTabs(store, state)
  const topTabId = browserTabId
    ? createBrowserTabId(sessionId, browserTabId)
    : activeBrowserTopTabId(sessionId, state)
  if (topTabId) store.set(activeTabIdAtom, topTabId)
}
