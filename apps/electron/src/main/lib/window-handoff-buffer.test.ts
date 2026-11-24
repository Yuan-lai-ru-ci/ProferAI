import { expect, test } from 'bun:test'
import { beginWindowHandoff, finishWindowHandoff, sendCoreWindowEvent } from './window-handoff-buffer'

test('目标缓冲保持权限、消息、终态顺序，commit 单次释放且不广播', () => {
  const received: unknown[] = []
  const target = { id: 981, isDestroyed: () => false, send: (channel: string, payload: unknown) => received.push([channel, payload]) } as never
  beginWindowHandoff(981, 's')
  for (const event of ['permission', 'message', 'terminal']) sendCoreWindowEvent(target, 'stream', { sessionId: 's', event })
  expect(received).toEqual([])
  finishWindowHandoff(target, true)
  finishWindowHandoff(target, true)
  expect(received).toEqual(['permission', 'message', 'terminal'].map(event => ['stream', { sessionId: 's', event }]))
  sendCoreWindowEvent(target, 'stream', 'live')
  expect(received.at(-1)).toEqual(['stream', 'live'])
})

test('失败不把目标专属缓冲发送给不相关窗口', () => {
  const received: unknown[] = []
  const target = { id: 982, isDestroyed: () => false, send: (...args: unknown[]) => received.push(args) } as never
  beginWindowHandoff(982, 's')
  sendCoreWindowEvent(target, 'stream', { sessionId: 's', event: 'permission' })
  finishWindowHandoff(target, false)
  expect(received).toEqual([])
})


test('pending 只缓冲指定会话，另一会话和来源实时事件不被吞掉', () => {
 const received: unknown[] = []
 const target = { id: 983, isDestroyed: () => false, send: (_channel: string, payload: unknown) => received.push(payload) } as never
 const source = { id: 984, isDestroyed: () => false, send: (_channel: string, payload: unknown) => received.push(payload) } as never
 beginWindowHandoff(983, 'moving')
 sendCoreWindowEvent(target, 'stream', { sessionId: 'moving', terminal: true })
 sendCoreWindowEvent(target, 'stream', { sessionId: 'other' })
 sendCoreWindowEvent(source, 'stream', { sessionId: 'moving', source: true })
 expect(received).toEqual([{ sessionId: 'other' }, { sessionId: 'moving', source: true }])
 finishWindowHandoff(target, false)
 expect(received).toHaveLength(2)
})
