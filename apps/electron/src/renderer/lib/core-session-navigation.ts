import { atom, type createStore } from 'jotai/vanilla'
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
  const validChat = new Set(conversations.map(conversation => conversation.id))
  const tabs = (state?.tabs ?? []).filter((tab): tab is TabItem => Boolean(tab && typeof tab.id === 'string' && typeof tab.sessionId === 'string'
    && typeof tab.title === 'string' && (tab.type === 'agent' ? validAgent.has(tab.sessionId) : tab.type === 'chat' && target.currentId === 'local' && validChat.has(tab.sessionId))))
  const ids = new Set(tabs.map(tab => tab.id))
  const requested = state?.activeTabId ?? (state ? legacyActiveId(state) : null)
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
  const subscriptions = [tabsAtom, activeTabIdAtom, tabGroupsAtom, currentAgentWorkspaceIdAtom, currentAgentSessionIdAtom, currentConversationIdAtom].map(item => store.sub(item, saveSoon))
  subscriptions.push(store.sub(coreTargetsAtom, () => {
    const next = store.get(coreTargetsAtom)
    const nextKey = scopeKey(next)
    if (!loaded) { target = next; key = nextKey; return }
    if (nextKey === key && next.generation === target.generation) { target = next; return }
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
    if (initial.generation >= current.generation) store.set(coreTargetsAtom, initial)
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
