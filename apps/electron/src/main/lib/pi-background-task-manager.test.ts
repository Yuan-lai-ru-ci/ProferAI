import { describe, expect, test } from 'bun:test'
import { PiBackgroundTaskManager } from './pi-background-task-manager'
import type { RuntimeProcessRecord } from './runtime-process-registry'

function serviceRecord(overrides: Partial<RuntimeProcessRecord> = {}): RuntimeProcessRecord {
  return {
    id: 'task-restore-1',
    sessionId: 'session-restore',
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
    lastObservedAt: 1_700_000_000_500,
    status: 'running',
    ...overrides,
  }
}

describe('PiBackgroundTaskManager', () => {
  test('按 sessionId + taskId 隔离输出，并保留输出 tail', async () => {
    const manager = new PiBackgroundTaskManager()
    manager.begin('session-1', 'task-1', 'npm run dev')
    manager.append('session-1', 'task-1', 'ready\n')
    manager.complete('session-1', 'task-1', 'completed', '服务已结束')

    await expect(manager.getOutput('session-1', 'task-1')).resolves.toEqual({
      output: 'ready\n',
      isComplete: true,
      status: 'completed',
      summary: '服务已结束',
    })
    await expect(manager.getOutput('session-2', 'task-1')).rejects.toThrow('不存在或不属于当前会话')
  })

  test('阻塞查询等待后台任务进入终态', async () => {
    const manager = new PiBackgroundTaskManager()
    manager.begin('session-1', 'task-1', 'npm run dev')
    setTimeout(() => manager.complete('session-1', 'task-1', 'stopped'), 30)

    await expect(manager.getOutput('session-1', 'task-1', { block: true, timeoutMs: 500 })).resolves.toMatchObject({
      isComplete: true,
      status: 'stopped',
    })
  })

  test('从持久化 registry record 恢复任务句柄，不虚构历史输出', async () => {
    const manager = new PiBackgroundTaskManager()
    manager.hydrate(serviceRecord())

    await expect(manager.getOutput('session-restore', 'task-restore-1')).resolves.toMatchObject({
      output: '',
      isComplete: false,
      status: 'running',
    })
  })

  test('非服务 record 不会被恢复为后台任务', async () => {
    const manager = new PiBackgroundTaskManager()
    manager.hydrate(serviceRecord({ likelyService: false, id: 'short-command' }))

    await expect(manager.getOutput('session-restore', 'short-command')).rejects.toThrow('不存在或不属于当前会话')
  })
})
