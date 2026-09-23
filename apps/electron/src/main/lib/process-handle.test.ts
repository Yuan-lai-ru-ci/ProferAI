import { describe, expect, test } from 'bun:test'
import { completeProcessHandle, isProcessHandleOwnedBySession, processHandleFromRuntimeRecord } from './process-handle'
import type { RuntimeProcessRecord } from './runtime-process-registry'

function makeRecord(overrides: Partial<RuntimeProcessRecord> = {}): RuntimeProcessRecord {
  return {
    id: 'handle-1',
    sessionId: 'session-1',
    runtime: 'pi',
    source: 'pi-owned',
    launcher: 'bash',
    likelyService: true,
    command: 'npm run dev',
    cwd: '/tmp/project',
    shellPid: 100,
    pid: 101,
    startTime: 1_700_000_000_000,
    ports: [5173],
    launchedAt: 1_700_000_000_000,
    lastObservedAt: 1_700_000_001_000,
    status: 'running',
    ...overrides,
  }
}

describe('ProcessHandle adapter', () => {
  test('将 registry pending/running/exited 映射为统一 starting/running/exited 状态', () => {
    expect(processHandleFromRuntimeRecord(makeRecord({ status: 'pending' })).status).toBe('starting')
    expect(processHandleFromRuntimeRecord(makeRecord()).status).toBe('running')
    expect(processHandleFromRuntimeRecord(makeRecord({ status: 'exited' })).endedAt).toBe(1_700_000_001_000)
  })

  test('保留 launcher pid 与确认后的实际 pid，避免把二者混为一谈', () => {
    const handle = processHandleFromRuntimeRecord(makeRecord())
    expect(handle.shellPid).toBe(100)
    expect(handle.pid).toBe(101)
    expect(handle.startTime).toBe(1_700_000_000_000)
  })

  test('完成句柄时保留 exitCode/signal，并默认把 signal 视为 killed', () => {
    const handle = processHandleFromRuntimeRecord(makeRecord())
    const killed = completeProcessHandle(handle, { signal: 'SIGTERM', endedAt: 1_700_000_002_000 })
    expect(killed.status).toBe('killed')
    expect(killed.signal).toBe('SIGTERM')
    expect(killed.endedAt).toBe(1_700_000_002_000)

    const exited = completeProcessHandle(handle, { exitCode: 1 })
    expect(exited.status).toBe('exited')
    expect(exited.exitCode).toBe(1)
  })

  test('只接受同一 runtime 的 session handle', () => {
    const handle = processHandleFromRuntimeRecord(makeRecord())
    expect(isProcessHandleOwnedBySession(handle, 'session-1')).toBe(true)
    expect(isProcessHandleOwnedBySession(handle, 'session-2')).toBe(false)
  })
})
