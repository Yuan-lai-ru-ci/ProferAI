import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Debugger } from 'electron'
import { BrowserDialogFrameScripts } from './browser-dialog-frame-scripts'

function harness(failMethod?: string) {
  const events = new EventEmitter()
  const commands: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  const failures: unknown[] = []
  const debuggerClient = Object.assign(events, { sendCommand: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
    commands.push({ method, params, sessionId })
    if (sessionId && method === failMethod) throw new Error('fixture install failure')
    return {}
  } })
  const scripts = new BrowserDialogFrameScripts(debuggerClient as unknown as Debugger, 'fixed-source', error => { failures.push(error) })
  const attached = (sessionId: string, type = 'iframe'): void => { events.emit('message', {}, 'Target.attachedToTarget', { sessionId, targetInfo: { type }, waitingForDebugger: true }) }
  return { events, commands, failures, scripts, attached }
}
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

test('root在导航前安装脚本，autoAttach仅限iframe，不暂停worker或其他页面', async () => {
  const h = harness()
  await h.scripts.start()
  expect(h.commands.map(command => command.method)).toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach'])
  expect(h.commands[1]?.params).toEqual({ source: 'fixed-source', runImmediately: true })
  expect(h.commands[2]?.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] })
  expect(h.commands.every(command => command.sessionId === undefined)).toBe(true)
  h.attached('worker', 'worker')
  await flush()
  expect(h.commands).toHaveLength(3)
  h.scripts.dispose()
})

test('跨站iframe和嵌套iframe先安装脚本与递归attach，最后才恢复运行', async () => {
  const h = harness()
  await h.scripts.start()
  h.attached('child')
  await flush()
  h.attached('nested')
  await flush()
  for (const sessionId of ['child', 'nested']) expect(h.commands.filter(command => command.sessionId === sessionId).map(command => command.method))
    .toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'])
  h.attached('child')
  await flush()
  expect(h.commands.filter(command => command.sessionId === 'child')).toHaveLength(4)
  h.scripts.dispose()
  expect(h.events.listenerCount('message')).toBe(0)
})

test('脚本安装失败不恢复iframe，报错由controller结束guest；迟到detach不误报失败', async () => {
  const h = harness('Page.addScriptToEvaluateOnNewDocument')
  await h.scripts.start()
  h.attached('broken')
  await flush()
  expect(h.failures).toHaveLength(1)
  expect(h.commands.some(command => command.sessionId === 'broken' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false)
  h.scripts.dispose()
})

test('重连重建document-start hook；dispose后的迟到消息不发命令', async () => {
  const h = harness()
  await h.scripts.start()
  await h.scripts.start()
  expect(h.commands.filter(command => command.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(2)
  h.scripts.dispose()
  const count = h.commands.length
  h.attached('late')
  await flush()
  expect(h.commands).toHaveLength(count)
  expect(h.failures).toHaveLength(0)
})
