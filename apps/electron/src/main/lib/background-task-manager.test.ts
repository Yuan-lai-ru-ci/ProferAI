import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BackgroundTaskManager } from './background-task-manager'

describe('BackgroundTaskManager', () => {
  test('只允许通过 sessionId + taskId 读取已登记任务', async () => {
    const manager = new BackgroundTaskManager()
    const dir = join(tmpdir(), `profer-task-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'output.txt')
    writeFileSync(outputFile, 'hello')
    manager.upsert({ sessionId: 's1', taskId: 't1', status: 'completed', outputFile })

    await expect(manager.getOutput('s1', 't1')).resolves.toMatchObject({
      output: 'hello', isComplete: true, status: 'completed',
    })
    await expect(manager.getOutput('s2', 't1')).rejects.toThrow('不存在或不属于当前会话')
  })

  test('阻塞查询会等待状态变为终态', async () => {
    const manager = new BackgroundTaskManager()
    manager.upsert({ sessionId: 's1', taskId: 't1', status: 'running' })
    setTimeout(() => manager.upsert({ sessionId: 's1', taskId: 't1', status: 'stopped' }), 30)

    await expect(manager.getOutput('s1', 't1', { block: true, timeoutMs: 500 })).resolves.toMatchObject({
      isComplete: true, status: 'stopped',
    })
  })

  test('同一任务重复停止是幂等的', () => {
    const manager = new BackgroundTaskManager()
    manager.upsert({ sessionId: 's1', taskId: 't1', status: 'running' })
    expect(manager.markStopped('s1', 't1').status).toBe('stopped')
    expect(manager.markStopped('s1', 't1').status).toBe('stopped')
  })
})
