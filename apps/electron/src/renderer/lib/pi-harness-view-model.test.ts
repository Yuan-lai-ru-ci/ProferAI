import { describe, expect, test } from 'bun:test'
import type { PiHarnessSnapshotView } from '@profer/shared'
import { presentPiHarnessTask } from './pi-harness-view-model'

function view(state: NonNullable<PiHarnessSnapshotView['tasks']['task']['assurance']>['state']): PiHarnessSnapshotView {
  return {
    sessionId: 'session',
    goal: { state: 'active', activeTaskId: 'task' },
    tasks: { task: { taskId: 'task', assurance: { state, reason: '证据说明', updatedAt: 1 } } },
  }
}

describe('Pi Harness graph view model', () => {
  test.each([
    ['verified', '已验证', 'emerald'],
    ['pending', '待验证', 'amber'],
    ['failed', '验证失败', 'red'],
    ['waived', '已接受风险', 'muted'],
  ] as const)('maps assurance %s to a read-only badge', (state, label, tone) => {
    expect(presentPiHarnessTask('task', view(state)).badge).toEqual({ label, tone })
  })

  test('prioritizes a paused Goal boundary over an assurance state', () => {
    const snapshot: PiHarnessSnapshotView = {
      ...view('pending'),
      goal: { state: 'paused', activeTaskId: 'task', pauseReason: 'user_stop' },
    }
    expect(presentPiHarnessTask('task', snapshot)).toMatchObject({ badge: { label: '已暂停' }, pauseReason: 'user_stop' })
  })

  test('keeps verification candidates read-only and exposes only ready_task/shadow_mode as user-continuable', () => {
    const verification: PiHarnessSnapshotView = {
      sessionId: 'session', tasks: { task: { taskId: 'task', shadowCandidate: { action: 'required_verification', reason: '缺少测试', blockedReason: 'shadow_mode' } } },
    }
    const ready: PiHarnessSnapshotView = {
      sessionId: 'session', tasks: { task: { taskId: 'task', shadowCandidate: { action: 'ready_task', reason: '下游任务就绪', blockedReason: 'shadow_mode', canManuallyContinue: true } } },
    }
    expect(presentPiHarnessTask('task', verification)).toMatchObject({ shadowCandidateLabel: expect.stringContaining('shadow，未执行') })
    expect(presentPiHarnessTask('task', verification).canManuallyContinue).toBeUndefined()
    expect(presentPiHarnessTask('task', ready)).toMatchObject({ canManuallyContinue: true })
  })

  test('returns no presentation for an absent Harness snapshot', () => {
    expect(presentPiHarnessTask('task', null)).toEqual({})
  })
})
