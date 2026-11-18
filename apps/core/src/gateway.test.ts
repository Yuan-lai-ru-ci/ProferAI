import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import type { AgentRunOutcome } from '@profer/agent-runtime'
import { createCoreAgentRuntime } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'

describe('Core WebSocket 终态协议', () => {
  test.each([
    { status: 'completed' },
    { status: 'failed', error: 'provider rejected request' },
    { status: 'stopped' },
  ] satisfies AgentRunOutcome[])('runtime_finished %s 通过真实 WS 保持桌面语义', async outcome => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-ws-terminal-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') })
    const server = createCoreServer({ version: 'test', runtime, apiKey: 'test-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer test-only' } })
    try {
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on('message', raw => {
          const frame = JSON.parse(raw.toString())
          if (frame.kind === 'agent_event') resolve(frame)
        })
        socket.on('error', reject)
      })
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      runtime.publish({ type: 'runtime', sessionId: 'agent-session', payload: { type: 'runtime_finished', sessionId: 'agent-session', outcome, finishedAt: 12345 } })
      const frame = await received
      expect(frame.sessionId).toBe('agent-session')
      const payload = frame.payload as { kind: string; event: Record<string, unknown> }
      expect(payload.kind).toBe('profer_event')
      expect(payload.event.type).toBe('run_completed')
      expect(payload.event.startedAt).toBeUndefined()
      if (outcome.status === 'completed') {
        expect(payload.event.resultSubtype).toBe('success')
        expect(payload.event.stoppedByUser).toBe(false)
        expect(payload.event.resultErrors).toBeUndefined()
      } else if (outcome.status === 'failed') {
        expect(payload.event.resultSubtype).toBe('error_during_execution')
        expect(payload.event.resultErrors).toEqual([outcome.error])
        expect(payload.event.stoppedByUser).toBe(false)
      } else {
        expect(payload.event.stoppedByUser).toBe(true)
        expect(payload.event.resultErrors).toBeUndefined()
        expect(payload.event.resultSubtype).toBeUndefined()
      }
    } finally {
      socket.terminate()
      await closeCoreServer(server)
      runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Planning uses authenticated WebSocket events separate from session lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-ws-planning-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') })
    const server = createCoreServer({ version: 'test', runtime, apiKey: 'test-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer test-only' } })
    try {
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.kind === 'planning_event') resolve(frame) })
        socket.on('error', reject)
      })
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      runtime.publish({ type: 'planning', sessionId: '', payload: { type: 'changed', resources: ['todos'] } })
      expect(await received).toEqual({ kind: 'planning_event', eventId: expect.stringMatching(/^[a-f0-9-]+:\d+$/), payload: { type: 'changed', resources: ['todos'] } })
    } finally { socket.terminate(); await closeCoreServer(server); runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  test('permission approval round-trips through authenticated WebSocket and resolves the Core gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-ws-permission-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') })
    const server = createCoreServer({ version: 'test', runtime, apiKey: 'test-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer test-only' } })
    const frames: Record<string, unknown>[] = []
    let nextId = 1
    const pending = new Map<string, (value: Record<string, unknown>) => void>()
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>
      frames.push(frame)
      if (frame.kind === 'command_result') {
        const id = String(frame.commandId ?? frame.requestId)
        pending.get(id)?.(frame)
        pending.delete(id)
      }
    })
    const command = async (value: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = `permission-test-${nextId++}`
      const result = new Promise<Record<string, unknown>>(resolve => pending.set(id, resolve))
      socket.send(JSON.stringify({ ...value, _cmdId: id }))
      return result
    }
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      const session = runtime.sessions.create({ title: 'Approval test', runtime: 'pi' })
      const controller = new AbortController()
      const resultPromise = runtime.permissions.createCanUseTool({ sessionId: session.id, runId: 'ws-run-1', sendPermissionRequest: request => runtime.publish({ type: 'runtime', sessionId: session.id, payload: { type: 'host_event', sessionId: session.id, event: { type: 'permission_request', request } } }) })('Execute', { fixture: 'isolated' }, { signal: controller.signal, toolUseID: 'tool-1' })
      let requestId = ''
      for (let attempt = 0; attempt < 20 && !requestId; attempt++) {
        requestId = runtime.permissions.listPending(session.id)[0]?.requestId ?? ''
        if (!requestId) await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(requestId).not.toBe('')
      const listed = await command({ type: 'list_pending_permissions', sessionId: session.id })
      expect(listed).toMatchObject({ ok: true, data: [expect.objectContaining({ sessionId: session.id, requestId })] })
      expect(await command({ type: 'respond_permission', sessionId: session.id, requestId, runId: 'ws-run-2', behavior: 'allow' })).toMatchObject({ ok: true, data: false })
      expect(await command({ type: 'respond_permission', sessionId: session.id, requestId, behavior: 'allow' })).toMatchObject({ ok: true, data: false })
      const responseFrame = await command({ type: 'respond_permission', sessionId: session.id, requestId, runId: 'ws-run-1', behavior: 'allow' })
      expect(responseFrame).toMatchObject({ ok: true, data: true })
      expect(await command({ type: 'respond_permission', sessionId: session.id, requestId, runId: 'ws-run-1', behavior: 'allow' })).toMatchObject({ ok: true, data: false })
      await expect(resultPromise).resolves.toMatchObject({ behavior: 'allow', updatedInput: { fixture: 'isolated' }, toolUseID: 'tool-1' })
    } finally {
      socket.terminate()
      await closeCoreServer(server)
      runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Goal命令在所属Core持久化并从WS恢复状态，非法预算不启动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-ws-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
    const server = createCoreServer({ version: 'goal-ws-test', runtime, apiKey: 'goal-test-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer goal-test-only' } })
    let commandId = 0
    const command = (body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> => new Promise((resolve, reject) => {
      const id = `goal:${++commandId}`
      const receive = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString())
        if (frame.commandId !== id) return
        clearTimeout(timer); socket.off('message', receive); resolve(frame)
      }
      const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Goal WS fixture timeout')) }, 2000)
      socket.on('message', receive)
      socket.send(JSON.stringify({ ...body, _cmdId: id }))
    })
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      const session = runtime.sessions.create({ title: 'Goal WS fixture', runtime: 'pi', permissionMode: 'plan' })
      expect(await command({ type: 'goal_start', sessionId: session.id, goal: 'fixture', limits: { maxConsecutiveFailures: 0 } })).toMatchObject({ ok: false })
      const created = await command({ type: 'goal_start', sessionId: session.id, goal: 'fixture', limits: { maxConsecutiveFailures: 3, maxIterations: 2 } })
      expect(created).toMatchObject({ ok: true, data: { sessionId: session.id, status: 'active' } })
      const id = (created.data as { id: string }).id
      expect(await command({ type: 'goal_list', sessionId: session.id })).toMatchObject({ ok: true, data: [expect.objectContaining({ id })] })
      expect(await command({ type: 'goal_pause', goalId: id })).toMatchObject({ ok: true, data: { status: 'paused' } })
      expect(await command({ type: 'goal_update', goalId: id, patch: { limits: { maxIterations: 4 } } })).toMatchObject({ ok: true, data: { limits: { maxIterations: 4 } } })
      expect(await command({ type: 'goal_resume', goalId: id })).toMatchObject({ ok: true, data: { status: 'active' } })
      expect(await command({ type: 'goal_stop', goalId: id })).toMatchObject({ ok: true, data: { status: 'stopped' } })
      expect(await command({ type: 'goal_clear', goalId: id })).toMatchObject({ ok: true, data: true })
      expect(await command({ type: 'goal_history', sessionId: session.id })).toMatchObject({ ok: true, data: [expect.objectContaining({ id, reasonCode: 'cleared' })] })
      expect(runtime.coordinator.isRunning(session.id)).toBe(false)
    } finally {
      socket.terminate(); await closeCoreServer(server); runtime.dispose(); await rm(root, { recursive: true, force: true })
    }
  })

  test('run_completed carries the startedAt of the same run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-ws-started-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') })
    const server = createCoreServer({ version: 'test', runtime, apiKey: 'test-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer test-only' } })
    try {
      const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on('message', raw => {
          const frame = JSON.parse(raw.toString())
          if (frame.kind !== 'agent_event') return
          const payload = frame.payload as { event?: { type?: string } }
          if (payload.event?.type === 'run_completed') resolve(frame)
        })
        socket.on('error', reject)
      })
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      runtime.publish({ type: 'runtime', sessionId: 'agent-session', payload: { type: 'runtime_started', sessionId: 'agent-session', runtime: 'pi', startedAt: 1760000000123 } })
      runtime.publish({ type: 'runtime', sessionId: 'agent-session', payload: { type: 'runtime_finished', sessionId: 'agent-session', runtime: 'pi', outcome: { status: 'stopped' }, finishedAt: 1760000000456 } })
      const frame = await completed
      const payload = frame.payload as { kind: string; event: Record<string, unknown> }
      expect(payload.kind).toBe('profer_event')
      expect(payload.event).toMatchObject({ type: 'run_completed', startedAt: 1760000000123, stoppedByUser: true })
    } finally {
      socket.terminate()
      await closeCoreServer(server)
      runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
