import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setSessionDeletionQueuePathForTest,
  completeSessionDeletion,
  enqueueSessionDeletion,
  enqueueSessionDeletions,
  failSessionDeletion,
  isSessionDeletionPending,
  listSessionDeletionRequests,
} from './agent-session-deletion-queue'

let root = ''
let queuePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-deletion-queue-'))
  queuePath = join(root, 'agent-session-deletions.json')
  __setSessionDeletionQueuePathForTest(queuePath)
})

afterEach(() => {
  __setSessionDeletionQueuePathForTest(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('会话删除队列', () => {
  test('Given 入队 When 查询 Then 整棵树都标记为待删除且已落盘', () => {
    enqueueSessionDeletion({ sessionId: 'parent', sessionIds: ['child', 'parent'], reason: 'user' })

    expect(isSessionDeletionPending('parent')).toBe(true)
    expect(isSessionDeletionPending('child')).toBe(true)
    expect(isSessionDeletionPending('other')).toBe(false)
    expect(existsSync(queuePath)).toBe(true)

    const raw = JSON.parse(readFileSync(queuePath, 'utf8')) as { requests: Array<{ sessionIds: string[] }> }
    expect(raw.requests).toHaveLength(1)
    expect(raw.requests[0]!.sessionIds).toEqual(['parent', 'child'])
  })

  test('Given 重复入队同一会话 When 入队 Then 合并快照而不产生第二条请求', () => {
    enqueueSessionDeletion({ sessionId: 'parent', sessionIds: ['child', 'parent'] })
    enqueueSessionDeletion({ sessionId: 'parent', sessionIds: ['grandchild'] })

    const requests = listSessionDeletionRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.sessionIds).toEqual(['parent', 'child', 'grandchild'])
    expect(isSessionDeletionPending('grandchild')).toBe(true)
  })

  test('Given 批量入队 When 落盘 Then 一个请求文件包含全部条目', () => {
    const requests = enqueueSessionDeletions([
      { sessionId: 'a', sessionIds: ['a-child', 'a'] },
      { sessionId: 'b', sessionIds: ['b'], reason: 'workspace' },
    ])

    expect(requests).toHaveLength(2)
    expect(isSessionDeletionPending('a-child')).toBe(true)
    expect(isSessionDeletionPending('b')).toBe(true)
    const raw = JSON.parse(readFileSync(queuePath, 'utf8')) as { requests: Array<{ sessionId: string; reason: string }> }
    expect(raw.requests.map((item) => item.sessionId)).toEqual(['a', 'b'])
    expect(raw.requests[1]!.reason).toBe('workspace')
  })

  test('Given 删除完成 When 出队 Then 待删除标记全部清除', () => {
    const request = enqueueSessionDeletion({ sessionId: 'parent', sessionIds: ['child', 'parent'] })!
    completeSessionDeletion(request.id)

    expect(isSessionDeletionPending('parent')).toBe(false)
    expect(isSessionDeletionPending('child')).toBe(false)
    expect(listSessionDeletionRequests()).toEqual([])
  })

  test('Given 连续失败 When 未达上限 Then 保留重试，达到上限后放弃', () => {
    const request = enqueueSessionDeletion({ sessionId: 's1', sessionIds: ['s1'] })!

    expect(failSessionDeletion(request.id).abandoned).toBe(false)
    expect(failSessionDeletion(request.id).abandoned).toBe(false)
    expect(isSessionDeletionPending('s1')).toBe(true)

    expect(failSessionDeletion(request.id).abandoned).toBe(true)
    expect(isSessionDeletionPending('s1')).toBe(false)
    expect(listSessionDeletionRequests()).toEqual([])
  })

  test('Given 进程重启 When 重新加载 Then 未完成请求仍然生效', () => {
    const request = enqueueSessionDeletion({ sessionId: 's1', sessionIds: ['s1'] })!

    // 模拟重启：丢弃内存状态后从磁盘重新读取。
    __setSessionDeletionQueuePathForTest(queuePath)
    expect(listSessionDeletionRequests().map((item) => item.id)).toEqual([request.id])
    expect(isSessionDeletionPending('s1')).toBe(true)
  })

  test('Given 队列文件损坏 When 加载 Then 按空队列启动且不抛错', () => {
    writeFileSync(queuePath, '{ not-json', 'utf8')

    expect(listSessionDeletionRequests()).toEqual([])
    expect(isSessionDeletionPending('s1')).toBe(false)
  })
})
