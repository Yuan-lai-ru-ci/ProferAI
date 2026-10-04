import { atom } from 'jotai'
import { VISUALIZATION_LIMITS, type VisualizationRecord, type VisualizationViewState } from '@profer/shared'

export const visualizationsAtom = atom<Map<string, VisualizationRecord[]>>(new Map())

/** 事件和首次加载共用合并：较旧投影不能覆盖后到的新修订。 */
export function mergeVisualizations(previous: VisualizationRecord[], incoming: VisualizationRecord[]): VisualizationRecord[] {
  const records = new Map(previous.map((record) => [record.id, record]))
  for (const record of incoming) {
    const current = records.get(record.id)
    if (!current || record.recordVersion > current.recordVersion) records.set(record.id, record)
  }
  return [...records.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function updateVisualizationSessionCache(previous: Map<string, VisualizationRecord[]>, sessionId: string, incoming: VisualizationRecord[]): Map<string, VisualizationRecord[]> {
  const next = new Map(previous)
  next.delete(sessionId)
  next.set(sessionId, mergeVisualizations(previous.get(sessionId) ?? [], incoming))
  while (next.size > VISUALIZATION_LIMITS.maxCachedSessions) next.delete(next.keys().next().value!)
  return next
}

export interface VisualizationCandidate { id: string; distance: number; focused: boolean }
export const visualizationCandidatesAtom = atom<Map<string, VisualizationCandidate>>(new Map())
export const visualizationViewStatesAtom = atom<Map<string, VisualizationViewState>>(new Map())

/** 保留轻量高度，回收 iframe 后避免长结果收缩导致会话位置跳变。 */
export const visualizationHeightsAtom = atom<Map<string, number>>(new Map())
