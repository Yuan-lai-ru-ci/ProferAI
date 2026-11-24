import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { initializeCoreSessionNavigation } from './core-session-navigation'
import { receiveHandoff, retryFailedHandoffs, subscribeHandoffRecovery } from './window-tab-handoff'
import { coreSessionNavigationPhaseAtom, coreTargetsAtom } from '../atoms/core-target-atoms'
import { tabsAtom } from '../atoms/tab-atoms'
import { agentSessionDraftsAtom } from '../atoms/agent-atoms'
import type { AgentSessionMeta, WindowTabHandoffEvent } from '@profer/shared'

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

test('bootstrap 慢目录前不ACK，导航ready后承载一次再ACK，重复迟到事件不删Tab', async () => {
  const store = createStore()
  const target = { currentId: 'local', generation: 0, targets: [{ id: 'local', name: 'local', kind: 'local' as const, status: 'connected' as const }] }
  store.set(coreTargetsAtom, target)
  const meta: AgentSessionMeta = { id: 'a', title: 'A', createdAt: 1, updatedAt: 1, agentRuntime: 'pi' }
  const event: WindowTabHandoffEvent = { handoffId: 'recovery', status: 'failed', sourceCore: { targetId: 'local' }, tab: { id: 'a', sessionId: 'a', title: 'A', type: 'agent', draft: 'saved' } }
  let release!: (items: AgentSessionMeta[]) => void
  const delayedCatalog = new Promise<AgentSessionMeta[]>(resolve => { release = resolve })
  const previous = globalThis.window
  let ack = 0
  globalThis.window = { electronAPI: { ackWindowTabHandoff: async () => {
    expect(store.get(tabsAtom).filter(tab => tab.sessionId === 'a')).toHaveLength(1)
    expect(store.get(agentSessionDraftsAtom).get('a')).toBe('saved')
    ack++
  } } } as unknown as Window & typeof globalThis
  const stop = subscribeHandoffRecovery(store)
  const nav = initializeCoreSessionNavigation(store, {
    isolated: true, getSettings: async () => ({ themeMode: 'system' }), listCoreTargets: async () => target,
    listAgentSessions: () => delayedCatalog, listConversations: async () => [], listWorkspaces: async () => [],
    updateSettings: async () => ({}), onFailure: error => { throw error },
  })
  try {
    receiveHandoff(store, event, true)
    await settle()
    expect(store.get(coreSessionNavigationPhaseAtom)).toBe('loading')
    expect(ack).toBe(0)
    release([meta])
    await nav.ready
    await settle()
    expect(ack).toBe(1)
    receiveHandoff(store, event, true)
    retryFailedHandoffs(store)
    expect(store.get(tabsAtom).filter(tab => tab.id === 'a')).toHaveLength(1)
    expect(ack).toBe(1)
    store.set(agentSessionDraftsAtom, new Map([['a', 'new']]))
    receiveHandoff(store, { ...event, handoffId: 'unknown', status: 'committed' })
    retryFailedHandoffs(store)
    expect(store.get(agentSessionDraftsAtom).get('a')).toBe('new')
  } finally { stop(); nav.dispose(); globalThis.window = previous }
})
