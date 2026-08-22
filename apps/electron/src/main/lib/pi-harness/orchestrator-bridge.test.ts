import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendGraphEvent } from '../project-graph-service'
import { loadPiHarnessSnapshot } from './pi-harness-store'
import {
  clearPiHarnessRunsForTest,
  getActivePiHarnessRunForTest,
  pauseActivePiHarnessRun,
  settlePiHarnessRun,
  startPiHarnessRun,
} from './orchestrator-bridge'

const roots: string[] = []
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function useTempConfig(): void {
  const root = mkdtempSync(join(tmpdir(), 'profer-pi-harness-bridge-'))
  roots.push(root)
  process.env.PROFER_CONFIG_DIR = root
}

const base = {
  permissionMode: 'bypassPermissions' as const,
  userMessage: '分阶段实现 Pi Harness，并先写测试再接入运行时',
  prompt: '用户原始请求',
}

afterEach(() => {
  clearPiHarnessRunsForTest()
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Pi Harness orchestrator bridge', () => {
  test('creates one Goal and one Turn, adds focus packet, and proposes a minimal root only once', () => {
    useTempConfig()
    const scope = startPiHarnessRun({ sessionId: 's1', ...base })
    const snapshot = loadPiHarnessSnapshot('s1')

    expect(scope).toBeDefined()
    expect(scope?.prompt).toContain('<graph_focus>')
    expect(scope?.prompt).toContain('用户原始请求')
    expect(Object.values(snapshot.goals)).toHaveLength(1)
    expect(Object.values(snapshot.turns)).toHaveLength(1)
    const goal = Object.values(snapshot.goals)[0]!
    expect(goal.activeTaskId).toBeDefined()
    expect(goal.rootTaskId).toBe(goal.activeTaskId)
    expect(goal.autonomyUsage.taskTransitions).toBe(0)
  })

  test('attributes same-Turn facts to the Host root when the user declares finite verification markers', () => {
    useTempConfig()
    const scope = startPiHarnessRun({
      sessionId: 'declared-root',
      permissionMode: 'bypassPermissions',
      userMessage: '分阶段创建验证文件\n@artifact: dist/output.txt\n@verify: bun test target',
      prompt: '用户原始请求',
    })!
    expect(scope.activeTaskId).toBeDefined()
    scope.observeToolResult({ toolUseId: 'write', toolName: 'Write', input: { file_path: 'dist/output.txt', content: 'secret body' }, result: 'wrote' })
    scope.observeToolResult({ toolUseId: 'read', toolName: 'Read', input: { file_path: 'dist/output.txt' }, result: 'read back' })
    scope.observeToolResult({ toolUseId: 'test', toolName: 'Bash', input: { command: 'bun test target' }, result: [{ type: 'text', text: '10 pass' }], isError: false })
    settlePiHarnessRun('declared-root', 'completed')

    const snapshot = loadPiHarnessSnapshot('declared-root')
    expect(snapshot.verificationByTask[scope.activeTaskId!]).toMatchObject({ state: 'verified' })
    expect(snapshot.goals[scope.goalId]?.autonomyUsage.taskTransitions).toBe(0)
    expect(Object.keys(snapshot.turns)).toHaveLength(1)
  })

  test('manual compact never creates a Goal, Turn, graph mutation, or active scope', () => {
    useTempConfig()
    const scope = startPiHarnessRun({ sessionId: 'compact', permissionMode: 'bypassPermissions', userMessage: '/compact', prompt: '/compact' })
    const snapshot = loadPiHarnessSnapshot('compact')

    expect(scope).toBeUndefined()
    expect(snapshot.goals).toEqual({})
    expect(snapshot.turns).toEqual({})
    expect(getActivePiHarnessRunForTest('compact')).toBeUndefined()
  })

  test('native retry and compaction remain inside the same Turn and consume no Goal transition', () => {
    useTempConfig()
    const scope = startPiHarnessRun({ sessionId: 'lifecycle', ...base })!
    scope.observeLifecycle({ type: 'turn_running', timestamp: 1 })
    scope.observeLifecycle({ type: 'model_call_completed', timestamp: 2 })
    scope.observeLifecycle({ type: 'retry_started', timestamp: 3 })
    scope.observeLifecycle({ type: 'retry_finished', timestamp: 4 })
    scope.observeLifecycle({ type: 'compaction_started', timestamp: 5 })
    scope.observeLifecycle({ type: 'compaction_finished', timestamp: 6, recovered: true })
    scope.observeResult({ type: 'result', usage: { input_tokens: 12, output_tokens: 34 } } as never)
    settlePiHarnessRun('lifecycle', 'completed')

    const snapshot = loadPiHarnessSnapshot('lifecycle')
    const turn = snapshot.turns[scope.turnId]!
    const goal = snapshot.goals[scope.goalId]!
    expect(turn).toMatchObject({ state: 'settled', usage: { modelCalls: 1, retries: 1, compactions: 1, inputTokens: 12, outputTokens: 34 } })
    expect(goal).toMatchObject({ state: 'active', autonomyUsage: { taskTransitions: 0 } })
    expect(Object.keys(snapshot.turns)).toHaveLength(1)
    expect(getActivePiHarnessRunForTest('lifecycle')).toBeUndefined()
  })

  test('stop pauses the active Goal without creating a follow-up turn', () => {
    useTempConfig()
    const scope = startPiHarnessRun({ sessionId: 'stop', ...base })!
    pauseActivePiHarnessRun('stop', 'user_stop')
    settlePiHarnessRun('stop', 'completed')

    const snapshot = loadPiHarnessSnapshot('stop')
    expect(snapshot.goals[scope.goalId]).toMatchObject({ state: 'paused' })
    expect(snapshot.turns[scope.turnId]).toMatchObject({ state: 'interrupted', endReason: 'user_stop' })
    expect(Object.keys(snapshot.turns)).toHaveLength(1)
  })

  test('attributes an interrupted tool-running Turn to one model call when Stop suppresses agent_end', () => {
    useTempConfig()
    const scope = startPiHarnessRun({ sessionId: 'stopped-after-tool', ...base })!
    scope.observeToolResult({ toolUseId: 'write', toolName: 'Write', input: { file_path: 'stop.txt', content: 'bounded' }, result: 'wrote' })
    pauseActivePiHarnessRun('stopped-after-tool', 'user_stop')

    const snapshot = loadPiHarnessSnapshot('stopped-after-tool')
    expect(snapshot.turns[scope.turnId]).toMatchObject({
      state: 'interrupted', endReason: 'user_stop', usage: { modelCalls: 1 },
    })
    expect(snapshot.goals[scope.goalId]).toMatchObject({ state: 'paused', autonomyUsage: { taskTransitions: 0 } })
    expect(Object.keys(snapshot.turns)).toHaveLength(1)
  })

  test('does not double-count the lifecycle confirmation after inferring a tool-running model call', () => {
    useTempConfig()
    const scope = startPiHarnessRun({ sessionId: 'tool-then-end', ...base })!
    scope.observeToolResult({ toolUseId: 'write', toolName: 'Write', input: { file_path: 'tool.txt', content: 'bounded' }, result: 'wrote' })
    scope.observeLifecycle({ type: 'model_call_completed', timestamp: 1 })
    settlePiHarnessRun('tool-then-end', 'completed')

    const snapshot = loadPiHarnessSnapshot('tool-then-end')
    expect(snapshot.turns[scope.turnId]).toMatchObject({ state: 'settled', usage: { modelCalls: 1 } })
  })

  test('uses an existing graph focus and does not create a second minimal root', () => {
    useTempConfig()
    appendGraphEvent('existing', {
      type: 'task_created', taskId: 'task-existing', timestamp: 1,
      payload: { subject: '已有任务', description: '', dependsOn: [] },
    })
    const scope = startPiHarnessRun({ sessionId: 'existing', ...base })!
    const snapshot = loadPiHarnessSnapshot('existing')
    const goal = snapshot.goals[scope.goalId]!

    expect(scope.activeTaskId).toBe('task-existing')
    expect(goal.rootTaskId).toBeUndefined()
    expect(goal.activeTaskId).toBe('task-existing')
  })

  test('reconciles completed Write/Read/Bash facts into verified without scheduling another Turn', () => {
    useTempConfig()
    appendGraphEvent('verified', {
      type: 'task_created', taskId: 'task-verify', timestamp: 1,
      payload: { subject: '验证任务', description: '@verify: bun test target\n@artifact: dist/output.txt', dependsOn: [] },
    })
    appendGraphEvent('verified', {
      type: 'task_status_changed', taskId: 'task-verify', timestamp: 2,
      payload: { newStatus: 'in_progress' },
    })
    const scope = startPiHarnessRun({ sessionId: 'verified', ...base })!
    scope.observeToolResult({ toolUseId: 'write', toolName: 'Write', input: { file_path: 'dist/output.txt', content: 'secret body' }, result: 'wrote' })
    scope.observeToolResult({ toolUseId: 'read', toolName: 'Read', input: { file_path: 'dist/output.txt' }, result: 'read back' })
    scope.observeToolResult({ toolUseId: 'test', toolName: 'Bash', input: { command: 'bun test target' }, result: '10 pass\nexit code 0' })
    settlePiHarnessRun('verified', 'completed')

    const snapshot = loadPiHarnessSnapshot('verified')
    expect(snapshot.verificationByTask['task-verify']).toMatchObject({ state: 'verified' })
    expect(Object.keys(snapshot.facts)).toHaveLength(3)
    expect(Object.keys(snapshot.turns)).toHaveLength(1)
    expect(snapshot.goals[scope.goalId]?.autonomyUsage.taskTransitions).toBe(0)
  })
})
