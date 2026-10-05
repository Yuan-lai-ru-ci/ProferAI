import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { VISUALIZATION_LIMITS, type VisualizationContent, type VisualizationRecord, type VisualizationViewState } from '@profer/shared'
import { chooseVisualizationInstances } from '@/lib/visualization-lifecycle'
import { readPersistedVisualizationHeight } from '@/lib/visualization-height-store'

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

export interface VisualizationCandidate {
  id: string
  distance: number
  focused: boolean
  /** 此刻已经渲染出内容的实例：滚动时预算不该把它换掉（否则正在看的那一个会中途变回占位）。 */
  live: boolean
}
export const visualizationCandidatesAtom = atom<Map<string, VisualizationCandidate>>(new Map())
export const visualizationViewStatesAtom = atom<Map<string, VisualizationViewState>>(new Map())

/** 保留轻量高度，回收 iframe 后避免长结果收缩导致会话位置跳变。 */
export const visualizationHeightsAtom = atom<Map<string, number>>(new Map())

/**
 * 已读回的内容缓存（按 `visualizationStateKey`）。
 *
 * 修订内容是内容寻址（revision = 内容 hash）且不可变，所以命中即可直接渲染：
 * 重新进入视口时不必再等一次 IPC 往返，否则滚动中会先空一段再出现。
 * 只做缓存，渲染仍然只靠 state，不引入第二份真源。
 */
export const visualizationContentCacheAtom = atom<Map<string, VisualizationContent>>(new Map())

export function cacheVisualizationContent(previous: Map<string, VisualizationContent>, key: string, content: VisualizationContent): Map<string, VisualizationContent> {
  if (previous.get(key) === content) return previous
  const next = new Map(previous)
  next.delete(key)
  next.set(key, content)
  while (next.size > VISUALIZATION_LIMITS.maxCachedContents) next.delete(next.keys().next().value!)
  return next
}

const EMPTY_VIEW_STATE: VisualizationViewState = Object.freeze({})

/**
 * 按 id / key 切片订阅（与 `agentSession*AtomFamily` 同一范式）。
 *
 * 直接 `useAtomValue(visualizationCandidatesAtom)` 会让**每个**可视化组件订阅整张 Map：
 * 上下滚动时候选距离每跨一个 64px 就换一次 Map，于是整段会话里每个可视化都重渲染；
 * 片段每次 `setState`、每次高度上报同样会拉起全部实例。这里把派生值收敛成
 * 「这一格是否还活着/是否选中/高度多少/状态是什么」，jotai 用 Object.is 比较派生值，
 * 没变的实例不会重渲染。
 */
export const visualizationCandidatePresentAtomFamily = atomFamily((candidateId: string) =>
  atom((get) => get(visualizationCandidatesAtom).has(candidateId)))

export const visualizationSelectedAtomFamily = atomFamily((candidateId: string) =>
  atom((get) => chooseVisualizationInstances(get(visualizationCandidatesAtom).values()).has(candidateId)))

/**
 * 内存里没有量过的高度时回落到 localStorage 里的上次结果：
 * 重启后首次挂载不必再用 240px 占位、过一会儿才跳成真实高度（那一下会让整段会话位移）。
 */
export const visualizationHeightAtomFamily = atomFamily((key: string) =>
  atom((get) => get(visualizationHeightsAtom).get(key) ?? readPersistedVisualizationHeight(key)))

export const visualizationViewStateAtomFamily = atomFamily((key: string) =>
  atom((get) => get(visualizationViewStatesAtom).get(key) ?? EMPTY_VIEW_STATE))
