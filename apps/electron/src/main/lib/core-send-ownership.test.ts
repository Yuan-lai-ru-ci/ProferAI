import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { AGENT_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')

test('本机Core未就绪消息保留根因，无根因时返回有限文本而非自递归', () => {
  const body = source.match(/function localCoreNotReadyMessage\(\): string \{([\s\S]*?)\n\}/)?.[1]
  expect(body).toBeDefined()
  const create = (reason: string | null): (() => string) => new Function('getLocalCoreStartFailure', `return function localCoreNotReadyMessage() { ${body} }`)(() => reason) as () => string
  expect(create('fixture-startup')()).toBe('本机Core尚未就绪：fixture-startup')
  expect(create(null)()).toBe('本机Core尚未就绪')
})

test('远端发送完整转发本轮渠道模型，list迟到目标切换时不能发送', async () => {
  const start = source.indexOf('  ipcMain.handle(\n    AGENT_IPC_CHANNELS.SEND_MESSAGE,')
  const end = source.indexOf('\n  )', start)
  expect(start).toBeGreaterThan(0)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 4))
  for (const stale of [false, true]) {
    const sent: unknown[] = []
    let generation = 1
    const client = {
      listSessions: async () => { if (stale) generation++; return [{ id: 'session', agentRuntime: 'pi' }] },
      sendMessage: async (...args: unknown[]) => {
        const guard = args[3]
        if (typeof guard !== 'function') throw new Error('缺少目标保护')
        guard()
        sent.push(args.slice(0, 3))
      },
    }
    let invoke: ((event: object, input: object) => Promise<void>) | undefined
    const dependencies = {
      AGENT_IPC_CHANNELS, assertSensitiveAgentIpcSender() {}, getCurrentCoreTargetId: () => 'remote',
      getActiveCoreClient: () => client, getCoreTargetGeneration: () => generation, currentCoreId: () => 'linux',
      parseCoreSessionId: () => ({ coreId: 'linux', sessionId: 'session' }),
      registerWebContents() {}, relayRemoteCoreRun() {}, randomUUID: () => 'fixture-uuid',
      createAgentRunContext: () => ({ traceId: 'fixture' }),
      ipcMain: { handle: (_channel: string, callback: typeof invoke) => { invoke = callback } },
    }
    new Function(...Object.keys(dependencies), js)(...Object.values(dependencies))
    if (!invoke) throw new Error('未注册发送handler')
    const promise = invoke({ sender: {} }, { sessionId: 'core:linux:session', channelId: 'chosen-channel', modelId: 'chosen-model', userMessage: 'fixture', rawUserMessage: 'raw', startedAt: 123 })
    if (stale) { await expect(promise).rejects.toThrow('Core'); expect(sent).toEqual([]) }
    else {
      await promise
      expect(sent).toEqual([['session', 'fixture', { channelId: 'chosen-channel', modelId: 'chosen-model', uuid: 'fixture-uuid', rawUserMessage: 'raw', startedAt: 123, context: { traceId: 'fixture' } }]])
    }
  }
})
