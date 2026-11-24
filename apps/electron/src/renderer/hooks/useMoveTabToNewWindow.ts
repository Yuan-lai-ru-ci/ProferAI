/**
 * useMoveTabToNewWindow — 把当前窗口的会话 Tab 移到独立主窗口。
 *
 * 目标确认已承载后才从当前窗口移除 Tab；创建或加载失败保留原状。
 * 只支持 chat / agent Tab：浏览器和插件页依赖主窗口原生 View，
 * 文件预览属于会话工作 Tab，留在原窗口。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import { isMovableSessionTab, tabsAtom } from '@/atoms/tab-atoms'
import { trackHandoff } from '@/lib/window-tab-handoff'
import { clearMovedDraft, detachMovedTab, snapshotSessionForMove, type SyncMovedTab, type WindowStore } from '@/lib/window-session-move'
import { useSyncActiveTabSideEffects } from './useSyncActiveTabSideEffects'

export async function moveTabToNewWindow(store: WindowStore, sync: SyncMovedTab, tabId: string): Promise<boolean> {
  const item = store.get(tabsAtom).find(tab => tab.id === tabId)
  if (!isMovableSessionTab(item)) return false
  const snapshot = snapshotSessionForMove(store, item)
  if ('error' in snapshot) { toast.error(snapshot.error); return false }
  const { tab } = snapshot
  const origin = store.get(coreTargetsAtom)
  try {
    const result = await window.electronAPI.openTabInNewWindow(tab)
    if (!result.ok) { toast.error(result.error ?? '移动会话失败'); return false }
    if (result.handoffId) {
      // 创建成功不是交付成功；全局监听器也能暂存早于 invoke 返回的确认。
      trackHandoff(store, result.handoffId, tab, origin.currentId, { generation: origin.generation, item, sync })
    } else {
      const current = store.get(coreTargetsAtom)
      if (current.currentId === origin.currentId && current.generation === origin.generation) {
        detachMovedTab(store, tab, sync)
        clearMovedDraft(store, tab)
      }
    }
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建新窗口失败')
    return false
  }
}

export function useMoveTabToNewWindow(): (tabId: string) => Promise<boolean> {
  const store = useStore()
  const sync = useSyncActiveTabSideEffects()
  return React.useCallback(tabId => moveTabToNewWindow(store, sync, tabId), [store, sync])
}
