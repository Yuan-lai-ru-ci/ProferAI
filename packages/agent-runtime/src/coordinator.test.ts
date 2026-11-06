import { describe, expect, test } from 'bun:test'
import { AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError } from '@profer/shared'
import type { AgentRuntimeAdapter, AgentRuntimeCallbacks, AgentRuntimeQuery } from './contract'
import type { AgentRunOutcome } from './events'
import { AgentRuntimeCoordinator } from './coordinator'
import type { AgentRuntimeEvent } from './events'
import { createAgentRunOwnershipRegistry } from './run-ownership'
import { AgentRunLedger, createInMemoryRunLedgerPort, type RunLedgerPort, type TaskTrigger } from './run-ledger'

function ledgerFixture(port: RunLedgerPort = createInMemoryRunLedgerPort()) {
  let sequence = 0
  const ledger = new AgentRunLedger(port, { now: () => 100 + sequence++, createId: () => `ledger-${sequence++}` })
  let finishes = 0
  const originalFinish = ledger.finish.bind(ledger)
  ledger.finish = (id, outcome) => { finishes += 1; return originalFinish(id, outcome) }
  return { ledger, port, finishes: () => finishes }
}

const runTrigger: TaskTrigger = { schemaVersion: 1, id: 'user-trigger', kind: 'user_message', actor: { type: 'user' }, createdAt: 1 }

function adapter(run: (input: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks) => Promise<AgentRunOutcome>, stop?: () => Promise<void>): AgentRuntimeAdapter {
  return { runtime: 'pi', query: run, stop }
}

const query: AgentRuntimeQuery = { sessionId: 'headless-session', runtime: 'pi', prompt: 'fixture' }

function streamAdapter(stream: () => AsyncIterable<import('@profer/shared').SDKMessage>, stop?: () => Promise<void>): AgentRuntimeAdapter {
  return { runtime: 'pi', stream, query: async () => ({ status: 'completed' }), stop }
}

describe('AgentRuntimeCoordinator headless host', () => {
  test('claims synchronous ownership, persists messages, emits lifecycle and returns terminal outcome', async () => {
    const events: AgentRuntimeEvent[] = []
    const messages: unknown[] = []
    const meta = { id: 'headless-session', title: 'fixture' } as never
    const coordinator = new AgentRuntimeCoordinator({
      adapters: {
        pi: adapter(async (_input, callbacks) => {
          await callbacks.onMessage?.({ type: 'result', session_id: 'headless-session', subtype: 'success' } as never)
          await callbacks.onComplete?.({ status: 'completed' })
          return { status: 'completed' }
        }),
      },
      ports: {
        sessions: {
          getMeta: () => meta,
          lockRuntime: () => meta,
          appendMessages: (_id, next) => { messages.push(...next) },
          updateMeta: () => undefined,
        },
        host: { emit: event => { events.push(event) } },
      },
    })
    const handle = coordinator.run(query)
    expect(coordinator.isRunning(query.sessionId)).toBe(true)
    const outcome = await handle.promise
    expect(outcome).toEqual({ status: 'completed' })
    expect(messages).toHaveLength(1)
    expect(events.map(event => event.type)).toEqual(['runtime_claimed', 'runtime_started', 'message', 'runtime_finished'])
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })

  test('Given a Pi partial stream When messages are forwarded Then partial frames stay live-only and result keeps duration', async () => {
    const persisted: Array<import('@profer/shared').SDKMessage> = []
    const events: AgentRuntimeEvent[] = []
    let now = 1000
    const coordinator = new AgentRuntimeCoordinator({
      now: () => now,
      adapters: {
        pi: streamAdapter(() => (async function* () {
          now = 1040
          // 内核消息带的是**原生**会话 id（与 agent 会话 id 不同），夹具不得用 query.sessionId 顶替。
          yield { type: 'assistant', uuid: 'assistant-1', _partial: true, session_id: 'pi-native-session-9' } as never
          now = 1060
          yield { type: 'assistant', uuid: 'assistant-1', session_id: 'pi-native-session-9' } as never
          now = 1120
          yield { type: 'result', subtype: 'success', session_id: 'pi-native-session-9' } as never
        })()),
      },
      ports: {
        sessions: {
          getMeta: () => undefined,
          appendMessages: (_sessionId, messages) => { persisted.push(...messages) },
          updateMeta: () => undefined,
        },
        host: { emit: event => { events.push(event) } },
      },
    })

    await expect(coordinator.run(query).promise).resolves.toEqual({ status: 'completed' })
    const messageEvents = events.filter((event): event is Extract<AgentRuntimeEvent, { type: 'message' }> => event.type === 'message')
    // 路由键必须是 agent 会话 id，不能是内核消息自带的 `session_id`。
    expect(messageEvents.every(event => event.sessionId === query.sessionId)).toBe(true)
    expect(messageEvents.map(event => event.message.type)).toEqual(['assistant', 'assistant', 'result'])
    expect(persisted.map(message => message.type)).toEqual(['assistant', 'result'])
    expect((messageEvents[0]!.message as Record<string, unknown>)._partial).toBe(true)
    expect((messageEvents[2]!.message as Record<string, unknown>)._durationMs).toBe(120)
  })

  test('Given runtime messages When persisted Then replay and internal frames stay out of history while tool results and visible system frames remain', async () => {
    const persisted: Array<import('@profer/shared').SDKMessage> = []
    const coordinator = new AgentRuntimeCoordinator({
      now: () => 2000,
      adapters: {
        pi: streamAdapter(() => (async function* () {
          yield { type: 'assistant', uuid: 'replay', isReplay: true, session_id: query.sessionId } as never
          yield { type: 'system', subtype: 'task_progress', session_id: query.sessionId } as never
          yield { type: 'tool_progress', tool_use_id: 'tool-1', session_id: query.sessionId } as never
          yield { type: 'user', uuid: 'internal-user', message: { content: [{ type: 'text', text: 'internal' }] }, session_id: query.sessionId } as never
          yield { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] }, session_id: query.sessionId } as never
          yield { type: 'system', subtype: 'compact_boundary', session_id: query.sessionId } as never
          yield { type: 'result', subtype: 'success', session_id: query.sessionId } as never
        })()),
      },
      ports: {
        sessions: {
          getMeta: () => undefined,
          appendMessages: (_sessionId, messages) => { persisted.push(...messages) },
          updateMeta: () => undefined,
        },
      },
    })

    await expect(coordinator.run({ ...query, modelId: 'configured-model' }).promise).resolves.toEqual({ status: 'completed' })
    expect(persisted.map(message => message.type === 'system' ? `system:${(message as { subtype?: string }).subtype}` : message.type)).toEqual([
      'user',
      'system:compact_boundary',
      'result',
    ])
    expect(persisted.every(message => typeof (message as Record<string, unknown>)._createdAt === 'number')).toBe(true)
  })

  test('Given an assistant message without channel metadata When runtime persists it Then model identity is normalized for replay', async () => {
    const persisted: Array<import('@profer/shared').SDKMessage> = []
    const coordinator = new AgentRuntimeCoordinator({
      now: () => 3000,
      adapters: {
        pi: streamAdapter(() => (async function* () {
          yield { type: 'assistant', uuid: 'assistant-model', session_id: query.sessionId } as never
          yield { type: 'result', subtype: 'success', session_id: query.sessionId } as never
        })()),
      },
      ports: {
        sessions: { getMeta: () => undefined, appendMessages: (_sessionId, messages) => { persisted.push(...messages) }, updateMeta: () => undefined },
      },
    })

    await expect(coordinator.run({ ...query, modelId: 'configured-model' }).promise).resolves.toEqual({ status: 'completed' })
    expect(persisted[0]).toMatchObject({ _channelModelId: 'configured-model', _createdAt: 3000 })
  })

  test('Given a persisted user message When runtime starts Then it is appended once after ownership lock before provider preparation', async () => {
    const messages: unknown[] = []
    const order: string[] = []
    const persistedUserMessage = { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } as never
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { order.push('provider'); return { status: 'completed' } }) },
      ports: {
        sessions: {
          getMeta: () => undefined,
          lockRuntime: () => { order.push('lock'); return meta() },
          appendMessages: (_id, next) => { order.push('append'); messages.push(...next) },
          updateMeta: () => undefined,
        },
      },
    })
    await expect(coordinator.run({ ...query, persistedUserMessage }).promise).resolves.toEqual({ status: 'completed' })
    // 落盘在 lock 之后、provider 之前（顺序断言只看相对位置，不把 preparation 写进这条用例）。
    expect(order).toEqual(['lock', 'append', 'provider'])
    expect(messages).toEqual([persistedUserMessage])
  })
  test('Given a persisted user message When the run starts Then the user bubble is forwarded on the event stream for remote clients', async () => {
    // Pocket 没有本地乐观气泡：电脑端发起的指令只能靠这条事件进入手机端。
    const events: AgentRuntimeEvent[] = []
    const persistedUserMessage = { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '来自电脑的指令' }] }, parent_tool_use_id: null } as never
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => ({ status: 'completed' })) },
      ports: {
        sessions: { getMeta: () => undefined, appendMessages: () => undefined, updateMeta: () => undefined },
        host: { emit: event => { events.push(event) } },
      },
    })
    await expect(coordinator.run({ ...query, persistedUserMessage }).promise).resolves.toEqual({ status: 'completed' })
    const messageEvents = events.filter((event): event is Extract<AgentRuntimeEvent, { type: 'message' }> => event.type === 'message')
    expect(messageEvents).toHaveLength(1)
    expect(messageEvents[0]!.sessionId).toBe(query.sessionId)
    expect(messageEvents[0]!.message).toEqual(persistedUserMessage)
    // 必须先于「运行开始」公告，手机端才能先看到指令再看到输出。
    expect(events.findIndex(event => event.type === 'message'))
      .toBeLessThan(events.findIndex(event => event.type === 'runtime_started'))
  })
  test('Given a persisted user message When runtime starts Then projection is delivered before provider and persistence is detached', async () => {
    // 2026-10-16 继承会话的行为变更（原断言为 lock → append → runtime_started → onRunStarted → preparation）：
    // 用户消息与「真正运行开始」都后移到准备成功之后、provider 启动之前，与旧编排器同序：
    // 凭证失败不再留下「孤儿用户气泡」，也不得建立 UI running 态 / 清未读 / 晋升 draft。
    const order: string[] = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { order.push('provider'); return { status: 'completed' } }) },
      ports: {
        sessions: { getMeta: () => undefined, lockRuntime: () => { order.push('lock'); return meta() }, appendMessages: () => { order.push('append') }, updateMeta: () => undefined },
        host: { emit: event => { if (event.type === 'runtime_claimed' || event.type === 'runtime_started') order.push(event.type) } },
        queryPreparation: { prepare: async () => { order.push('preparation'); return {} } },
      },
    })
    await expect(coordinator.run({ ...query, persistedUserMessage: { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } }, {
      onEvent() {},
      onRunStarted: () => { order.push('onRunStarted') },
    }).promise).resolves.toEqual({ status: 'completed' })
    expect(order).toEqual(['lock', 'runtime_claimed', 'preparation', 'runtime_started', 'append', 'onRunStarted', 'provider'])
  })
  test('Given a persisted user message without SessionPort When runtime starts Then the run fails as a preparation failure before the provider', async () => {
    // 变更点：落盘时机后移到异步准备阶段之后，因此失败以「准备失败」终态返回，而不是同步 reject。
    let started = false
    const failures: Array<{ phase: string; code?: string }> = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { started = true; return { status: 'completed' } }) },
    })
    await expect(coordinator.run({ ...query, persistedUserMessage: { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } }, {
      onEvent() {},
      onPreparationFailure: failure => { failures.push({ phase: failure.phase, ...(failure.code ? { code: failure.code } : {}) }) },
    }).promise)
      .resolves.toEqual({ status: 'failed', error: 'Persisted user message requires a SessionPort' })
    expect(failures).toEqual([{ phase: 'persistence', code: 'session_port_missing' }])
    expect(started).toBe(false)
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })
  test('Given user transcript persistence fails When runtime starts Then persistence failure does not block the run', async () => {
    let started = false
    const failures: Array<{ phase: string; message: string }> = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { started = true; return { status: 'completed' } }) },
      ports: { sessions: { getMeta: () => undefined, appendMessages: () => { throw new Error('user persistence failed') }, updateMeta: () => undefined } },
    })
    await expect(coordinator.run({ ...query, persistedUserMessage: { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } }, {
      onEvent() {},
      onPreparationFailure: failure => { failures.push({ phase: failure.phase, message: failure.message }) },
    }).promise).resolves.toEqual({ status: 'completed' })
    expect(failures).toEqual([])
    expect(started).toBe(true)
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })
  test('rejects duplicate ownership before the second adapter starts', async () => {
    let started = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { started += 1; await pending; return { status: 'completed' } }) },
      ports: { sessions: { getMeta: () => undefined, lockRuntime: () => meta(), appendMessages: () => undefined, updateMeta: () => undefined } },
    })
    const first = coordinator.run(query)
    const second = coordinator.run(query)
    // 拒绝是可识别的具名错误，不是 failed outcome：调用方不需要字符串比较，也不会把它当运行终态。
    await expect(second.promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    release()
    await expect(first.promise).resolves.toEqual({ status: 'completed' })
    expect(started).toBe(1)
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given 被拒绝的并发请求 When 它不产生任何副作用 Then 不落盘/不发事件/不影响 owner', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const events: AgentRuntimeEvent[] = []
    const messages: unknown[] = []
    const outcomes: unknown[] = []
    let starts = 0
    let stops = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async () => { starts += 1; await pending; return { status: 'completed' } }, stop: async () => { stops += 1 } } },
      ports: {
        sessions: { getMeta: () => undefined, appendMessages: (_id, next) => { messages.push(...next) }, updateMeta: () => undefined },
        host: { emit: event => { events.push(event) } },
      },
    })
    const persistedUserMessage = { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } as never
    const first = coordinator.run(query)
    const eventsAfterFirst = events.length
    const second = coordinator.run({ ...query, persistedUserMessage }, {
      onEvent() {},
      onError() { throw new Error('被拒绝的请求不能上报 onError') },
      onComplete() { throw new Error('被拒绝的请求不能上报 onComplete') },
    })
    await expect(second.promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(events.length).toBe(eventsAfterFirst)
    expect(messages).toEqual([])
    // 拒绝路径的 stop 不能停掉 owner。
    await second.stop()
    expect(stops).toBe(0)
    expect(coordinator.isRunning(query.sessionId)).toBe(true)
    release()
    await expect(first.promise).resolves.toEqual({ status: 'completed' })
    expect(outcomes).toEqual([])
    expect(starts).toBe(1)
  })

  test('Given 停止流程中的 owner When 新请求到达 Then 拒绝文案标明正在停止', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async input => {
        await Promise.race([pending, new Promise(resolve => input.abortSignal?.addEventListener('abort', resolve, { once: true }))])
        return input.abortSignal?.aborted ? { status: 'stopped' } : { status: 'completed' }
      } } },
    })
    const first = coordinator.run(query)
    await new Promise(resolve => setTimeout(resolve, 0))
    const stopping = first.stop()
    let rejected: unknown
    try {
      await coordinator.run(query).promise
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeInstanceOf(AgentRunAlreadyActiveError)
    expect((rejected as AgentRunAlreadyActiveError).stopping).toBe(true)
    release()
    await stopping
    await expect(first.promise).resolves.toEqual({ status: 'stopped' })
    // 停止收敛后 owner 释放，新 run 可以再次取得执行权。
    expect(coordinator.ownership.ownerCount()).toBe(0)
    await expect(coordinator.run(query).promise).resolves.toEqual({ status: 'completed' })
  })

  test('Given SessionPort 未提供 lockRuntime When 会话已绑定另一内核 Then 核心独立拒绝 mismatch', async () => {
    let starts = 0
    const messages: unknown[] = []
    const events: AgentRuntimeEvent[] = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', stream: () => { starts += 1; return (async function* () { yield { type: 'result', subtype: 'success' } as never })() }, query: async () => ({ status: 'completed' }) } },
      ports: {
        sessions: {
          getMeta: () => ({ id: 'headless-session', title: 'fixture', agentRuntime: 'claude' }) as never,
          appendMessages: (_id, next) => { messages.push(...next) },
          updateMeta: () => undefined,
        },
        host: { emit: event => { events.push(event) } },
      },
    })
    await expect(coordinator.run({ ...query, persistedUserMessage: { type: 'user', message: { content: [] }, parent_tool_use_id: null } as never }).promise)
      .rejects.toBeInstanceOf(AgentSessionRuntimeMismatchError)
    expect(starts).toBe(0)
    expect(messages).toEqual([])
    expect(events).toEqual([])
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given SessionPort 提供 lockRuntime When 请求内核与会话绑定不同 Then 仍由端口在写盘前拒绝', async () => {
    let starts = 0
    const lockAttempts: Array<{ runtime: string; accepted: boolean }> = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', stream: () => { starts += 1; return (async function* () { yield { type: 'result', subtype: 'success' } as never })() }, query: async () => ({ status: 'completed' }) } },
      ports: {
        sessions: {
          getMeta: () => ({ id: 'headless-session', title: 'fixture', agentRuntime: 'claude' }) as never,
          lockRuntime: (_id, runtime) => {
            lockAttempts.push({ runtime, accepted: false })
            throw new AgentSessionRuntimeMismatchError('claude', runtime)
          },
          appendMessages: () => undefined,
          updateMeta: () => undefined,
        },
      },
    })
    await expect(coordinator.run(query).promise).rejects.toBeInstanceOf(AgentSessionRuntimeMismatchError)
    // 端口存在时判定权归端口（保留 lockRuntime 的写盘失败等其它语义），核心不抢先拒绝。
    expect(lockAttempts).toEqual([{ runtime: 'pi', accepted: false }])
    expect(starts).toBe(0)
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given 上层入口已持有执行权 When 委派到 runtime 入口 Then 同一 token 幂等接管而不自拒', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    const outer = ownership.claim({ sessionId: query.sessionId, runtime: 'pi', token: 'entry-token' })
    expect(outer.ok).toBe(true)
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async () => ({ status: 'completed' }) } },
      ownership,
    })
    await expect(coordinator.run({ ...query, ownershipToken: 'entry-token' }).promise).resolves.toEqual({ status: 'completed' })
    expect(ownership.ownerCount()).toBe(0)
  })

  test('Given 后台任务未结束（provider 保持流未关闭） When 收到并发请求 Then owner 仍被持有，流结束后才释放', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let starts = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: {
        runtime: 'pi',
        stream: () => {
          starts += 1
          return (async function* () {
            yield { type: 'result', subtype: 'success', _keepChannelOpenForTasks: true } as never
            await gate
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'wakeup' }] }, parent_tool_use_id: null } as never
          })()
        },
        query: async () => ({ status: 'completed' }),
      } },
    })
    const running = coordinator.run(query)
    await new Promise(resolve => setTimeout(resolve, 10))
    // result 已到达但后台任务未结束：provider 流未关闭，owner 不得提前释放。
    expect(coordinator.isRunning(query.sessionId)).toBe(true)
    await expect(coordinator.run(query).promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(starts).toBe(1)
    release()
    await expect(running.promise).resolves.toEqual({ status: 'completed' })
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given provider 打轻量完成注解 When 后台任务续轮 Then 上报软空闲并补发 run_resumed（不产生终态）', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const idleSignals: Array<{ startedAt?: number; resultSubtype?: string }> = []
    const events: AgentRuntimeEvent[] = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: {
        runtime: 'pi',
        stream: () => (async function* () {
          yield { type: 'result', subtype: 'success', _keepChannelOpenForTasks: true } as never
          await gate
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'wakeup' }] }, parent_tool_use_id: null } as never
          yield { type: 'result', subtype: 'success' } as never
        })(),
        query: async () => ({ status: 'completed' }),
      } },
    })
    const handle = coordinator.run(query, {
      onEvent: event => { events.push(event) },
      onBackgroundTasksPending: signal => { idleSignals.push(signal) },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    // 轻量完成已上报，但 run 尚未结束（不是终态，owner 仍被持有）。
    expect(idleSignals).toEqual([{ startedAt: expect.any(Number), resultSubtype: 'success' }])
    expect(coordinator.isRunning(query.sessionId)).toBe(true)
    release()
    await expect(handle.promise).resolves.toEqual({ status: 'completed' })
    // 续轮首条实质消息前补发 run_resumed，且只在唤醒时发一次。
    const resumed = events.filter(event => event.type === 'host_event' && event.event.type === 'run_resumed')
    expect(resumed).toHaveLength(1)
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given 旧 token 的 handle When 新 run 已接管 Then stop 不会清理新 run', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let starts = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async input => {
        starts += 1
        if (starts === 1) return { status: 'failed', error: 'first attempt failed' }
        await gate
        return input.abortSignal?.aborted ? { status: 'stopped' } : { status: 'completed' }
      } } },
    })
    const first = coordinator.run(query)
    await first.promise
    const second = coordinator.run(query)
    await new Promise(resolve => setTimeout(resolve, 0))
    // 第一个 handle 的 stop 已经失效（owner 已换人）。
    await first.stop()
    expect(coordinator.isRunning(query.sessionId)).toBe(true)
    release()
    await expect(second.promise).resolves.toEqual({ status: 'completed' })
  })

  test('stop aborts the provider and produces stopped terminal outcome', async () => {
    let stopped = false
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async (_input, callbacks) => {
        ready()
        await pending
        if (callbacks.onComplete) await callbacks.onComplete({ status: 'stopped' })
        return { status: 'stopped' }
      }, async () => { stopped = true; release() }) },
    })
    const handle = coordinator.run(query)
    await started
    await handle.stop()
    expect(stopped).toBe(true)
    await expect(handle.promise).resolves.toEqual({ status: 'stopped' })
  })

  test('prepares credentials, resources and permission callback before provider query in a headless host', async () => {
    const calls: string[] = []
    let prepared: AgentRuntimeQuery['prepared']
    const coordinator = new AgentRuntimeCoordinator({
      adapters: {
        pi: adapter(async (input) => { prepared = input.prepared; return { status: 'completed' } }),
      },
      ports: {
        credentials: { resolve: async input => { calls.push(`credentials:${input.channelId}`); return { ok: true, credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'custom', forceBearerAuth: false } } } },
        resources: { load: input => { calls.push(`resources:${input.cwd}`); return { systemPrompt: 'fixture system', skills: ['fixture-skill'] } } },
        events: { emit() {} },
        permissions: { createCanUseTool: input => { calls.push(`permissions:${input.sessionId}`); return async () => ({ behavior: 'allow', updatedInput: {} }) } },
      },
    })
    const outcome = await coordinator.run({ ...query, channelId: 'channel-1', cwd: '/headless' }).promise
    expect(outcome).toEqual({ status: 'completed' })
    expect(calls).toEqual(['credentials:channel-1', 'resources:/headless', 'permissions:headless-session'])
    expect(prepared).toMatchObject({ credentials: { apiKey: 'fixture' }, resources: { systemPrompt: 'fixture system' }, canUseTool: expect.any(Function) })
  })

  test('credential failure becomes a failed terminal outcome without starting provider query', async () => {
    let started = false
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { started = true; return { status: 'completed' } }) },
      ports: { credentials: { resolve: async () => ({ ok: false, code: 'token_expired' }) } },
    })
    await expect(coordinator.run({ ...query, channelId: 'expired' }).promise).resolves.toEqual({ status: 'failed', error: 'Credential resolution failed: token_expired' })
    expect(started).toBe(false)
  })
  test('Given preparation failure When run settles Then 不宣告 runtime_started / onRunStarted（不建立运行态副作用）', async () => {
    // 回归：准备阶段（凭证 / 资源 / 工具装配）失败时 provider 从未启动，
    // 宿主不得清未读 / 晋升 draft / 广播 external_run_started。
    const events: AgentRuntimeEvent[] = []
    let runStarted = 0
    for (const ports of [
      { credentials: { resolve: async () => ({ ok: false as const, code: 'token_expired' as const }) } },
      { resources: { load: () => { throw new Error('resource load failed') } } },
      { toolAssembly: { build: async () => { throw new Error('tool assembly failed') } } },
    ]) {
      const coordinator = new AgentRuntimeCoordinator({
        adapters: { pi: adapter(async () => ({ status: 'completed' })) },
        ports: { ...ports, host: { emit: event => { events.push(event) } } },
      })
      const outcome = await coordinator.run(
        { ...query, channelId: 'channel-1', toolAssemblyContext: { sdk: undefined, context: {} } },
        { onEvent() {}, onRunStarted: () => { runStarted += 1 } },
      ).promise
      expect(outcome.status).toBe('failed')
    }
    expect(runStarted).toBe(0)
    expect(events.filter(event => event.type === 'runtime_started')).toEqual([])
    // claim 与终态仍然各投递一次（终态必须可见且只投递一次）。
    expect(events.filter(event => event.type === 'runtime_claimed')).toHaveLength(3)
    expect(events.filter(event => event.type === 'runtime_finished')).toHaveLength(3)
  })
  test('synchronous session lock failure prevents provider start and rejects the run', async () => {
    let started = false
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { started = true; return { status: 'completed' } }) },
      ports: { sessions: { getMeta: () => undefined, lockRuntime: () => { throw new Error('locked write failed') }, appendMessages: () => undefined, updateMeta: () => undefined } },
    })
    await expect(coordinator.run(query).promise).rejects.toThrow('locked write failed')
    expect(started).toBe(false)
  })
  test('drives an async iterable provider through message persistence, done and terminal outcome', async () => {
    const messages: unknown[] = []
    let queried = false
    const coordinator = new AgentRuntimeCoordinator({
      adapters: {
        pi: streamAdapter(async function* () {
          queried = true
          yield { type: 'assistant', message: { content: [] } } as never
          yield { type: 'result', subtype: 'success' } as never
        }),
      },
      ports: { sessions: { getMeta: () => undefined, appendMessages: (_id, next) => { messages.push(...next) }, updateMeta: () => undefined } },
    })
    await expect(coordinator.run(query).promise).resolves.toEqual({ status: 'completed' })
    expect(queried).toBe(true)
    expect(messages).toHaveLength(2)
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })

  test('runs provider query preparation after runtime preparation and forwards its options', async () => {
    let received: AgentRuntimeQuery['providerInput']
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: {
        runtime: 'pi',
        stream: input => {
          received = input.providerInput
          return (async function* () { yield { type: 'result', subtype: 'success' } as never })()
        },
        query: async () => ({ status: 'completed' }),
      } },
      ports: {
        queryPreparation: { prepare: async () => ({ credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'custom', forceBearerAuth: false } }) },
        providerQueryPreparation: { prepare: async (_input, prepared) => ({ provider: 'custom', apiKey: prepared.credentials?.apiKey, preparedMarker: 'fixture' }) },
      },
    })
    await expect(coordinator.run({ ...query, providerInput: { stale: true } }).promise).resolves.toEqual({ status: 'completed' })
    expect(received).toEqual({ provider: 'custom', apiKey: 'fixture', preparedMarker: 'fixture' })
  })
  test('Given provider query preparation throws When running Then provider never starts and one failed terminal is emitted', async () => {
    let started = 0
    const events: AgentRuntimeEvent[] = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { started += 1; return { status: 'completed' } }) },
      ports: { providerQueryPreparation: { prepare: async () => { throw new Error('provider preparation failed') } }, host: { emit: event => { events.push(event) } } },
    })
    await expect(coordinator.run(query).promise).resolves.toEqual({ status: 'failed', error: 'provider preparation failed' })
    expect(started).toBe(0)
    expect(events.map(event => event.type)).toEqual(['runtime_claimed', 'runtime_finished'])
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })
  test('stops a pending async iterable, calls provider stop and releases ownership', async () => {
    let returned = false
    let stopped = false
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const stream = () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => { await pending; return { done: true as const, value: undefined } },
          return: async () => { returned = true; release(); return { done: true as const, value: undefined } },
        }
      },
    })
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: streamAdapter(stream, async () => { stopped = true }) },
    })
    const handle = coordinator.run(query)
    await new Promise(resolve => setTimeout(resolve, 0))
    await handle.stop()
    await expect(handle.promise).resolves.toEqual({ status: 'stopped' })
    expect(stopped).toBe(true)
    expect(returned).toBe(true)
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })

  test('Given custom preparation throws When run settles Then one failed terminal is delivered and ownership released', async () => {
    const events: AgentRuntimeEvent[] = []
    const outcomes: AgentRunOutcome[] = []
    let started = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { started++; return { status: 'completed' } }) },
      ports: { queryPreparation: { prepare: () => { throw new Error('preparation failed') } }, host: { emit: e => { events.push(e) } } },
    })
    const outcome = await coordinator.run(query, { onEvent() {}, onComplete: o => { outcomes.push(o) } }).promise
    expect(outcome).toEqual({ status: 'failed', error: 'preparation failed' })
    expect(outcomes).toEqual([outcome])
    expect(events.map(e => e.type)).toEqual(['runtime_claimed', 'runtime_finished'])
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
    expect(started).toBe(0)
  })

  for (const method of ['handle', 'session', 'external', 'pre-aborted'] as const) {
    test(`Given ${method} stop during custom preflight When preparation resolves Then no provider is started`, async () => {
      let prepared!: () => void
      const entered = new Promise<void>(resolve => { prepared = resolve })
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let starts = 0
      let stops = 0
      const controller = new AbortController()
      const events: AgentRuntimeEvent[] = []
      const coordinator = new AgentRuntimeCoordinator({
        adapters: { pi: adapter(async () => { starts++; return { status: 'completed' } }, async () => { stops++ }) },
        ports: { queryPreparation: { prepare: async () => { prepared(); await gate; return {} } }, host: { emit: e => { events.push(e) } } },
      })
      if (method === 'pre-aborted') controller.abort()
      const handle = coordinator.run({ ...query, abortSignal: controller.signal })
      if (method !== 'pre-aborted') {
        await entered
        if (method === 'handle') await handle.stop()
        if (method === 'session') await coordinator.stop(query.sessionId)
        if (method === 'external') controller.abort()
      }
      release()
      expect(await handle.promise).toEqual({ status: 'stopped' })
      expect(starts).toBe(0)
      expect(stops).toBe(0)
      // 准备期间取消保持 stopped 语义：不得宣告运行已开始。
      expect(events.filter(e => e.type === 'runtime_started')).toEqual([])
      expect(events.filter(e => e.type === 'runtime_claimed')).toHaveLength(1)
      expect(events.filter(e => e.type === 'runtime_finished')).toHaveLength(1)
      expect(coordinator.isRunning(query.sessionId)).toBe(false)
      expect(coordinator.ownership.ownerCount()).toBe(0)
    })
  }

  for (const method of ['handle', 'session', 'external', 'pre-aborted'] as const) {
    test(`Given ${method} stop during provider preparation When preparation resolves Then no provider is started`, async () => {
      let enteredPreparation!: () => void
      const entered = new Promise<void>(resolve => { enteredPreparation = resolve })
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let starts = 0
      let stops = 0
      const controller = new AbortController()
      const events: AgentRuntimeEvent[] = []
      const coordinator = new AgentRuntimeCoordinator({
        adapters: { pi: adapter(async () => { starts += 1; return { status: 'completed' } }, async () => { stops += 1 }) },
        ports: {
          providerQueryPreparation: {
            prepare: async () => {
              enteredPreparation()
              await gate
              return { preparedMarker: method }
            },
          },
          host: { emit: event => { events.push(event) } },
        },
      })
      if (method === 'pre-aborted') controller.abort()
      const handle = coordinator.run({ ...query, abortSignal: controller.signal })
      if (method !== 'pre-aborted') {
        await entered
        if (method === 'handle') await handle.stop()
        if (method === 'session') await coordinator.stop(query.sessionId)
        if (method === 'external') controller.abort()
      }
      release()
      await expect(handle.promise).resolves.toEqual({ status: 'stopped' })
      expect(starts).toBe(0)
      expect(stops).toBe(0)
      // 提供方准备阶段取消同样保持 stopped 语义且不宣告运行开始。
      expect(events.filter(event => event.type === 'runtime_started')).toEqual([])
      expect(events.filter(event => event.type === 'runtime_finished')).toHaveLength(1)
      expect(coordinator.isRunning(query.sessionId)).toBe(false)
    })
  }
  test('Given a retryable provider failure When retry is enabled Then preparation and provider rerun before one completed terminal', async () => {
    let preparations = 0
    let attempts = 0
    const receivedPrepared: unknown[] = []
    const retries: AgentRuntimeEvent[] = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: {
        runtime: 'pi',
        query: async input => {
          attempts += 1
          receivedPrepared.push(input.prepared)
          return attempts === 1 ? { status: 'failed', error: '503 upstream busy' } : { status: 'completed' }
        },
      } },
      ports: {
        queryPreparation: { prepare: async () => { preparations += 1; return { systemPrompt: `prepared-${preparations}` } } },
        host: { emit: event => { retries.push(event) } },
      },
      retry: { maxRetries: 1, maxWaitMs: 1_000, maxDelayMs: 1, random: () => 0 },
    })
    await expect(coordinator.run(query).promise).resolves.toEqual({ status: 'completed' })
    expect(preparations).toBe(2)
    expect(attempts).toBe(2)
    expect(receivedPrepared).toEqual([{ systemPrompt: 'prepared-1' }, { systemPrompt: 'prepared-2' }])
    expect(retries.filter(event => event.type === 'retry')).toHaveLength(1)
    // 重试只重做准备与 provider attempt，不重复宣告「运行开始」。
    expect(retries.filter(event => event.type === 'runtime_started')).toHaveLength(1)
    expect(retries.filter(event => event.type === 'runtime_claimed')).toHaveLength(1)
    expect(retries.filter(event => event.type === 'runtime_finished')).toHaveLength(1)
  })

  test('Given 第一次 provider 尝试失败并触发重试 When 第二次成功 Then transcript 只有一条 user message', async () => {
    // 回归：`persistedUserMessage` 曾经在 retry while 循环内，重试会把同一条用户消息重复 append。
    const messages: unknown[] = []
    let attempts = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async () => {
        attempts += 1
        return attempts === 1 ? { status: 'failed', error: '503 upstream busy' } : { status: 'completed' }
      } } },
      ports: {
        sessions: { getMeta: () => undefined, appendMessages: (_id, next) => { messages.push(...next) }, updateMeta: () => undefined },
        queryPreparation: { prepare: async () => ({ credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'custom', forceBearerAuth: false } }) },
      },
      retry: { maxRetries: 1, maxWaitMs: 1_000, maxDelayMs: 1, random: () => 0 },
    })
    const persistedUserMessage = { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null }
    await expect(coordinator.run({ ...query, persistedUserMessage: persistedUserMessage as never }).promise).resolves.toEqual({ status: 'completed' })
    expect(attempts).toBe(2)
    expect(messages).toEqual([persistedUserMessage])
  })

  test('Given a provider attempt throws a retryable error When retry is enabled Then the next attempt can complete', async () => {
    let attempts = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('503 upstream busy')
        return { status: 'completed' }
      } } },
      retry: { maxRetries: 1, maxWaitMs: 1_000, maxDelayMs: 1, random: () => 0 },
    })
    await expect(coordinator.run(query).promise).resolves.toEqual({ status: 'completed' })
    expect(attempts).toBe(2)
  })
  test('Given retry budget exhaustion When every attempt fails Then onError and terminal are each delivered once', async () => {
    let attempts = 0
    let errors = 0
    let terminals = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async () => { attempts += 1; return { status: 'failed', error: '503 upstream busy' } } } },
      retry: { maxRetries: 1, maxWaitMs: 1_000, maxDelayMs: 1, random: () => 0 },
    })
    await expect(coordinator.run(query, {
      onEvent() {},
      onError: () => { errors += 1 },
      onComplete: () => { terminals += 1 },
    }).promise).resolves.toEqual({ status: 'failed', error: '503 upstream busy' })
    expect(attempts).toBe(2)
    expect(errors).toBe(1)
    expect(terminals).toBe(1)
  })
  test('Given a retry backoff When stopped Then provider is not retried and outcome is stopped', async () => {
    let attempts = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async () => { attempts += 1; return { status: 'failed', error: '503 upstream busy' } } } },
      retry: { maxRetries: 1, maxWaitMs: 10_000, maxDelayMs: 10_000, random: () => 1 },
    })
    const handle = coordinator.run(query)
    await new Promise(resolve => setTimeout(resolve, 0))
    await handle.stop()
    await expect(handle.promise).resolves.toEqual({ status: 'stopped' })
    expect(attempts).toBe(1)
  })
  test('Given active runtime owners When stopAndWait and stopAll run Then they await every owner release', async () => {
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async input => await new Promise(resolve => {
        input.abortSignal?.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true })
      })) },
    })
    const first = coordinator.run({ ...query, sessionId: 'stop-wait-one' })
    const second = coordinator.run({ ...query, sessionId: 'stop-wait-two' })
    await new Promise(resolve => setTimeout(resolve, 0))
    let stoppedAndWaited = false
    const stopFirst = coordinator.stopAndWait(first.sessionId).then(() => { stoppedAndWaited = true })
    const stopAll = coordinator.stopAll()
    await Promise.all([stopFirst, stopAll])
    expect(stoppedAndWaited).toBe(true)
    expect(coordinator.isRunning(first.sessionId)).toBe(false)
    expect(coordinator.isRunning(second.sessionId)).toBe(false)
    await expect(first.promise).resolves.toEqual({ status: 'stopped' })
    await expect(second.promise).resolves.toEqual({ status: 'stopped' })
  })
  test('Given provider completion repeats When it returns Then terminal callback runs once and late messages are ignored', async () => {
    let saved!: AgentRuntimeCallbacks
    let terminalCalls = 0
    let writes = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async (_input, callbacks) => {
        saved = callbacks
        await callbacks.onComplete?.({ status: 'completed' })
        await callbacks.onComplete?.({ status: 'completed' })
        return { status: 'completed' }
      }) },
      ports: { queryPreparation: { prepare: async () => ({}) }, sessions: { getMeta: () => undefined, appendMessages: () => { writes++; return undefined }, updateMeta: () => undefined } },
    })
    expect(await coordinator.run(query, { onEvent() {}, onComplete: () => { terminalCalls++ } }).promise).toEqual({ status: 'completed' })
    await saved.onMessage?.({ type: 'result' } as never)
    await saved.onComplete?.({ status: 'stopped' })
    expect(terminalCalls).toBe(1)
    expect(writes).toBe(0)
  })

  test('Given transcript write fails When a runtime message streams Then projection and run completion survive', async () => {
    const events: AgentRuntimeEvent[] = []
    let errors = 0
    let terminals = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async (_input, callbacks) => { await callbacks.onMessage?.({ type: 'result' } as never); return { status: 'completed' } }) },
      ports: {
        queryPreparation: { prepare: async () => ({}) },
        sessions: { getMeta: () => undefined, appendMessages: () => { throw new Error('persist failed') }, updateMeta: () => undefined },
        host: { emit: event => { events.push(event) } },
      },
    })
    await expect(coordinator.run(query, {
      onEvent() {},
      onError: () => { errors += 1 },
      onComplete: () => { terminals += 1 },
    }).promise).resolves.toEqual({ status: 'completed' })
    expect(errors).toBe(0)
    expect(terminals).toBe(1)
    expect(events.filter(event => event.type === 'message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'runtime_finished')).toHaveLength(1)
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })

  test('Given a started observer throws When running Then provider is not started and owner is released', async () => {
    let starts = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => { starts++; return { status: 'completed' } }) },
      ports: { host: { emit: e => { if (e.type === 'runtime_started') throw new Error('start observer failed') } } },
    })
    expect(await coordinator.run(query).promise).toEqual({ status: 'failed', error: 'start observer failed' })
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
    expect(starts).toBe(0)
  })

  test('Given terminal observers throw When outcome settles Then one completed outcome survives and owner is released', async () => {
    let delivered = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(async () => ({ status: 'completed' })) },
      ports: { host: { emit: e => { if (e.type === 'runtime_finished') throw new Error('finished observer failed') } } },
    })
    expect(await coordinator.run(query, { onEvent() {}, onComplete: () => { delivered++; throw new Error('completion observer failed') } }).promise).toEqual({ status: 'completed' })
    expect(delivered).toBe(1)
    expect(coordinator.isRunning(query.sessionId)).toBe(false)
  })

  test('Given custom preparation and a synchronous provider throw When querying Then failure is unified', async () => {
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter(() => { throw new Error('sync query failed') }) },
      ports: { queryPreparation: { prepare: async () => ({}) } },
    })
    expect(await coordinator.run(query).promise).toEqual({ status: 'failed', error: 'sync query failed' })
  })
})

describe('AgentRuntimeCoordinator Run ledger', () => {
  for (const runtime of ['pi', 'claude'] as const) {
    test(`Given ${runtime} 普通运行无 Task When 准备后启动 Then queued/running/completed 对应同一业务 Run`, async () => {
      const { ledger, port, finishes } = ledgerFixture()
      const phases: string[] = []
      const starts: unknown[] = []
      const completes: unknown[] = []
      let received: AgentRuntimeQuery | undefined
      const coordinator = new AgentRuntimeCoordinator({
        runLedger: ledger,
        createRunContext: input => ({ trigger: input.trigger ?? runTrigger, executorRef: 'trusted-agent' }),
        adapters: { [runtime]: { runtime, query: async (input: AgentRuntimeQuery) => {
          received = input
          phases.push(ledger.get('business-run')!.status)
          return { status: 'completed' as const }
        } } },
        ports: {
          queryPreparation: { prepare: async input => {
            expect(input.runId).toBe('business-run')
            phases.push(ledger.get('business-run')!.status)
            return {}
          } },
          host: { emit: event => {
            if (event.type === 'runtime_claimed' || event.type === 'runtime_started') phases.push(ledger.get('business-run')!.status)
          } },
        },
      })
      await expect(coordinator.run({ ...query, runtime, runId: 'business-run', ownershipToken: 'execution-owner' }, {
        onEvent() {}, onRunStarted: signal => { starts.push(signal) }, onComplete: outcome => { completes.push(outcome) },
      }).promise).resolves.toEqual({ status: 'completed' })
      expect(phases).toEqual(['queued', 'queued', 'running', 'running'])
      expect(received).toMatchObject({ runId: 'business-run', trigger: runTrigger, context: { trigger: runTrigger } })
      expect(starts).toEqual([expect.objectContaining({ runId: 'business-run', triggerId: runTrigger.id })])
      expect(completes).toEqual([{ status: 'completed', runId: 'business-run', triggerId: runTrigger.id }])
      expect(ledger.get('business-run')).toMatchObject({ id: 'business-run', status: 'completed', executorRef: 'trusted-agent', runtime, sessionRef: query.sessionId })
      expect(ledger.get('business-run')?.taskId).toBeUndefined()
      expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'completed'])
      expect(finishes()).toBe(1)
      expect(coordinator.ownership.ownerCount()).toBe(0)
    })
  }

  test('Given 只有普通 query 且无 Task/Trigger When 注入 ledger Then 生成业务身份且不改 provider role', async () => {
    const { ledger, port } = ledgerFixture()
    const message = { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } as const
    const persisted: unknown[] = []
    let runId: string | undefined
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async input => { runId = input.runId; return { status: 'completed' } }) },
      ports: { sessions: { getMeta: () => undefined, appendMessages: (_id, messages) => { persisted.push(...messages) }, updateMeta: () => undefined } },
    })
    await coordinator.run({ ...query, persistedUserMessage: message as never }).promise
    expect(ledger.get(runId!)?.status).toBe('completed')
    expect(ledger.get(runId!)?.taskId).toBeUndefined()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ ...message, _provenance: { runId, author: { type: 'user' } } })
  })

  test('Given retry/compact/queued input When provider retries Then 同一 Run 仅开始和结束一次', async () => {
    const { ledger, port, finishes } = ledgerFixture()
    let attempts = 0
    const runIds: unknown[] = []
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async (input, callbacks) => {
        attempts += 1
        runIds.push(input.runId)
        if (attempts === 1) {
          expect(ledger.attachInput(input.runId!, { ...runTrigger, id: 'queued-input' })).toBe(true)
          await callbacks.onMessage?.({ type: 'system', subtype: 'compact_boundary' } as never)
          return { status: 'failed', error: '503 upstream busy' }
        }
        return { status: 'completed' }
      }) },
      retry: { maxRetries: 1, maxWaitMs: 1_000, maxDelayMs: 1, random: () => 0 },
    })
    await expect(coordinator.run({ ...query, trigger: runTrigger, taskId: 'task' }).promise).resolves.toEqual({ status: 'completed' })
    expect(ledger.list()).toHaveLength(1)
    expect(runIds).toEqual([ledger.list()[0]!.id, ledger.list()[0]!.id])
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'input_attached', 'completed'])
    expect(ledger.list()[0]).toMatchObject({ taskId: 'task', triggerId: runTrigger.id })
    expect(finishes()).toBe(1)
  })

  test('Given 准备失败 When 收束 Then queued→failed 且 startedAt 为空', async () => {
    const { ledger, port, finishes } = ledgerFixture()
    let providerStarts = 0
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async () => { providerStarts++; return { status: 'completed' } }) },
      ports: { queryPreparation: { prepare: async () => { throw new Error('preflight failed') } } },
    })
    await expect(coordinator.run({ ...query, trigger: runTrigger }).promise).resolves.toEqual({ status: 'failed', error: 'preflight failed' })
    expect(ledger.list()[0]).toMatchObject({ status: 'failed', failureReason: 'preflight failed' })
    expect(ledger.list()[0]!.startedAt).toBeUndefined()
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'failed'])
    expect(finishes()).toBe(1)
    expect(providerStarts).toBe(0)
  })

  for (const status of ['completed', 'failed', 'stopped'] as const) {
    test(`Given ${status} 与重复迟到终态 When 收束 Then finish 只调用一次且不覆写`, async () => {
      const { ledger, port, finishes } = ledgerFixture()
      let saved!: AgentRuntimeCallbacks
      const outcome: AgentRunOutcome = status === 'failed' ? { status, error: 'provider failed' } : { status }
      const coordinator = new AgentRuntimeCoordinator({
        runLedger: ledger,
        adapters: { pi: adapter(async (_input, callbacks) => {
          saved = callbacks
          await callbacks.onComplete?.({ status: 'stopped' })
          await callbacks.onComplete?.({ status: 'completed' })
          return outcome
        }) },
      })
      await expect(coordinator.run({ ...query, trigger: runTrigger }).promise).resolves.toEqual(outcome)
      const snapshot = port.load()
      await saved.onComplete?.({ status: 'failed', error: 'late' })
      await saved.onMessage?.({ type: 'result', subtype: 'success' } as never)
      await saved.onError?.('late')
      expect(finishes()).toBe(1)
      expect(ledger.list()[0]!.status).toBe(status)
      expect(port.load()).toEqual(snapshot)
    })
  }

  test('Given 没有 ledger When 传入上下文 Then 原 query/callback/outcome 行为兼容且不调用工厂', async () => {
    let factories = 0
    const completes: unknown[] = []
    let received: AgentRuntimeQuery | undefined
    const coordinator = new AgentRuntimeCoordinator({
      createRunContext: () => { factories++; throw new Error('unused factory') },
      adapters: { pi: adapter(async input => { received = input; return { status: 'completed' } }) },
    })
    await expect(coordinator.run({ ...query, trigger: runTrigger }, { onEvent() {}, onComplete: outcome => { completes.push(outcome) } }).promise).resolves.toEqual({ status: 'completed' })
    expect(received?.trigger).toEqual(runTrigger)
    expect(received?.runId).toBeUndefined()
    expect(completes).toEqual([{ status: 'completed' }])
    expect(factories).toBe(0)
  })

  test('Given begin/start 保存失败 When 准入 Then 不启动 provider，失败可见且释放 owner', async () => {
    for (const failSave of [1, 2]) {
      const memory = createInMemoryRunLedgerPort()
      let saves = 0
      const { ledger, finishes } = ledgerFixture({ load: memory.load, save: snapshot => {
        if (++saves === failSave) throw new Error('ledger write failed')
        memory.save(snapshot)
      } })
      let starts = 0
      const coordinator = new AgentRuntimeCoordinator({ runLedger: ledger, adapters: { pi: adapter(async () => { starts++; return { status: 'completed' } }) } })
      await expect(coordinator.run({ ...query, trigger: runTrigger }).promise).resolves.toEqual({ status: 'failed', error: 'ledger write failed' })
      expect(starts).toBe(0)
      expect(coordinator.ownership.ownerCount()).toBe(0)
      expect(finishes()).toBe(failSave === 1 ? 0 : 1)
      if (failSave === 2) {
        expect(ledger.list()[0]!.status).toBe('failed')
        expect(ledger.list()[0]!.startedAt).toBeUndefined()
      }
    }
  })

  test('Given provider 副作用已完成而 finish 保存失败 When 收束 Then 报告失败且不重跑 provider/finish', async () => {
    const memory = createInMemoryRunLedgerPort()
    let saves = 0
    const { ledger, finishes } = ledgerFixture({ load: memory.load, save: snapshot => {
      if (++saves === 3) throw new Error('finish write failed')
      memory.save(snapshot)
    } })
    let effects = 0
    const terminals: unknown[] = []
    const coordinator = new AgentRuntimeCoordinator({ runLedger: ledger, adapters: { pi: adapter(async () => { effects++; return { status: 'completed' } }) } })
    await expect(coordinator.run({ ...query, trigger: runTrigger }, { onEvent() {}, onComplete: outcome => { terminals.push(outcome) } }).promise)
      .resolves.toEqual({ status: 'failed', error: 'finish write failed' })
    expect(effects).toBe(1)
    expect(finishes()).toBe(1)
    expect(terminals).toEqual([expect.objectContaining({ status: 'failed', error: 'finish write failed' })])
    expect(ledger.list()[0]!.status).toBe('running')
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given 准备期间停止 When 准备返回 Then queued→stopped 且不启动 provider', async () => {
    const { ledger, port, finishes } = ledgerFixture()
    let release!: () => void
    let prepared!: () => void
    const preparationStarted = new Promise<void>(resolve => { prepared = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let starts = 0
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async () => { starts++; return { status: 'completed' } }) },
      ports: { queryPreparation: { prepare: async () => { prepared(); await gate; return {} } } },
    })
    const handle = coordinator.run({ ...query, trigger: runTrigger })
    await preparationStarted
    await handle.stop()
    release()
    await expect(handle.promise).resolves.toEqual({ status: 'stopped' })
    expect(starts).toBe(0)
    expect(finishes()).toBe(1)
    expect(ledger.list()[0]!.startedAt).toBeUndefined()
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'stopped'])
  })

  test('Given 准备失败通知也抛错 When 收束 Then 仍结束账本并释放执行权且保留两项错误', async () => {
    const { ledger, finishes } = ledgerFixture()
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async () => ({ status: 'completed' })) },
      ports: { queryPreparation: { prepare: async () => { throw new Error('prepare failed') } } },
    })
    await expect(coordinator.run({ ...query, trigger: runTrigger }, {
      onEvent() {}, onPreparationFailure: () => { throw new Error('notification failed') },
    }).promise).resolves.toEqual({ status: 'failed', error: 'prepare failed\nnotification failed' })
    expect(ledger.list()[0]!.status).toBe('failed')
    expect(finishes()).toBe(1)
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given 账本被其他 owner 结束 When 旧 provider 后完成 Then 不覆盖先前终态', async () => {
    const { ledger, port, finishes } = ledgerFixture()
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async input => {
        ledger.finish(input.runId!, { status: 'stopped' })
        return { status: 'completed' }
      }) },
    })
    await expect(coordinator.run({ ...query, trigger: runTrigger }).promise).resolves.toEqual({ status: 'stopped' })
    expect(ledger.list()[0]!.status).toBe('stopped')
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'stopped'])
    // 这里一项来自外部 owner，另一项来自 coordinator 的唯一 finish 点。
    expect(finishes()).toBe(2)
  })

  test('Given 同一 token 的重复请求 When 当前 Run 仍活跃 Then 复用 handle 而不释放原 owner', async () => {
    const { ledger, finishes } = ledgerFixture()
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let effects = 0
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async () => { effects++; started(); await gate; return { status: 'completed' } }) },
    })
    const input = { ...query, ownershipToken: 'same-owner', trigger: runTrigger }
    const first = coordinator.run(input)
    await ready
    const repeated = coordinator.run(input)
    expect(repeated.promise).toBe(first.promise)
    expect(coordinator.isRunning(query.sessionId)).toBe(true)
    expect(coordinator.ownership.isOwned(query.sessionId)).toBe(true)
    release()
    await expect(first.promise).resolves.toEqual({ status: 'completed' })
    expect(effects).toBe(1)
    expect(finishes()).toBe(1)
  })

  test('Given 同一尚未结束 trigger 重投 When claim 成功 Then 受阻而不重放或改写原 Run', async () => {
    const { ledger, port, finishes } = ledgerFixture()
    const existing = ledger.begin({ trigger: runTrigger, executorRef: 'previous-owner', runtime: 'pi', sessionRef: query.sessionId }).run
    ledger.start(existing.id)
    const before = port.load()
    let starts = 0
    const coordinator = new AgentRuntimeCoordinator({ runLedger: ledger, adapters: { pi: adapter(async () => { starts++; return { status: 'completed' } }) } })
    const outcome = await coordinator.run({ ...query, trigger: runTrigger }).promise
    expect(outcome.status).toBe('failed')
    expect(starts).toBe(0)
    expect(finishes()).toBe(0)
    expect(port.load()).toEqual(before)
    expect(coordinator.ownership.ownerCount()).toBe(0)
  })

  test('Given 同一已完成 trigger 重投 When 准入 Then 返回账本终态而不重放 provider/finish', async () => {
    const { ledger, finishes } = ledgerFixture()
    let effects = 0
    const coordinator = new AgentRuntimeCoordinator({ runLedger: ledger, adapters: { pi: adapter(async () => { effects++; return { status: 'completed' } }) } })
    await coordinator.run({ ...query, trigger: runTrigger }).promise
    await expect(coordinator.run({ ...query, trigger: runTrigger }).promise).resolves.toEqual({ status: 'completed' })
    expect(effects).toBe(1)
    expect(finishes()).toBe(1)
    expect(ledger.list()).toHaveLength(1)
  })
})

function meta() { return { id: 'headless-session', title: 'fixture' } as never }

describe('coordinator Run 来源与追加输入', () => {
  for (const runtime of ['pi', 'claude'] as const) {
    test(`${runtime}: 准入后、资源加载前发布真实 Run，输入与输出保留稳定作者`, async () => {
      const { ledger } = ledgerFixture()
      const persisted: import('@profer/shared').SDKMessage[] = []
      const seen: import('@profer/shared').SDKMessage[] = []
      const order: string[] = []
      let preparedInput: AgentRuntimeQuery | undefined
      const context = { trigger: { ...runTrigger, id: `origin-${runtime}`, actor: { type: 'automation' as const, id: 'schedule' } }, messageAuthor: { type: 'user' as const }, taskId: 'task' }
      const coordinator = new AgentRuntimeCoordinator({
        runLedger: ledger,
        adapters: { [runtime]: { runtime, query: async (input: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks) => {
          preparedInput = input
          await callbacks.onMessage?.({ type: 'assistant', _partial: true, message: { id: 'logical', content: [] } } as never)
          await callbacks.onMessage?.({ type: 'assistant', uuid: 'provider-final', message: { id: 'logical', content: [] } } as never)
          await callbacks.onMessage?.({ type: 'result', subtype: 'success' } as never)
          return { status: 'completed' as const }
        } } },
        ports: {
          sessions: { getMeta: () => undefined, appendMessages: (_id, messages) => { persisted.push(...messages) }, updateMeta: () => undefined },
          resources: { load: async () => { order.push('resources'); return {} } },
          toolAssembly: { build: async () => ({ tools: [] }) },
        },
      })
      await coordinator.run({
        ...query, runtime, context,
        toolAssemblyContext: { sdk: {}, context: { sessionId: query.sessionId, sourceRunId: 'forged' } },
        deferredToolAssemblyContext: { sessionId: query.sessionId, sourceRunId: 'forged' },
        persistedUserMessage: { type: 'user', uuid: 'original-user', message: { content: [{ type: 'text', text: 'input' }] } } as never,
        onRunAdmitted: input => {
          order.push('admitted')
          expect(input.runId).toBe(ledger.list()[0]!.id)
          expect(input.toolAssemblyContext?.context).toMatchObject({ sourceRunId: input.runId, runId: input.runId })
        },
      }, { onEvent() {}, onMessage: message => { seen.push(message) } }).promise
      expect(order).toEqual(['admitted', 'resources'])
      const run = ledger.list()[0]!
      expect(preparedInput?.deferredToolAssemblyContext).toMatchObject({ sourceRunId: run.id, runId: run.id })
      expect(preparedInput?.prompt).toContain('<profer_task_origin>')
      expect(persisted[0]).toMatchObject({ type: 'system', subtype: 'task_trigger', _provenance: { author: { type: 'automation', id: 'schedule' }, runId: run.id } })
      expect(persisted[1]).toMatchObject({ uuid: 'original-user', _provenance: { author: { type: 'user' }, runId: run.id, taskId: 'task', triggerId: context.trigger.id, messageId: 'original-user' } })
      expect(seen[0]?._provenance).toMatchObject({ author: { type: 'agent', id: query.sessionId }, runId: run.id })
      expect(seen[0]?._provenance?.messageId).toBe(seen[1]?._provenance?.messageId)
      expect(seen[0]).not.toHaveProperty('uuid')
      expect(seen[1]).toHaveProperty('uuid', 'provider-final')
      expect(seen[2]?._provenance?.author).toEqual({ type: 'system' })
    })
  }

  test('Provider 接收期间结束时仍关联原 Run，终态等到已接收输入记账且重复 UUID 不重注入', async () => {
    const { ledger, port } = ledgerFixture()
    const persisted: import('@profer/shared').SDKMessage[] = []
    const events: AgentRuntimeEvent[] = []
    let finishProvider!: () => void
    let releaseReceive!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async () => { started(); await new Promise<void>(resolve => { finishProvider = resolve }); return { status: 'completed' } }) },
      ports: {
        sessions: { getMeta: () => undefined, appendMessages: (_id, messages) => { persisted.push(...messages) }, updateMeta: () => undefined },
        host: { emit: event => { events.push(event) } },
      },
    })
    const handle = coordinator.run({ ...query, trigger: { ...runTrigger, id: 'queue-run' } })
    await ready
    const token = coordinator.ownership.getOwner(query.sessionId)!.token
    let deliveries = 0
    const queued = {
      sessionId: query.sessionId, ownershipToken: token,
      context: { trigger: { ...runTrigger, id: 'follow-up', actor: { type: 'agent' as const, id: 'parent-session' } } },
      message: { type: 'user', uuid: 'queued-uuid', message: { content: [{ type: 'text', text: 'follow-up' }] } } as import('@profer/shared').SDKMessage,
      receive: async (accepted: { message: import('@profer/shared').SDKMessage; runId?: string }) => {
        deliveries++
        expect(accepted.runId).toBe(ledger.list()[0]!.id)
        expect(accepted.message._provenance?.author).toEqual({ type: 'agent', id: 'parent-session' })
        await new Promise<void>(resolve => { releaseReceive = resolve })
      },
    }
    const first = coordinator.queueMessage(queued)
    const second = coordinator.queueMessage(queued)
    finishProvider()
    await Promise.resolve()
    expect(ledger.list()[0]!.status).toBe('running')
    releaseReceive()
    await expect(first).resolves.toMatchObject({ messageId: 'queued-uuid', runId: ledger.list()[0]!.id })
    await second
    expect(deliveries).toBe(1)
    await handle.promise
    expect(ledger.findByTrigger('follow-up')?.id).toBe(ledger.list()[0]!.id)
    expect(persisted).toHaveLength(1)
    expect(events.filter(event => event.type === 'message')).toHaveLength(1)
    expect(port.load().events.filter(event => event.type === 'input_attached')).toHaveLength(1)
    await expect(coordinator.queueMessage(queued)).rejects.toThrow('未运行')
    expect(ledger.list()).toHaveLength(1)
  })

  test('未接收、过期 token 和 settled 输入均不能产生追加事实或新 Run', async () => {
    const { ledger, port } = ledgerFixture()
    let stopProvider!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const coordinator = new AgentRuntimeCoordinator({ runLedger: ledger, adapters: { pi: adapter(async () => {
      started(); await new Promise<void>(resolve => { stopProvider = resolve }); return { status: 'completed' }
    }) }, ports: { sessions: { getMeta: () => undefined, appendMessages: () => undefined, updateMeta: () => undefined } } })
    const handle = coordinator.run({ ...query, trigger: { ...runTrigger, id: 'reject-run' } })
    await ready
    const input = { sessionId: query.sessionId, context: { trigger: { ...runTrigger, id: 'not-accepted' } }, message: { type: 'user', uuid: 'retry-uuid' } as import('@profer/shared').SDKMessage, receive: async () => { throw new Error('Provider settled') } }
    await expect(coordinator.queueMessage({ ...input, ownershipToken: 'old-token' })).rejects.toThrow()
    await expect(coordinator.queueMessage(input)).rejects.toThrow('Provider settled')
    expect(ledger.findByTrigger('not-accepted')).toBeUndefined()
    stopProvider()
    await handle.promise
    await expect(coordinator.queueMessage(input)).rejects.toThrow()
    expect(port.load().triggers).toHaveLength(1)
  })
})

describe('coordinator 真实等待与接收失败', () => {
  test('真实权限 hook 等待/恢复同一 Run，停止后的迟到恢复不会改写终态', async () => {
    const { ledger, port } = ledgerFixture()
    let lifecycle: NonNullable<AgentRuntimeQuery['runLifecycle']> | undefined
    const coordinator = new AgentRuntimeCoordinator({ runLedger: ledger, adapters: { pi: adapter(async input => {
      lifecycle = input.runLifecycle
      lifecycle!.wait('approval')
      expect(ledger.list()[0]!.status).toBe('waiting')
      lifecycle!.resume('approval')
      expect(ledger.list()[0]!.status).toBe('running')
      return { status: 'completed' }
    }) } })
    await coordinator.run({ ...query, trigger: { ...runTrigger, id: 'permission-run' } }).promise
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'waiting', 'resumed', 'completed'])
    const before = port.load()
    lifecycle!.resume('approval')
    lifecycle!.wait('late')
    expect(port.load()).toEqual(before)
    expect(ledger.list()).toHaveLength(1)
  })

  test('Provider 已接收后磁盘失败时仍确认输入，不重复注入且运行完成', async () => {
    const { ledger } = ledgerFixture()
    let complete!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let delivered = 0
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async () => { started(); await new Promise<void>(resolve => { complete = resolve }); return { status: 'completed' } }) },
      ports: { sessions: { getMeta: () => undefined, appendMessages: () => { throw new Error('disk full') }, updateMeta: () => undefined } },
    })
    const handle = coordinator.run({ ...query, trigger: { ...runTrigger, id: 'write-failure' } })
    await ready
    const queued = { sessionId: query.sessionId, message: { type: 'user', uuid: 'accepted-uuid' } as import('@profer/shared').SDKMessage,
      context: { trigger: { ...runTrigger, id: 'accepted-trigger' } }, receive: async () => { delivered++ } }
    await expect(coordinator.queueMessage(queued)).resolves.toMatchObject({ messageId: 'accepted-uuid' })
    await expect(coordinator.queueMessage(queued)).resolves.toMatchObject({ messageId: 'accepted-uuid' })
    expect(delivered).toBe(1)
    expect(ledger.findByTrigger('accepted-trigger')?.id).toBe(ledger.list()[0]!.id)
    complete()
    expect((await handle.promise).status).toBe('completed')
    expect(ledger.list()[0]!.status).toBe('completed')
  })
})

describe('queueMessage 停止竞态', () => {
  test('接收闭包已进入后停止，已接收消息仍保存原 Run；后续轮次不受旧 token 影响', async () => {
    const { ledger } = ledgerFixture()
    let releaseProvider!: () => void
    let accept!: () => void
    let receiveEntered!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const receiving = new Promise<void>(resolve => { receiveEntered = resolve })
    const saved: import('@profer/shared').SDKMessage[] = []
    const coordinator = new AgentRuntimeCoordinator({
      runLedger: ledger,
      adapters: { pi: adapter(async () => { started(); await new Promise<void>(resolve => { releaseProvider = resolve }); return { status: 'completed' } }, async () => { releaseProvider() }) },
      ports: { sessions: { getMeta: () => undefined, appendMessages: (_id, messages) => { saved.push(...messages) }, updateMeta: () => undefined } },
    })
    const run = coordinator.run({ ...query, trigger: { ...runTrigger, id: 'stopping-run' } })
    await ready
    const token = coordinator.ownership.getOwner(query.sessionId)!.token
    const queued = coordinator.queueMessage({ sessionId: query.sessionId, ownershipToken: token,
      context: { trigger: { ...runTrigger, id: 'accepted-during-stop' } },
      message: { type: 'user', uuid: 'stop-queue' } as import('@profer/shared').SDKMessage,
      receive: async () => { receiveEntered(); await new Promise<void>(resolve => { accept = resolve }) },
    })
    await receiving
    await coordinator.stop(query.sessionId)
    expect(ledger.list()[0]!.status).toBe('running')
    accept()
    await queued
    expect(await run.promise).toEqual({ status: 'stopped' })
    expect(saved[0]?._provenance?.runId).toBe(ledger.list()[0]!.id)
    expect(ledger.findByTrigger('accepted-during-stop')?.id).toBe(ledger.list()[0]!.id)
    await expect(coordinator.queueMessage({ sessionId: query.sessionId, ownershipToken: token, context: { trigger: runTrigger }, message: { type: 'user' } as never, receive: async () => {} })).rejects.toThrow('未运行')
  })
})
