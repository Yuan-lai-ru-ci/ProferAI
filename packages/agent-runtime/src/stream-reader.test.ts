import { describe, expect, test } from 'bun:test'
import { closeAgentStreamIterator, createAgentStreamDrainController, readAgentStreamNext } from './stream-reader'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('runtime stream reader', () => {
  test('waits for iterator completion after result messages', async () => {
    const iterator = (async function* () {
      yield { type: 'result' }
    })()

    expect(await readAgentStreamNext(iterator, { shouldStop: () => false })).toEqual({ kind: 'message', value: { type: 'result' } })
    expect(await readAgentStreamNext(iterator, { shouldStop: () => false })).toEqual({ kind: 'done' })
  })

  test('closes a pending iterator when the host requests stop', async () => {
    const gate = deferred<IteratorResult<string>>()
    let returned = false
    const iterator = {
      next: () => gate.promise,
      return: async () => { returned = true; return { done: true, value: undefined } },
    }
    let stopped = false
    const result = readAgentStreamNext(iterator, { shouldStop: () => stopped, pollIntervalMs: 1 })
    stopped = true

    await expect(result).resolves.toEqual({ kind: 'stopped' })
    expect(returned).toBe(true)
    gate.resolve({ done: true, value: undefined })
  })

  test('preserves the stream drain state transitions for the host', () => {
    const drain = createAgentStreamDrainController()
    expect(drain.signal('result')).toBe('result_received')
    expect(drain.signal('iterator_done')).toBe('closed')
    expect(drain.signal('stop')).toBe('closed')
  })

  // 回归：provider 的 return() 在内部 await 未 settle 时永不 resolve（async generator
  // 语义如此）。停止路径一旦 await 它，读取器就永不返回，宿主的终态与 cleanup 全部卡死。
  test('停止不被永不 settle 的 provider 清理阻塞', async () => {
    const gate = deferred<IteratorResult<string>>()
    const iterator = {
      next: () => gate.promise,
      return: () => new Promise<IteratorResult<string>>(() => {}),
    }
    let stopped = false
    const reading = readAgentStreamNext(iterator, { shouldStop: () => stopped, pollIntervalMs: 1 })
    stopped = true

    await expect(reading).resolves.toEqual({ kind: 'stopped' })
  })

  test('清理超时后放弃等待，不拖死调用方', async () => {
    const iterator = {
      next: async () => ({ done: true as const, value: undefined }),
      return: () => new Promise<IteratorResult<string>>(() => {}),
    }
    const startedAt = Date.now()

    await closeAgentStreamIterator(iterator, { timeoutMs: 20 })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
