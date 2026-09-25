/**
 * useCloseTab — 统一的当前会话入口关闭逻辑
 *
 * 被 TabBar（×按钮/中键）和 GlobalShortcuts（Cmd+W）共用，
 *
 * 关键行为：
 * - 关闭当前会话入口只回到 Scratch Pad，不停止后台 Agent
 * - 运行中或阻塞中的会话继续通过左侧状态 indicator 恢复
 * - idle 状态的 Agent 会话在用户主动关闭 Tab 时清除完成提醒状态
 * - 真正删除/归档时由侧边栏路径负责清理 per-session 状态
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  closeTab,
  isBrowserTab,
  isPreviewTab,
  selectSameModeCloseFallback,
  tabMruAtom,
} from '@/atoms/tab-atoms'
import { browserPanelDismissedSessionIdsAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { previewFilesByTabAtom } from '@/atoms/preview-atoms'
import {
  agentSessionsAtom,
  agentSessionIndicatorMapAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'

interface UseCloseTabReturn {
  /** 请求关闭当前会话入口 */
  requestClose: (tabId: string) => void
  /** 直接执行关闭 */
  executeClose: (tabId: string) => void
}

export function useCloseTab(): UseCloseTabReturn {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [tabMru, setTabMru] = useAtom(tabMruAtom)
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()
  const store = useStore()
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setPreviewFilesByTab = useSetAtom(previewFilesByTabAtom)
  const setBrowserDismissed = useSetAtom(browserPanelDismissedSessionIdsAtom)

  const clearIdleAgentCompletionNotice = React.useCallback((sessionId: string) => {
    const indicatorMap = store.get(agentSessionIndicatorMapAtom)
    const status = indicatorMap.get(sessionId)
    // running 或 blocked 的会话仍需要侧边栏状态提示
    if (status === 'running' || status === 'blocked') return

    // 通过 IPC 清除持久化的 completedButUnconfirmed 和旧版 manualWorking 状态
    window.electronAPI.clearAgentCompletionState(sessionId)
      .then((updated) => {
        setAgentSessions((prev) =>
          prev.map((s) => (s.id === updated.id ? updated : s))
        )
      })
      .catch(console.error)

    setUnviewedCompleted((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [store, setAgentSessions, setUnviewedCompleted])

  const executeClose = React.useCallback((tabId: string) => {
    const closingTab = tabs.find((t) => t.id === tabId)
    const result = closeTab(tabs, activeTabId, tabId, tabMru)
    // 关闭会话入口后的回退选择：同类会话优先（MRU），同类关完回 Scratch Pad，不跨模式跳转。
    const fallbackTabId = selectSameModeCloseFallback(
      result.tabs,
      closingTab,
      result.activeTabId !== activeTabId,
      tabMru,
      result.activeTabId,
    )
    const nextActiveTabId = fallbackTabId ?? result.activeTabId
    const nextResult = nextActiveTabId === result.activeTabId
      ? result
      : { ...result, activeTabId: nextActiveTabId }
    const wasActive = nextResult.activeTabId !== activeTabId
    // 原生插件 View 位于 renderer DOM 之上，先收起/销毁再切换 Tab，避免关闭瞬间
    // 仍有不可见的 native View 覆盖新激活内容。
    const removedPluginTabs = tabs.filter((tab) => tab.type === 'plugin' && !nextResult.tabs.some((remaining) => remaining.id === tab.id))
    for (const removed of removedPluginTabs) {
      if (!removed.pluginId || !removed.pluginPageId) continue
      void window.electronAPI.closePluginView(removed.pluginId, removed.pluginPageId, removed.pluginScope === 'session' ? { kind: 'tab', sessionId: removed.sessionId } : { kind: 'tab' }).catch(() => undefined)
    }
    if (closingTab?.type === 'plugin' && closingTab.pluginId && closingTab.pluginPageId) {
      void window.electronAPI.closePluginView(closingTab.pluginId, closingTab.pluginPageId, closingTab.pluginScope === 'session' ? { kind: 'tab', sessionId: closingTab.sessionId } : { kind: 'tab' }).catch(() => undefined)
    }
    setTabs(nextResult.tabs)
    setActiveTabId(nextResult.activeTabId)
    setTabMru(result.mru)

    // 同步工作 Tab 的附属状态：
    // - 关闭预览 Tab → 清理其文件元数据条目
    // - 关闭浏览器 Tab → 记入 dismissed（浏览器进程保留在后台，推送不再自动重开）
    // - 关闭会话 Tab（连带其工作 Tab）→ 清理该会话全部工作 Tab 元数据
    if (closingTab && isPreviewTab(closingTab)) {
      setPreviewFilesByTab((prev) => {
        if (!prev.has(tabId)) return prev
        const next = new Map(prev)
        next.delete(tabId)
        return next
      })
    } else if (closingTab && isBrowserTab(closingTab)) {
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
      const remainingBrowserTabs = nextResult.tabs.filter((tab) => isBrowserTab(tab) && tab.sessionId === browserSessionId)
      if (remainingBrowserTabs.length === 0) {
        void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(browserSessionId)
        setBrowserDismissed((prev) => {
          if (prev.has(browserSessionId)) return prev
          const next = new Set(prev)
          next.add(browserSessionId)
          return next
        })
      }
    } else if (closingTab?.type === 'agent' || closingTab?.type === 'chat') {
      setPreviewFilesByTab((prev) => {
        const next = new Map(prev)
        let changed = false
        for (const key of next.keys()) {
          if (key.startsWith(`__preview__:${closingTab.sessionId}:`)) {
            next.delete(key)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }

    if (wasActive) {
      const newActiveTab = nextResult.activeTabId
        ? nextResult.tabs.find((t) => t.id === nextResult.activeTabId) ?? null
        : null
      syncActiveTabSideEffects(newActiveTab)
    }

    // 用户主动关闭 idle 的 Agent Tab 时，清除完成提醒状态
    if (closingTab && closingTab.type === 'agent') {
      clearIdleAgentCompletionNotice(closingTab.sessionId)
    }
  }, [tabs, activeTabId, tabMru, setTabs, setActiveTabId, setTabMru, setPreviewFilesByTab, setBrowserDismissed, syncActiveTabSideEffects, clearIdleAgentCompletionNotice])

  const requestClose = React.useCallback((tabId: string) => {
    executeClose(tabId)
  }, [executeClose])

  return { requestClose, executeClose }
}
