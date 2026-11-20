import { expect, test } from 'bun:test'
import { CoreClient, type CoreChatEvent, type CoreWebSocket } from './core-client'
class Socket implements CoreWebSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  send(_data: string): void {}
  close(): void { this.readyState = 3; this.onclose?.() }
  open(): void { this.readyState = 1; this.onopen?.() }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
}
test('Chat WS事件与Agent流分离、恢复游标去重且旧socket不能发布', async () => {
  const chat: CoreChatEvent[] = [], agent: unknown[] = [], sockets: Socket[] = []
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false,
    onChatEvent: event => chat.push(event), onEvent: event => agent.push(event),
    webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  let listeners = 0
  client.addChatEventListener(() => { listeners++ })
  const connecting = client.connect(); sockets[0]!.open(); await connecting
  const frame = { kind: 'chat_event', conversationId: 'raw', channel: 'chat:stream:chunk', payload: { runId: 'run', delta: 'hello' }, eventId: 'epoch:1' }
  sockets[0]!.message(frame); sockets[0]!.message(frame)
  sockets[0]!.message({ ...frame, channel: 'agent:stream:event', eventId: 'epoch:1.5' })
  expect(chat).toHaveLength(1); expect(listeners).toBe(1); expect(agent).toEqual([])
  client.close()
  const reconnecting = client.connect(); sockets[1]!.open(); await reconnecting
  sockets[0]!.message({ ...frame, eventId: 'epoch:2' })
  expect(chat).toHaveLength(1)
  sockets[1]!.message({ ...frame, eventId: 'epoch:2' }); expect(chat).toHaveLength(2)
  client.close()
})
test('Chat发送需先连事件流并在连接等待后验证目标，过期请求不发HTTP', async () => {
  const socket = new Socket()
  let requests = 0, valid = true
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false,
    webSocketFactory: () => socket, fetchImpl: async () => { requests++; return new Response('{"result":{"accepted":true}}') } })
  const pending = client.chatOperation('chat:send-message', [{ conversationId: 'raw', runId: 'run' }], () => { if (!valid) throw new Error('过期') })
  valid = false; socket.open()
  await expect(pending).rejects.toThrow('过期'); expect(requests).toBe(0)
  client.close()
})
