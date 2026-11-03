import type { AgentSessionMeta } from '@profer/shared'
import type { AgentSessionsIndex } from './contracts'

/**
 * 会话索引里体积最大的两个字段，只在 Pi 回退 / 分叉时才会被读取。
 *
 * 实测 1262 条会话的索引约 20MB，其中 `piFileCheckpoints` 11.7MB、`piEntryBindings`
 * 5.5MB，其余全部字段合计只有 1.5MB。它们留在索引里会让每次会话元数据更新都全量
 * 重写 20MB，并让列表 IPC 传输 20MB。这里把两者拆到独立文件，读取时在内存合并，
 * 调用方拿到的 `AgentSessionMeta` 形状不变。
 */
const PI_STATE_FIELDS = ['piEntryBindings', 'piFileCheckpoints'] as const

export type PiStateFields = Pick<AgentSessionMeta, (typeof PI_STATE_FIELDS)[number]>

export interface PiStateFile {
  version: number
  states: Record<string, PiStateFields>
}

export const PI_STATE_VERSION = 1

/** 索引文件旁的 Pi 状态文件路径：`agent-sessions.json` → `agent-sessions-pi-state.json`。 */
export function resolvePiStatePath(indexPath: string): string {
  return indexPath.endsWith('.json')
    ? `${indexPath.slice(0, -'.json'.length)}-pi-state.json`
    : `${indexPath}-pi-state.json`
}

export function pickPiState(meta: AgentSessionMeta): PiStateFields | null {
  const picked: PiStateFields = {}
  if (meta.piEntryBindings !== undefined) picked.piEntryBindings = meta.piEntryBindings
  if (meta.piFileCheckpoints !== undefined) picked.piFileCheckpoints = meta.piFileCheckpoints
  return Object.keys(picked).length > 0 ? picked : null
}

/** 把索引拆成「轻量索引」与「Pi 状态」两份。未携带 Pi 字段的会话对象保持原引用。 */
export function splitSessionIndex(index: AgentSessionsIndex): { light: AgentSessionsIndex; pi: PiStateFile } {
  const states: Record<string, PiStateFields> = {}
  let strippedAny = false
  const sessions = index.sessions.map((session) => {
    const pi = pickPiState(session)
    if (!pi) return session
    strippedAny = true
    states[session.id] = pi
    const { piEntryBindings: _entryBindings, piFileCheckpoints: _fileCheckpoints, ...rest } = session
    return rest as AgentSessionMeta
  })
  return {
    light: strippedAny ? { ...index, sessions } : index,
    pi: { version: PI_STATE_VERSION, states },
  }
}

/** 把 Pi 状态合并回轻量索引。没有对应条目的会话保持原引用。 */
export function mergeSessionIndex(light: AgentSessionsIndex, pi: PiStateFile | null): AgentSessionsIndex {
  if (!pi) return light
  const states = pi.states
  if (!states || typeof states !== 'object' || Object.keys(states).length === 0) return light
  let mergedAny = false
  const sessions = light.sessions.map((session) => {
    const state = states[session.id]
    if (!state || typeof state !== 'object') return session
    mergedAny = true
    return { ...session, ...state }
  })
  return mergedAny ? { ...light, sessions } : light
}

/** 解析出的 Pi 状态文件是否可用；损坏或形状不对时按空状态降级。 */
export function isPiStateFile(value: unknown): value is PiStateFile {
  if (!value || typeof value !== 'object') return false
  const candidate = value as PiStateFile
  return Boolean(candidate.states) && typeof candidate.states === 'object'
}
