import { receiveHandoff, subscribeHandoffRecovery } from './window-tab-handoff'
import { useCallback, useEffect, useRef } from 'react'
import { agentWindowListenersReadyAtom } from './confirm-window-handoff'
import { activeViewAtom } from '../atoms/active-view'
import { automationFormAtom } from '../atoms/automation-atoms'
import { useSyncActiveTabSideEffects } from '../hooks/useSyncActiveTabSideEffects'
import { sameMovedSnapshot, consumePreparedMove, matchesMoveCore, prepareWindowSessionMove, readMoveDraft, snapshotSessionForMove, detachMovedTab, clearMovedDraft, type SyncMovedTab } from './window-session-move'
import type { AcceptWindowSessionMove, WindowTabHandoffEvent, WindowMoveResult } from '@profer/shared'
import { useStore } from 'jotai'
import type { createStore } from 'jotai/vanilla'
import type { AppWindowSession, AppWindowSummary, MainWindowBootstrap } from '@profer/shared'
import { appWindowsAtom, windowBootstrapAtom } from '../atoms/app-windows'
import { tabsAtom, activeTabIdAtom, openTab, type TabItem } from '../atoms/tab-atoms'
import { coreTargetsAtom, coreSessionNavigationPhaseAtom } from '../atoms/core-target-atoms'
import { agentSessionDraftsAtom, agentSessionDraftHtmlAtom, agentSessionsAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '../atoms/agent-atoms'
import { conversationDraftsAtom, currentConversationIdAtom } from '../atoms/chat-atoms'
import { appModeAtom } from '../atoms/app-mode'
import { getWindowBootstrap } from './window-bootstrap'

type Store = ReturnType<typeof createStore>

export function collectWindowSessions(tabs: TabItem[]): AppWindowSession[] {
  return tabs.flatMap(tab => tab.type === 'chat' || tab.type === 'agent'
    ? [{ type: tab.type, sessionId: tab.sessionId }] : [])
}

export function hasOtherSessionWindow(windows: AppWindowSummary[], ownId: string | undefined, session: AppWindowSession): boolean {
  return windows.some(window => ownId !== undefined && window.windowId !== ownId
    && window.sessions.some(item => item.type === session.type && item.sessionId === session.sessionId))
}

/** 已关闭或聚焦失败时恢复本地导航，调用方不必吞掉打开意图。 */
export async function focusSessionOrOpenLocal(focus: () => Promise<boolean>, openLocal: () => void): Promise<void> {
  try { if (await focus()) return } catch { /* 目标窗口消失时按本地打开处理。 */ }
  openLocal()
}

/** 以本窗口真实 Tab 为先；远端快照仅用于导航，不将父子会话视作同一个 owner。 */
export function navigateWindowSession(store: Store, session: AppWindowSession, openLocal: () => void): void {
  if (store.get(tabsAtom).some(tab => tab.type === session.type && tab.sessionId === session.sessionId)
    || !hasOtherSessionWindow(store.get(appWindowsAtom), store.get(windowBootstrapAtom)?.windowId, session)) {
    openLocal()
    return
  }
  const origin = store.get(coreTargetsAtom)
  void focusSessionOrOpenLocal(() => window.electronAPI.focusSessionWindow(session), () => {
    const current = store.get(coreTargetsAtom)
    if (origin.currentId === current.currentId && origin.generation === current.generation) openLocal()
  })
}

/** 目录恢复完成后再注入交接；不走跨窗口聚焦路由。 */
export function applyInitialWindowTab(store: Store, tab: MainWindowBootstrap['initialTab'], activate = true): void {
  if (!tab) return
  if (tab.type === 'agent') {
    if (tab.draft !== undefined) store.set(agentSessionDraftsAtom, previous => new Map(previous).set(tab.sessionId, tab.draft!))
    if (tab.draftHtml !== undefined) store.set(agentSessionDraftHtmlAtom, previous => new Map(previous).set(tab.sessionId, tab.draftHtml!))
    if (!activate) {
      store.set(tabsAtom, openTab(store.get(tabsAtom), tab).tabs)
      return
    }
    store.set(currentAgentSessionIdAtom, tab.sessionId)
    store.set(currentConversationIdAtom, null)
    const meta = store.get(agentSessionsAtom).find(item => item.id === tab.sessionId)
    if (meta?.workspaceId) store.set(currentAgentWorkspaceIdAtom, meta.workspaceId)
  } else {
    if (tab.draft !== undefined) store.set(conversationDraftsAtom, previous => new Map(previous).set(tab.sessionId, tab.draft!))
    if (!activate) {
      store.set(tabsAtom, openTab(store.get(tabsAtom), tab).tabs)
      return
    }
    store.set(currentConversationIdAtom, tab.sessionId)
    store.set(currentAgentSessionIdAtom, null)
  }
  const result = openTab(store.get(tabsAtom), tab)
  store.set(tabsAtom, result.tabs)
  store.set(activeTabIdAtom, result.activeTabId)
  store.set(appModeAtom, tab.type)
}

/** 移入请求与 accept 回调在同一 renderer；失败时只回滚本请求导入且尚未编辑的副本。 */
interface IncomingMove {
  session: AppWindowSession
  imported?: { request: AcceptWindowSessionMove; item: TabItem; previousDraft: ReturnType<typeof readMoveDraft> }
}
const incomingMoves = new WeakMap<Store, IncomingMove>()
export async function requestSessionMoveHere(store: Store, session: AppWindowSession, sync: SyncMovedTab): Promise<WindowMoveResult> {
  if (incomingMoves.has(store)) return { ok: false, error: '此窗口正在接收会话' }
  const move: IncomingMove = { session }
  incomingMoves.set(store, move)
  const previousActive = store.get(activeTabIdAtom)
  let accepted = false
  try {
    const result = await window.electronAPI.moveSessionToThisWindow(session)
    accepted = result.ok
    return result
  } finally {
    incomingMoves.delete(store)
    const imported = move.imported
    if (!accepted && imported && matchesMoveCore(store, imported.request.core)) {
      const { tab } = imported.request
      const current = snapshotSessionForMove(store, tab)
      if (store.get(tabsAtom).includes(imported.item) && 'tab' in current && sameMovedSnapshot(tab, current.tab)) {
        const restoreFocus = store.get(activeTabIdAtom) === tab.id
        detachMovedTab(store, tab, sync)
        clearMovedDraft(store, tab)
        const old = imported.previousDraft
        if (old.draft) store.set(tab.type === 'agent' ? agentSessionDraftsAtom : conversationDraftsAtom, previous => new Map(previous).set(tab.sessionId, old.draft!))
        if (old.draftHtml) store.set(agentSessionDraftHtmlAtom, previous => new Map(previous).set(tab.sessionId, old.draftHtml!))
        const previous = store.get(tabsAtom).find(item => item.id === previousActive)
        if (restoreFocus && previous) { store.set(activeTabIdAtom, previous.id); sync(previous) }
      }
    }
  }
}
export function useMoveSessionHere(): (session: AppWindowSession) => Promise<WindowMoveResult> {
  const store = useStore()
  const sync = useSyncActiveTabSideEffects()
  return useCallback(session => requestSessionMoveHere(store, session, sync), [store, sync])
}

/** 已开窗口的接收端：目录和监听器未就绪、标签/草稿冲突时先拒绝，再由发起方提示。 */
export async function acceptWindowSessionMove(store: Store, request: AcceptWindowSessionMove): Promise<WindowMoveResult> {
  const { tab, core } = request
  const move = incomingMoves.get(store)
  if (move?.session.type !== tab.type || move?.session.sessionId !== tab.sessionId || move.imported) return { ok: false, error: '移入请求已失效' }
  if (!matchesMoveCore(store, core) || (tab.type === 'agent' && !store.get(agentWindowListenersReadyAtom))) return { ok: false, error: '目标窗口尚未就绪' }
  if (store.get(tabsAtom).some(item => item.id === tab.id || (item.type === tab.type && item.sessionId === tab.sessionId))) return { ok: false, error: '目标窗口已有此标签' }
  const draft = readMoveDraft(store, tab)
  if ((draft.draft && draft.draft !== tab.draft) || (draft.draftHtml && draft.draftHtml !== tab.draftHtml)) return { ok: false, error: '目标窗口有不同的未发送草稿，未覆盖' }
  applyInitialWindowTab(store, tab)
  move.imported = { request, item: store.get(tabsAtom).find(item => item.id === tab.id)!, previousDraft: draft }
  store.set(activeViewAtom, 'conversations')
  store.set(automationFormAtom, { open: false, draft: null })
  await window.electronAPI.reportWindowSessions(collectWindowSessions(store.get(tabsAtom)))
  return matchesMoveCore(store, core) ? { ok: true } : { ok: false, error: '目标窗口 Core 已变化' }
}

/** 主进程确认目标已实际承载后发来 commit；源端最后再检查一次输入与子标签，不丢新编辑。 */
export function releaseWindowSessionMove(store: Store, event: WindowTabHandoffEvent, sync: SyncMovedTab): void {
  if (event.status !== 'committed' || event.sourceGeneration === undefined || !matchesMoveCore(store, { ...event.sourceCore, generation: event.sourceGeneration })) return
  if (!consumePreparedMove(store, event.handoffId, event.tab)) return
  const snapshot = snapshotSessionForMove(store, event.tab)
  if (!('tab' in snapshot)) return
  const tab = snapshot.tab
  if (!sameMovedSnapshot(tab, event.tab)) return
  detachMovedTab(store, tab, sync)
  clearMovedDraft(store, tab)
}

export function AppWindowsInitializer(): null {
  const store = useStore()
  const sync = useSyncActiveTabSideEffects()
  const syncRef = useRef(sync)
  syncRef.current = sync
  useEffect(() => {
    let disposed = false
    const stopHandoffs = window.electronAPI.onWindowTabHandoff(event => {
      if (event.existingWindowMove) releaseWindowSessionMove(store, event, syncRef.current)
      else receiveHandoff(store, event)
    })
    const stopPrepare = window.electronAPI.onPrepareWindowSessionMove(request => prepareWindowSessionMove(store, request))
    const stopAccept = window.electronAPI.onAcceptWindowSessionMove(request => acceptWindowSessionMove(store, request))
    let receivedSnapshot = false
    const unsubscribe = window.electronAPI.onAppWindowsChanged(windows => {
      receivedSnapshot = true
      store.set(appWindowsAtom, windows)
    })
    void getWindowBootstrap().then(bootstrap => {
      if (disposed) return
      if (!receivedSnapshot) store.set(appWindowsAtom, bootstrap.openWindows)
      for (const event of bootstrap.recoverableHandoffs ?? []) receiveHandoff(store,event,true)
    })
    // 不把恢复过程中的空 Tab 列表上报，避免覆盖主进程的交接关联。
    const report = (): void => {
      if (!store.get(windowBootstrapAtom) || store.get(coreSessionNavigationPhaseAtom) !== 'ready') return
      void window.electronAPI.reportWindowSessions(collectWindowSessions(store.get(tabsAtom))).catch(console.error)
    }
    const stopRecovery = subscribeHandoffRecovery(store)
    const stops = [tabsAtom, windowBootstrapAtom, coreSessionNavigationPhaseAtom].map(item => store.sub(item, report))
    report()
    return () => { disposed = true; stopHandoffs(); stopPrepare(); stopAccept(); stopRecovery(); unsubscribe(); stops.forEach(stop => stop()) }
  }, [store])
  return null
}
