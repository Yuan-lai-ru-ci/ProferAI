/**
 * 协作子会话阻塞处理契约。
 *
 * 覆盖：阻塞登记/解决/清理、唤醒去重与前置条件、提示词决策规则、
 * 以及「父等子完成、子等父回答」互锁的解除（等待提前返回 blocked）。
 */

import { describe, expect, test } from 'bun:test'
import {
  DelegationBlockedRegistry,
  buildDelegationBlockedPrompt,
  decideDelegationBlockedWake,
  waitForDelegationProgress,
} from './delegation-blocked'

let sequence = 0
function createRegistry(now: () => number = () => 1000): DelegationBlockedRegistry {
  return new DelegationBlockedRegistry({ now, createId: () => `blocked-${++sequence}` })
}

function registerAskUser(registry: DelegationBlockedRegistry, delegationId = 'delegation-a') {
  return registry.register({
    delegationId,
    childSessionId: `${delegationId}-child`,
    kind: 'ask_user',
    requestId: `${delegationId}-request`,
    questions: [{
      question: '要不要覆盖已有产物？',
      header: '覆盖策略',
      options: [
        { label: '覆盖', description: '直接替换' },
        { label: '保留', description: '另存新文件' },
      ],
    }],
  })
}

describe('阻塞事件注册表', () => {
  test('Given 子会话提问 When 登记 Then 进入待处理并通知监听方', () => {
    const registry = createRegistry()
    const seen: string[] = []
    const unsubscribe = registry.onBlocked((event) => seen.push(event.id))

    const event = registerAskUser(registry)

    expect(registry.pendingFor(['delegation-a'])).toEqual([event])
    expect(seen).toEqual([event.id])
    expect(event).toMatchObject({ kind: 'ask_user', requestId: 'delegation-a-request', createdAt: 1000 })
    unsubscribe()
  })

  test('Given 同一请求重复上报 When 登记 Then 复用同一事件，不重复唤醒', () => {
    const registry = createRegistry()
    const first = registerAskUser(registry)
    const repeated = registerAskUser(registry)

    expect(repeated.id).toBe(first.id)
    expect(registry.pendingFor()).toHaveLength(1)
  })

  test('Given 用户回答 When 按请求 ID 解决 Then 不再待处理且不覆盖首次解决者', () => {
    const registry = createRegistry()
    const event = registerAskUser(registry)

    expect(registry.resolveByRequestId('delegation-a-request', 'answered_by_user')?.id).toBe(event.id)
    expect(registry.pendingFor()).toEqual([])
    expect(registry.resolve(event.id, 'answered_by_parent')).toBe(false)
    expect(event.resolution).toBe('answered_by_user')
  })

  test('Given 同一事件 When 重复标记唤醒/转交 Then 只认第一次', () => {
    const registry = createRegistry()
    const event = registerAskUser(registry)

    expect(registry.markWoken(event.id)).toBe(true)
    expect(registry.markWoken(event.id)).toBe(false)
    expect(registry.markEscalated(event.id)).toBe(true)
    expect(registry.markEscalated(event.id)).toBe(false)
    expect(event.wokenAt).toBe(1000)
    expect(event.escalatedAt).toBe(1000)
  })

  test('Given 委派结束 When 清理 Then 该委派下的阻塞不再唤醒等待方', () => {
    const registry = createRegistry()
    registerAskUser(registry, 'delegation-a')
    registerAskUser(registry, 'delegation-b')

    registry.clearDelegation('delegation-a')

    expect(registry.pendingFor().map((event) => event.delegationId)).toEqual(['delegation-b'])
  })
})

describe('父会话唤醒决策', () => {
  test('Given 父会话空闲且有渠道 When 存在未处理阻塞 Then 唤醒一次并带决策规则', () => {
    const registry = createRegistry()
    const event = registerAskUser(registry)

    const decision = decideDelegationBlockedWake([event], {
      parentActive: false,
      parentHasChannel: true,
      childTitles: { 'delegation-a': '核对发布清单' },
    })

    expect(decision.action).toBe('wake')
    if (decision.action !== 'wake') throw new Error('unreachable')
    expect(decision.eventIds).toEqual([event.id])
    expect(decision.prompt).toContain('### 核对发布清单')
    expect(decision.prompt).toContain(`阻塞事件 ID：${event.id}`)
    expect(decision.prompt).toContain('要不要覆盖已有产物？')
    expect(decision.prompt).toContain('覆盖（直接替换）')
    expect(decision.prompt).toContain('answer_delegation_question')
    expect(decision.prompt).toContain('已转交用户')
  })

  test('Given 父会话仍在运行 When 出现阻塞 Then 不打断，交给等待/轮询路径', () => {
    const registry = createRegistry()
    const event = registerAskUser(registry)

    expect(decideDelegationBlockedWake([event], { parentActive: true, parentHasChannel: true }))
      .toEqual({ action: 'skip', reason: 'parent_active' })
  })

  test('Given 父会话已停止或无渠道 When 出现阻塞 Then 跳过唤醒，问题留给用户', () => {
    const registry = createRegistry()
    const event = registerAskUser(registry)

    expect(decideDelegationBlockedWake([event], { parentActive: false, parentStoppedByUser: true, parentHasChannel: true }))
      .toEqual({ action: 'skip', reason: 'parent_stopped' })
    expect(decideDelegationBlockedWake([event], { parentActive: false, parentHasChannel: false }))
      .toEqual({ action: 'skip', reason: 'parent_channel_missing' })
  })

  test('Given 事件已唤醒或已转交 When 再次决策 Then 不重复唤醒', () => {
    const registry = createRegistry()
    const woken = registerAskUser(registry, 'delegation-a')
    const escalated = registerAskUser(registry, 'delegation-b')
    registry.markWoken(woken.id)
    registry.markEscalated(escalated.id)

    expect(decideDelegationBlockedWake([woken, escalated], { parentActive: false, parentHasChannel: true }))
      .toEqual({ action: 'skip', reason: 'already_handled' })
    expect(decideDelegationBlockedWake([], { parentActive: false, parentHasChannel: true }))
      .toEqual({ action: 'skip', reason: 'no_pending' })
  })

  test('Given 多个子会话同时阻塞 When 唤醒 Then 合并成一次并逐项列出', () => {
    const registry = createRegistry()
    const first = registerAskUser(registry, 'delegation-a')
    const second = registerAskUser(registry, 'delegation-b')

    const decision = decideDelegationBlockedWake([first, second], {
      parentActive: false,
      parentHasChannel: true,
      childTitles: { 'delegation-a': '任务甲', 'delegation-b': '任务乙' },
    })

    expect(decision.action).toBe('wake')
    if (decision.action !== 'wake') throw new Error('unreachable')
    expect(decision.eventIds).toEqual([first.id, second.id])
    expect(decision.prompt).toContain('### 任务甲')
    expect(decision.prompt).toContain('### 任务乙')
  })

  test('Given 权限阻塞 When 构建提示词 Then 标明工具且默认归用户决定', () => {
    const registry = createRegistry()
    const event = registry.register({
      delegationId: 'delegation-a',
      childSessionId: 'child',
      kind: 'permission',
      requestId: 'permission-request',
      toolName: 'Bash',
    })

    const prompt = buildDelegationBlockedPrompt([event])

    expect(prompt).toContain('类型：权限审批')
    expect(prompt).toContain('工具：Bash')
    expect(prompt).toContain('权限类阻塞默认归用户决定')
  })
})

describe('等待竞速', () => {
  test('Given 进入等待前已有阻塞 When 等待 Then 立即返回 blocked 而不是等到超时', async () => {
    const registry = createRegistry()
    const event = registerAskUser(registry)

    const result = await waitForDelegationProgress({
      registry,
      delegationIds: ['delegation-a'],
      completed: new Promise<void>(() => {}),
      timeoutMs: 5_000,
      initialBlocked: [event],
    })

    expect(result).toEqual({ status: 'blocked', event })
  })

  test('Given 等待中才出现阻塞 When 子会话提问 Then 提前返回 blocked', async () => {
    const registry = createRegistry()
    const waiting = waitForDelegationProgress({
      registry,
      delegationIds: ['delegation-a'],
      completed: new Promise<void>(() => {}),
      timeoutMs: 5_000,
    })

    const event = registerAskUser(registry)

    expect(await waiting).toEqual({ status: 'blocked', event })
  })

  test('Given 等待中其他委派阻塞 When 不在等待范围 Then 不提前返回', async () => {
    const registry = createRegistry()
    const waiting = waitForDelegationProgress({
      registry,
      delegationIds: ['delegation-a'],
      completed: new Promise<void>((resolve) => setTimeout(resolve, 10)),
      timeoutMs: 5_000,
    })

    registerAskUser(registry, 'delegation-b')

    expect(await waiting).toEqual({ status: 'completed' })
  })

  test('Given 子会话完成 When 同时出现阻塞 Then 完成优先，阻塞留给下一轮', async () => {
    const registry = createRegistry()
    let completed = false
    const waiting = waitForDelegationProgress({
      registry,
      delegationIds: ['delegation-a'],
      completed: Promise.resolve(),
      isCompleted: () => completed,
      timeoutMs: 5_000,
    })
    completed = true

    expect(await waiting).toEqual({ status: 'completed' })
  })

  test('Given 既无完成也无阻塞 When 超时 Then 返回 timeout 并解除监听', async () => {
    const registry = createRegistry()
    const result = await waitForDelegationProgress({
      registry,
      delegationIds: ['delegation-a'],
      completed: new Promise<void>(() => {}),
      timeoutMs: 10,
    })

    expect(result).toEqual({ status: 'timeout' })
    // 超时后登记的新阻塞不应再被上一轮等待消费。
    expect(registry.pendingFor()).toEqual([])
  })
})
