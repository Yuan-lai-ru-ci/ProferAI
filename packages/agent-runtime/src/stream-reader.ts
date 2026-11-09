import type { AgentStreamDrainSignal, AgentStreamDrainState } from './stream-drain'
import { advanceAgentStreamDrain } from './stream-drain'

export type AgentStreamReadResult<T> =
  | { kind: 'message'; value: T }
  | { kind: 'done' }
  | { kind: 'stopped' }

export interface AgentStreamReader<T> {
  next(...args: []): Promise<IteratorResult<T>>
  return?(value?: unknown): Promise<IteratorResult<T>>
}

export interface ReadAgentStreamNextOptions {
  shouldStop(): boolean
  pollIntervalMs?: number
}

/**
 * 读取一个异步迭代器事件，并在宿主请求停止时主动关闭迭代器。
 *
 * provider 的 next() 可能长期等待工具审批、后台任务或网络响应；这里保留
 * pending next 的 promise，同时用宿主无关的停止谓词打断等待。消息业务解释仍
 * 留在宿主，runtime 只拥有 iterator 的生命周期和 drain 边界。
 */
export async function readAgentStreamNext<T>(
  iterator: AgentStreamReader<T>,
  options: ReadAgentStreamNextOptions,
): Promise<AgentStreamReadResult<T>> {
  if (options.shouldStop()) {
    // 停止路径不得等待 provider 清理。async generator 的 return() 无法抢占其内部
    // 未 settle 的 await（实测：既不 resolve 也不 reject），await 它会让读取器
    // 永久挂住，终态就永远到不了宿主。清理转后台，generator 最终仍会走自己的 finally。
    void closeAgentStreamIterator(iterator)
    return { kind: 'stopped' }
  }

  const pendingNext = Promise.resolve().then(() => iterator.next())
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopResolved = false
  const stopPromise = new Promise<'stopped'>((resolve) => {
    const check = () => {
      if (stopResolved) return
      if (options.shouldStop()) {
        stopResolved = true
        resolve('stopped')
        return
      }
      timer = setTimeout(check, options.pollIntervalMs ?? 200)
    }
    check()
  })

  try {
    const result = await Promise.race([
      pendingNext.then(next => ({ kind: 'next' as const, next })),
      stopPromise.then(kind => ({ kind, next: null })),
    ])
    if (result.kind === 'stopped') {
      pendingNext.catch(() => {})
      // 同第一个分支：先宣布终态，清理不参与终态时序。
      void closeAgentStreamIterator(iterator)
      return { kind: 'stopped' }
    }
    if (result.next.done) return { kind: 'done' }
    return { kind: 'message', value: result.next.value }
  } finally {
    if (timer) clearTimeout(timer)
    stopResolved = true
  }
}

/**
 * 关闭 provider 迭代器。
 *
 * 停止路径不 await 本函数；即便有调用方等待，也不能让它无限挂住：
 * provider 的 return() 在内部 await 未 settle 时不会 resolve，所以这里加一道
 * 超时，超时只记日志并放弃等待，不影响已经决定的本轮终态。
 */
export async function closeAgentStreamIterator<T>(
  iterator: AgentStreamReader<T>,
  options?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(iterator.return?.()),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn('[agent-runtime] provider 迭代器清理超时，已放弃等待（终态不受影响）')
          resolve()
        }, timeoutMs)
      }),
    ])
  } catch {
    // stop 已经决定了本轮终态；provider 的 close 错误交给下一层统一处理。
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface AgentStreamDrainController {
  state: AgentStreamDrainState
  signal(signal: AgentStreamDrainSignal): AgentStreamDrainState
}

export function createAgentStreamDrainController(): AgentStreamDrainController {
  let state: AgentStreamDrainState = 'open'
  return {
    get state() {
      return state
    },
    signal(signal) {
      state = advanceAgentStreamDrain(state, signal)
      return state
    },
  }
}
