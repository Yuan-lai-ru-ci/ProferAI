import { describe, expect, test } from 'bun:test'
import { createPiRewindTracker, restorePiRewindTracker, annotateLegacyPiCheckpointCoverage } from './agent-rewind-pi'
import type { PiFileMutationEvidence } from '@profer/agent-provider-pi'

function version(revision: string): { kind: 'file'; revision: string; sha256: string; size: number } {
  return { kind: 'file', revision, sha256: revision, size: 1 }
}

function mutation(path: string, before: string, after: string, toolCallId: string): PiFileMutationEvidence {
  return {
    path,
    source: 'write',
    toolCallId,
    before: version(before),
    after: version(after),
    rootId: 'workspace-1',
    relativePath: path,
    coverage: 'managed',
    beforeBackup: { kind: 'file', contentRef: 'a'.repeat(64), sha256: 'a'.repeat(64), size: 1 },
    afterBackup: { kind: 'file', contentRef: 'b'.repeat(64), sha256: 'b'.repeat(64), size: 1 },
    evidence: 'controlled-write',
    status: 'complete',
    completedAt: Date.now(),
  }
}

describe('Pi rewind tracking', () => {
  test('after T1 and before T2 resolve to the same incremental boundary', () => {
    const tracker = createPiRewindTracker('session-1')
    tracker.beginTurn('T1', 1)
    tracker.recordMutation('T1', mutation('tracked.txt', 'A', 'B', 'call-1'))
    tracker.completeTurn('T1', 'entry-1', 2)
    tracker.beginTurn('T2', 3)
    tracker.recordMutation('T2', mutation('tracked.txt', 'B', 'C', 'call-2'))
    tracker.completeTurn('T2', 'entry-2', 4)

    const afterT1 = tracker.resolveFilePlan({ kind: 'after-turn', turnId: 'T1' })
    const beforeT2 = tracker.resolveFilePlan({ kind: 'before-turn', turnId: 'T2' })
    expect(afterT1.supported).toBeTrue()
    expect(beforeT2.supported).toBeTrue()
    expect(afterT1.boundary.mutationSequence).toBe(beforeT2.boundary.mutationSequence)
    expect(afterT1.items).toEqual(beforeT2.items)
    expect(afterT1.items[0]).toMatchObject({ path: 'tracked.txt', action: 'restore', targetRevision: 'B', currentRevision: 'C' })
  })

  test('受控新建文件有明确 delete 证据，手工新增文件没有候选', () => {
    const tracker = createPiRewindTracker('session-created')
    tracker.beginTurn('T1')
    tracker.recordMutation('T1', {
      path: 'created.txt',
      source: 'write',
      toolCallId: 'call-created',
      before: { kind: 'absent', revision: 'absent' },
      after: version('B'),
      rootId: 'workspace-1',
      relativePath: 'created.txt',
      coverage: 'managed',
      beforeBackup: { kind: 'absent' },
      afterBackup: { kind: 'file', contentRef: 'b'.repeat(64), sha256: 'b'.repeat(64), size: 1 },
      evidence: 'controlled-write',
      status: 'complete',
      completedAt: Date.now(),
    })
    tracker.completeTurn('T1', 'entry-1')
    const plan = tracker.resolveFilePlan({ kind: 'session-start' })
    expect(plan.items).toMatchObject([{ path: 'created.txt', action: 'delete', targetRevision: 'absent' }])
    expect(plan.items.some(item => item.path === 'manual.txt')).toBeFalse()
  })

  test('manual files are never inferred as delete candidates', () => {
    const tracker = createPiRewindTracker('session-2')
    tracker.beginTurn('T1')
    tracker.recordMutation('T1', mutation('tracked.txt', 'A', 'B', 'call-1'))
    tracker.completeTurn('T1', 'entry-1')
    const plan = tracker.resolveFilePlan({ kind: 'after-turn', turnId: 'T1' })
    expect(plan.items).toEqual([])
  })

  test('同一路径 before/after 不连续时标记 conflict，不生成恢复动作', () => {
    const tracker = createPiRewindTracker('session-conflict')
    tracker.beginTurn('T1')
    tracker.recordMutation('T1', mutation('tracked.txt', 'A', 'B', 'call-1'))
    tracker.completeTurn('T1', 'entry-1')
    tracker.beginTurn('T2')
    tracker.recordMutation('T2', mutation('tracked.txt', 'EXTERNAL', 'C', 'call-2'))
    tracker.completeTurn('T2', 'entry-2')

    expect(tracker.resolveFilePlan({ kind: 'session-start' }).items).toMatchObject([{
      path: 'tracked.txt',
      action: 'conflict',
    }])
  })

  test('first turn without terminal entry is explicitly unavailable', () => {
    const tracker = createPiRewindTracker('session-3')
    tracker.beginTurn('T0')
    tracker.failTurn('T0')
    expect(tracker.resolveBoundary({ kind: 'session-start' })).toMatchObject({
      available: false,
      reason: expect.stringContaining('terminal'),
    })
    expect(tracker.resolveFilePlan({ kind: 'after-turn', turnId: 'T0' }).supported).toBeFalse()
  })

  test('Bash-like unsupported evidence does not enter tracked mutations', () => {
    const tracker = createPiRewindTracker('session-4')
    tracker.beginTurn('T1')
    tracker.completeTurn('T1', 'entry-1')
    const unsupported: PiFileMutationEvidence = {
      path: 'manual.txt',
      source: 'bash',
      toolCallId: 'bash-call',
      before: version('A'),
      after: version('B'),
      evidence: 'controlled-write',
      status: 'complete',
      reason: 'Bash diff has no ownership proof',
      completedAt: Date.now(),
    }
    expect(tracker.recordMutation('T1', unsupported)).toBeUndefined()
    expect(tracker.listMutations()).toEqual([])
    expect(tracker.listUnsupportedEvidence()).toEqual([unsupported])
  })

  test('tracker snapshot 重启恢复保留 turn 和 mutation 顺序', () => {
    const tracker = createPiRewindTracker('session-restart')
    tracker.beginTurn('T1', 1)
    tracker.recordMutation('T1', mutation('tracked.txt', 'A', 'B', 'call-1'))
    tracker.completeTurn('T1', 'entry-1', 2)

    const restored = restorePiRewindTracker(tracker.snapshot())
    expect(restored.listTurns()).toMatchObject([{ turnId: 'T1', terminal: true, terminalEntryId: 'entry-1' }])
    expect(restored.listMutations()).toEqual(tracker.listMutations())
    expect(restored.resolveFilePlan({ kind: 'session-start' }).items).toMatchObject([{ path: 'tracked.txt', action: 'restore' }])
  })

  test('legacy checkpoints expose before-turn or unknown coverage, never after-turn', () => {
    expect(annotateLegacyPiCheckpointCoverage({ checkpointPath: '/checkpoint/a', entryId: 'entry-1', turnId: 'T1' })).toMatchObject({
      coverage: 'before-turn',
      supportsAfterTurn: false,
    })
    expect(annotateLegacyPiCheckpointCoverage({ checkpointPath: '/checkpoint/old' })).toMatchObject({
      coverage: 'unknown',
      supportsAfterTurn: false,
    })
  })
})
