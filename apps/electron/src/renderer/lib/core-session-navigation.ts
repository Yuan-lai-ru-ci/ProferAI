import { atom, type createStore } from 'jotai/vanilla'
import { selectAtom } from 'jotai/vanilla/utils'
import type { AgentSessionMeta, AgentWorkspace, ConversationMeta } from '@profer/shared'
import type { AppSettings, CoreTabSettings, CoreTargetsSnapshot } from '../../types/settings'
import { activeTabIdAtom, ensureScratchPadTab, getPersistableTabState, SCRATCH_PAD_ID, tabMruAtom, tabsAtom, type TabItem } from '../atoms/tab-atoms'
import { fromPersistedTabGroup, fromPersistedTabGroups, reconcileTabGroups, tabGroupsAtom, toPersistedTabGroups } from '../atoms/tab-group-atoms'
import { agentSDKMessagesCacheAtom, agentSessionsAtom, agentWorkspacesAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom, resolvedBlobMessagesAtom } from '../atoms/agent-atoms'
import { conversationsAtom, currentConversationIdAtom } from '../atoms/chat-atoms'
import { coreChannelsAtom, coreChannelsLoadedAtom, coreSessionNavigationPhaseAtom, coreTargetsAtom } from '../atoms/core-target-atoms'
import { appModeAtom } from '../atoms/app-mode'
import { activeViewAtom } from '../atoms/active-view'
import { getVisibleAgentWorkspaces } from './product-feature-flags'

interface NavigationDeps {
  getSettings: () => Promise<AppSettings>
  listCoreTargets: () => Promise<CoreTargetsSnapshot>
  listConversations: () => Promise<ConversationMeta[]>
  listAgentSessions: () => Promise<AgentSessionMeta[]>
  listWorkspaces: () => Promise<AgentWorkspace[]>
  updateSettings: (patch: Partial<AppSettings>) => Promise<unknown>
  onFailure: (error: unknown) => void
}
type Store = ReturnType<typeof createStore>

/** 会话历史跟Core身份，而不是名称或连接URL走；本机保持既有local身份。 */
function scopeKey(target: CoreTargetsSnapshot): string {
  if (target.currentId === 'local') return 'local'
  const selected = target.targets.find(item => item.id === target.currentId)
  return selected?.coreId ? `core:${selected.coreId}` : `target:${target.currentId}`
}

function capture(store: Store): CoreTabSettings {
  const persistable = getPersistableTabState(store.get(tabsAtom), store.get(activeTabIdAtom))
  const activeId = store.get(activeTabIdAtom)
  const state = activeId === SCRATCH_PAD_ID ? { ...persistable, activeTabId: SCRATCH_PAD_ID }
    : activeId ? persistable : { ...persistable, activeTabId: null }
  const groups = toPersistedTabGroups(store.get(tabGroupsAtom), new Set(state.tabs.map(tab => tab.id)))
  return { ...state, workspaceId: store.get(currentAgentWorkspaceIdAtom), ...(groups.length ? { groups } : {}) }
}

function legacyActiveId(state: CoreTabSettings): string | null {
  const legacy = state as CoreTabSettings & { splitLayout?: { focusedPanelIndex?: number; panels?: {activeTabId?: string | null}[] } }
  const panels = legacy.splitLayout?.panels
  return panels?.[legacy.splitLayout?.focusedPanelIndex ?? 0]?.activeTabId ?? panels?.[0]?.activeTabId ?? null
}

/** 以所属Core的真实目录校验；不存在的记忆只移除，不替用户挑另一个业务会话。 */
function validate(state: CoreTabSettings | undefined, sessions: AgentSessionMeta[], conversations: ConversationMeta[], workspaces: AgentWorkspace[], target: CoreTargetsSnapshot): CoreTabSettings {
  const visible = new Set(getVisibleAgentWorkspaces(workspaces).map(workspace => workspace.id))
  const coreId = target.targets.find(item => item.id === target.currentId)?.coreId
  const owned = (id: string): boolean => target.currentId === 'local'
    ? !id.startsWith('core:') : Boolean(coreId && id.startsWith(`core:${encodeURIComponent(coreId)}:`))
  const validAgent = new Set(sessions.filter(session => owned(session.id) && session.workspaceId && visible.has(session.workspaceId)).map(session => session.id))
  const ownedChat = (id: string): boolean => id.startsWith('core-chat:')
    ? Boolean(coreId && id.startsWith(`core-chat:${encodeURIComponent(coreId)}:`))
    : target.currentId === 'local'
  const validChat = new Set(conversations.filter(conversation => ownedChat(conversation.id)).map(conversation => conversation.id))
  // 旧桌面 local Tab 用 rawId，迁入本机 Core 时只按目录中确实存在的同 rawId 恢复。
  const migratedIds = new Map<string, string>()
  const candidates = (state?.tabs ?? []).map(tab => {
    if (target.currentId !== 'local' || tab.type !== 'chat' || tab.sessionId.startsWith('core-chat:') || validChat.has(tab.sessionId)) return tab
    const match = conversations.find(item => item.id === `core-chat:${encodeURIComponent(coreId ?? '')}:${tab.sessionId}`)
    if (!match) return tab
    migratedIds.set(tab.id, match.id)
    return { ...tab, id: match.id, sessionId: match.id }
  })
  const tabs = candidates.filter((tab): tab is TabItem => Boolean(tab && typeof tab.id === 'string' && typeof tab.sessionId === 'string'
    && typeof tab.title === 'string' && (tab.type === 'agent' ? validAgent.has(tab.sessionId) : tab.type === 'chat' && validChat.has(tab.sessionId))))
  const ids = new Set(tabs.map(tab => tab.id))
  const oldRequested = state?.activeTabId ?? (state ? legacyActiveId(state) : null)
  const requested = oldRequested ? migratedIds.get(oldRequested) ?? oldRequested : null
  const activeTabId = requested === SCRATCH_PAD_ID ? SCRATCH_PAD_ID : requested && ids.has(requested) ? requested : null
  const active = tabs.find(tab => tab.id === activeTabId)
  const workspaceId = active?.type === 'agent' ? sessions.find(session => session.id === active.sessionId)?.workspaceId ?? null
    : state?.workspaceId && visible.has(state.workspaceId) ? state.workspaceId : null
  const groups = state?.groups?.length ? fromPersistedTabGroups(state.groups) : [fromPersistedTabGroup(state?.group)].filter(group => group !== null)
  return { tabs, activeTabId, workspaceId, groups: toPersistedTabGroups(reconcileTabGroups(groups, ids), ids) }
}

/** 一个write atom内更新所有导航状态，避免列表、选中项和Tab来自不同Core。 */
const applyNavigationAtom = atom(null, (_get, set, input: { state: CoreTabSettings; sessions: AgentSessionMeta[]; conversations: ConversationMeta[]; workspaces: AgentWorkspace[] }) => {
  const { state, sessions, conversations, workspaces } = input
  set(tabsAtom, ensureScratchPadTab(state.tabs))
  set(activeTabIdAtom, state.activeTabId)
  set(tabMruAtom, state.activeTabId ? [state.activeTabId] : [])
  set(tabGroupsAtom, fromPersistedTabGroups(state.groups ?? []))
  set(agentSessionsAtom, sessions)
  set(conversationsAtom, conversations)
  set(agentWorkspacesAtom, workspaces)
  set(currentAgentWorkspaceIdAtom, state.workspaceId ?? null)
  const active = state.tabs.find(tab => tab.id === state.activeTabId)
  set(currentAgentSessionIdAtom, active?.type === 'agent' ? active.sessionId : null)
  set(currentConversationIdAtom, active?.type === 'chat' ? active.sessionId : null)
  set(appModeAtom, active?.type === 'chat' ? 'chat' : 'agent')
})

// 启动时补入或重建 Scratch Pad 标签不算用户导航；显式选中它仍由 activeTabIdAtom 记录。
const navigationTabsAtom = selectAtom(tabsAtom, tabs => tabs.filter(tab => tab.id !== SCRATCH_PAD_ID),
  (before, after) => before.length === after.length && before.every((tab, i) => tab === after[i]))

/** 同时负责启动恢复、切换恢复及落盘；不再由侧栏和全局tabState各恢复一遍。 */
export function initializeCoreSessionNavigation(store: Store, deps: NavigationDeps) {
  let active = true
  let loaded = false
  let applying = false
  let canCapture = false
  let revision = 0
  let navigationRevision = 0
  store.set(coreSessionNavigationPhaseAtom, 'loading')
  let target = store.get(coreTargetsAtom)
  let key = scopeKey(target)
  let history: Record<string, CoreTabSettings> = {}
  let legacyKey: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes = Promise.resolve()
  const settingsPromise = deps.getSettings()
  const persist = (): Promise<void> => {
    const patch = { coreTabStates: structuredClone(history) }
    const request = writes.catch(() => undefined).then(() => deps.updateSettings(patch)).then(() => undefined)
    writes = request
    void request.catch(deps.onFailure)
    return request
  }
  const remember = (): void => {
    if (canCapture && !applying) history[key] = capture(store)
  }
  const saveSoon = (): void => {
    if (applying) return
    if (loaded && !canCapture) { navigationRevision += 1; return }
    if (!loaded || !canCapture) return
    remember()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void persist() }, 500)
  }
  const clear = (): void => {
    applying = true
    store.set(coreSessionNavigationPhaseAtom, 'loading')
    store.set(applyNavigationAtom, { state: {tabs:[],activeTabId:null}, sessions:[], conversations:[], workspaces:[] })
    store.set(coreChannelsAtom, [])
    store.set(coreChannelsLoadedAtom, null)
    store.set(agentSDKMessagesCacheAtom, new Map())
    store.set(resolvedBlobMessagesAtom, new Map())
    store.set(activeViewAtom, 'conversations')
    applying = false
  }
  const load = async (): Promise<void> => {
    const request = ++revision
    const requestedKey = key
    const requestedTarget = target
    canCapture = false
    clear()
    if (requestedTarget.startup === 'restoring') return
    const initialNavigationRevision = navigationRevision
    try {
      const [settings, sessions, conversations, workspaces] = await Promise.all([
        settingsPromise, deps.listAgentSessions(), deps.listConversations(), deps.listWorkspaces(),
      ])
      if (!active || request !== revision) return
      const legacy = requestedKey === legacyKey && settings.tabState
        ? { ...settings.tabState, ...(settings.scratchPadActive ? { activeTabId: SCRATCH_PAD_ID } : {}) } : undefined
      const candidate = navigationRevision !== initialNavigationRevision
        ? capture(store) : history[requestedKey] ?? (legacy as CoreTabSettings | undefined)
      const state = validate(candidate, sessions, conversations, workspaces, requestedTarget)
      applying = true
      store.set(applyNavigationAtom, { state, sessions, conversations, workspaces })
      store.set(coreSessionNavigationPhaseAtom, 'ready')
      applying = false
      canCapture = true
      history[requestedKey] = capture(store)
      saveSoon()
    } catch (error) {
      if (active && request === revision) {
        store.set(coreSessionNavigationPhaseAtom, 'error')
        deps.onFailure(error)
      }
    }
  }
  const subscriptions = [navigationTabsAtom, activeTabIdAtom, tabGroupsAtom, currentAgentWorkspaceIdAtom, currentAgentSessionIdAtom, currentConversationIdAtom].map(item => store.sub(item, saveSoon))
  subscriptions.push(store.sub(coreTargetsAtom, () => {
    const next = store.get(coreTargetsAtom)
    const nextKey = scopeKey(next)
    if (!loaded) { target = next; key = nextKey; return }
    if (nextKey === key && next.generation === target.generation) {
      const previous = target
      target = next
      const phase = store.get(coreSessionNavigationPhaseAtom)
      // 就绪或手动重连不一定改变 generation，普通延迟/状态广播不重载已打开的会话。
      if (phase !== 'ready' && ((previous.startup === 'restoring' && next.startup !== 'restoring')
        || (previous.targets.find(item => item.id === next.currentId)?.status !== 'connected'
          && next.targets.find(item => item.id === next.currentId)?.status === 'connected'))) void load()
      return
    }
    remember()
    if (timer) { clearTimeout(timer); timer = undefined }
    target = next
    key = nextKey
    void persist()
    void load()
  }))
  const ready = Promise.all([settingsPromise, deps.listCoreTargets()]).then(async ([settings, initial]) => {
    if (!active) return
    history = { ...settings.coreTabStates }
    const current = store.get(coreTargetsAtom)
    if ((initial.revision ?? initial.generation) >= (current.revision ?? current.generation)) store.set(coreTargetsAtom, initial)
    target = store.get(coreTargetsAtom)
    key = scopeKey(target)
    if (!settings.coreTabStates) legacyKey = key
    loaded = true
    await load()
  }).catch(error => { if (active) { store.set(coreSessionNavigationPhaseAtom, 'error'); deps.onFailure(error) } })
  return {
    ready,
    flush(): Promise<void> {
      if (!loaded) return Promise.resolve()
      if (timer) { clearTimeout(timer); timer = undefined }
      remember()
      return persist()
    },
    beforeUnload(): Partial<AppSettings> | null {
      if (!loaded) return null
      remember()
      return {coreTabStates: structuredClone(history)}
    },
    dispose(): void {
      active = false
      revision += 1
      subscriptions.forEach(stop => stop())
      if (timer) clearTimeout(timer)
    },
  }
}
