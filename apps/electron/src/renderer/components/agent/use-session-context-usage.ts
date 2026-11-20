import { useAtomValue } from 'jotai'
import { coreTargetsAtom, ownsCoreResources } from '@/atoms/core-target-atoms'
import { useEffect, useMemo, useState } from 'react'
import type { AgentContextUsageSnapshot } from '@profer/shared'

type LiveUsage = Partial<AgentContextUsageSnapshot> & { isCompacting?: boolean; running?: boolean }

/** 每次读取独占回调；切换会话或实时读数到达后的迟到响应直接丢弃。 */
export function readSessionContextUsage(
  sessionId: string,
  read: ((id: string) => Promise<AgentContextUsageSnapshot | null>) | undefined,
  publish: (snapshot: AgentContextUsageSnapshot) => void,
): () => void {
  let active = true
  void read?.(sessionId).then(usage => {
    if (active && usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens > 0) publish(usage)
  }).catch(() => { /* 旧宿主或快照不可读时保持隐藏。 */ })
  return () => { active = false }
}

export function useSessionContextUsage(sessionId: string, live?: LiveUsage | null): AgentContextUsageSnapshot | null {
  const target = useAtomValue(coreTargetsAtom)
  const coreOwned = ownsCoreResources(target)
  const { inputTokens, outputTokens, contextWindow, cacheReadTokens, cacheCreationTokens, usageUpdatedAt } = live ?? {}
  const current = useMemo(() => inputTokens != null && Number.isSafeInteger(inputTokens) && inputTokens > 0
    ? { inputTokens, outputTokens, contextWindow, cacheReadTokens, cacheCreationTokens, usageUpdatedAt }
    : null, [inputTokens, outputTokens, contextWindow, cacheReadTokens, cacheCreationTokens, usageUpdatedAt])
  // 每次会话切换、实时值消失或压缩结束都重新读取，不复用上一次请求的结果。
  const hasCurrent = current !== null
  const compacting = !!live?.isCompacting
  const running = !!live?.running
  const request = useMemo(() => ({ sessionId }), [sessionId, hasCurrent, compacting, running, target.currentId, target.generation])
  const [saved, setSaved] = useState<{ request: typeof request; usage: AgentContextUsageSnapshot } | null>(null)
  useEffect(() => {
    if (coreOwned || hasCurrent || !request.sessionId) return
    return readSessionContextUsage(request.sessionId, window.electronAPI.getAgentContextUsageSnapshot,
      usage => setSaved({ request, usage }))
  }, [request, hasCurrent, coreOwned])
  if (coreOwned) return null
  return current ?? (saved?.request === request ? saved.usage : null)
}
