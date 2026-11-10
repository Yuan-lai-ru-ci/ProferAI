import { expect, test } from 'bun:test'
import { canReplaceAgentHistory, acceptPersistenceAck, decideAgentHistoryLoad, decidePersistenceAck } from './agent-persistence'

test('legacy completion allows history; pending and failed retain live across mounts', () => {
  expect(canReplaceAgentHistory(undefined, undefined)).toBe(true)
  for (const status of ['pending', 'failed'] as const) {
    expect(canReplaceAgentHistory({ status, startedAt: 1 }, { startedAt: 1 })).toBe(false)
  }
})
test('late ACK from old run cannot replace live history for current generation', () => {
  const current = { status: 'pending' as const, runId: 'run-b', startedAt: 2, watermark: 8 }
  expect(acceptPersistenceAck(current, { runId: 'run-a', status: 'saved', watermark: 7 }, { startedAt: 2, running: true })).toBe(false)
  expect(canReplaceAgentHistory(current, { startedAt: 2, running: false })).toBe(false)
})

test('saved ACK is run and generation scoped', () => {
  const state = { status: 'pending' as const, runId: 'a', startedAt: 1, watermark: 4 }
  expect(acceptPersistenceAck(state, { runId: 'old', status: 'saved' }, { startedAt: 1 })).toBe(false)
  expect(acceptPersistenceAck(state, { runId: 'a', status: 'saved' }, { startedAt: 2, running: true })).toBe(false)
  expect(acceptPersistenceAck(state, { runId: 'a', status: 'saved', watermark: 3 }, { startedAt: 1 })).toBe(false)
  expect(acceptPersistenceAck(state, { runId: 'a', status: 'saved', watermark: 4 }, { startedAt: 1 })).toBe(true)
})
test('saved permits cleanup only for matching idle generation', () => {
  const saved = { status: 'saved' as const, startedAt: 1 }
  expect(canReplaceAgentHistory(saved, { startedAt: 1, running: false })).toBe(true)
  expect(canReplaceAgentHistory(saved, { startedAt: 2, running: false })).toBe(false)
  expect(canReplaceAgentHistory(saved, { startedAt: 1, running: true })).toBe(false)
})
test('unscoped ACK never upgrades pending, failed can recover without provider retry', () => {
  const failed = { status: 'failed' as const, startedAt: 1, runId: 'a' }
  expect(acceptPersistenceAck(failed, { status: 'saved' }, { startedAt: 1 })).toBe(false)
  expect(acceptPersistenceAck(failed, { status: 'saved', runId: 'a' }, { startedAt: 1 })).toBe(true)
  expect(acceptPersistenceAck(undefined, { status: 'saved', runId: 'a' }, undefined)).toBe(false)
})

// ===== 对话体验断点：落盘状态与读盘窗口 =====

test('legacy and unscoped ACK still warn on failure but never rewrite run state', () => {
  // 旧链路（无 runId、无本轮记账）保存失败必须继续提示，否则用户以为已经存好了。
  expect(decidePersistenceAck(undefined, { status: 'failed' }, undefined)).toBe('toast')
  const pending = { status: 'pending' as const, runId: 'run-a', startedAt: 1 }
  expect(decidePersistenceAck(pending, { status: 'failed' }, { startedAt: 1 })).toBe('toast')
  // 无身份 ACK 不得改写状态（saved/pending 都忽略）。
  expect(decidePersistenceAck(pending, { status: 'saved' }, { startedAt: 1 })).toBe('ignore')
  expect(decidePersistenceAck(undefined, { status: 'saved' }, undefined)).toBe('ignore')
  // 身份匹配才应用；旧 run 的迟到 ACK 忽略。
  expect(decidePersistenceAck(pending, { status: 'saved', runId: 'run-a' }, { startedAt: 1 })).toBe('apply')
  expect(decidePersistenceAck(pending, { status: 'saved', runId: 'run-z' }, { startedAt: 1 })).toBe('ignore')
})

test('history load survives in-flight persistence change without blanking the session', () => {
  // 正常：状态没变，直接应用。
  expect(decideAgentHistoryLoad({ generationAtLoad: 1, generationNow: 1 })).toBe('apply')
  // 新 run 接管：旧快照丢弃。
  expect(decideAgentHistoryLoad({ generationAtLoad: 1, generationNow: 2 })).toBe('discard')
  // 读取期间变成 pending/failed：必须重读，否则 failed 会让整段历史一直空窗。
  const pending = { status: 'pending' as const, runId: 'r', startedAt: 1 }
  const failed = { status: 'failed' as const, runId: 'r', startedAt: 1 }
  expect(decideAgentHistoryLoad({ generationAtLoad: 1, generationNow: 1, persistenceAtLoad: undefined, persistenceNow: pending, streamNow: { startedAt: 1 } })).toBe('retry')
  expect(decideAgentHistoryLoad({ generationAtLoad: 1, generationNow: 1, persistenceAtLoad: pending, persistenceNow: failed, streamNow: { startedAt: 1 } })).toBe('retry')
  // 进房前就已 failed 的会话不能被判成需要重读，否则会无限刷新。
  expect(decideAgentHistoryLoad({ generationAtLoad: 1, generationNow: 1, persistenceAtLoad: failed, persistenceNow: failed, streamNow: { startedAt: 1 } })).toBe('apply')
  // 读取期间转为 saved：交给 ACK 的 bump，别用旧快照清理实时副本。
  const saved = { status: 'saved' as const, runId: 'r', startedAt: 1 }
  expect(decideAgentHistoryLoad({ generationAtLoad: 1, generationNow: 1, persistenceAtLoad: pending, persistenceNow: saved, streamNow: { startedAt: 1 } })).toBe('discard')
})
