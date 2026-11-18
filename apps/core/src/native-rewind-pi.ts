import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RewindFilePlanItem, RewindTarget } from '@profer/shared'
import type { PiFileMutationEvidence, PiFileVersion, PiStoredFileVersion } from '@profer/agent-provider-pi'

export interface PiRewindTurn {
  turnId: string
  startedAt: number
  completedAt?: number
  terminalEntryId?: string
  terminal: boolean
  failed: boolean
}

export interface PiTrackedMutation {
  mutationId: string
  sessionId: string
  turnId: string
  sequence: number
  path: string
  toolCallId: string
  source: 'write' | 'edit'
  before?: PiFileVersion
  after?: PiFileVersion
  rootId?: string
  relativePath?: string
  coverage?: 'managed' | 'project'
  beforeBackup: PiStoredFileVersion
  afterBackup: PiStoredFileVersion
  evidence: 'controlled-write'
  completedAt: number
}

export interface PiRewindBoundary {
  available: boolean
  target: RewindTarget
  /** The last mutation sequence included by this boundary. */
  mutationSequence: number
  turnId?: string
  reason?: string
}

export interface PiRewindFilePlan {
  supported: boolean
  boundary: PiRewindBoundary
  items: RewindFilePlanItem[]
  reason?: string
}

export interface PiLegacyCheckpointCoverage {
  checkpointPath: string
  entryId?: string
  turnId?: string
  coverage: 'before-turn' | 'unknown'
  /** Legacy checkpoints cannot represent an after-turn state. */
  supportsAfterTurn: false
  reason: string
}

export interface PiRewindTracker {
  beginTurn(turnId: string, startedAt?: number): void
  completeTurn(turnId: string, terminalEntryId?: string, completedAt?: number): void
  failTurn(turnId: string, completedAt?: number): void
  recordMutation(turnId: string, evidence: PiFileMutationEvidence): PiTrackedMutation | undefined
  resolveBoundary(target: RewindTarget): PiRewindBoundary
  resolveFilePlan(target: RewindTarget): PiRewindFilePlan
  listTurns(): PiRewindTurn[]
  listMutations(): PiTrackedMutation[]
  listUnsupportedEvidence(): PiFileMutationEvidence[]
  restoreUnsupportedEvidence(evidence: PiFileMutationEvidence): void
  snapshot(): PiRewindTrackerSnapshot
}

export interface PiRewindTrackerSnapshot {
  schemaVersion: 1
  sessionId: string
  turns: PiRewindTurn[]
  turnMutationSequences: number[]
  mutations: PiTrackedMutation[]
  unsupported: PiFileMutationEvidence[]
}

interface MutableTurn extends PiRewindTurn {
  mutationSequence: number
}

function isCompleteEvidence(evidence: PiFileMutationEvidence): evidence is PiFileMutationEvidence & {
  source: 'write' | 'edit'
  before: PiFileVersion
  after: PiFileVersion
  rootId: string
  relativePath: string
  beforeBackup: PiStoredFileVersion
  afterBackup: PiStoredFileVersion
} {
  return evidence.status === 'complete'
    && evidence.source !== 'bash'
    && evidence.evidence === 'controlled-write'
    && evidence.before !== undefined
    && evidence.after !== undefined
    && evidence.rootId !== undefined
    && evidence.relativePath !== undefined
    && evidence.beforeBackup !== undefined
    && evidence.afterBackup !== undefined
    && evidence.path.length > 0
}

function revision(version: PiFileVersion): string {
  return version.revision
}

function itemId(sequence: number, path: string): string {
  return `pi-mutation-${sequence}-${path}`
}

/**
 * Track only provider-confirmed write/edit evidence. Bash observations are deliberately
 * not accepted here: a changed path is not proof that this session owns the change.
 */
export function createPiRewindTracker(sessionId: string): PiRewindTracker {
  const turns = new Map<string, MutableTurn>()
  const turnOrder: string[] = []
  const mutations: PiTrackedMutation[] = []
  const unsupported: PiFileMutationEvidence[] = []
  let nextSequence = 0

  function turnIndex(turnId: string): number {
    return turnOrder.indexOf(turnId)
  }

  function lastSequenceBeforeTurn(index: number): number {
    if (index <= 0) return 0
    const previousTurnId = turnOrder[index - 1]
    const previousTurn = previousTurnId ? turns.get(previousTurnId) : undefined
    return previousTurn?.mutationSequence ?? 0
  }

  function boundary(target: RewindTarget): PiRewindBoundary {
    if (target.kind === 'message') {
      return {
        available: false,
        target,
        mutationSequence: 0,
        reason: 'Pi 文件证据只绑定完成轮次，不能用消息 UUID 猜测文件边界',
      }
    }

    if (target.kind === 'session-start') {
      const firstTurn = turnOrder[0] ? turns.get(turnOrder[0]) : undefined
      if (!firstTurn || !firstTurn.terminal) {
        return {
          available: false,
          target,
          mutationSequence: 0,
          reason: '首轮没有 terminal entry，无法确认会话起点的文件边界',
        }
      }
      return { available: true, target, mutationSequence: 0 }
    }

    const index = turnIndex(target.turnId)
    const turn = turns.get(target.turnId)
    if (index < 0 || !turn) {
      return {
        available: false,
        target,
        mutationSequence: 0,
        reason: `未找到 Pi 完成轮次 ${target.turnId}`,
      }
    }

    if (target.kind === 'after-turn') {
      if (!turn.terminal) {
        return {
          available: false,
          target,
          mutationSequence: 0,
          turnId: target.turnId,
          reason: `轮次 ${target.turnId} 没有 terminal entry，不能作为 after-turn 目标`,
        }
      }
      return { available: true, target, mutationSequence: turn.mutationSequence, turnId: target.turnId }
    }

    // before-turn T2 is the same file boundary as after-turn T1. A later turn may
    // still be running, but it must at least have been opened by the provider.
    if (index === 0) {
      if (!turn.terminal) {
        return {
          available: false,
          target,
          mutationSequence: 0,
          turnId: target.turnId,
          reason: `首轮 ${target.turnId} 没有 terminal entry，无法确认 before-turn 边界`,
        }
      }
      return { available: true, target, mutationSequence: 0, turnId: target.turnId }
    }
    const previousTurnId = turnOrder[index - 1]
    const previousTurn = previousTurnId ? turns.get(previousTurnId) : undefined
    if (!previousTurn?.terminal) {
      return {
        available: false,
        target,
        mutationSequence: 0,
        turnId: target.turnId,
        reason: `前一轮 ${previousTurnId ?? 'unknown'} 没有 terminal entry，无法确认 before-turn 边界`,
      }
    }
    return {
      available: true,
      target,
      mutationSequence: lastSequenceBeforeTurn(index),
      turnId: target.turnId,
    }
  }

  return {
    beginTurn(turnId, startedAt = Date.now()) {
      const existing = turns.get(turnId)
      if (existing) return
      turns.set(turnId, {
        turnId,
        startedAt,
        terminal: false,
        failed: false,
        mutationSequence: nextSequence,
      })
      turnOrder.push(turnId)
    },

    completeTurn(turnId, terminalEntryId, completedAt = Date.now()) {
      const turn = turns.get(turnId)
      if (!turn) return
      turn.terminal = terminalEntryId !== undefined
      turn.failed = false
      turn.completedAt = completedAt
      if (terminalEntryId) turn.terminalEntryId = terminalEntryId
      turn.mutationSequence = nextSequence
    },

    failTurn(turnId, completedAt = Date.now()) {
      const turn = turns.get(turnId)
      if (!turn) return
      turn.failed = true
      turn.terminal = false
      turn.completedAt = completedAt
      turn.mutationSequence = nextSequence
    },

    recordMutation(turnId, evidence) {
      if (!isCompleteEvidence(evidence)) {
        unsupported.push(evidence)
        return undefined
      }
      const turn = turns.get(turnId)
      if (!turn) {
        unsupported.push({ ...evidence, status: 'unsupported', reason: '写入没有对应的 Pi 轮次' })
        return undefined
      }
      const record: PiTrackedMutation = {
        mutationId: `${sessionId}:${nextSequence + 1}`,
        sessionId,
        turnId,
        sequence: ++nextSequence,
        path: evidence.path,
        toolCallId: evidence.toolCallId,
        source: evidence.source,
        before: evidence.before,
        after: evidence.after,
        rootId: evidence.rootId,
        relativePath: evidence.relativePath,
        coverage: evidence.coverage,
        beforeBackup: evidence.beforeBackup,
        afterBackup: evidence.afterBackup,
        evidence: 'controlled-write',
        completedAt: evidence.completedAt,
      }
      mutations.push(record)
      turn.mutationSequence = nextSequence
      return record
    },

    resolveBoundary(target) {
      return boundary(target)
    },

    resolveFilePlan(target) {
      const resolved = boundary(target)
      if (!resolved.available) return { supported: false, boundary: resolved, items: [], reason: resolved.reason }

      const mutationsByPath = new Map<string, PiTrackedMutation[]>()
      for (const mutation of mutations) {
        if (mutation.sequence <= resolved.mutationSequence) continue
        const pathMutations = mutationsByPath.get(mutation.path) ?? []
        pathMutations.push(mutation)
        mutationsByPath.set(mutation.path, pathMutations)
      }

      const items: RewindFilePlanItem[] = []
      for (const [path, pathMutations] of mutationsByPath) {
        const first = pathMutations[0]!
        const latest = pathMutations.at(-1)!
        const targetVersion = first.before!
        const currentVersion = latest.after!
        const chainIntact = pathMutations.every((mutation, index) => index === 0
          || pathMutations[index - 1]!.after!.revision === mutation.before!.revision)
        const item: RewindFilePlanItem = {
          itemId: itemId(latest.sequence, path),
          path,
          ...(latest.rootId === undefined ? {} : { rootId: latest.rootId }),
          ...(latest.relativePath === undefined ? {} : { relativePath: latest.relativePath }),
          action: chainIntact ? (targetVersion.kind === 'absent' ? 'delete' : 'restore') : 'conflict',
          currentRevision: revision(currentVersion),
          targetRevision: revision(targetVersion),
          ...(latest.afterBackup.kind === 'file' ? { currentBackupRef: latest.afterBackup.contentRef } : {}),
          ...(first.beforeBackup.kind === 'file' ? { targetBackupRef: first.beforeBackup.contentRef } : {}),
          evidence: 'tracked-write',
          reason: chainIntact
            ? '仅基于本会话受控 write/edit 的连续 before/after 证据'
            : '同一路径的受控写入版本链不连续，可能存在外部修改',
        }
        items.push(item)
      }
      return { supported: true, boundary: resolved, items }
    },

    listTurns() {
      return turnOrder.map(turnId => {
        const turn = turns.get(turnId)!
        const { mutationSequence: _mutationSequence, ...result } = turn
        return result
      })
    },

    listMutations() {
      return [...mutations]
    },

    listUnsupportedEvidence() {
      return [...unsupported]
    },
    restoreUnsupportedEvidence(evidence) {
      unsupported.push(evidence)
    },
    snapshot() {
      return {
        schemaVersion: 1,
        sessionId,
        turns: turnOrder.map(turnId => {
          const turn = turns.get(turnId)!
          const { mutationSequence: _mutationSequence, ...result } = turn
          return result
        }),
        turnMutationSequences: turnOrder.map(turnId => turns.get(turnId)!.mutationSequence),
        mutations: [...mutations],
        unsupported: [...unsupported],
      }
    },
  }
}

export function restorePiRewindTracker(snapshot: PiRewindTrackerSnapshot): PiRewindTracker {
  if (snapshot.schemaVersion !== 1) throw new Error('不支持的 Pi rewind tracker schema')
  const tracker = createPiRewindTracker(snapshot.sessionId)
  for (const turn of snapshot.turns) {
    tracker.beginTurn(turn.turnId, turn.startedAt)
    for (const mutation of snapshot.mutations.filter(item => item.turnId === turn.turnId)) {
      tracker.recordMutation(turn.turnId, {
        path: mutation.path,
        source: mutation.source,
        toolCallId: mutation.toolCallId,
        before: mutation.before,
        after: mutation.after,
        rootId: mutation.rootId,
        relativePath: mutation.relativePath,
        coverage: mutation.coverage,
        beforeBackup: mutation.beforeBackup,
        afterBackup: mutation.afterBackup,
        evidence: 'controlled-write',
        status: 'complete',
        completedAt: mutation.completedAt,
      })
    }
    if (turn.completedAt !== undefined) {
      if (turn.terminal && turn.terminalEntryId) tracker.completeTurn(turn.turnId, turn.terminalEntryId, turn.completedAt)
      else tracker.failTurn(turn.turnId, turn.completedAt)
    }
  }
  for (const evidence of snapshot.unsupported ?? []) tracker.restoreUnsupportedEvidence(evidence)
  return tracker
}

export async function persistPiRewindTracker(path: string, tracker: PiRewindTracker): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(tracker.snapshot())}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function loadPiRewindTracker(path: string, sessionId: string): Promise<PiRewindTracker> {
  try {
    const raw = await readFile(path, 'utf8')
    const snapshot = JSON.parse(raw) as PiRewindTrackerSnapshot
    if (snapshot.sessionId !== sessionId) throw new Error('Pi tracker sessionId 不匹配')
    return restorePiRewindTracker(snapshot)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return createPiRewindTracker(sessionId)
    throw error
  }
}

/**
 * Old Pi checkpoints are created before a turn. Keep this fact explicit so callers do
 * not silently present a legacy checkpoint as an exact after-turn snapshot.
 */
export function annotateLegacyPiCheckpointCoverage(input: {
  checkpointPath: string
  entryId?: string
  turnId?: string
}): PiLegacyCheckpointCoverage {
  if (!input.turnId) {
    return {
      checkpointPath: input.checkpointPath,
      ...(input.entryId ? { entryId: input.entryId } : {}),
      coverage: 'unknown',
      supportsAfterTurn: false,
      reason: '旧 Pi 检查点缺少可靠的完成轮映射，不能用于精确文件目标',
    }
  }
  return {
    checkpointPath: input.checkpointPath,
    ...(input.entryId ? { entryId: input.entryId } : {}),
    turnId: input.turnId,
    coverage: 'before-turn',
    supportsAfterTurn: false,
    reason: '旧 Pi 检查点在该轮 provider 启动前创建，只能标注为 before-turn 近似边界',
  }
}
