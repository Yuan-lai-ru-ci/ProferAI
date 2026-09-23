import { describe, expect, test } from 'bun:test'
import { createExecutionService } from './execution-service'
import type { CommandExecutionResult } from './command-execution'

function result(overrides: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
  return {
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    shell: '/bin/bash',
    cwd: '/tmp/project',
    truncated: false,
    ...overrides,
  }
}

describe('runtime-neutral ExecutionService', () => {
  test('保留 injected executor 的统一结果并在完成后保留句柄快照', async () => {
    let spawnedPid: number | undefined
    const service = createExecutionService({
      execute: async (_request, _signal, onSpawn) => {
        onSpawn(1234)
        spawnedPid = 1234
        return result({ exitCode: 7, stderr: 'expected failure' })
      },
    })

    const execution = await service.execute({
      sessionId: 'session-1',
      command: 'echo ok',
      cwd: '/tmp/project',
      shell: '/bin/bash',
    })

    expect(execution.exitCode).toBe(7)
    expect(spawnedPid).toBe(1234)
    expect(execution.errorKind).toBeUndefined()
  })

  test('取消使用同一个 AbortSignal，并将取消结果保留为 killed handle', async () => {
    let aborted = false
    const service = createExecutionService({
      execute: async (_request, signal, onSpawn) => {
        onSpawn(4321)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
        })
        return result({ exitCode: null, aborted: true, signal: 'SIGTERM' })
      },
    })

    const pending = service.execute({
      sessionId: 'session-2',
      handleId: 'handle-2',
      command: 'sleep 10',
      cwd: '/tmp/project',
      shell: '/bin/bash',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await service.cancel('handle-2')
    const execution = await pending

    expect(aborted).toBe(true)
    expect(execution.aborted).toBe(true)
    expect(service.get('handle-2')?.handle.status).toBe('killed')
  })
})
