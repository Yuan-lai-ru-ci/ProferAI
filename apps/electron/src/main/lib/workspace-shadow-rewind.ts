/**
 * 把工作区回退接到「当前 session 回退」上（Phase 4）。
 *
 * 职责分两半，都是为了不把会话层和文件层搅在一起：
 * - `resolveWorkspaceShadowRewind`：只读，算出「要撤哪些 turn、会动哪些文件」；
 * - `applyWorkspaceShadowRewind`：串行执行每个 turn 的逆向 patch。
 *
 * 顺序必须是**从新到旧**：turn N 的 `before` 就是 turn N-1 的 `after`，
 * 倒着撤完，最终状态等于最早那个 turn 的 `before`。反过来会把中间态当成基线。
 */

import type { RewindFilePlanItem } from '@profer/shared'
import { readShadowTurnAttributions, type ShadowTurnAttributionRecord } from '@profer/session-store'
import { getAgentSessionMeta } from './agent-session-manager'
import { getWorkspaceShadowDir } from './workspace-shadow-git'
import { restoreWorkspaceShadowTurn, type RestoreWorkspaceShadowTurnResult } from './workspace-shadow-restore'

export interface WorkspaceShadowRewindResolution {
  /** 该会话有 Shadow Git 归属记录、且能定位到目标边界时才为 true。 */
  available: boolean
  reason?: string
  workspaceId?: string
  /** 需要撤销的 turn，按时间正序（执行时由调用方倒序）。 */
  turns: string[]
  items: RewindFilePlanItem[]
  counts: { restore: number; delete: number; keep: number }
}

export interface ApplyWorkspaceShadowRewindResult {
  ok: boolean
  restoredPaths: string[]
  deletedPaths: string[]
  /** 因重合/用户已改而保留的文件（用于轻量提示，不阻塞用户）。 */
  keptPaths: string[]
  restoreIds: string[]
  turns: string[]
  error?: string
}

function emptyResolution(reason: string): WorkspaceShadowRewindResolution {
  return { available: false, reason, turns: [], items: [], counts: { restore: 0, delete: 0, keep: 0 } }
}

/**
 * 边界由会话层换算后传进来（`fromTurnIndex` = 最后保留那轮的下标 + 1）。
 *
 * 不在这里解析 RewindTarget：会话层的 turn 标识是 `${sessionId}-T{n}` 这类合成 id，
 * 而归属记录里的 turnId 是用户消息 uuid。两套词表各解一次必然错位，
 * 所以边界只算一次，文件侧只负责按顺序切片。
 */
function recordsFrom(records: ShadowTurnAttributionRecord[], fromTurnIndex: number): ShadowTurnAttributionRecord[] {
  return records.slice(Math.max(0, fromTurnIndex))
}

/** 单条变化 → 计划动作。判定口径与 reverse-patch 一致，但不读文件。 */
function planActionFor(record: ShadowTurnAttributionRecord, change: ShadowTurnAttributionRecord['changes'][number]): {
  action: RewindFilePlanItem['action']
  reason: string
} {
  if (change.attribution !== 'confirmed') return { action: 'keep', reason: 'unconfirmed-change' }
  if (change.rootIntroduced) return { action: 'keep', reason: 'root-introduced' }
  // partial 记录只恢复、不删除：撤销「新建」等于删除文件，不能做。
  if (record.partial && change.status === 'added') return { action: 'keep', reason: 'partial-evidence' }
  // 树差异说是新增，但写入前已有内容：那是用户自己建的文件，撤销「新建」会删掉它。
  // 口径必须与 reverse-patch 的 keep-current 一致，否则弹窗统计的 delete 比实际做得多。
  if (change.status === 'added' && change.preexisting) return { action: 'keep', reason: 'preexisting-file' }
  if (change.status === 'added') return { action: 'delete', reason: 'agent-created' }
  return { action: 'restore', reason: 'agent-changed' }
}

export async function resolveWorkspaceShadowRewind(input: {
  sessionId: string
  /** 需要撤销的第一轮在会话 turn 序列里的下标。 */
  fromTurnIndex: number
}): Promise<WorkspaceShadowRewindResolution> {
  const meta = getAgentSessionMeta(input.sessionId)
  const workspaceId = meta?.workspaceId
  if (!workspaceId) return emptyResolution('当前会话没有绑定工作区')

  const records = readShadowTurnAttributions(getWorkspaceShadowDir(workspaceId), { sessionId: input.sessionId })
  if (records.length === 0) return emptyResolution('该会话还没有文件变化记录')

  const scoped = recordsFrom(records, input.fromTurnIndex)
  if (scoped.length === 0) {
    return { available: true, workspaceId, turns: [], items: [], counts: { restore: 0, delete: 0, keep: 0 } }
  }

  // 同一路径可能被多轮改过。按「从新到旧」取第一次出现：
  // 那才是回退完成后的净效果，重复条目会让用户看到同一文件出现好几次。
  const items: RewindFilePlanItem[] = []
  const seen = new Set<string>()
  const counts = { restore: 0, delete: 0, keep: 0 }
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const record = scoped[index]!
    for (const change of record.changes) {
      const key = `${change.rootId}\u0000${change.path}`
      if (seen.has(key)) continue
      seen.add(key)
      const planned = planActionFor(record, change)
      counts[planned.action === 'keep' ? 'keep' : planned.action === 'delete' ? 'delete' : 'restore'] += 1
      items.push({
        itemId: `shadow:${change.rootId}:${change.path}`,
        path: change.absolutePath || change.path,
        rootId: change.rootId,
        relativePath: change.path,
        action: planned.action,
        evidence: 'tracked-write',
        reason: planned.reason,
      })
    }
  }

  return { available: true, workspaceId, turns: scoped.map((record) => record.turnId), items, counts }
}

/**
 * 逐个 turn 执行逆向 patch（**从新到旧**）。
 *
 * 中途失败就停：后续 turn 的 before 依赖前一轮的实际结果，
 * 带着不确定状态继续撤会把用户文件推到没人预测得了的位置。
 */
export async function applyWorkspaceShadowRewind(input: {
  sessionId: string
  workspaceId: string
  turns: string[]
}): Promise<ApplyWorkspaceShadowRewindResult> {
  const result: ApplyWorkspaceShadowRewindResult = {
    ok: true,
    restoredPaths: [],
    deletedPaths: [],
    keptPaths: [],
    restoreIds: [],
    turns: [],
  }
  for (let index = input.turns.length - 1; index >= 0; index -= 1) {
    const turnId = input.turns[index]!
    const applied: RestoreWorkspaceShadowTurnResult = await restoreWorkspaceShadowTurn({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId,
    })
    if (!applied.ok) {
      return {
        ...result,
        ok: false,
        error: applied.error ?? `回退 ${turnId} 失败`,
      }
    }
    result.turns.push(turnId)
    if (applied.restoreId) result.restoreIds.push(applied.restoreId)
    for (const entry of applied.entries) {
      // skipped 里有「本来就是目标状态」的情形，不算冲突，不往用户提示里塞。
      if (entry.action === 'restore') result.restoredPaths.push(entry.path)
      else if (entry.action === 'delete') result.deletedPaths.push(entry.path)
      else if (entry.action === 'keep-current') result.keptPaths.push(entry.path)
    }
  }
  // 同一文件可能被多轮改过：结果里保留第一次出现（从新到旧），别让用户看到重复条目。
  result.restoredPaths = [...new Set(result.restoredPaths)]
  result.deletedPaths = [...new Set(result.deletedPaths.filter((path) => !result.restoredPaths.includes(path)))]
  result.keptPaths = [
    ...new Set(result.keptPaths.filter((path) => !result.restoredPaths.includes(path) && !result.deletedPaths.includes(path))),
  ]
  return result
}
