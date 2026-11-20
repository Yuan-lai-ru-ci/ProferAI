/**
 * 非 Electron 验证 fixture：可控 Claude Agent SDK 替身 + 进程替身。
 *
 * 用途：
 * - packages/agent-provider-claude 的单元测试（通过 ClaudeProviderDependencies.sdkLoader 注入）
 * - test-hosts/minimal-claude-runner.ts 的最小 Bun runner
 *
 * 只替代外部能力（SDK 查询对象、子进程、后台任务控制），不替代真实抽出的 ClaudeAgentAdapter。
 * 不发起任何真实网络请求，不读取凭据。
 */

import { EventEmitter } from 'node:events'
import type { ClaudeSdkModule, ClaudeSpawnProcessLike, ClaudeSpawnedProcessLike } from '../src/claude-agent-adapter'

/** 伪造 PID：选择系统当前不存在的 PID，避免 abort 兜底真的向真实进程发信号。 */
function freeFakePid(): number {
  for (const pid of [999_999, 999_998, 999_997, 4_194_303]) {
    try {
      process.kill(pid, 0)
    } catch {
      return pid
    }
  }
  throw new Error('无法找到未占用的伪造 PID')
}

/** 子进程替身：只提供 adapter 实际使用的 pid / stderr / once('exit')。 */
export class FakeChildProcess extends EventEmitter {
  readonly pid: number
  readonly stderr: EventEmitter & { resume: () => void }
  killed = false

  constructor(pid = freeFakePid()) {
    super()
    this.pid = pid
    this.stderr = Object.assign(new EventEmitter(), { resume: () => {} })
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }

  /** 模拟子进程自然退出，触发 adapter 的 pidMap 清理。 */
  exit(): void {
    this.emit('exit', 0, null)
  }
}
export interface ClaudeSdkSpawnOptionsLike {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

export interface ClaudeSdkDoubleState {
  /** adapter 传给 sdk.query 的 options。 */
  options?: Record<string, unknown>
  /** adapter 传给 sdk.query 的 prompt（消息通道 generator）。 */
  prompt?: AsyncIterable<unknown>
  /** SDK 侧实际从消息通道取到的消息。 */
  promptInputs: unknown[]
  stopTaskCalls: string[]
  stopTaskError?: Error
  interruptCalls: number
  closeCalls: number
  /** adapter 主动结束 SDK iterator（for-await break 触发 return()）。 */
  returnCalls: number
  permissionModeCalls: string[]
  permissionModeError?: Error
  permissionModeWait?: Promise<void>
  spawnCalls: number
  spawnedEnvs: Array<Record<string, string | undefined>>
  /** 最后一次进程替身，供模拟 exit。 */
  lastChild?: FakeChildProcess
  stop: () => void
}

export interface ClaudeSdkDouble {
  /** 注入给 ClaudeProviderDependencies.sdkLoader 的模块替身。 */
  module: ClaudeSdkModule
  /** 注入给 ClaudeProviderDependencies.spawnProcess 的进程启动替身。 */
  spawnProcess: ClaudeSpawnProcessLike
  state: ClaudeSdkDoubleState
  /** 向 adapter 的消费流推送一条 SDK 消息。 */
  push: (message: unknown) => void
  /** 结束 SDK 输出流（iterator done）。 */
  end: () => void
  /** 让 SDK 流以错误结束（抛给 adapter）。 */
  fail: (error: unknown) => void
  /** 读取 adapter 注入的下一条用户消息（消息通道）。 */
  nextPromptInput: (timeoutMs?: number) => Promise<unknown>
  /** 让 SDK 侧调用 adapter 传入的 spawnClaudeCodeProcess（进程本身由替身提供）。 */
  spawn: (overrides?: Partial<ClaudeSdkSpawnOptionsLike>) => ClaudeSpawnedProcessLike
  /** 关闭替身内部所有的等待者，防止测试残留挂起。 */
  dispose: () => void
}

/**
 * 创建一个可脚本化驱动的 SDK 双出。
 *
 * adapter 的查询对象接口：AsyncIterable + close()/stopTask()/interrupt()/setPermissionMode()。
 */
export function createClaudeSdkDouble(): ClaudeSdkDouble {
  const state: ClaudeSdkDoubleState = {
    promptInputs: [],
    stopTaskCalls: [],
    interruptCalls: 0,
    closeCalls: 0,
    returnCalls: 0,
    permissionModeCalls: [],
    spawnCalls: 0,
    spawnedEnvs: [],
    stop: () => {},
  }

  const queue: unknown[] = []
  const waiters: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []
  let closed = false
  let failure: unknown
  let failurePending = false
  const promptWaiters: Array<(value: unknown) => void> = []

  function settle(): void {
    while (waiters.length > 0) {
      const waiter = waiters.shift()!
      if (failurePending) {
        failurePending = false
        waiter.reject(failure)
        continue
      }
      if (queue.length > 0) {
        waiter.resolve(queue.shift())
        continue
      }
      if (closed) {
        waiter.resolve(undefined)
        continue
      }
      waiters.unshift(waiter)
      break
    }
  }

  const iterator: AsyncIterator<unknown> = {
    async next(): Promise<IteratorResult<unknown>> {
      if (queue.length > 0) return { value: queue.shift(), done: false }
      if (failurePending) {
        failurePending = false
        throw failure
      }
      if (closed) return { value: undefined, done: true }
      const value = await new Promise<unknown>((resolve, reject) => waiters.push({ resolve, reject }))
      if (value === undefined && (closed || failurePending)) {
        if (failurePending) {
          failurePending = false
          throw failure
        }
        return { value: undefined, done: true }
      }
      return { value, done: false }
    },
    async return(): Promise<IteratorResult<unknown>> {
      state.returnCalls += 1
      closed = true
      settle()
      return { value: undefined, done: true }
    },
  }

  /**
   * SDK 查询对象：adapter 会把它当 async iterable 消费，并在其上调
   * close()/stopTask()/interrupt()/setPermissionMode()，因此方法必须挂在同一对象上。
   */
  const queryObject = {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return iterator
    },
    async close() {
      state.closeCalls += 1
      closed = true
      settle()
    },
    async stopTask(taskId: string) {
      state.stopTaskCalls.push(taskId)
      if (state.stopTaskError) throw state.stopTaskError
    },
    async interrupt() {
      state.interruptCalls += 1
    },
    async setPermissionMode(mode: string) {
      state.permissionModeCalls.push(mode)
      await state.permissionModeWait
      if (state.permissionModeError) throw state.permissionModeError
    },
  }

  /** 消费 adapter 的消息通道，并记录 SDK 侧实际收到的输入。 */
  async function consumePrompt(prompt: AsyncIterable<unknown>): Promise<void> {
    for await (const message of prompt) {
      state.promptInputs.push(message)
      const waiter = promptWaiters.shift()
      if (waiter) waiter(message)
    }
  }

  const sdkModule = {
    query(input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) {
      // 每次 query 都是独立的 SDK 查询：重置上一轮的终止/错误状态与残留队列。
      closed = false
      failure = undefined
      failurePending = false
      queue.length = 0
      state.options = input.options
      state.prompt = input.prompt
      void consumePrompt(input.prompt)
      return queryObject
    },
  }

  state.stop = () => {
    closed = true
    settle()
  }

  /** 进程启动替身：只记录启动参数并返回 FakeChildProcess，不真的创建进程。 */
  const spawnProcess: ClaudeSpawnProcessLike = (_command, _args, options) => {
    state.spawnCalls += 1
    state.spawnedEnvs.push({ ...(options.env ?? {}) })
    const child = new FakeChildProcess()
    state.lastChild = child
    return child
  }

  return {
    module: sdkModule as unknown as ClaudeSdkModule,
    spawnProcess,
    state,
    push(message: unknown) {
      queue.push(message)
      settle()
    },
    end() {
      closed = true
      settle()
    },
    fail(error: unknown) {
      failure = error
      failurePending = true
      settle()
    },
    async nextPromptInput(timeoutMs = 2_000): Promise<unknown> {
      if (state.promptInputs.length > 0) return state.promptInputs.shift()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待注入消息超时')), timeoutMs)
        promptWaiters.push((message) => {
          clearTimeout(timer)
          state.promptInputs.shift()
          resolve(message)
        })
      })
    },
    spawn(overrides: Partial<ClaudeSdkSpawnOptionsLike> = {}): ClaudeSpawnedProcessLike {
      const spawn = state.options?.spawnClaudeCodeProcess as
        | ((options: ClaudeSdkSpawnOptionsLike) => ClaudeSpawnedProcessLike)
        | undefined
      if (!spawn) throw new Error('adapter 未向 SDK 传入 spawnClaudeCodeProcess')
      const options: ClaudeSdkSpawnOptionsLike = {
        command: 'fake-claude',
        args: [],
        cwd: process.cwd(),
        env: {},
        ...overrides,
      }
      return spawn(options)
    },
    dispose() {
      closed = true
      settle()
      promptWaiters.length = 0
    },
  }
}
