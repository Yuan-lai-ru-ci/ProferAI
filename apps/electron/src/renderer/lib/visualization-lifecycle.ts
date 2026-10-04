import { VISUALIZATION_LIMITS } from '@profer/shared'
import type { VisualizationCandidate } from '@/atoms/visualization-atoms'

/** 可见实例共享一个预算；操作中的结果优先，不能为每个 iframe 各设一份预算。 */
export function chooseVisualizationInstances(candidates: Iterable<VisualizationCandidate>, limit = VISUALIZATION_LIMITS.maxActiveInstances): Set<string> {
  return new Set([...candidates].sort((a, b) => Number(b.focused) - Number(a.focused) || a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, Math.max(0, limit)).map((candidate) => candidate.id))
}
export function visualizationStateKey(sessionId: string, id: string, revision: string): string {
  return JSON.stringify([sessionId, id, revision])
}
