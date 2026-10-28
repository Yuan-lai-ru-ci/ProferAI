/**
 * useMoveTabToNewWindow — 把当前窗口的会话 Tab 移到独立主窗口。
 *
 * 新窗口创建成功后才从当前窗口移除 Tab；创建失败保留原状并提示。
 * 只支持 chat / agent Tab：浏览器和插件页依赖主窗口原生 View，
 * 文件预览属于会话工作 Tab，留在原窗口。
 */

import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  activeTabIdAtom,
  detachTab,
  isMovableSessionTab,
  tabMruAtom,
  tabsAtom,
} from '@/atoms/tab-atoms'
import { streamingConversationIdsAtom, conversationDraftsAtom } from '@/atoms/chat-atoms'
import { agentSessionDraftHtmlAtom, agentSessionDraftsAtom, agentStreamingStatesAtom, allPendingAskUserRequestsAtom, allPendingExitPlanRequestsAtom, allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import { reconcileTabGroups, tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'

/** 返回删除指定 key 的 Map；不存在时保留原引用，避免无意义重渲染。 */
function withoutKey<T>(map: Map<string, T>, key: string): Map<string, T> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

export function useMoveTabToNewWindow(): (tabId: string) => Promise<boolean> {
  const store = useStore()
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()
  const streamingConversationIds = useAtomValue(streamingConversationIdsAtom)

  return React.useCallback(async (tabId: string): Promise<boolean> => {
    const tab = store.get(tabsAtom).find((item) => item.id === tabId)
    if (!isMovableSessionTab(tab)) return false

    // Chat 流直接绑定发起窗口，主进程没有刷新重放；生成中拆窗会丢后续 chunk。
    if (tab.type === 'chat' && streamingConversationIds.has(tab.sessionId)) {
      toast.info('对话正在生成，结束后再移到新窗口')
      return false
    }

    let result: Awaited<ReturnType<typeof window.electronAPI.openTabInNewWindow>>
    const draft = tab.type === 'agent'
      ? store.get(agentSessionDraftsAtom).get(tab.sessionId)
      : store.get(conversationDraftsAtom).get(tab.sessionId)
    // 富文本草稿单独保存引用胶囊等结构；只传纯文本会让划词引用退化成普通文字。
    const draftHtml = tab.type === 'agent'
      ? store.get(agentSessionDraftHtmlAtom).get(tab.sessionId)
      : undefined
    try {
      result = await window.electronAPI.openTabInNewWindow({
        id: tab.id,
        type: tab.type,
        sessionId: tab.sessionId,
        title: tab.title,
        ...(tab.parentSessionId ? { parentSessionId: tab.parentSessionId } : {}),
        ...(draft ? { draft } : {}),
        ...(draftHtml ? { draftHtml } : {}),
      })
    } catch (error) {
      console.error('[多窗口] 创建新窗口失败:', error)
      toast.error('创建新窗口失败')
      return false
    }

    if (!result.ok) {
      toast.error(result.error ?? '创建新窗口失败')
      return false
    }

    const previousActiveTabId = store.get(activeTabIdAtom)
    const next = detachTab(
      store.get(tabsAtom),
      previousActiveTabId,
      tabId,
      store.get(tabMruAtom),
    )
    store.set(tabsAtom, next.tabs)
    store.set(activeTabIdAtom, next.activeTabId)
    store.set(tabMruAtom, next.mru)
    store.set(
      tabGroupsAtom,
      reconcileTabGroups(store.get(tabGroupsAtom), new Set(next.tabs.map((item) => item.id))),
    )

    if (next.activeTabId !== previousActiveTabId) {
      syncActiveTabSideEffects(next.tabs.find((item) => item.id === next.activeTabId) ?? null)
    }

    // 草稿已经交给新窗口，源窗口清掉，避免两个窗口各自保留一份。
    if (draftHtml) {
      store.set(agentSessionDraftHtmlAtom, (prev) => withoutKey(prev, tab.sessionId))
    }
    if (draft) {
      if (tab.type === 'agent') {
        store.set(agentSessionDraftsAtom, (prev) => {
          if (!prev.has(tab.sessionId)) return prev
          const copy = new Map(prev)
          copy.delete(tab.sessionId)
          return copy
        })
      } else {
        store.set(conversationDraftsAtom, (prev) => {
          if (!prev.has(tab.sessionId)) return prev
          const copy = new Map(prev)
          copy.delete(tab.sessionId)
          return copy
        })
      }
    }

    // 运行中的会话已由新窗口接管事件流；源窗口清掉流式状态和待处理交互，
    // 否则侧边栏会一直停留在“运行中”，重新打开会话时还会看到已在新窗口处理的旧请求。
    if (tab.type === 'agent') {
      store.set(agentStreamingStatesAtom, (prev) => withoutKey(prev, tab.sessionId))
      store.set(allPendingPermissionRequestsAtom, (prev) => withoutKey(prev, tab.sessionId))
      store.set(allPendingAskUserRequestsAtom, (prev) => withoutKey(prev, tab.sessionId))
      store.set(allPendingExitPlanRequestsAtom, (prev) => withoutKey(prev, tab.sessionId))
    }
    return true
  }, [store, syncActiveTabSideEffects, streamingConversationIds])
}
