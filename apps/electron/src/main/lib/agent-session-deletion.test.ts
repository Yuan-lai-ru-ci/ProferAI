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

  test('Given 父会话带多级委派后代 When 删除 Then 先停止整棵树再从叶子删除到父会话', async () => {
    const calls: string[] = []
    const coordinator = new AgentSessionDeletionCoordinator()
    const deletion = coordinator.delete('parent', {
      getDeletionOrder: () => ['grandchild', 'child', 'parent'],
      beginDeletion: (id) => calls.push(`begin:${id}`),
      endDeletion: (id) => calls.push(`end:${id}`),
      stopAndWait: async (id) => { calls.push(`stop:${id}`) },
      clearState: (id) => calls.push(`clear:${id}`),
      deleteSession: (id) => calls.push(`delete:${id}`),
    })

    await deletion
    expect(calls).toEqual([
      'begin:grandchild', 'begin:child', 'begin:parent',
      'stop:grandchild', 'stop:child', 'stop:parent',
      'clear:grandchild', 'delete:grandchild',
      'clear:child', 'delete:child',
      'clear:parent', 'delete:parent',
      'end:grandchild', 'end:child', 'end:parent',
    ])
  })

  test('Given 子会话停止失败 When 级联删除 Then 不删除树中任何会话', async () => {
    const calls: string[] = []
    const coordinator = new AgentSessionDeletionCoordinator()
    await expect(coordinator.delete('parent', {
      getDeletionOrder: () => ['child', 'parent'],
      beginDeletion: (id) => calls.push(`begin:${id}`),
      endDeletion: (id) => calls.push(`end:${id}`),
      stopAndWait: async (id) => {
        calls.push(`stop:${id}`)
        if (id === 'child') throw new Error('child timeout')
      },
      clearState: (id) => calls.push(`clear:${id}`),
      deleteSession: (id) => calls.push(`delete:${id}`),
    })).rejects.toThrow('child timeout')

    expect(calls).toEqual(['begin:child', 'begin:parent', 'stop:child', 'end:child', 'end:parent'])
  })

  test('Given 父会话级联删除进行中 When 同时删除其子会话 Then 合并到同一删除事务', async () => {
    const calls: string[] = []
    let releaseStop: (() => void) | undefined
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
    const coordinator = new AgentSessionDeletionCoordinator()
    const parentDeletion = coordinator.delete('parent', {
      getDeletionOrder: () => ['child', 'parent'],
      beginDeletion: (id) => calls.push(`begin:${id}`),
      endDeletion: (id) => calls.push(`end:${id}`),
      stopAndWait: async (id) => {
        calls.push(`stop:${id}`)
        if (id === 'child') await stopGate
      },
      clearState: (id) => calls.push(`clear:${id}`),
      deleteSession: (id) => calls.push(`delete:${id}`),
    })
    const childDeletion = coordinator.delete('child', controlledDeps(calls, async () => {}))

    expect(childDeletion).toBe(parentDeletion)
    releaseStop?.()
    await parentDeletion
    expect(calls.filter((call) => call === 'delete:child')).toHaveLength(1)
  })
})
