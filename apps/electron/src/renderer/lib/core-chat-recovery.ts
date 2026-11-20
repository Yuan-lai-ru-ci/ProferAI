import type { createStore } from 'jotai/vanilla'
import type { CoreChatSnapshot } from '../../types/core-chat'
import { coreTargetsAtom } from '../atoms/core-target-atoms'
import { conversationsAtom, streamingStatesAtom, chatMessageRefreshAtom, chatStreamErrorsAtom } from '../atoms/chat-atoms'

type Store = ReturnType<typeof createStore>
/** 快照是服务端运行权威；只恢复仍活跃的 run，绝不自动重发请求。 */
export function applyCoreChatSnapshot(store: Store, snapshot: CoreChatSnapshot, cancelPending: (id: string) => void): boolean {
  const target = store.get(coreTargetsAtom)
  if (snapshot.targetId !== target.currentId || snapshot.generation !== target.generation) return false
  const coreId = target.targets.find(item => item.id === target.currentId)?.coreId
  if (!coreId) return false
  const prefix = `core-chat:${encodeURIComponent(coreId)}:`
  const conversations = snapshot.conversations.filter(item => item.id.startsWith(prefix))
  const runs = new Map(snapshot.activeRuns.filter(run => run.conversationId.startsWith(prefix)).map(run => [run.conversationId, run.runId]))
  const refresh = new Set([...conversations.map(item => item.id), ...runs.keys()])
  store.set(streamingStatesAtom, previous => {
    const next = new Map(previous)
    for (const [id, state] of previous) {
      if (!id.startsWith(prefix)) continue
      cancelPending(id)
      refresh.add(id)
      if (runs.get(id) !== state.runId) next.delete(id)
    }
    for (const [id, runId] of runs) {
      const state = next.get(id)
      next.set(id, state?.runId === runId ? { ...state, streaming:true } : { runId, streaming:true, content:'', reasoning:'', toolActivities:[], startedAt:Date.now() })
    }
    return next
  })
  store.set(conversationsAtom, conversations)
  store.set(chatStreamErrorsAtom, previous => {
    const next = new Map(previous)
    for (const id of refresh) next.delete(id)
    return next
  })
  store.set(chatMessageRefreshAtom, previous => {
    const next = new Map(previous)
    for (const id of refresh) next.set(id, (next.get(id) ?? 0) + 1)
    return next
  })
  return true
}

export function markCoreChatDisconnected(store: Store, cancelPending: (id: string) => void): void {
  const target = store.get(coreTargetsAtom)
  const selected = target.targets.find(item => item.id === target.currentId)
  if (selected?.status === 'connected' || !selected?.coreId) return
  const prefix = `core-chat:${encodeURIComponent(selected.coreId)}:`
  const affected = [...store.get(streamingStatesAtom)].filter(([id, state]) => id.startsWith(prefix) && state.streaming)
  if (!affected.length) return
  store.set(streamingStatesAtom, previous => {
    const next = new Map(previous)
    for (const [id, state] of affected) { cancelPending(id); next.set(id, { ...state, streaming:false }) }
    return next
  })
  store.set(chatStreamErrorsAtom, previous => {
    const next = new Map(previous)
    for (const [id] of affected) next.set(id, 'Core 连接已中断；未自动重发，重新连接后将恢复服务端状态')
    return next
  })
}
