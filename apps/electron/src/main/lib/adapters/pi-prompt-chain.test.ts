import { describe, expect, test } from 'bun:test'
import { runPiPromptChain, type PiInterruptReservation, type PiPromptChainState } from './pi-prompt-chain'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function reservation(contentReady: Promise<string>) {
  const accepted = deferred<void>()
  const item: PiInterruptReservation = {
    contentReady,
    resolveAccepted: () => accepted.resolve(),
    rejectAccepted: accepted.reject,
  }
  return { item, accepted: accepted.promise }
}

function state(): PiPromptChainState {
  return { abortRequested: false, interrupting: false, pendingInterruptPrompts: [] }
}

describe('runPiPromptChain', () => {
  test('等待旧 prompt 真正结束后才消费 interrupt reservation，并在续轮结束后收束', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const prompts: string[] = []
    const active = state()
    const next = reservation(Promise.resolve('你好'))
    let calls = 0

    const chain = runPiPromptChain('旧任务', active, {
      prompt: (content) => {
        prompts.push(content)
        return calls++ === 0 ? first.promise : second.promise
      },
      prepareInitialPrompt: async (content) => content,
      shouldStopBeforeNextTurn: () => false,
      rejectPendingInterruptPrompts: () => {},
      createAbortError: () => new Error('aborted'),
      dropTrailingAbortedAssistant: () => {},
    })

    await Promise.resolve()
    expect(prompts).toEqual(['旧任务'])
    active.abortRequested = true
    active.interrupting = true
    active.pendingInterruptPrompts.push(next.item)
    first.resolve()
    await next.accepted
    expect(prompts).toEqual(['旧任务', '你好'])
    second.resolve()
    await chain
    expect(prompts).toEqual(['旧任务', '你好'])
  })

  test('连续 interrupt 时已取出的 R1 与新到的 R2 都获得 receipt 且按 FIFO 执行', async () => {
    const first = deferred<void>()
    const r1Prompt = deferred<void>()
    const r2Prompt = deferred<void>()
    const prompts: string[] = []
    const active = state()
    const r1Content = deferred<string>()
    const r1 = reservation(r1Content.promise)
    const r2 = reservation(Promise.resolve('第二条'))
    let calls = 0
    const chain = runPiPromptChain('旧任务', active, {
      prompt: (content) => {
        prompts.push(content)
        return [first.promise, r1Prompt.promise, r2Prompt.promise][calls++]!
      },
      prepareInitialPrompt: async (content) => content,
      shouldStopBeforeNextTurn: () => false,
      rejectPendingInterruptPrompts: () => {},
      createAbortError: () => new Error('aborted'),
      dropTrailingAbortedAssistant: () => {},
    })

    await Promise.resolve()
    active.abortRequested = true
    active.pendingInterruptPrompts.push(r1.item)
    first.resolve()
    await Promise.resolve()
    // R1 已被 chain shift，但尚未开始其 prompt；此时 R2 再次 interrupt。
    active.abortRequested = true
    active.pendingInterruptPrompts.push(r2.item)
    r1Content.resolve('第一条')
    await r1.accepted
    expect(prompts).toEqual(['旧任务', '第一条'])
    r1Prompt.resolve()
    await r2.accepted
    expect(prompts).toEqual(['旧任务', '第一条', '第二条'])
    r2Prompt.resolve()
    await chain
  })

  test('没有 reservation 的 abort 是真正 Stop，不启动续轮', async () => {
    const current = deferred<void>()
    const prompts: string[] = []
    const active = state()
    const chain = runPiPromptChain('旧任务', active, {
      prompt: (content) => { prompts.push(content); return current.promise },
      prepareInitialPrompt: async (content) => content,
      shouldStopBeforeNextTurn: () => false,
      rejectPendingInterruptPrompts: () => {},
      createAbortError: () => new Error('aborted'),
      dropTrailingAbortedAssistant: () => {},
    })
    await Promise.resolve()
    active.abortRequested = true
    current.resolve()
    await chain
    expect(prompts).toEqual(['旧任务'])
  })

  test('续轮内容准备失败会拒绝该 reservation 并使 chain reject，而不是悬挂', async () => {
    const first = deferred<void>()
    const active = state()
    const contentError = new Error('skill preparation failed')
    const content = deferred<string>()
    const next = reservation(content.promise)
    const chain = runPiPromptChain('旧任务', active, {
      prompt: () => first.promise,
      prepareInitialPrompt: async (content) => content,
      shouldStopBeforeNextTurn: () => false,
      rejectPendingInterruptPrompts: () => {},
      createAbortError: () => new Error('aborted'),
      dropTrailingAbortedAssistant: () => {},
    })
    const outcomes = Promise.allSettled([next.accepted, chain])
    await Promise.resolve()
    active.abortRequested = true
    active.pendingInterruptPrompts.push(next.item)
    first.resolve()
    await Promise.resolve()
    content.reject(contentError)
    const [acceptedOutcome, chainOutcome] = await outcomes
    expect(acceptedOutcome.status).toBe('rejected')
    expect(chainOutcome.status).toBe('rejected')
    if (acceptedOutcome.status === 'rejected') expect(acceptedOutcome.reason).toBe(contentError)
    if (chainOutcome.status === 'rejected') expect(chainOutcome.reason).toBe(contentError)
  })
})
