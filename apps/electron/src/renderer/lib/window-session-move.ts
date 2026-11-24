import type { createStore } from 'jotai/vanilla'
import type { AppWindowSession, MainWindowTabPayload, PrepareWindowSessionMove, PrepareWindowSessionMoveResult, WindowMoveCore } from '@profer/shared'
import { activeTabIdAtom, detachTab, isMovableSessionTab, tabMruAtom, tabsAtom, type TabItem } from '../atoms/tab-atoms'
import { appModeAtom } from '../atoms/app-mode'
import { coreSessionNavigationPhaseAtom, coreTargetsAtom } from '../atoms/core-target-atoms'
import { agentSessionDraftsAtom, agentSessionDraftHtmlAtom, agentSessionsAtom } from '../atoms/agent-atoms'
import { conversationDraftsAtom, streamingConversationIdsAtom } from '../atoms/chat-atoms'
import { reconcileTabGroups, tabGroupsAtom } from '../atoms/tab-group-atoms'

export type WindowStore = ReturnType<typeof createStore>
export type SyncMovedTab = (tab: TabItem | null) => void

export function matchesMoveCore(store: WindowStore, route: WindowMoveCore): boolean {
  const core = store.get(coreTargetsAtom)
  return store.get(coreSessionNavigationPhaseAtom) === 'ready' && core.startup !== 'offline' && core.startup !== 'restoring'
    && core.currentId === route.targetId && core.generation === route.generation
    && core.targets.find(item => item.id === core.currentId)?.coreId === route.coreId
}

export function readMoveDraft(store: WindowStore, session: AppWindowSession) {
  const draft = store.get(session.type === 'agent' ? agentSessionDraftsAtom : conversationDraftsAtom).get(session.sessionId)
  const draftHtml = session.type === 'agent' ? store.get(agentSessionDraftHtmlAtom).get(session.sessionId) : undefined
  return { draft: draft || undefined, draftHtml: draftHtml || undefined }
}

export function sameMovedSnapshot(a: MainWindowTabPayload, b: MainWindowTabPayload): boolean {
  return a.id === b.id && a.sessionId === b.sessionId && a.type === b.type && a.parentSessionId === b.parentSessionId
    && a.draft === b.draft && a.draftHtml === b.draftHtml
}

/** 不暗中移动子树。已经分窗的子项没有本地 Tab，不妨碍单移父项。 */
export function snapshotSessionForMove(store: WindowStore, session: AppWindowSession): PrepareWindowSessionMoveResult {
  const tabs = store.get(tabsAtom)
  const tab = tabs.find(item => item.type === session.type && item.sessionId === session.sessionId)
  if (!isMovableSessionTab(tab)) return { error: '会话不在源窗口' }
  const meta = tab.type === 'agent' ? store.get(agentSessionsAtom) : []
  if (tab.type === 'chat' && store.get(streamingConversationIdsAtom).has(tab.sessionId)) return { error: '对话正在生成，结束后再移动' }
  const { draft, draftHtml } = readMoveDraft(store, session)
  if ((draft?.length ?? 0) > 100_000 || (draftHtml?.length ?? 0) > 500_000) return { error: '草稿过大，无法完整交接' }
  const ownMeta = meta.find(item => item.id === tab.sessionId)
  const parentSessionId = tab.parentSessionId ?? ownMeta?.parentSessionId ?? ownMeta?.explorationParentSessionId
  return { tab: { id: tab.id, sessionId: tab.sessionId, type: tab.type, title: tab.title,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(draft !== undefined ? { draft } : {}), ...(draftHtml !== undefined ? { draftHtml } : {}) } }
}

// 最新 prepare 绑到具体 Tab 实例，关闭重开 / 重复 commit 不会误摘后来的同 ID 标签。
const preparedTabs = new WeakMap<TabItem, string>()
export function consumePreparedMove(store: WindowStore, requestId: string, tab: MainWindowTabPayload): boolean {
  const item = store.get(tabsAtom).find(item => item.id === tab.id)
  if (!item || preparedTabs.get(item) !== requestId) return false
  preparedTabs.delete(item)
  return true
}

export function prepareWindowSessionMove(store: WindowStore, request: PrepareWindowSessionMove): PrepareWindowSessionMoveResult {
  if (!matchesMoveCore(store, request.core)) return { error: '源窗口 Core 已变化或尚未就绪' }
  const snapshot = snapshotSessionForMove(store, request.session)
  if ('tab' in snapshot) preparedTabs.set(store.get(tabsAtom).find(item => item.id === snapshot.tab.id)!, request.handoffId)
  return snapshot
}

export function detachMovedTab(store: WindowStore, tab: MainWindowTabPayload, sync: SyncMovedTab): void {
  const previous = store.get(activeTabIdAtom)
  const next = detachTab(store.get(tabsAtom), previous, tab.id, store.get(tabMruAtom))
  store.set(tabsAtom, next.tabs)
  store.set(activeTabIdAtom, next.activeTabId)
  store.set(tabMruAtom, next.mru)
  store.set(tabGroupsAtom, reconcileTabGroups(store.get(tabGroupsAtom), new Set(next.tabs.map(item => item.id))))
  if (next.activeTabId !== previous) sync(next.tabs.find(item => item.id === next.activeTabId) ?? null)
  if (previous === tab.id && !next.activeTabId) store.set(appModeAtom, tab.type)
}

/** 只清理已被交付的内容；确认期间键入的纯文本或引用均不能丢。 */
export function clearMovedDraft(store: WindowStore, tab: MainWindowTabPayload): void {
  const draft = readMoveDraft(store, tab)
  if (draft.draft !== tab.draft || draft.draftHtml !== tab.draftHtml) return
  const remove = (previous: Map<string, string>) => {
    if (!previous.has(tab.sessionId)) return previous
    const next = new Map(previous); next.delete(tab.sessionId); return next
  }
  store.set(tab.type === 'agent' ? agentSessionDraftsAtom : conversationDraftsAtom, remove)
  if (tab.type === 'agent') store.set(agentSessionDraftHtmlAtom, remove)
}
