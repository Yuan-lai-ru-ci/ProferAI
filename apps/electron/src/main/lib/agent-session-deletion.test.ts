import { describe, expect, test } from 'bun:test'
import { AgentSessionDeletionCoordinator } from './agent-session-deletion'

function controlledDeps(calls: string[], stop: () => Promise<void>) {
  return {
    beginDeletion: () => calls.push('begin'),
    endDeletion: () => calls.push('end'),
    stopAndWait: async () => { calls.push('stop'); await stop() },
    clearState: () => calls.push('clear'),
    deleteSession: () => calls.push('delete'),
  }
}

describe('Agent session 删除协调器', () => {
  test('Given 运行仍在退出 When 删除 Then 必须等待后才清理和删除', async () => {
    const calls: string[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const deletion = new AgentSessionDeletionCoordinator().delete('s1', controlledDeps(calls, () => pending))
    await Promise.resolve()
    expect(calls).toEqual(['begin', 'stop'])
    release()
    await deletion
    expect(calls).toEqual(['begin', 'stop', 'clear', 'delete', 'end'])
  })

  test('Given 并发删除同一会话 When 调用 Then 合并为一个流程', async () => {
    const calls: string[] = []
    const coordinator = new AgentSessionDeletionCoordinator()
    const deps = controlledDeps(calls, async () => {})
    const first = coordinator.delete('s1', deps)
    const second = coordinator.delete('s1', deps)
    expect(first).toBe(second)
    await first
    expect(calls).toEqual(['begin', 'stop', 'clear', 'delete', 'end'])
  })

  test('Given stopAndWait 失败 When 删除 Then 不清理或删除但释放删除锁', async () => {
    const calls: string[] = []
    const coordinator = new AgentSessionDeletionCoordinator()
    await expect(coordinator.delete('s1', controlledDeps(calls, async () => { throw new Error('timeout') }))).rejects.toThrow('timeout')
    expect(calls).toEqual(['begin', 'stop', 'end'])
  })
})
