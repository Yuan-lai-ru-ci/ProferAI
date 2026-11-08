/**
 * useCloseTab — 统一的当前会话入口关闭逻辑
 *
 * 被 TabBar（×按钮/中键）和 GlobalShortcuts（Cmd+W）共用，
 *
 * 关键行为：
 * - 关闭当前会话入口只回到 Scratch Pad，不停止后台 Agent
 * - 运行中或阻塞中的会话继续通过左侧状态 indicator 恢复
 * - idle 状态的 Agent 会话在用户主动关闭 Tab 时清除完成提醒状态
   （仅关闭态；开启「手动确认已读」后关闭标签页不再清未读）
 * - 真正删除/归档时由侧边栏路径负责清理 per-session 状态
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  closeTabs,
  isBrowserTab,
  isPreviewTab,
  tabMruAtom,
  type TabItem,
} from '@/atoms/tab-atoms'
import { browserPanelDismissedSessionIdsAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { previewFilesByTabAtom } from '@/atoms/preview-atoms'
import {
  agentSessionsAtom,
  agentSessionIndicatorMapAtom,
  agentSDKMessagesCacheAtom,
  resolvedBlobMessagesAtom,
  deleteSessionMapEntry,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { manualReadConfirmEnabledAtom } from '@/atoms/agent-unread-settings'
import { shouldAutoClearUnreadOnView } from '@/lib/agent-unread-gate'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'

interface CloseManyOptions {
  /**
   * 关闭后希望激活的 Tab。
   *
   * 右键菜单的目标条目本身不在关闭范围内，用户刚在它上面操作，落点应回到它；
   * 而 `closeTabs` 的缺省回退是 MRU + 就近，不保证落在目标上。
   * 该 Tab 若已被连带关闭（例如作为某会话的工作 Tab）则忽略，仍按缺省回退。
   */
  activateTabId?: string
}

interface UseCloseTabReturn {
  /** 请求关闭当前会话入口 */
  requestClose: (tabId: string) => void
  /** 直接执行关闭 */
  executeClose: (tabId: string) => void
  /** 批量关闭多个当前会话入口（「关闭其他 / 关闭所有」），一次提交，避免逐次读到过期快照 */
  requestCloseMany: (tabIds: readonly string[], options?: CloseManyOptions) => void
}

export function useCloseTab(): UseCloseTabReturn {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [tabMru, setTabMru] = useAtom(tabMruAtom)
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()
  const store = useStore()
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  // 开启态下「关闭标签页清未读」失效；内存侧由模式感知 atom 统一门控。
  const manualReadConfirmEnabled = useAtomValue(manualReadConfirmEnabledAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setPreviewFilesByTab = useSetAtom(previewFilesByTabAtom)
  const setBrowserDismissed = useSetAtom(browserPanelDismissedSessionIdsAtom)
  const setAgentMessagesCache = useSetAtom(agentSDKMessagesCacheAtom)
  const setResolvedBlobMessages = useSetAtom(resolvedBlobMessagesAtom)

  const clearIdleAgentCompletionNotice = React.useCallback((sessionId: string) => {
    const indicatorMap = store.get(agentSessionIndicatorMapAtom)
    const status = indicatorMap.get(sessionId)
    // running 或 blocked 的会话仍需要侧边栏状态提示
    if (status === 'running' || status === 'blocked') return

    // 通过 IPC 清除持久化的 completedButUnconfirmed 和旧版 manualWorking 状态。
    // 开启态下不执行：关闭标签页是导航副作用，不是用户确认已读（需求 §3.2-2）。
    if (shouldAutoClearUnreadOnView(manualReadConfirmEnabled ? 'manual' : 'auto')) {
      window.electronAPI.clearAgentCompletionState(sessionId)
        .then((updated) => {
          setAgentSessions((prev) =>
            prev.map((s) => (s.id === updated.id ? updated : s))
          )
        })
        .catch(console.error)
    }

    setUnviewedCompleted((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [store, setAgentSessions, setUnviewedCompleted, manualReadConfirmEnabled])

  /**
   * 单个已关闭 Tab 的附属状态清理：
   * - 关闭预览 Tab → 清理其文件元数据条目
   * - 关闭浏览器 Tab → 记入 dismissed（浏览器进程保留在后台，推送不再自动重开）
   * - 关闭会话 Tab（连带其工作 Tab）→ 清理该会话全部工作 Tab 元数据
   * - 关闭 Agent Tab → 释放可从磁盘/实时消息重建的重型缓存
   * 单 Tab 与批量关闭共用，保证「关闭其他 / 关闭所有」不会漏掉逐 Tab 清理。
   */
  const applyClosedTabSideEffects = React.useCallback((closingTab: TabItem, remainingTabs: readonly TabItem[]) => {
    if (isPreviewTab(closingTab)) {
      const closingTabId = closingTab.id
      setPreviewFilesByTab((prev) => {
        if (!prev.has(closingTabId)) return prev
        const next = new Map(prev)
        next.delete(closingTabId)
        return next
      })
    } else if (isBrowserTab(closingTab)) {
      // 关闭顶栏 Tab = 关闭对应网页（每页一个 Tab）；主进程关到 0 页时销毁会话（返回 null），
      // 此时清掉状态镜像，reconcile 后续会移除同会话残留的浏览器 Tab。
      const browserSessionId = closingTab.sessionId
      if (closingTab.browserTabId) {
        void (window.electronAPI as Partial<typeof window.electronAPI>)
          .closeAgentBrowserTab?.({ sessionId: browserSessionId, tabId: closingTab.browserTabId })
          .then((nextState) => {
            if (nextState !== null) return
            store.set(browserStateMapAtom, (prev) => {
              if (!prev.has(browserSessionId)) return prev
              const next = new Map(prev)
              next.delete(browserSessionId)
              return next
            })
          })
          .catch(() => undefined)
      }
      // 用户关掉该会话最后一个浏览器页 Tab：记入 dismissed，推送不再自动重开
      const remainingBrowserTabs = remainingTabs.filter((tab) => isBrowserTab(tab) && tab.sessionId === browserSessionId)
      if (remainingBrowserTabs.length === 0) {
        void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(browserSessionId)
        setBrowserDismissed((prev) => {
          if (prev.has(browserSessionId)) return prev
          const next = new Set(prev)
          next.add(browserSessionId)
          return next
        })
      }
    } else if (closingTab.type === 'agent' || closingTab.type === 'chat') {
      const closingSessionId = closingTab.sessionId
      setPreviewFilesByTab((prev) => {
        const next = new Map(prev)
        let changed = false
        for (const key of next.keys()) {
          if (key.startsWith(`__preview__:${closingSessionId}:`)) {
            next.delete(key)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }

    // 关闭 Agent Tab 不停止后台 Agent，但要释放可从磁盘/实时消息重建的重型缓存。
    // 否则会话虽从界面关闭，完整消息数组和用户主动加载的全文 blob 仍一直驻留到进程重启。
    if (closingTab.type === 'agent') {
      const sessionId = closingTab.sessionId
      setAgentMessagesCache((prev) => deleteSessionMapEntry(prev, sessionId))
      setResolvedBlobMessages((prev) => deleteSessionMapEntry(prev, sessionId))
      clearIdleAgentCompletionNotice(sessionId)
    }
  }, [setPreviewFilesByTab, setBrowserDismissed, store, setAgentMessagesCache, setResolvedBlobMessages, clearIdleAgentCompletionNotice])

  /** 提交一次关闭结果：插件原生 View 先销毁，再提交 tabs 状态，最后逐个同步被关闭 Tab 的附属状态。 */
  const commitClose = React.useCallback((
    previousTabs: readonly TabItem[],
    closingTabs: readonly TabItem[],
    nextTabs: TabItem[],
    nextActiveTabId: string | null,
    nextMru: string[],
  ) => {
    // 原生插件 View 位于 renderer DOM 之上，先收起/销毁再切换 Tab，避免关闭瞬间
    // 仍有不可见的 native View 覆盖新激活内容。
    const removedPluginTabs = previousTabs.filter((tab) => tab.type === 'plugin' && !nextTabs.some((remaining) => remaining.id === tab.id))
    for (const removed of removedPluginTabs) {
      if (!removed.pluginId || !removed.pluginPageId) continue
      void window.electronAPI.closePluginView(removed.pluginId, removed.pluginPageId, removed.pluginScope === 'session' ? { kind: 'tab', sessionId: removed.sessionId } : { kind: 'tab' }).catch(() => undefined)
    }
    setTabs(nextTabs)
    setActiveTabId(nextActiveTabId)
    setTabMru(nextMru)

    for (const closingTab of closingTabs) {
      applyClosedTabSideEffects(closingTab, nextTabs)
    }

    if (nextActiveTabId !== activeTabId) {
      const newActiveTab = nextActiveTabId
        ? nextTabs.find((t) => t.id === nextActiveTabId) ?? null
        : null
      syncActiveTabSideEffects(newActiveTab)
    }
  }, [activeTabId, setTabs, setActiveTabId, setTabMru, applyClosedTabSideEffects, syncActiveTabSideEffects])

  /**
   * 关闭一组当前会话入口。
   *
   * 逐次调用单 Tab 关闭会各自读到同一份过期 `tabs` 快照（最后一次提交覆盖前面所有结果），
   * 因此这里在同一份工作副本上按传入顺序串行推进，结束时只提交一次。
   */
  const executeCloseMany = React.useCallback((tabIds: readonly string[], options?: CloseManyOptions) => {
    const result = closeTabs(tabs, activeTabId, tabIds, tabMru)
    if (result.closedTabs.length === 0) return
    // 右键目标不在关闭范围内：优先落回它，而不是 MRU / 就近回退（落在别处会像"没按我指的走"）。
    const requestedTabId = options?.activateTabId
    const nextActiveTabId =
      requestedTabId && result.tabs.some((tab) => tab.id === requestedTabId)
        ? requestedTabId
        : result.activeTabId
    commitClose(tabs, result.closedTabs, result.tabs, nextActiveTabId, result.mru)
  }, [tabs, activeTabId, tabMru, commitClose])

  const executeClose = React.useCallback((tabId: string) => {
    executeCloseMany([tabId])
  }, [executeCloseMany])

  const requestClose = React.useCallback((tabId: string) => {
    executeClose(tabId)
  }, [executeClose])

  const requestCloseMany = React.useCallback((tabIds: readonly string[], options?: CloseManyOptions) => {
    executeCloseMany(tabIds, options)
  }, [executeCloseMany])

  return { requestClose, executeClose, requestCloseMany }
}
