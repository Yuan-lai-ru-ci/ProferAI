import { describe, expect, spyOn, test } from 'bun:test'
import * as React from 'react'
import { useCompletionTransition } from './useCompletionTransition'

type Cleanup = () => void
type Effect = { deps: readonly unknown[] | undefined; cleanup?: Cleanup }
type StateAction<T> = T | ((previous: T) => T)

// 只模拟 hook 的 render/commit 与时钟，不模拟 DOM 布局；不替换全局 React 模块。
function createHarness() {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown }
    }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const states: unknown[] = []
  const effects: Effect[] = []
  let cursor = 0
  let dirty = false
  let jobs: Array<() => void> = []
  let now = 0
  let nextTimer = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const fakeTimeout = (callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    if (typeof callback !== 'function') throw new Error('只支持函数 timer')
    const id = nextTimer++
    timers.set(id, { at: now + Number(delay ?? 0), callback: () => callback() })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  const timeoutImpl = Object.assign(
    fakeTimeout,
    { __promisify__: globalThis.setTimeout.__promisify__ },
  ) as typeof setTimeout
  const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(timeoutImpl)
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
    timers.delete(Number(id))
  })
  const dispatcher = {
    useState<T>(initial: T | (() => T)): [T, (action: StateAction<T>) => void] {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [states[index] as T, (action) => {
        states[index] = typeof action === 'function'
          ? (action as (previous: T) => T)(states[index] as T)
          : action
        dirty = true
      }]
    },
    useEffect(create: () => Cleanup | void, deps?: readonly unknown[]) {
      const index = cursor++
      const previous = effects[index]
      if (previous && deps && previous.deps && deps.every((value, i) => Object.is(value, previous.deps![i]))) return
      jobs.push(() => {
        previous?.cleanup?.()
        effects[index] = { deps, cleanup: create() || undefined }
      })
    },
  }

  return {
    render(streaming: boolean, pending: boolean) {
      let output = false
      let firstOutput = false
      let passes = 0
      do {
        if (++passes > 10) throw new Error('render-phase 更新未收敛')
        cursor = 0
        dirty = false
        jobs = []
        const previous = internals.ReactCurrentDispatcher.current
        internals.ReactCurrentDispatcher.current = dispatcher
        try {
          output = useCompletionTransition(streaming, pending)
          if (passes === 1) firstOutput = output
        } finally {
          internals.ReactCurrentDispatcher.current = previous
        }
      } while (dirty)
      for (const job of jobs) job()
      return { firstOutput, output }
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    timerCount: () => timers.size,
    dispose() {
      for (const effect of effects) effect?.cleanup?.()
      timeoutSpy.mockRestore()
      clearSpy.mockRestore()
    },
  }
}

function withHarness(run: (harness: ReturnType<typeof createHarness>) => void) {
  const harness = createHarness()
  try { run(harness) } finally { harness.dispose() }
}

describe('流式完成过渡', () => {
  test('静态历史和流式运行均不使用完成过渡，也不启动计时器', () => withHarness((h) => {
    expect(h.render(false, false).output).toBe(false)
    expect(h.timerCount()).toBe(0)
    expect(h.render(true, true).output).toBe(false)
    expect(h.timerCount()).toBe(0)
  }))

  test('无正文短轮次结束首帧 instant，150ms 后恢复而非永久 cooldown', () => withHarness((h) => {
    h.render(true, false)
    expect(h.render(false, false)).toEqual({ firstOutput: true, output: true })
    expect(h.timerCount()).toBe(1)
    h.advance(149)
    expect(h.render(false, false).output).toBe(true)
    h.advance(1)
    expect(h.render(false, false).output).toBe(false)
    expect(h.timerCount()).toBe(0)
  }))

  test('等待持久化期间不启动 timer，完成替换后才计算 150ms', () => withHarness((h) => {
    h.render(true, true)
    expect(h.render(false, true).firstOutput).toBe(true)
    expect(h.timerCount()).toBe(0)
    h.advance(1000)
    expect(h.render(false, true).output).toBe(true)
    expect(h.render(false, false).output).toBe(true)
    expect(h.timerCount()).toBe(1)
    h.advance(150)
    expect(h.render(false, false).output).toBe(false)
  }))

  test('cooldown 中新轮次取消旧 timer，下一轮仍获得完整兜底', () => withHarness((h) => {
    h.render(true, false)
    h.render(false, false)
    h.advance(100)
    expect(h.render(true, true).output).toBe(false)
    expect(h.timerCount()).toBe(0)
    h.advance(50)
    expect(h.render(false, false).output).toBe(true)
    h.advance(149)
    expect(h.render(false, false).output).toBe(true)
    h.advance(1)
    expect(h.render(false, false).output).toBe(false)
  }))

  test('替换等待重新出现时取消兜底，清空后重新获得完整 150ms', () => withHarness((h) => {
    h.render(true, true)
    h.render(false, false)
    h.advance(100)
    h.render(false, true)
    expect(h.timerCount()).toBe(0)
    h.advance(100)
    h.render(false, false)
    h.advance(149)
    expect(h.render(false, false).output).toBe(true)
    h.advance(1)
    expect(h.render(false, false).output).toBe(false)
  }))

  test('非流式挂载时仅由 pending 保持 instant，清空后不残留过渡', () => withHarness((h) => {
    expect(h.render(false, true).output).toBe(true)
    expect(h.timerCount()).toBe(0)
    expect(h.render(false, false).output).toBe(false)
  }))

  test('卸载清理尚未触发的 timer', () => {
    const h = createHarness()
    try {
      h.render(true, false)
      h.render(false, false)
      expect(h.timerCount()).toBe(1)
    } finally { h.dispose() }
    expect(h.timerCount()).toBe(0)
  })
})
