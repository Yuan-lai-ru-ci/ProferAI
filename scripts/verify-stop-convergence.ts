#!/usr/bin/env bun
/**
 * 停止收敛验证脚本。
 *
 * 不启动 Electron，直接 import 真实的 runtime 模块，验证「用户点停止 → 终态到达」
 * 这条链上曾经会挂死的三个点。可以随时重跑：
 *
 *   bun scripts/verify-stop-convergence.ts
 *
 * 为什么不用单测覆盖就够了：单测里 iterator 的 return() 往往会立即 resolve，
 * 而真实 provider（Pi 的 async generator）在工具卡住时 return() 永不 settle。
 * 这个脚本专门构造那种 iterator。
 */

import { closeAgentStreamIterator, readAgentStreamNext } from '../packages/agent-runtime/src/stream-reader'
import { DelegationBlockedRegistry, waitForDelegationProgress } from '../packages/agent-runtime/src/delegation-blocked'

const results: Array<{ name: string; pass: boolean; detail: string }> = []

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/** 对照：修复前读取器就是这样 await 清理的，这里证明它会挂住。 */
async function controlReturnNeverSettles(): Promise<void> {
  const iterator = {
    next: () => neverSettles<IteratorResult<string>>(),
    return: () => neverSettles<IteratorResult<string>>(),
  }
  const startedAt = Date.now()
  const outcome = await Promise.race([
    readAgentStreamNext(iterator, { shouldStop: () => true, pollIntervalMs: 10 }),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
  ])
  const elapsed = Date.now() - startedAt
  record(
    '对照：provider 的 return() 永不 settle 时，读取器仍能在 2s 内返回',
    outcome !== 'hung',
    `elapsed=${elapsed}ms, result=${typeof outcome === 'string' ? outcome : JSON.stringify(outcome)}`,
  )
}

/** 场景 A：模拟 orchestrator 的消费循环，工具卡死但用户点了停止。 */
async function stopWhileToolHangs(): Promise<void> {
  let stopped = false
  const iterator = {
    // 模拟 agent-loop 里 await tool.execute(...)：这个 promise 永不 settle。
    next: () => neverSettles<IteratorResult<{ type: string }>>(),
    return: () => neverSettles<IteratorResult<{ type: string }>>(),
  }

  const startedAt = Date.now()
  const loop = (async (): Promise<string> => {
    for (;;) {
      const next = await readAgentStreamNext(iterator, { shouldStop: () => stopped, pollIntervalMs: 50 })
      if (next.kind === 'stopped') return 'stopped'
      if (next.kind === 'done') return 'done'
    }
  })()

  // 用户点停止。
  setTimeout(() => { stopped = true }, 50)

  const outcome = await Promise.race([
    loop,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
  ])
  const elapsed = Date.now() - startedAt
  record(
    '场景 A：工具卡死时点停止，消费循环在 1s 内退出',
    outcome === 'stopped' && elapsed < 1_000,
    `outcome=${outcome}, elapsed=${elapsed}ms`,
  )
}

/** 场景 B：清理超时不再拖死调用方。 */
async function cleanupTimeout(): Promise<void> {
  const iterator = {
    next: async () => ({ done: true as const, value: undefined }),
    return: () => neverSettles<IteratorResult<string>>(),
  }
  const startedAt = Date.now()
  await closeAgentStreamIterator(iterator, { timeoutMs: 100 })
  const elapsed = Date.now() - startedAt
  record(
    '场景 B：清理超时后放弃等待，不拖死调用方',
    elapsed < 1_500,
    `elapsed=${elapsed}ms（配置超时 100ms）`,
  )
}

/** 场景 C：父会话停止时，wait_for_delegations 的等待能被解除。 */
async function delegationWaitInterrupted(): Promise<void> {
  const registry = new DelegationBlockedRegistry({ now: () => 1_000, createId: () => 'blocked-1' })
  const controller = new AbortController()
  const startedAt = Date.now()

  const waiting = waitForDelegationProgress({
    registry,
    delegationIds: ['delegation-a'],
    completed: neverSettles<void>(),
    timeoutMs: 30 * 60_000,
    signal: controller.signal,
  })

  setTimeout(() => controller.abort(), 50)
  const outcome = await Promise.race([
    waiting,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
  ])
  const elapsed = Date.now() - startedAt
  record(
    '场景 C：父会话停止时，子会话等待在 1s 内返回 interrupted',
    outcome !== 'hung' && (outcome as { status?: string }).status === 'interrupted' && elapsed < 1_000,
    `outcome=${JSON.stringify(outcome)}, elapsed=${elapsed}ms`,
  )
}

/** 场景 D：正常流不能被改动影响。 */
async function normalStreamUnaffected(): Promise<void> {
  const iterator = (async function* () {
    yield { type: 'assistant' }
    yield { type: 'result' }
  })()
  const seen: string[] = []
  for (;;) {
    const next = await readAgentStreamNext(iterator, { shouldStop: () => false, pollIntervalMs: 50 })
    if (next.kind === 'done') break
    if (next.kind === 'stopped') break
    seen.push(next.value.type)
  }
  record(
    '场景 D：正常流仍按顺序读完，未被停止逻辑干扰',
    seen.join(',') === 'assistant,result',
    `messages=${seen.join(',')}`,
  )
}

console.log('=== 停止收敛验证 ===\n')
await controlReturnNeverSettles()
await stopWhileToolHangs()
await cleanupTimeout()
await delegationWaitInterrupted()
await normalStreamUnaffected()

const failed = results.filter((item) => !item.pass)
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  console.log(failed.map((item) => `- ${item.name}: ${item.detail}`).join('\n'))
  process.exit(1)
}
