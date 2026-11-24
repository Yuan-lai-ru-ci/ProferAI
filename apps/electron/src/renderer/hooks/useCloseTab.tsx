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
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  tabsAtom,
  activeTabIdAtom,
  closeTabs,
  isBrowserTab,
  isPreviewTab,
  tabMruAtom,
  tabMinimapCacheAtom,
  deleteTabMinimapCacheEntry,
  type TabItem,
} from '@/atoms/tab-atoms'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
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
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()
  const store = useStore()
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  // 开启态下「关闭标签页清未读」失效；内存侧由模式感知 atom 统一门控。
  const manualReadConfirmEnabled = useAtomValue(manualReadConfirmEnabledAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setPreviewFilesByTab = useSetAtom(previewFilesByTabAtom)
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
   * - 关闭会话 Tab（连带其工作 Tab）→ 清理该会话全部工作 Tab 元数据
   * - 关闭 Agent Tab → 释放可从磁盘/实时消息重建的重型缓存
   * 单 Tab 与批量关闭共用，保证「关闭其他 / 关闭所有」不会漏掉逐 Tab 清理。
   */
  const applyClosedTabSideEffects = React.useCallback((closingTab: TabItem) => {
    if (isPreviewTab(closingTab)) {
      const closingTabId = closingTab.id
      setPreviewFilesByTab((prev) => {
        if (!prev.has(closingTabId)) return prev
        const next = new Map(prev)
        next.delete(closingTabId)
        return next
      })
    } else if (closingTab.type === 'agent' || closingTab.type === 'chat') {
      const closingSessionId = closingTab.sessionId
      // 迷你地图缓存只服务 hover 预览，可从消息重建：Tab 关掉就释放，
      // 否则它按 sessionId 常驻，长期不重启的进程里只增不减。
      store.set(tabMinimapCacheAtom, (prev) => deleteTabMinimapCacheEntry(prev, closingSessionId))
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
  }, [setPreviewFilesByTab, store, setAgentMessagesCache, setResolvedBlobMessages, clearIdleAgentCompletionNotice])

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
    const activeTabId = store.get(activeTabIdAtom)
    store.set(tabsAtom, nextTabs)
    store.set(activeTabIdAtom, nextActiveTabId)
    store.set(tabMruAtom, nextMru)

    for (const closingTab of closingTabs) {
      applyClosedTabSideEffects(closingTab)
    }

    if (nextActiveTabId !== activeTabId) {
      const newActiveTab = nextActiveTabId
        ? nextTabs.find((t) => t.id === nextActiveTabId) ?? null
        : null
      syncActiveTabSideEffects(newActiveTab)
    }
  }, [store, applyClosedTabSideEffects, syncActiveTabSideEffects])

  const executeCloseMany = React.useCallback(async (tabIds: readonly string[], options?: CloseManyOptions) => {
    const originCore = store.get(coreTargetsAtom)
    const initial = store.get(tabsAtom)
    const initialActive = store.get(activeTabIdAtom)
    const planned = closeTabs(initial, initialActive, tabIds, store.get(tabMruAtom))
    if (!planned.closedTabs.length) return
    const remaining = new Set(planned.tabs.map(tab => tab.id))
    const pages = initial.filter(tab => isBrowserTab(tab) && !remaining.has(tab.id))
    const closedPageIds = new Set<string>()
    if (pages.length) {
      // 不乐观隐藏 guest。失败页仍可见、可重试；不同请求的旧返回值绝不能覆盖推送的新状态。
      await Promise.all(pages.map(async page => {
        try {
          if (!page.browserTabId) throw new Error('网页缺少标签 ID。')
          await window.electronAPI.closeAgentBrowserTab({ sessionId: page.sessionId, tabId: page.browserTabId })
          closedPageIds.add(page.id)
        } catch (error) {
          toast.error(`未能关闭网页：${page.title}`, { description: error instanceof Error ? error.message : String(error) })
        }
      }))
    }
    const core = store.get(coreTargetsAtom)
    if (originCore.generation !== core.generation || originCore.currentId !== core.currentId) return
    const tabs = store.get(tabsAtom)
    const active = store.get(activeTabIdAtom)
    // 等待期间可能有新页进入同一会话。不能让关闭 owner 连带隐藏失败页或从未请求关闭的新页。
    const protectedSessions = new Set(tabs.filter(tab => isBrowserTab(tab) && !closedPageIds.has(tab.id)).map(tab => tab.sessionId))
    const safeIds = tabIds.filter(id => {
      const tab = tabs.find(item => item.id === id)
      if (!tab || isBrowserTab(tab)) return closedPageIds.has(id)
      return !(tab.type === 'agent' || tab.type === 'chat') || !protectedSessions.has(tab.sessionId)
    })
    const result = closeTabs(tabs, active, [...safeIds, ...closedPageIds], store.get(tabMruAtom))
    const requestedTabId = active === initialActive ? options?.activateTabId : undefined
    const nextActive = requestedTabId && result.tabs.some(tab => tab.id === requestedTabId) ? requestedTabId : result.activeTabId
    if (result.closedTabs.length || nextActive !== active) commitClose(tabs, result.closedTabs, result.tabs, nextActive, result.mru)
  }, [store, commitClose])

  const executeClose = React.useCallback((tabId: string) => {
    void executeCloseMany([tabId])
  }, [executeCloseMany])

  const requestClose = React.useCallback((tabId: string) => {
    executeClose(tabId)
  }, [executeClose])

  const requestCloseMany = React.useCallback((tabIds: readonly string[], options?: CloseManyOptions) => {
    void executeCloseMany(tabIds, options)
  }, [executeCloseMany])

  return { requestClose, executeClose, requestCloseMany }
}
