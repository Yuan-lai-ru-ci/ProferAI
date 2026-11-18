import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { createCoreAgentRuntime } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'
import type { Automation } from '@profer/shared'

test('Core真实鉴权WebSocket CRUD/运行与Automation事件，重连读取权威快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-automation-ws-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [{ id: 'offline', name: 'fixture', provider: 'anthropic', apiKey: 'unused' }] })
  const server = createCoreServer({ version: 'test', runtime, apiKey: 'test-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`
  const events: unknown[] = []
  let socket: WebSocket | undefined
  const connect = async () => {
    const ws = new WebSocket(url, ['profer.v1'], { headers: { authorization: 'Bearer test-only' } })
    ws.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.kind === 'automation_event') events.push(frame.payload) })
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    socket = ws
  }
  const command = <T>(operation: string, input: Record<string, unknown> = {}): Promise<T> => new Promise((resolve, reject) => {
    const ws = socket!, id = crypto.randomUUID()
    const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('command timeout')) }, 3000)
    const listener = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString())
      if (frame.commandId !== id) return
      clearTimeout(timer); ws.off('message', listener)
      if (frame.ok) resolve(frame.data as T); else reject(new Error(frame.error))
    }
    ws.on('message', listener); ws.send(JSON.stringify({ type: `automation_${operation}`, _cmdId: id, ...input }))
  })
  try {
    const workspace = runtime.workspaces.createManaged('fixture')
    await connect()
    const operationId = crypto.randomUUID()
    const created = await command<Automation>('create', { operationId, input: { name: 'idempotent', prompt: 'fixture only', scheduleType: 'interval', intervalMinutes: 10, workspaceId: workspace.id, channelId: 'offline', active: false } })
    const retried = await command<Automation>('create', { operationId, input: { name: 'idempotent', prompt: 'fixture only', scheduleType: 'interval', intervalMinutes: 10, workspaceId: workspace.id, channelId: 'offline', active: false } })
    expect(retried.id).toBe(created.id)
    expect((await command<Automation[]>('list')).filter(item => item.name === 'idempotent')).toHaveLength(1)
    let conflict: unknown
    try { await command('create', { operationId, input: { name: 'different' } }) } catch (error) { conflict = error }
    expect(conflict instanceof Error ? conflict.message : conflict).toContain('operationId')
    await command('delete', { id: created.id })
    const task = await command<Automation>('create', { input: { name: 'fixture', prompt: 'fixture only', scheduleType: 'interval', intervalMinutes: 10, workspaceId: workspace.id, channelId: 'offline', agentRuntime: 'pi', active: false,
      promptAuthor: { type: 'agent', id: 'forged' }, timeZone: 'Asia/Shanghai' } })
    expect(task.promptAuthor).toEqual({ type: 'user' })
    expect(task.timeZone).toBe('Asia/Shanghai')
    expect((await command<Automation[]>('list')).find(item => item.id === task.id)?.id).toBe(task.id)
    await command('update', { input: { id: task.id, name: 'renamed' } })
    const runOperationId = crypto.randomUUID()
    await command('run_now', { id: task.id, operationId: runOperationId })
    await command('run_now', { id: task.id, operationId: runOperationId })
    expect(runtime.automations.manager.listAutomationTriggers()).toHaveLength(1)
    socket!.terminate()
    const deadline = Date.now() + 6000
    while (runtime.automations.list()[0]?.runCount !== 1 && Date.now() < deadline) await Bun.sleep(20)
    expect(runtime.automations.list()[0]?.runCount).toBe(1)
    await connect()
    const restored = await command<Automation[]>('list')
    expect(restored[0]?.name).toBe('renamed')
    expect(restored[0]?.runHistory[0]?.status).toBe('success')
    expect(events.length).toBeGreaterThan(0)
    expect(await command<boolean>('delete', { id: task.id })).toBe(true)
    expect(await command<Automation[]>('list')).toEqual([])
    let invalid: unknown
    try { await command('create', { input: { name: 'invalid', prompt: 'fixture', active: 'yes' } }) } catch (error) { invalid = error }
    expect(invalid).toBeInstanceOf(Error)
  } finally { socket?.terminate(); await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 15000)
