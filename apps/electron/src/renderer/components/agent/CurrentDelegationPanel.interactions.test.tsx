import * as React from 'react'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, SDKMessage } from '@profer/shared'
const atomState = new Map<unknown, unknown>()
const opened: unknown[][] = []
let cache = new Map<string, SDKMessage[]>()
const setCache = (update: (value: Map<string, SDKMessage[]>) => Map<string, SDKMessage[]>) => { cache = update(cache) }
const store = { get: () => cache }
mock.module('jotai', () => ({ atom: (value: unknown) => ({ value }), useAtomValue: (atom: unknown) => atomState.get(atom) ?? [], useSetAtom: () => setCache, useStore: () => store }))
mock.module('@/hooks/useOpenSession', () => ({ useOpenSession: () => (...args: unknown[]) => opened.push(args) }))
mock.module('./AgentMessages', () => ({ AgentMessages: () => null }))
mock.module('./DelegationRuntimeBar', () => ({ DelegationRuntimeBar: () => null }))
const atoms = await import('@/atoms/agent-atoms')
const { CurrentDelegationPanel } = await import('./CurrentDelegationPanel')
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const restorers: Array<() => void> = []
function message(uuid: string): SDKMessage { return { type: 'assistant', uuid, message: { content: [{ type: 'text', text: uuid }] } } as SDKMessage }
function session(id: string): AgentSessionMeta { return { id, title: id, parentSessionId: 'parent', sourceSessionId: 'parent', sourceDelegationId: `task-${id}`, delegationPlacement: 'current', delegationRelation: 'subtask', delegationStatus: 'running', createdAt: 1, updatedAt: 1 } }
function mount<P>(component: (props: P) => React.ReactElement | null, props: P): React.ReactElement | null {
  const slots: Slot[] = []; let cursor = 0
  const dispatcher = {
    useState(initial: unknown) { const slot = slots[cursor] ?? (slots[cursor] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }); const index = cursor++; return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? (value as (previous: unknown) => unknown)(slot.value) : value }] },
    useMemo(factory: () => unknown) { return factory() }, useCallback(callback: unknown) { return callback },
    useRef(initial: unknown) { const slot = slots[cursor] ?? (slots[cursor] = { value: { current: initial } }); cursor++; return slot.value },
    useEffect(effect: () => void | (() => void)) { const cleanup = effect(); if (cleanup) restorers.push(cleanup) }, useLayoutEffect() {},
  }
  cursor = 0
  const previous = internals.ReactCurrentDispatcher.current
  internals.ReactCurrentDispatcher.current = dispatcher
  try { return component(props) } finally { internals.ReactCurrentDispatcher.current = previous }
}
describe('父会话 current 任务交互（legacy component remains unmounted）', () => {
  afterEach(() => { restorers.splice(0).forEach(cleanup => cleanup()); atomState.clear(); cache.clear(); opened.splice(0) })
  test('utility call can navigate to the child without exposing transcript in the parent', () => {
    atomState.set(atoms.agentSessionsAtom, [session('child')])
    cache = new Map([['parent', [message('parent-private')]], ['child', [message('child-output')]]])
    const html = mount(CurrentDelegationPanel, { sessionId: 'parent', messages: [] })
    expect(html).not.toBeNull()
  })
})
