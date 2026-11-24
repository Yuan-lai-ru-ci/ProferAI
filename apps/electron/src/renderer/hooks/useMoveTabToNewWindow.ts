/**
 * useMoveTabToNewWindow — 把当前窗口的会话 Tab 移到独立主窗口。
 *
 * 新窗口创建成功后才从当前窗口移除 Tab；创建失败保留原状并提示。
 * 只支持 chat / agent Tab：浏览器和插件页依赖主窗口原生 View，
 * 文件预览属于会话工作 Tab，留在原窗口。
 */

import { receiveHandoff, trackHandoff } from '@/lib/window-tab-handoff'
import * as React from 'react'
import { useStore } from 'jotai'
import type { createStore } from 'jotai/vanilla'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { toast } from 'sonner'
import {
  activeTabIdAtom,
  detachTab,
  isMovableSessionTab,
  tabMruAtom,
  tabsAtom,
} from '@/atoms/tab-atoms'
import { streamingConversationIdsAtom, conversationDraftsAtom } from '@/atoms/chat-atoms'
import { agentSessionDraftHtmlAtom, agentSessionDraftsAtom } from '@/atoms/agent-atoms'
import { reconcileTabGroups, tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'

/** 返回删除指定 key 的 Map；不存在时保留原引用，避免无意义重渲染。 */
function withoutKey<T>(map: Map<string, T>, key: string): Map<string, T> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

export async function moveTabToNewWindow(store: ReturnType<typeof createStore>, syncActiveTabSideEffects: ReturnType<typeof useSyncActiveTabSideEffects>, tabId: string): Promise<boolean> {
  const originCore = store.get(coreTargetsAtom)
  const tab = store.get(tabsAtom).find((item) => item.id === tabId)
  if (!isMovableSessionTab(tab)) return false

  // Chat 流直接绑定发起窗口，主进程没有刷新重放；生成中拆窗会丢后续 chunk。
  if (tab.type === 'chat' && store.get(streamingConversationIdsAtom).has(tab.sessionId)) {
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
  const unsubscribe = window.electronAPI.onWindowTabHandoff?.(event => receiveHandoff(store,event))
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
    unsubscribe?.()
    return false
  }

  if (!result.ok) {
    unsubscribe?.()
    toast.error(result.error ?? '创建新窗口失败')
    return false
  }

  // 确认期间可切 Core；成功只清理当时交接且未再编辑的草稿，不碰新 Core 导航。
  const currentCore = store.get(coreTargetsAtom)
  const sameCore = currentCore.currentId === originCore.currentId && currentCore.generation === originCore.generation
  const previousActiveTabId = store.get(activeTabIdAtom)
  const next = detachTab(
    store.get(tabsAtom),
    previousActiveTabId,
    tabId,
    store.get(tabMruAtom),
  )
  if (sameCore) {
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

    if (previousActiveTabId === tabId && !next.activeTabId) store.set(appModeAtom, tab.type)
  }

  if (result.handoffId) {
    trackHandoff(store,result.handoffId,{...tab,type:tab.type,draft,draftHtml},originCore.currentId)
    // 全局订阅接管后续结果；invoke 前订阅已将快速事件暂存。
    unsubscribe?.()
    return true
  }
  unsubscribe?.()
  // 草稿已经交给新窗口，源窗口清掉，避免两个窗口各自保留一份。
  if (draftHtml !== undefined && store.get(agentSessionDraftHtmlAtom).get(tab.sessionId) === draftHtml) {
    store.set(agentSessionDraftHtmlAtom, (prev) => withoutKey(prev, tab.sessionId))
  }
  if (draft !== undefined) {
    if (tab.type === 'agent') {
      store.set(agentSessionDraftsAtom, (prev) => {
        if (prev.get(tab.sessionId) !== draft) return prev
        const copy = new Map(prev)
        copy.delete(tab.sessionId)
        return copy
      })
    } else {
      store.set(conversationDraftsAtom, (prev) => {
        if (prev.get(tab.sessionId) !== draft) return prev
        const copy = new Map(prev)
        copy.delete(tab.sessionId)
        return copy
      })
    }
  }

  // 完整窗口继续监听全局运行状态，保留侧栏状态与待处理交互。
  return true
}

export function useMoveTabToNewWindow(): (tabId: string) => Promise<boolean> {
  const store = useStore()
  const sync = useSyncActiveTabSideEffects()
  return React.useCallback(tabId => moveTabToNewWindow(store, sync, tabId), [store, sync])
}
