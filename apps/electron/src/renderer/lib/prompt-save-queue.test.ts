import { describe, expect, test } from 'bun:test'
import { createPromptSaveQueue, mergeSystemPromptUpdate } from './prompt-save-queue'
import type { SystemPromptUpdateInput } from '@profer/shared'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface RecordedSave {
  id: string
  input: SystemPromptUpdateInput
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('串行提示词保存与失败草稿', () => {
  test('并发 flush 共享在途写入，直到最新字段全部保存', async () => {
    const response = deferred<void>()
    const calls: RecordedSave[] = []
    const queue = createPromptSaveQueue(async (id, input) => {
      calls.push({ id, input })
      if (calls.length === 1) await response.promise
    }, 10000)
    queue.queue('p1', { content: 'A' })
    const first = queue.flush()
    queue.queue('p1', { content: 'B' })
    const second = queue.flush()
    expect(calls).toHaveLength(1)
    response.resolve()
    await Promise.all([first, second])
    expect(calls).toEqual([{ id: 'p1', input: { content: 'A' } }, { id: 'p1', input: { content: 'B' } }])
    expect(queue.pendingCount()).toBe(0)
  })

  test('失败字段与在途新字段合并，重试不丢名称或内容', async () => {
    const response = deferred<void>()
    const calls: RecordedSave[] = []
    const queue = createPromptSaveQueue(async (id, input) => {
      calls.push({ id, input })
      if (calls.length === 1) await response.promise
    }, 10000)
    queue.queue('p1', { name: 'A', content: 'old' })
    const first = queue.flush()
    queue.queue('p1', { content: 'new' })
    response.reject(new Error('fixture failure'))
    await expect(first).rejects.toThrow('fixture failure')
    expect(queue.pendingCount()).toBe(1)
    await queue.flush()
    expect(calls[1]!.input).toEqual({ name: 'A', content: 'new' })
    expect(queue.pendingCount()).toBe(0)
  })

  test('其它条目在等待期间收到新字段，读取最新待写值而不是旧快照', async () => {
    const response = deferred<void>()
    const calls: RecordedSave[] = []
    const queue = createPromptSaveQueue(async (id, input) => {
      calls.push({ id, input })
      if (id === 'p1') await response.promise
    }, 10000)
    queue.queue('p1', { content: 'A' })
    queue.queue('p2', { content: 'old' })
    const saving = queue.flush()
    queue.queue('p2', { name: 'Name', content: 'new' })
    response.resolve()
    await saving
    expect(calls[1]).toEqual({ id: 'p2', input: { name: 'Name', content: 'new' } })
  })
})

/** 记录落盘调用的假 save */
function createRecorder(failFor: string[] = []): {
  calls: RecordedSave[]
  save: (id: string, input: SystemPromptUpdateInput) => Promise<void>
} {
  const calls: RecordedSave[] = []
  return {
    calls,
    save: async (id, input) => {
      if (failFor.includes(id)) throw new Error(`模拟失败: ${id}`)
      calls.push({ id, input })
    },
  }
}

describe('createPromptSaveQueue 行为', () => {
  test('输入期间不落盘，静默后只落盘一次且取最后一次的值', async () => {
    const { calls, save } = createRecorder()
    const queue = createPromptSaveQueue(save, 30)

    queue.queue('p1', { name: 'a' })
    await sleep(10)
    queue.queue('p1', { name: 'ab' })
    await sleep(10)
    queue.queue('p1', { name: 'abc' })

    // 连续输入期间一次都没写
    expect(calls).toEqual([])
    expect(queue.pendingCount()).toBe(1)

    await sleep(60)

    expect(calls).toEqual([{ id: 'p1', input: { name: 'abc' } }])
    expect(queue.pendingCount()).toBe(0)
  })

  test('同一防抖窗口内“先改名、再改内容”两项都要落盘（修复字段被覆盖丢失）', async () => {
    const { calls, save } = createRecorder()
    const queue = createPromptSaveQueue(save, 30)

    queue.queue('p1', { name: '新名字' })
    queue.queue('p1', { content: '新内容' })

    await sleep(60)

    expect(calls).toEqual([{ id: 'p1', input: { name: '新名字', content: '新内容' } }])
  })

  test('flush 立即落盘，不等静默期（卸载/切换前的兜底）', async () => {
    const { calls, save } = createRecorder()
    const queue = createPromptSaveQueue(save, 10_000)

    queue.queue('p1', { content: '未到静默期' })
    expect(calls).toEqual([])

    await queue.flush()

    expect(calls).toEqual([{ id: 'p1', input: { content: '未到静默期' } }])
    expect(queue.pendingCount()).toBe(0)

    // flush 之后原来的定时器不应再产生第二次写入
    await sleep(20)
    expect(calls).toHaveLength(1)
  })

  test('切换提示词时各自累积，互不覆盖', async () => {
    const { calls, save } = createRecorder()
    const queue = createPromptSaveQueue(save, 30)

    queue.queue('p1', { content: 'A 的内容' })
    queue.queue('p2', { content: 'B 的内容' })
    queue.queue('p1', { name: 'A 的名字' })

    await sleep(60)

    const byId = new Map(calls.map((c) => [c.id, c.input]))
    expect(byId.get('p1')).toEqual({ content: 'A 的内容', name: 'A 的名字' })
    expect(byId.get('p2')).toEqual({ content: 'B 的内容' })
  })

  test('maxWaitMs：持续输入不停时也至少每 maxWait 落盘一次', async () => {
    const { calls, save } = createRecorder()
    // 防拖 30ms、最长延迟 60ms；每 10ms 输入一次，永无静默期
    const queue = createPromptSaveQueue(save, 30, { maxWaitMs: 60 })

    for (let i = 0; i < 12; i++) {
      queue.queue('p1', { content: `第 ${i} 次` })
      await sleep(10)
    }

    // 未被无限推迟：至少落盘了一次
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls.every((c) => c.id === 'p1')).toBe(true)
  })

  test('单条落盘失败不阻塞其它条目，失败草稿保留供重试', async () => {
    const { calls, save } = createRecorder(['p2'])
    const queue = createPromptSaveQueue(save, 30)

    // 失败路径会打印错误日志，测试中静音以免污染输出
    const originalError = console.error
    console.error = (): void => {}
    try {
      queue.queue('p1', { content: '1' })
      queue.queue('p2', { content: '2' })
      queue.queue('p3', { content: '3' })

      await sleep(60)
    } finally {
      console.error = originalError
    }

    expect(calls.map((c) => c.id)).toEqual(['p1', 'p3'])
    expect(queue.pendingCount()).toBe(1)
  })
})

describe('mergeSystemPromptUpdate', () => {
  test('同一字段重复修改只保留最新值', () => {
    const pending = new Map<string, SystemPromptUpdateInput>()
    mergeSystemPromptUpdate(pending, 'p1', { name: '一' })
    mergeSystemPromptUpdate(pending, 'p1', { name: '二' })
    expect(pending.get('p1')).toEqual({ name: '二' })
    expect(pending.size).toBe(1)
  })

  test('不修改传入的对象（避免共享引用被后续变更污染）', () => {
    const pending = new Map<string, SystemPromptUpdateInput>()
    const first: SystemPromptUpdateInput = { name: '原名' }
    mergeSystemPromptUpdate(pending, 'p1', first)
    mergeSystemPromptUpdate(pending, 'p1', { content: '内容' })

    expect(first).toEqual({ name: '原名' })
    expect(pending.get('p1')).toEqual({ name: '原名', content: '内容' })
  })
})
