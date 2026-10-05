import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { capGoalLifecycle, GOAL_REASON_CODES, GOAL_STATUSES, isGoalTransitionAllowed, isValidGoalLimits, normalizeGoalReason } from '@profer/shared'
import type { AgentGoalState, AgentGoalStatus, AgentGoalReasonCode, AgentGoalIterationRecord, AgentGoalUsage } from '@profer/shared'
import { GOAL_HISTORY_LIMIT } from './goal-loop'

const CURRENT_SCHEMA_VERSION = 3
const FALLBACK_REASONS: Record<AgentGoalStatus, AgentGoalReasonCode> = {
  active: 'unknown', stopping: 'unknown', paused: 'user_pause', stopped: 'user_stop',
  blocked: 'blocked', failed: 'failed', completed: 'completed', budget_limited: 'budget_limited',
}

interface GoalStorePayload { version: number; goals: unknown[]; history?: unknown[] }

function nonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function validTimestamp(value: unknown): value is number { return nonNegativeInteger(value) && value <= 8_640_000_000_000_000 }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function evidence(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string') }
function validUsage(value: unknown): value is AgentGoalUsage {
  return record(value) && nonNegativeInteger(value.inputTokens) && nonNegativeInteger(value.outputTokens) && nonNegativeInteger(value.totalTokens)
}
function validHistoryRecord(value: unknown): value is AgentGoalIterationRecord {
  if (!record(value)) return false
  return nonNegativeInteger(value.iteration) && value.iteration > 0
    && nonNegativeInteger(value.startedAt) && nonNegativeInteger(value.finishedAt) && value.finishedAt >= value.startedAt
    && ['continue', 'complete', 'blocked'].includes(String(value.status))
    && typeof value.summary === 'string' && evidence(value.evidence)
    && (value.outcome === undefined || ['success', 'failed', 'stopped', 'deferred'].includes(String(value.outcome)))
    && (value.error === undefined || typeof value.error === 'string')
    && (value.usage === undefined || validUsage(value.usage))
}
function validStatus(value: unknown): value is AgentGoalStatus { return GOAL_STATUSES.includes(value as AgentGoalStatus) }
function validReason(value: unknown): value is AgentGoalReasonCode { return GOAL_REASON_CODES.includes(value as AgentGoalReasonCode) }
function validLifecycle(value: unknown, goalId: string, sessionId: string, stateRevision: number): boolean {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  let previousRevision = -1
  // 必须先验证完整事件数组，再裁剪；不能让被裁掉的非法事件绕过保存校验。
  for (const event of value) {
    if (!record(event) || !nonEmptyString(event.id) || ids.has(event.id)) return false
    if (event.goalId !== goalId || event.sessionId !== sessionId) return false
    if (event.from !== null && !validStatus(event.from)) return false
    if (event.to !== 'cleared' && !validStatus(event.to)) return false
    if (!isGoalTransitionAllowed(event.from, event.to) || !validReason(event.reason)) return false
    if (!nonNegativeInteger(event.revision) || event.revision <= previousRevision || event.revision > stateRevision) return false
    if (!validTimestamp(event.at)) return false
    if (event.runId !== undefined && typeof event.runId !== 'string') return false
    if (event.detail !== undefined && typeof event.detail !== 'string') return false
    ids.add(event.id)
    previousRevision = event.revision
  }
  return true
}
function isGoalState(value: unknown): value is AgentGoalState {
  if (!record(value)) return false
  if (!nonEmptyString(value.id) || !nonEmptyString(value.sessionId) || !nonEmptyString(value.goal) || !validStatus(value.status)) return false
  if (!nonNegativeInteger(value.iteration) || !nonNegativeInteger(value.consecutiveFailures) || !nonNegativeInteger(value.startedAt) || !nonNegativeInteger(value.updatedAt)) return false
  const limits = value.limits
  if (!isValidGoalLimits(limits)) return false
  if (value.waiting !== undefined && value.waiting !== 'plan_mode') return false
  if (value.retry !== undefined && (!record(value.retry) || !nonNegativeInteger(value.retry.attempt) || !nonNegativeInteger(value.retry.nextAt) || typeof value.retry.error !== 'string')) return false
  if (value.revision !== undefined && !nonNegativeInteger(value.revision)) return false
  if (value.lifecycle !== undefined && !validLifecycle(value.lifecycle, value.id, value.sessionId, value.revision ?? 1)) return false
  if (value.reasonCode !== undefined && !validReason(value.reasonCode)) return false
  if (value.elapsedMs !== undefined && !nonNegativeInteger(value.elapsedMs)) return false
  if (value.usage !== undefined && !validUsage(value.usage)) return false
  if (value.history !== undefined && (!Array.isArray(value.history) || !value.history.every(validHistoryRecord))) return false
  if (value.lastEvidence !== undefined && !evidence(value.lastEvidence)) return false
  for (const key of ['activeRunId', 'runtimeSessionId', 'runtimeSessionFile', 'blockedTodoId', 'lastSummary', 'stopReason', 'reasonDetail']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false
  }
  if (value.contract !== undefined) {
    if (!record(value.contract)) return false
    for (const key of ['verification', 'constraints', 'stopWhen']) {
      if (value.contract[key] !== undefined && typeof value.contract[key] !== 'string') return false
    }
  }
  return true
}

function sanitize(state: AgentGoalState): AgentGoalState {
  const history = Array.isArray(state.history) ? state.history.slice(-GOAL_HISTORY_LIMIT) : []
  // v1 没有净执行时间，只迁移可确认的历史轮次时长；不使用 startedAt 的墙钟时间。
  const elapsedMs = state.elapsedMs ?? (state.history ?? []).reduce((total, item) => total + item.finishedAt - item.startedAt, 0)
  return {
    ...state, history, revision: state.revision ?? 1, elapsedMs,
    // 旧快照不补造事件；重启暂停与 owner 清理由 Controller 负责。
    lifecycle: capGoalLifecycle(state.lifecycle ?? []),
    reasonCode: state.reasonCode ?? normalizeGoalReason(state.stopReason, FALLBACK_REASONS[state.status]),
    reasonDetail: state.reasonDetail ?? state.stopReason,
  }
}

function readPayload(filePath: string): GoalStorePayload | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const payload = parsed as Partial<GoalStorePayload>
    if (payload.version !== CURRENT_SCHEMA_VERSION && payload.version !== 1 && payload.version !== 2) return undefined
    if (!Array.isArray(payload.goals) || (payload.history !== undefined && !Array.isArray(payload.history))) return undefined
    return { version: payload.version, goals: payload.goals, history: Array.isArray(payload.history) ? payload.history : [] }
  } catch { return undefined }
}

export function loadGoalStates(filePath: string): AgentGoalState[] {
  const payload = readPayload(filePath)
  if (!payload) return []
  return payload.goals.filter(isGoalState).map(sanitize)
}

export function loadGoalHistory(filePath: string, sessionId?: string): AgentGoalState[] {
  const payload = readPayload(filePath)
  if (!payload?.history) return []
  return payload.history.filter(isGoalState).map(sanitize).filter((state) => sessionId === undefined || state.sessionId === sessionId)
}

function writePayload(filePath: string, payload: GoalStorePayload): void {
  // 损坏或未知版本不是空仓库：保留原文件，禁止恢复/保存默默覆盖数据。
  if (existsSync(filePath)) {
    const existing = readPayload(filePath)
    if (!existing || !existing.goals.every(isGoalState) || !(existing.history ?? []).every(isGoalState)) {
      throw new Error('Goal 状态文件损坏或版本不受支持，已保留原文件')
    }
  }
  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tempPath, filePath)
}

export function saveGoalStates(filePath: string, states: AgentGoalState[]): void {
  if (!states.every(isGoalState)) throw new Error('Goal 状态不符合持久化 schema')
  const existing = readPayload(filePath)
  writePayload(filePath, { version: CURRENT_SCHEMA_VERSION, goals: states.map(sanitize), history: existing?.history?.filter(isGoalState).map(sanitize) ?? [] })
}

/** 归档按 Goal id 去重；允许旧 Goal 归档，不依赖 sessionId 当前 live 槽位。 */
export function archiveGoalState(filePath: string, state: AgentGoalState): void {
  if (!isGoalState(state)) throw new Error('归档 Goal 不符合持久化 schema')
  const existing = readPayload(filePath)
  const history = (existing?.history?.filter(isGoalState).map(sanitize) ?? []).filter((item) => item.id !== state.id)
  const goals = existing?.goals?.filter(isGoalState).map(sanitize) ?? []
  // 清除快照与 live 移除同一次原子落盘，避免归档成功后退出又恢复旧目标。
  const live = state.reasonCode === 'cleared' || state.stopReason === 'cleared'
    ? goals.filter((item) => item.id !== state.id)
    : goals
  writePayload(filePath, { version: CURRENT_SCHEMA_VERSION, goals: live, history: [...history, sanitize(state)] })
}
