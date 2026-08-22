import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { WsClient } from './ws-client'

type SocketEvent = { data?: string; code?: number; reason?: string }

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static latest: FakeWebSocket | null = null

  readonly url: string
  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: SocketEvent) => void) | null = null
  onclose: ((event: SocketEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.latest = this
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  FakeWebSocket.latest?.close()
  FakeWebSocket.latest = null
  globalThis.WebSocket = originalWebSocket
})

describe('WsClient Agent event recovery', () => {
  test('首次握手不回放，同实例重连发送 cursor，并按 eventId 去重', () => {
    const events: Array<{ sessionId: string; eventId?: number }> = []
    const client = new WsClient({
      url: 'ws://test/ws',
      token: 'token',
      onAgentEvent: (event) => events.push({ sessionId: event.sessionId, eventId: event.eventId }),
    })

    client.connect()
    const firstSocket = FakeWebSocket.latest!
    firstSocket.open()
    firstSocket.receive({ kind: 'hello', serverTime: 1, serverInstanceId: 'instance-1' })
    expect(firstSocket.sent).toHaveLength(0)

    firstSocket.receive({ kind: 'agent_event', eventId: 10, sessionId: 'session-1', payload: {} })
    firstSocket.receive({ kind: 'agent_event', eventId: 10, sessionId: 'session-1', payload: {} })
    firstSocket.receive({ kind: 'agent_event', eventId: 9, sessionId: 'session-1', payload: {} })
    expect(events).toEqual([{ sessionId: 'session-1', eventId: 10 }])

    client.disconnect()
    client.connect()
    const secondSocket = FakeWebSocket.latest!
    secondSocket.open()
    secondSocket.receive({ kind: 'hello', serverTime: 2, serverInstanceId: 'instance-1' })
    expect(secondSocket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: 'resume_agent_events',
      cursor: 10,
    })

    secondSocket.receive({ kind: 'agent_events_resumed', requiresSnapshot: false })
    secondSocket.receive({ kind: 'agent_event', eventId: 11, sessionId: 'session-1', payload: {} })
    expect(events).toEqual([
      { sessionId: 'session-1', eventId: 10 },
      { sessionId: 'session-1', eventId: 11 },
    ])
  })

  test('服务实例变化或 replay 要求快照时通知上层，并丢弃旧 cursor', () => {
    let snapshotRequests = 0
    const client = new WsClient({
      url: 'ws://test/ws',
      token: 'token',
      onAgentSnapshotRequired: () => { snapshotRequests += 1 },
    })

    client.connect()
    const firstSocket = FakeWebSocket.latest!
    firstSocket.open()
    firstSocket.receive({ kind: 'hello', serverTime: 1, serverInstanceId: 'instance-1' })
    firstSocket.receive({ kind: 'agent_event', eventId: 10, sessionId: 'session-1', payload: {} })

    client.disconnect()
    client.connect()
    const secondSocket = FakeWebSocket.latest!
    secondSocket.open()
    secondSocket.receive({ kind: 'hello', serverTime: 2, serverInstanceId: 'instance-2' })
    expect(snapshotRequests).toBe(1)
    expect(secondSocket.sent).toHaveLength(0)

    secondSocket.receive({ kind: 'agent_events_resumed', requiresSnapshot: true })
    expect(snapshotRequests).toBe(2)
  })
})
