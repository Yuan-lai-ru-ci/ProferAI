/**
 * remote 侧会话绑定与回放登记 —— 接线与回放计划的行为测试（GAP-3）
 *
 * 两层证据：
 * 1. **行为**：直接驱动 `planAgentStreamsRestore`（remote-service 里真正的回放决策函数），
 *    用真实 `RemoteAgentReplayRegistry` 验证刷新回放、增量补发、requiresSnapshot 传播；
 * 2. **接线**：对 `remote-service.ts` 做源码切片断言，证明登记被喂入、命令被分发、
 *    绑定/解绑发生在正确位置，且**没有**复制桌面 webContents 机制。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AgentStreamPayload } from '@profer/shared'
import { RemoteAgentReplayRegistry } from './remote-agent-replay-registry'
import { planAgentStreamsRestore } from './remote-service'

const source = readFileSync(new URL('./remote-service.ts', import.meta.url), 'utf8')

function slice(from: string, to: string): string {
  const start = source.indexOf(from)
  expect(start, `未找到起点片段: ${from}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(to, start)
  expect(end, `未找到终点片段: ${to}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

let eventId = 1
function sdk(text: string): AgentStreamPayload {
  return { kind: 'sdk_message', message: { type: 'assistant', text } as never }
}

describe('planAgentStreamsRestore（刷新回放决策）', () => {
  function seed() {
    eventId = 1
    const registry = new RemoteAgentReplayRegistry({ now: () => 1_000 })
    const observe = (sessionId: string, payload: AgentStreamPayload) => {
      registry.observe({ eventId: eventId++, sessionId, payload, createdAt: 1_000 })
    }
    observe('s-a', sdk('a1'))
    observe('s-a', sdk('a2'))
    observe('s-b', sdk('b1'))
    return { registry, observe }
  }

  test('刷新后的客户端（lastSentEventId = 0）拿到全部在飞事件，按 eventId 升序', () => {
    const { registry } = seed()
    const plan = planAgentStreamsRestore(registry, 'fresh-pocket', { lastSentEventId: 0, requestId: 'r-1' })

    expect(plan.requiresSnapshot).toBe(false)
    expect(plan.records.map((record) => record.eventId)).toEqual([1, 2, 3])
    expect(plan.frame).toMatchObject({
      kind: 'agent_streams_restored',
      requestId: 'r-1',
      replayed: 3,
      requiresSnapshot: false,
      oldestEventId: 1,
      latestEventId: 3,
    })
    expect((plan.frame.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toEqual(['s-a', 's-b'])
  })

  test('弱网重连重复调用：第二次只补增量，不重复消息', () => {
    const { registry, observe } = seed()
    const first = planAgentStreamsRestore(registry, 'pocket', { lastSentEventId: 0 })
    expect(first.records).toHaveLength(3)

    const second = planAgentStreamsRestore(registry, 'pocket', { lastSentEventId: 3 })
    expect(second.records).toEqual([])
    expect(second.frame.replayed).toBe(0)

    observe('s-a', sdk('a3'))
    const third = planAgentStreamsRestore(registry, 'pocket', { lastSentEventId: 3 })
    expect(third.records.map((record) => record.eventId)).toEqual([4])
  })

  test('客户端游标落后于本连接已发游标时取较大值（不重发已发出的帧）', () => {
    const { registry } = seed()
    const plan = planAgentStreamsRestore(registry, 'pocket', { sinceEventId: 0, lastSentEventId: 2 })
    expect(plan.records.map((record) => record.eventId)).toEqual([3])
  })

  test('已绑定客户端只回放自己关注的会话', () => {
    const { registry } = seed()
    registry.bindClient('pocket-1', 's-b')
    const plan = planAgentStreamsRestore(registry, 'pocket-1', { lastSentEventId: 0 })
    expect(plan.records.map((record) => record.sessionId)).toEqual(['s-b'])
  })

  test('登记不完整时不下发半段事件，只标记 requiresSnapshot', () => {
    eventId = 1
    const registry = new RemoteAgentReplayRegistry({ maxRecordsPerSession: 1, now: () => 1_000 })
    registry.observe({ eventId: 1, sessionId: 's-a', payload: sdk('a1'), createdAt: 1_000 })
    registry.observe({ eventId: 2, sessionId: 's-a', payload: sdk('a2'), createdAt: 1_000 })

    const plan = planAgentStreamsRestore(registry, 'pocket', { lastSentEventId: 0 })
    expect(plan.records).toEqual([])
    expect(plan.requiresSnapshot).toBe(true)
    expect(plan.frame).toMatchObject({ requiresSnapshot: true, replayed: 0 })
  })

  test('无任何登记时回放为空且不需要快照（等价于「当前没有在飞的一轮」）', () => {
    const registry = new RemoteAgentReplayRegistry({ now: () => 1_000 })
    const plan = planAgentStreamsRestore(registry, 'pocket', { lastSentEventId: 0 })
    expect(plan.records).toEqual([])
    expect(plan.requiresSnapshot).toBe(false)
    expect(plan.frame).toMatchObject({ sessions: [], replayed: 0 })
  })
})

describe('remote-service 接线（源码切片）', () => {
  test('登记被喂入：广播入口把同一份记录交给会话级登记', () => {
    const broadcast = slice('function broadcastAgentFrame(', 'function sendAgentEventRecord(')
    expect(broadcast).toContain('remoteAgentEventLog.append(sessionId, projectAgentPayloadForPocket(payload))')
    expect(broadcast).toContain('remoteAgentReplayRegistry.observe(record)')
  })

  test('命令被分发：restore_agent_streams 走会话级回放，不是游标补发', () => {
    expect(source).toContain("if (parsedRaw?.type === 'restore_agent_streams')")
    expect(source).toContain('restoreAgentStreams(ws, reqId, parsedRaw as')
    const restore = slice('function restoreAgentStreams(', '/**\n * agentEventBus → 移动端 WS 的广播入口')
    expect(restore).toContain('planAgentStreamsRestore(remoteAgentReplayRegistry, replayState.clientKey')
    expect(restore).toContain("client.send(JSON.stringify(plan.frame))")
    expect(source).toContain("kind: 'agent_streams_restored'")
  })

  test('客户端绑定：带 sessionId 的命令声明关注；断连解绑；删除会话释放登记', () => {
    expect(source).toContain('clientKey: randomUUID()')
    expect(source).toContain('remoteAgentReplayRegistry.bindClient(replayState.clientKey, scopedSessionId)')
    expect(source).toContain('remoteAgentReplayRegistry.unbindClient(replayState.clientKey)')
    expect(source).toContain('remoteAgentReplayRegistry.clearSession(sessionId)')
  })

  test('不复制桌面 webContents 机制：remote 不出现 registerWebContents / restoreActiveAgentStreams', () => {
    expect(source).not.toContain('registerWebContents')
    expect(source).not.toContain('restoreActiveAgentStreams')
    expect(source).not.toContain('activeStreamEventBacklogs')
  })

  test('relay 透明层不做会话级回放，一律要求取快照（不混用跨连接状态）', () => {
    const relay = slice('remoteRelayClient = editionProviders.remote.createRelayClient?.(', '// 监听地址：默认 0.0.0.0')
    expect(relay).toContain("parsed.type === 'restore_agent_streams'")
    expect(relay).toContain('requiresSnapshot: true')
  })

  test('两个握手/回放通道并存：游标补发语义保持不变（未改动既有协议）', () => {
    expect(source).toContain("if (parsedRaw?.type === 'resume_agent_events')")
    expect(source).toContain('replayAgentEvents(ws, reqId, (parsedRaw as { cursor?: unknown }).cursor ?? null)')
    expect(source).toContain('agent_events_resumed')
  })
})
