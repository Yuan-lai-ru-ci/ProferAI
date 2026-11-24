import type { createStore } from 'jotai'
import { agentObservedActivityAtom, agentSessionsAtom, agentStreamingStatesAtom, visibleAgentViewsAtom, type AgentStreamState, type ObservedAgentActivity } from '@/atoms/agent-atoms'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'

/** No stream subscription, replay, owner claim, completion or notification side effects here. */
export function installAgentActivityObserver(store: ReturnType<typeof createStore>, host: {
  read: (id: string) => Promise<boolean>
  subscribe: (invalidate: (id: string) => void) => () => void
  isVisible: () => boolean
  onReveal: (refresh: () => void) => () => void
  every: (poll: () => void, ms: number) => () => void
  now: () => number
}) {
  const pollMs = 5000
  const deferred = new Set<string>()
  let disposed = false
  let visible = new Set<string>()
  let known = new Set<string>()
  const reads = new Map<string, { dirty: boolean }>()
  const idleProof = new Map<string, { state: AgentStreamState; since: number }>()
  const publish = (id: string, value: ObservedAgentActivity | undefined) => store.set(agentObservedActivityAtom, prev => {
    if (prev.get(id) === value) return prev
    const next = new Map(prev)
    if (value) next.set(id, value); else next.delete(id)
    return next
  })
  const read = (id: string, supersede = false) => {
    if (disposed) return
    if (!host.isVisible()) {
      // A hidden invalidation also fences off a read started before the signal.
      if (supersede) reads.delete(id)
      deferred.add(id)
      return
    }
    deferred.delete(id)
    const pending = reads.get(id)
    if (pending) { if (supersede) pending.dirty = true; return }
    const token = { dirty: false }
    reads.set(id, token)
    const state = store.get(agentStreamingStatesAtom).get(id)
    const core = store.get(coreTargetsAtom)
    const selected = core.targets.find(t => t.id === core.currentId)
    if ((core.currentId !== 'local' || selected?.independent) && selected?.status !== 'connected') {
      reads.delete(id); idleProof.delete(id); publish(id, 'unknown')
      return
    }
    void (async () => {
      let value: ObservedAgentActivity = 'unknown'
      try { const active = await host.read(id); if (typeof active === 'boolean') value = active ? 'active' : 'inactive' } catch { /* disconnected / missing detail, not an idle confirmation */ }
      if (disposed || reads.get(id) !== token) return
      reads.delete(id)
      if (token.dirty) { read(id); return }
      if (store.get(agentStreamingStatesAtom).get(id) !== state) return // run changed while query was in flight
      if (state?.running && value === 'inactive') {
        // A negative detail can race optimistic startup or the owner's real STREAM_COMPLETE.
        // Require two separated confirmations for the exact unchanged state. Keep content/approvals intact.
        const proof = idleProof.get(id)
        if (!state.stopping && !state.backgroundWaiting && proof?.state === state && host.now() - proof.since >= pollMs) {
          store.set(agentStreamingStatesAtom, prev => new Map(prev).set(id, { ...state, running: false, awaitingOwnerTerminal: true, isCompacting: false, compactInFlight: false }))
          idleProof.delete(id)
        } else if (proof?.state !== state) idleProof.set(id, { state, since: host.now() })
      } else idleProof.delete(id)
      publish(id, value)
    })()
  }
  const refresh = () => {
    if (!host.isVisible()) return
    const ids = new Set([...visible, ...deferred])
    deferred.clear()
    for (const id of ids) read(id, true)
  }
  const updateVisible = () => {
    const next = new Set(store.get(visibleAgentViewsAtom).keys())
    const parents = new Set(next)
    // Also observe the delegated children whose activity is displayed in the visible parent.
    const sessions = store.get(agentSessionsAtom)
    known = new Set(sessions.map(meta => meta.id))
    for (const meta of sessions) {
      if (meta.parentSessionId && parents.has(meta.parentSessionId) && meta.sourceDelegationId && meta.delegationStatus === 'running') next.add(meta.id)
    }
    const before = visible
    visible = next
    for (const id of next) if (!before.has(id)) read(id, true)
  }
  const forget = (id: string) => { deferred.delete(id); reads.delete(id); idleProof.delete(id); publish(id, undefined) }
  let lastCore = ''
  const updateCore = () => {
    const core = store.get(coreTargetsAtom)
    const selected = core.targets.find(target => target.id === core.currentId)
    const key = JSON.stringify([core.currentId, core.generation, core.startup, selected?.coreId, selected?.independent, selected?.status])
    if (key === lastCore) return
    lastCore = key
    reads.clear(); idleProof.clear(); deferred.clear(); store.set(agentObservedActivityAtom, new Map())
    refresh()
  }
  const cleanups = [store.sub(visibleAgentViewsAtom, updateVisible), store.sub(agentSessionsAtom, updateVisible), store.sub(coreTargetsAtom, updateCore),
    host.onReveal(refresh), host.subscribe(id => {
      if (visible.has(id) || known.has(id)) read(id, true)
    }), host.every(() => {
      if (!host.isVisible()) return
      for (const id of visible) {
        const status = store.get(agentObservedActivityAtom).get(id)
        const owner = store.get(agentStreamingStatesAtom).get(id)
        if (status !== 'inactive' || owner?.running || owner?.backgroundWaiting || owner?.stopping) read(id)
      }
    }, pollMs)]
  updateCore(); updateVisible()
  return { forget, dispose: () => { disposed = true; for (const cleanup of cleanups) cleanup(); reads.clear(); idleProof.clear() } }
}
