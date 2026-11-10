import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { BrowserPageInteractions } from './browser-page-interactions'

function harness(timeoutMs?: number) {
  const events = new EventEmitter()
  const searches: Array<{ query: string; options: unknown }> = []
  let requestId = 0
  let stopped = 0
  const contents = {
    on: events.on.bind(events), removeListener: events.removeListener.bind(events), isDestroyed: () => false,
    findInPage: (query: string, options: unknown) => { searches.push({ query, options }); return ++requestId },
    stopFindInPage: () => { stopped++ },
  }
  let changes = 0
  const interaction = new BrowserPageInteractions(contents as unknown as WebContents, () => { changes++ }, timeoutMs)
  return { interaction, events, searches, stopped: () => stopped, changes: () => changes }
}
const confirm = { type: 'confirm' as const, message: '确认提交？', defaultPrompt: '', origin: 'https://example.com' }

test('查找只接收当前 requestId 的结果，空关键词清除高亮', () => {
  const h = harness()
  h.interaction.find({ query: 'hello' })
  expect(h.searches).toEqual([{ query: 'hello', options: { forward: true, findNext: true, matchCase: false } }])
  h.interaction.find({ query: 'world' })
  h.events.emit('found-in-page', {}, { requestId: 1, matches: 10, activeMatchOrdinal: 1, finalUpdate: true })
  expect(h.interaction.snapshot().find?.matches).toBe(0)
  h.events.emit('found-in-page', {}, { requestId: 2, matches: 3, activeMatchOrdinal: 2, finalUpdate: true })
  expect(h.interaction.snapshot().find).toMatchObject({ query: 'world', matches: 3, activeMatchOrdinal: 2, searching: false })
  h.interaction.find({ query: '' })
  expect(h.stopped()).toBe(1)
  expect(h.interaction.snapshot().find).toBeNull()
  h.interaction.dispose()
})

test('下一项/上一项复用同一关键词，大小写变化创建新查找', () => {
  const h = harness()
  h.interaction.find({ query: '中文' })
  h.interaction.find({ query: '中文', next: true, forward: false })
  expect(h.searches[1]).toEqual({ query: '中文', options: { forward: false, findNext: false, matchCase: false } })
  h.interaction.find({ query: '中文', next: true, matchCase: true })
  expect(h.searches[2]).toEqual({ query: '中文', options: { forward: true, findNext: true, matchCase: true } })
  h.interaction.dispose()
})

test('网页提示等待明确回应，不自动接受；过期ID与第二次回应无效', async () => {
  const h = harness()
  let settled = false
  const result = h.interaction.requestDialog(confirm, () => true, new AbortController().signal).then(value => { settled = true; return value })
  const dialog = h.interaction.snapshot().dialog!
  expect(dialog).toMatchObject(confirm)
  await Promise.resolve()
  expect(settled).toBe(false)
  await expect(h.interaction.respond({ dialogId: 'stale', accept: true })).rejects.toThrow('已失效')
  expect(settled).toBe(false)
  await h.interaction.respond({ dialogId: dialog.id, accept: true })
  expect(await result).toBe(true)
  expect(h.interaction.snapshot().dialog).toBeNull()
  await expect(h.interaction.respond({ dialogId: dialog.id, accept: true })).rejects.toThrow('已失效')
  h.interaction.dispose()
})

test('prompt保留中文文本；取消返回null，confirm取消返回false', async () => {
  const h = harness()
  const prompt = { ...confirm, type: 'prompt' as const, defaultPrompt: '默认' }
  const result = h.interaction.requestDialog(prompt, () => true, new AbortController().signal)
  await h.interaction.respond({ dialogId: h.interaction.snapshot().dialog!.id, accept: true, promptText: '多行\n中文' })
  expect(await result).toBe('多行\n中文')
  const cancelled = h.interaction.requestDialog(prompt, () => true, new AbortController().signal)
  await h.interaction.respond({ dialogId: h.interaction.snapshot().dialog!.id, accept: false })
  expect(await cancelled).toBeNull()
  const declined = h.interaction.requestDialog(confirm, () => true, new AbortController().signal)
  h.interaction.cancelDialog()
  expect(await declined).toBe(false)
  h.interaction.dispose()
})

test('重叠提示不会替换当前请求；abort、导航、dispose都取消等待', async () => {
  const h = harness()
  const abort = new AbortController()
  const first = h.interaction.requestDialog(confirm, () => true, abort.signal)
  const id = h.interaction.snapshot().dialog!.id
  expect(await h.interaction.requestDialog(confirm, () => true, abort.signal)).toBe(false)
  expect(h.interaction.snapshot().dialog!.id).toBe(id)
  abort.abort()
  expect(await first).toBe(false)
  const second = h.interaction.requestDialog(confirm, () => true, new AbortController().signal)
  h.interaction.find({ query: 'old' })
  h.interaction.resetDocument()
  expect(await second).toBe(false)
  expect(h.interaction.snapshot().find).toBeNull()
  const third = h.interaction.requestDialog(confirm, () => true, new AbortController().signal)
  h.interaction.dispose()
  expect(await third).toBe(false)
  expect(h.events.listenerCount('found-in-page')).toBe(0)
  expect(h.interaction.snapshot().dialog).toBeNull()
})

test('失效frame不能接受，超时不永久挂起且绝不接受', async () => {
  const h = harness(15)
  let alive = true
  const result = h.interaction.requestDialog(confirm, () => alive, new AbortController().signal)
  const id = h.interaction.snapshot().dialog!.id
  alive = false
  await expect(h.interaction.respond({ dialogId: id, accept: true })).rejects.toThrow('已失效')
  expect(await result).toBe(false)
  const expired = h.interaction.requestDialog(confirm, () => true, new AbortController().signal)
  expect(await expired).toBe(false)
  expect(h.interaction.snapshot().dialog).toBeNull()
  h.interaction.dispose()
})
