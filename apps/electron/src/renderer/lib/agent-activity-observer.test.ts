import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { allPendingPermissionRequestsAtom, agentObservedActivityAtom, agentSessionIndicatorMapAtom, agentSessionsAtom, agentStreamingStatesAtom, ownerSessionIndicatorMapAtom, visibleAgentViewsAtom, type AgentStreamState } from '@/atoms/agent-atoms'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import { countRunningDelegations } from '@/domains/agent-runtime/agent-runtime-display-policy'
import { resolveDelegationRuntimeDisplay } from '@/domains/agent-runtime/delegation-runtime-display'
import { installAgentActivityObserver } from './agent-activity-observer'
import { isCurrentAgentStreamCompletion, settleCompletedAgentStreamState } from './agent-stream-state-cleanup'

function harness() {
  const store = createStore()
  let now = 0, visible = true, ms = 0
  let poll = () => {}, focus = () => {}, invalidate = (_id: string) => {}
  const reads: { id: string; resolve: (active: boolean) => void; reject: () => void }[] = []
  const observer = installAgentActivityObserver(store, {
    read: id => new Promise((resolve, reject) => reads.push({ id, resolve, reject })),
    every: (cb, interval) => { poll = cb; ms = interval; return () => { poll = () => {} } },
    onReveal: cb => { focus = cb; return () => { focus = () => {} } },
    subscribe: cb => { invalidate = cb; return () => { invalidate = () => {} } },
    now: () => now, isVisible: () => visible,
  })
  return { store, reads, observer, invalidate, focus, tick: () => { now += ms; poll() }, setVisible: (v: boolean) => { visible = v },
    mount: (...ids: string[]) => store.set(visibleAgentViewsAtom, new Map(ids.map(id => [id, 1]))),
    status: (id: string) => store.get(agentObservedActivityAtom).get(id),
  }
}
const done = () => Promise.resolve()
const parent = { id: 'p', title: 'p', createdAt: 1, updatedAt: 1 }
const child = { ...parent, id: 'c', parentSessionId: 'p', sourceDelegationId: 'd', delegationStatus: 'running' as const }

describe('window-local read-only activity', () => {
  test('visible split panes and running children read immediately; only visible active/unknown pages poll', async () => {
    const h = harness()
    h.store.set(agentSessionsAtom, [parent, child]); h.mount('p', 'split')
    expect(h.reads.map(r => r.id)).toEqual(['p', 'split', 'c'])
    h.reads[0]!.resolve(false); h.reads[1]!.reject(); h.reads[2]!.resolve(true); await done()
    expect(h.store.get(agentStreamingStatesAtom).size).toBe(0)
    expect(h.store.get(ownerSessionIndicatorMapAtom).size).toBe(0)
    expect(h.store.get(agentSessionIndicatorMapAtom).get('c')).toBe('running')
    expect(h.status('split')).toBe('unknown')
    expect(resolveDelegationRuntimeDisplay({ ...child, observed: 'active', sessionUpdatedAt: 1, liveRunning: false, liveStartedAt: 123 })).toMatchObject({ phase: 'running', startedAt: undefined, live: false })
    h.setVisible(false); h.tick(); h.invalidate('c'); expect(h.reads.length).toBe(3)
    h.setVisible(true); h.tick(); expect(h.reads.slice(3).map(r => r.id)).toEqual(['split', 'c'])
    h.reads[3]!.resolve(false); h.reads[4]!.resolve(false); await done()
    const facts = h.store.get(agentObservedActivityAtom)
    expect(countRunningDelegations([parent, child], 'p', facts)).toBe(0)
    expect(resolveDelegationRuntimeDisplay({ ...child, observed: facts.get('c'), sessionUpdatedAt: 1, liveRunning: false }).label).toBe('子代理当前未运行')
    h.focus(); expect(h.reads.slice(5).map(r => r.id).sort()).toEqual(['c', 'p', 'split'])
    h.observer.dispose()
  })
  test('invalidations coalesce, stale Core/old round/in-flight unmount answers do not apply', async () => {
    const h = harness(); h.mount('p')
    h.invalidate('p'); h.invalidate('p'); expect(h.reads.length).toBe(1)
    h.reads[0]!.resolve(false); await done(); expect(h.status('p')).toBeUndefined(); expect(h.reads.length).toBe(2)
    h.store.set(coreTargetsAtom, prev => ({ ...prev, generation: prev.generation + 1 }))
    h.reads[1]!.resolve(true); await done(); expect(h.status('p')).toBeUndefined()
    const nextRun = { running: true, content: 'new', toolActivities: [], startedAt: 5 }
    h.store.set(agentStreamingStatesAtom, new Map([['p', nextRun]]))
    h.reads[2]!.resolve(false); await done(); expect(h.store.get(agentStreamingStatesAtom).get('p')).toBe(nextRun)
    expect(h.status('p')).toBeUndefined(); h.focus(); h.observer.dispose()
    h.reads[3]!.resolve(false); await done(); expect(h.status('p')).toBeUndefined()
  })
  test('remote disconnect marks visible status unknown without querying; reconnect drops the old in-flight answer', async () => {
    const h = harness(); h.mount('p')
    h.store.set(coreTargetsAtom, { currentId: 'remote', generation: 1, targets: [{ id: 'remote', kind: 'remote', name: 'r', status: 'disconnected' }] })
    expect(h.status('p')).toBe('unknown'); expect(h.reads.length).toBe(1)
    h.store.set(coreTargetsAtom, prev => ({ ...prev, targets: prev.targets.map(t => ({ ...t, status: 'connected' })) }))
    expect(h.reads.length).toBe(2); h.reads[1]!.resolve(true); h.reads[0]!.resolve(false); await done()
    expect(h.status('p')).toBe('active'); h.observer.dispose()
  })
  test('disconnected is unknown, reconnect immediately reads; two stable local idle proofs repair only flags', async () => {
    const h = harness()
    const state: AgentStreamState = { runId: 'old', running: true, content: 'unsaved text', startedAt: 1, toolActivities: [] }
    h.store.set(agentStreamingStatesAtom, new Map([['p', state]]))
    h.store.set(allPendingPermissionRequestsAtom, new Map([['p', [{ requestId: 'ask', sessionId: 'p', toolName: 'test', toolInput: {}, description: 'ask', dangerLevel: 'safe' }]]]))
    const approvals = h.store.get(allPendingPermissionRequestsAtom)
    h.mount('p'); h.reads[0]!.reject(); await done(); expect(h.status('p')).toBe('unknown')
    expect(h.store.get(agentStreamingStatesAtom).get('p')).toBe(state)
    h.store.set(coreTargetsAtom, prev => ({ ...prev, targets: prev.targets.map(t => ({ ...t, status: 'connected' })) }))
    h.reads[1]!.resolve(false); await done(); expect(h.store.get(agentStreamingStatesAtom).get('p')).toBe(state)
    h.invalidate('p'); h.reads[2]!.resolve(false); await done(); expect(h.store.get(agentStreamingStatesAtom).get('p')).toBe(state)
    h.tick(); h.reads[3]!.resolve(false); await done()
    const repaired = h.store.get(agentStreamingStatesAtom).get('p')!
    expect(repaired).toMatchObject({ content: 'unsaved text', running: false, runId: 'old' }); expect(repaired.toolActivities).toBe(state.toolActivities)
    expect(h.store.get(allPendingPermissionRequestsAtom)).toBe(approvals)
    expect(isCurrentAgentStreamCompletion(repaired, { runId: 'old' })).toBe(true)
    expect(isCurrentAgentStreamCompletion(repaired, { runId: 'new' })).toBe(false)
    expect(isCurrentAgentStreamCompletion(settleCompletedAgentStreamState(repaired, false), { runId: 'old' })).toBe(false)
    h.observer.dispose()
  })
})
