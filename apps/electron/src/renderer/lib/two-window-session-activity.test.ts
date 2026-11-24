import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { agentObservedActivityAtom, agentStreamingStatesAtom, visibleAgentViewsAtom, allPendingPermissionRequestsAtom } from '../atoms/agent-atoms'
import { installAgentActivityObserver } from './agent-activity-observer'
import { settleCompletedAgentStreamState } from './agent-stream-state-cleanup'

test('one Core, two windows: missing the terminal hint in the observer does not leave its page running', async () => {
  const sid = 'same-session', left = createStore(), right = createStore()
  let coreActive = true, now = 0
  const ticks: (() => void)[] = [], signals: ((id: string) => void)[] = []
  const listeners = [left,right].map(store => installAgentActivityObserver(store, {
    read: async id => { expect(id).toBe(sid); return coreActive },
    isVisible: () => true, now: () => now,
    every: (tick, ms) => { expect(ms).toBe(5000); ticks.push(tick); return () => {} },
    subscribe: fn => { signals.push(fn); return () => {} }, onReveal: () => () => {},
  }))
  try {
    const approvals = left.get(allPendingPermissionRequestsAtom)
    const owned = { runId: 'r1', running: true, startedAt: 1, content: 'already streamed text', toolActivities: [] }
    right.set(agentStreamingStatesAtom,new Map([[sid,owned]]))
    for (const store of [left,right]) store.set(visibleAgentViewsAtom,new Map([[sid,1]]))
    await Promise.resolve()
    expect(left.get(agentObservedActivityAtom).get(sid)).toBe('active')
    expect(left.get(agentStreamingStatesAtom).has(sid)).toBe(false)
    coreActive = false
    right.set(agentStreamingStatesAtom,new Map([[sid,settleCompletedAgentStreamState(owned,false)]]))
    signals[1]!(sid) // The left window never receives this notification and never changes tab.
    await Promise.resolve()
    now += 5000; ticks[0]!(); await Promise.resolve()
    expect(left.get(agentObservedActivityAtom).get(sid)).toBe('inactive')
    expect(right.get(agentObservedActivityAtom).get(sid)).toBe('inactive')
    expect(left.get(agentStreamingStatesAtom).size).toBe(0)
    expect(left.get(allPendingPermissionRequestsAtom)).toBe(approvals)
  } finally { for (const observer of listeners) observer.dispose() }
})
