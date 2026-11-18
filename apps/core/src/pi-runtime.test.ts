import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { PiAgentAdapter } from '@profer/agent-provider-pi'
import { ModelRuntime, createScriptedTransport, type ScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { createCoreAgentRuntime, createCorePiRuntimeEnv } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'

// 真实 SDK 的会话、adapter、Core 和 WS 均保持原样，仅替换模型传输，避免联网付费。

describe('Core Pi 恢复集成（真实 SDK + 脚本模型 + WS）', () => {
  test('Core Pi Bash uses an absolute POSIX shell and receives the host environment', () => {
    const env = createCorePiRuntimeEnv({ PATH: '/custom/bin', HOME: '/var/lib/profer-core' }, 'linux')
    expect(env.shellKind).toBe('posix')
    expect(env.shellPath).toBe('/bin/bash')
    expect(env.env).toEqual({ PATH: '/custom/bin', HOME: '/var/lib/profer-core' })
  })

  test('Core Pi Bash selects a validated Windows Git Bash path from case-insensitive env keys', () => {
    const selected = createCorePiRuntimeEnv({ Path: 'C:\\Git\\bin', claude_code_shell: 'C:\\Git\\bin\\bash.exe' }, 'win32', path => path === 'C:\\Git\\bin\\bash.exe')
    expect(selected).toMatchObject({ shellKind: 'git-bash', shellPath: 'C:\\Git\\bin\\bash.exe' })
    const missing = createCorePiRuntimeEnv({ PATH: 'C:\\Git\\bin', CLAUDE_CODE_SHELL: 'C:\\missing\\bash.exe' }, 'win32', () => false)
    expect(missing.shellPath).toBeUndefined()
    expect(missing.shellKind).toBeUndefined()
  })

  test.each(['bypassPermissions', 'plan', 'auto'] as const)('Core Pi Planning respects permission mode %s in its owning database', async permissionMode => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-pi-planning-'))
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    const transport = createScriptedTransport([
      { toolCall: { id: 'planning-create', name: 'mcp__planning__create_todo', arguments: { title: 'Created by Core Pi', reminders: [] } } },
      { textChunks: ['PLANNING_CORE_OK'] },
    ])
    prototype.stream = transport.streamSimple
    prototype.streamSimple = transport.streamSimple
    const runtime = createCoreAgentRuntime({
      host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'test-channel', name: 'offline test', provider: 'anthropic', apiKey: 'unused-test-key', baseUrl: 'https://api.anthropic.com' }],
    })
    try {
      const workspace = runtime.workspaces.createManaged('planning-owner')
      const session = runtime.sessions.create({ title: 'planning', runtime: 'pi', channelId: 'test-channel', modelId: 'claude-sonnet-4-5', workspaceId: workspace.id })
      runtime.sessions.updateMeta(session.id, { permissionMode })
      const events: unknown[] = []
      const unsubscribe = runtime.subscribe(event => {
        if (event.type === 'planning') events.push(event.payload)
        const payload = event.payload as { event?: { type?: string; request?: import('@profer/shared').PermissionRequest } }
        if (permissionMode === 'auto' && payload.event?.type === 'permission_request' && payload.event.request) {
          const request = payload.event.request
          queueMicrotask(() => runtime.respondToPermission(request.sessionId, request.requestId, 'allow', false, request.runId))
        }
      })
      const handle = runtime.coordinator.run(runtime.createQuery(session, 'Create a Planning Todo in this project'), { onEvent() {}, onComplete() {}, onError() {} })
      expect(await handle.promise).toEqual({ status: 'completed' })
      expect(transport.calls).toHaveLength(2)
      const todos = runtime.planning.listTodos()
      if (permissionMode === 'plan') {
        expect(todos).toEqual([])
        const transcript = JSON.stringify(runtime.sessions.readMessages(session.id))
        expect(transcript).toContain('计划模式下')
        expect(events).toEqual([])
        unsubscribe()
        return
      }
      expect(todos).toHaveLength(1)
      expect(todos[0]).toMatchObject({ title: 'Created by Core Pi', workspaceId: workspace.id, sessionLinks: [{ sessionId: session.id }] })
      expect(events).toContainEqual({ type: 'changed', resources: ['todos', 'reminders'] })
      expect(events).toContainEqual({ type: 'agent_operation', operation: { sessionId: session.id, target: 'todo', action: 'created', title: 'Created by Core Pi' } })
      unsubscribe()
    } finally {
      runtime.dispose()
      prototype.stream = originalStream
      prototype.streamSimple = originalSimple
      transport.releasePending()
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each(['allow', 'deny'] as const)('Core Pi 文件写入经真实权限门禁 %s 并记录等待/恢复', async behavior => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-approval-'))
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    const transport = createScriptedTransport([
      { toolCall: { id: 'file-write', name: 'write', arguments: { path: 'approval.txt', content: 'isolated approval fixture' } } },
      { textChunks: ['DONE'] },
    ])
    prototype.stream = transport.streamSimple
    prototype.streamSimple = transport.streamSimple
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
    const server = createCoreServer({ version: 'offline-approval', runtime, apiKey: 'approval-fixture' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    let socket: WebSocket | undefined
    let commandId = 0
    const connect = async () => {
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer approval-fixture' } })
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    }
    const command = (body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> => {
      const id = `approval:${++commandId}`
      return new Promise((resolve, reject) => {
        const current = socket!
        const timer = setTimeout(() => { current.off('message', receive); reject(new Error('fixture command timed out')) }, 2000)
        const receive = (raw: WebSocket.RawData) => {
          const frame = JSON.parse(raw.toString())
          if (frame.commandId !== id) return
          clearTimeout(timer)
          current.off('message', receive)
          resolve(frame)
        }
        current.on('message', receive)
        current.send(JSON.stringify({ ...body, _cmdId: id }))
      })
    }
    let approval: import('@profer/shared').PermissionRequest | undefined
    let unsubscribe = () => {}
    try {
      const workspace = runtime.workspaces.createManaged('approval')
      const session = runtime.sessions.create({ title: 'approval', runtime: 'pi', permissionMode: 'auto', workspaceId: workspace.id, channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
      unsubscribe = runtime.subscribe(event => {
        const payload = event.payload as { event?: { type?: string; request?: import('@profer/shared').PermissionRequest } }
        if (payload.event?.type === 'permission_request') approval = payload.event.request
      })
      await connect()
      const handle = runtime.coordinator.run(runtime.createQuery(session, 'Write the fixture file'))
      const deadline = Date.now() + 3000
      while (!approval && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      expect(approval).toBeDefined()
      expect(approval!.runId).toBeString()
      const ledgerPath = join(root, 'core-agent-runs.json')
      const waiting = JSON.parse(await readFile(ledgerPath, 'utf8'))
      expect(waiting.runs).toContainEqual(expect.objectContaining({ id: approval!.runId, status: 'waiting', waitingFor: { type: 'request', id: approval!.requestId } }))
      expect(runtime.respondToPermission(session.id, approval!.requestId, 'allow', false, 'wrong-run')).toBe(false)
      // 断线并重连：只从 Core 快照恢复原 request/run，连接断开不意味着授权或取消。
      const closed = new Promise<void>(resolve => socket!.once('close', () => resolve()))
      socket!.terminate()
      await closed
      await connect()
      expect(await command({ type: 'list_pending_permissions', sessionId: session.id })).toMatchObject({ ok: true, data: [expect.objectContaining({ requestId: approval!.requestId, runId: approval!.runId })] })
      const invalidRevision = (runtime.sessions.getMeta(session.id)?.revision ?? 0) - 1
      const patchUrl = `http://127.0.0.1:${port}/sessions/${session.id}`
      const headers = { authorization: 'Bearer approval-fixture', 'content-type': 'application/json' }
      expect((await fetch(patchUrl, { method: 'PATCH', headers, body: JSON.stringify({ permissionMode: 'plan', expectedRevision: invalidRevision }) })).status).toBe(400)
      expect(runtime.sessions.getMeta(session.id)?.permissionMode).toBe('auto')
      expect(runtime.listPendingPermissions(session.id)).toHaveLength(1)
      if (behavior === 'deny') {
        const response = await fetch(patchUrl, { method: 'PATCH', headers, body: JSON.stringify({ permissionMode: 'plan', expectedRevision: runtime.sessions.getMeta(session.id)?.revision ?? 0 }) })
        expect(response.status).toBe(200)
        expect(runtime.listPendingPermissions(session.id)).toEqual([])
        expect(await command({ type: 'respond_permission', sessionId: session.id, requestId: approval!.requestId, runId: approval!.runId, behavior: 'allow' })).toMatchObject({ ok: true, data: false })
      } else {
        expect(await command({ type: 'respond_permission', sessionId: session.id, requestId: approval!.requestId, runId: approval!.runId, behavior })).toMatchObject({ ok: true, data: true })
      }
      expect(await handle.promise).toEqual({ status: 'completed' })
      const target = join(runtime.createQuery(session, '').cwd!, 'approval.txt')
      if (behavior === 'allow') expect(await readFile(target, 'utf8')).toBe('isolated approval fixture')
      else expect(await Bun.file(target).exists()).toBe(false)
      const finished = JSON.parse(await readFile(ledgerPath, 'utf8'))
      expect(finished.runs).toContainEqual(expect.objectContaining({ id: approval!.runId, status: 'completed' }))
      expect(finished.events.map((event: { type: string }) => event.type)).toContain('resumed')
      expect(runtime.respondToPermission(session.id, approval!.requestId, 'allow', false, approval!.runId)).toBe(false)
    } finally {
      unsubscribe()
      socket?.terminate()
      await closeCoreServer(server)
      for (const session of runtime.sessions.list()) if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
      runtime.dispose()
      prototype.stream = originalStream
      prototype.streamSimple = originalSimple
      transport.releasePending()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Pi 同一运行 bypass → plan → auto 实际拦截后续文件工具', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-hot-mode-'))
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    const transport = createScriptedTransport([
      { toolCall: { id: 'write-bypass', name: 'write', arguments: { path: 'bypass.txt', content: 'bypass' } } },
      { toolCall: { id: 'write-plan', name: 'write', arguments: { path: 'plan.txt', content: 'plan' } } },
      { toolCall: { id: 'write-auto', name: 'write', arguments: { path: 'auto.txt', content: 'auto' } } },
      { textChunks: ['DONE'] },
    ])
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
    const workspace = runtime.workspaces.createManaged('hot-mode')
    const session = runtime.sessions.create({ title: 'hot-mode', runtime: 'pi', permissionMode: 'bypassPermissions', workspaceId: workspace.id, channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    let approvals = 0
    const unsubscribe = runtime.subscribe(event => {
      const payload = event.payload as { event?: { type?: string; request?: import('@profer/shared').PermissionRequest } }
      if (payload.event?.type === 'permission_request' && payload.event.request) {
        approvals++
        const request = payload.event.request
        queueMicrotask(() => runtime.respondToPermission(request.sessionId, request.requestId, 'allow', false, request.runId))
      }
    })
    const stream: ScriptedTransport['streamSimple'] = (model, context, options) => {
      if (transport.calls.length === 1) runtime.sessions.updateMeta(session.id, { permissionMode: 'plan' })
      if (transport.calls.length === 2) runtime.sessions.updateMeta(session.id, { permissionMode: 'auto' })
      return transport.streamSimple(model, context, options)
    }
    prototype.stream = stream
    prototype.streamSimple = stream
    try {
      const handle = runtime.coordinator.run(runtime.createQuery(session, 'Write the isolated fixture files'))
      expect(await handle.promise).toEqual({ status: 'completed' })
      const cwd = runtime.createQuery(session, '').cwd!
      expect(await readFile(join(cwd, 'bypass.txt'), 'utf8')).toBe('bypass')
      expect(await Bun.file(join(cwd, 'plan.txt')).exists()).toBe(false)
      expect(await readFile(join(cwd, 'auto.txt'), 'utf8')).toBe('auto')
      expect(approvals).toBe(1)
      expect(transport.calls).toHaveLength(4)
    } finally {
      unsubscribe()
      if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
      runtime.dispose()
      prototype.stream = originalStream
      prototype.streamSimple = originalSimple
      transport.releasePending()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Pi plan 仅写会话私有计划Markdown，不写项目目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-plan-path-'))
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
    const workspace = runtime.workspaces.createManaged('plan-path')
    const session = runtime.sessions.create({ title: 'plan-path', runtime: 'pi', permissionMode: 'plan', workspaceId: workspace.id, channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const planPath = join(root, 'session-workspaces', session.id, '.context', 'plan', 'design.md')
    const transport = createScriptedTransport([
      { toolCall: { id: 'write-plan', name: 'write', arguments: { path: planPath, content: 'isolated plan' } } },
      { toolCall: { id: 'write-project', name: 'write', arguments: { path: 'project.md', content: 'must not exist' } } },
      { textChunks: ['DONE'] },
    ])
    prototype.stream = transport.streamSimple
    prototype.streamSimple = transport.streamSimple
    try {
      const handle = runtime.coordinator.run(runtime.createQuery(session, 'Write the plan, not project files'))
      expect(await handle.promise).toEqual({ status: 'completed' })
      expect(await readFile(planPath, 'utf8')).toBe('isolated plan')
      expect(await Bun.file(join(runtime.createQuery(session, '').cwd!, 'project.md')).exists()).toBe(false)
      expect(runtime.listPendingPermissions(session.id)).toEqual([])
    } finally {
      if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
      runtime.dispose()
      prototype.stream = originalStream
      prototype.streamSimple = originalSimple
      transport.releasePending()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Core预设禁用Write在bypass下仍阻止真实Pi文件写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-preset-gate-'))
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
    const workspace = runtime.workspaces.createManaged('preset-gate')
    const presetPath = join(root, 'workspaces', workspace.slug, 'agent-presets.json')
    await writeFile(presetPath, JSON.stringify({ presets: [{ id: 'no-write', name: 'No Write', version: '1', createdAt: 0, updatedAt: 0, disabledTools: ['Write'], promptSections: ['PRESET_PROMPT_SENTINEL'] }] }))
    const session = runtime.sessions.create({ title: 'preset gate', runtime: 'pi', channelId: 'fixture', modelId: 'claude-sonnet-4-5', workspaceId: workspace.id, permissionMode: 'bypassPermissions',
      presetReference: { presetId: 'no-write', presetScope: 'workspace', workspaceSlug: workspace.slug } })
    const transport = createScriptedTransport([
      { toolCall: { id: 'write-blocked', name: 'write', arguments: { path: 'blocked.txt', content: 'must not exist' } } },
      { textChunks: ['DONE'] },
    ])
    prototype.stream = transport.streamSimple
    prototype.streamSimple = transport.streamSimple
    try {
      const handle = runtime.coordinator.run(runtime.createQuery(session, 'Try the file tool'))
      expect(await handle.promise).toEqual({ status: 'completed' })
      expect(await Bun.file(join(runtime.createQuery(session, '').cwd!, 'blocked.txt')).exists()).toBe(false)
      expect(transport.calls[0]?.systemPrompt).toContain('PRESET_PROMPT_SENTINEL')
      expect(runtime.listPendingPermissions(session.id)).toEqual([])
    } finally {
      if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
      runtime.dispose(); prototype.stream = originalStream; prototype.streamSimple = originalSimple; transport.releasePending()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Core当前Run冻结预设，下一Run才读取磁盘变更', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-preset-frozen-'))
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
    const workspace = runtime.workspaces.createManaged('preset-frozen')
    const presetPath = join(root, 'workspaces', workspace.slug, 'agent-presets.json')
    const preset = { id: 'frozen', name: 'Frozen', version: '1', createdAt: 0, updatedAt: 0, disabledTools: ['Write'], promptSections: ['FROZEN_PRESET_ONE'] }
    await writeFile(presetPath, JSON.stringify({ presets: [preset] }))
    const session = runtime.sessions.create({ title: 'preset freeze', runtime: 'pi', channelId: 'fixture', modelId: 'claude-sonnet-4-5', workspaceId: workspace.id, permissionMode: 'bypassPermissions',
      presetReference: { presetId: 'frozen', presetScope: 'workspace', workspaceSlug: workspace.slug } })
    let transport = createScriptedTransport([
      { toolCall: { id: 'read-fixture', name: 'ls', arguments: { path: '.' } } },
      { toolCall: { id: 'write-frozen', name: 'write', arguments: { path: 'frozen.txt', content: 'must not exist' } } },
      { textChunks: ['DONE'] },
    ])
    const stream: ScriptedTransport['streamSimple'] = (model, context, options) => {
      if (transport.calls.length === 1) {
        // 模拟用户在设置页修改预设文件；当前Run仍必须使用首次冻结的策略。
        require('node:fs').writeFileSync(presetPath, JSON.stringify({ presets: [{ ...preset, disabledTools: [], promptSections: ['FROZEN_PRESET_TWO'] }] }))
      }
      return transport.streamSimple(model, context, options)
    }
    prototype.stream = stream
    prototype.streamSimple = stream
    try {
      expect(await runtime.coordinator.run(runtime.createQuery(session, 'first frozen run')).promise).toEqual({ status: 'completed' })
      const cwd = runtime.createQuery(session, '').cwd!
      expect(await Bun.file(join(cwd, 'frozen.txt')).exists()).toBe(false)
      expect(transport.calls.every(call => call.systemPrompt?.includes('FROZEN_PRESET_ONE'))).toBe(true)
      transport = createScriptedTransport([
        { toolCall: { id: 'write-next', name: 'write', arguments: { path: 'next.txt', content: 'next run' } } },
        { textChunks: ['DONE'] },
      ])
      expect(await runtime.coordinator.run(runtime.createQuery(runtime.sessions.getMeta(session.id)!, 'next run')).promise).toEqual({ status: 'completed' })
      expect(await readFile(join(cwd, 'next.txt'), 'utf8')).toBe('next run')
      expect(transport.calls[0]?.systemPrompt).toContain('FROZEN_PRESET_TWO')
    } finally {
      if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
      runtime.dispose(); prototype.stream = originalStream; prototype.streamSimple = originalSimple; transport.releasePending()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('旧目录会话保留历史续接，新目录会话正常创建并再次续接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-pi-resume-'))
    const legacyDir = join(root, 'sdk-config', 'sessions', 'pi')
    const provider = new PiAgentAdapter()
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    let transport: ScriptedTransport = createScriptedTransport([{ textChunks: ['seed reply'] }])
    const stream: ScriptedTransport['streamSimple'] = (model, context, options) => transport.streamSimple(model, context, options)
    prototype.stream = stream
    prototype.streamSimple = stream
    const runtime = createCoreAgentRuntime({
      host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'test-channel', name: 'offline test', provider: 'anthropic', apiKey: 'unused-test-key', baseUrl: 'https://api.anthropic.com' }],
    })
    const server = createCoreServer({ version: 'test', runtime, apiKey: 'test-only' })
    let socket: WebSocket | undefined
    let sdkId = ''
    let seededFile = ''
    try {
      // 先由真实 adapter/SDK 生成一份旧布局会话，后续让 Core 接手同一个原生会话。
      for await (const _message of provider.query({
        sessionId: 'seed-agent', prompt: 'remember core migration sentinel', provider: 'anthropic',
        apiKey: 'unused-test-key', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', permissionMode: 'bypassPermissions',
        systemPrompt: 'offline test', cwd: root, piAgentDir: join(root, 'agent'), piSessionDir: legacyDir,
        onSessionId: (id, file) => { sdkId = id; seededFile = file ?? '' },
      })) { /* 完整消费真实 SDK query */ }
      expect(sdkId.length).toBeGreaterThan(0)
      expect(seededFile.length).toBeGreaterThan(0)
      const seededContent = await readFile(seededFile, 'utf8')
      const session = runtime.sessions.create({ title: 'migrated', runtime: 'pi', channelId: 'test-channel', modelId: 'claude-sonnet-4-5' })
      runtime.sessions.updateMeta(session.id, { sdkSessionId: sdkId, piSessionFile: join(root, 'outside-current-config', 'obsolete.jsonl') })
      await listenCoreServer(server, '127.0.0.1', 0)
      const port = (server.address() as AddressInfo).port
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer test-only' } })
      const completions: Array<{ sessionId: string; resultSubtype?: string; resultErrors?: string[] }> = []
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString())
        if (frame.payload?.event?.type === 'run_completed') completions.push(frame.payload.event)
      })
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
      transport = createScriptedTransport([{ textChunks: ['resumed legacy'] }])
      const resumed = runtime.sessions.getMeta(session.id)!
      const handle = runtime.coordinator.run(runtime.createQuery(resumed, 'continue after migration'), { onEvent() {}, onComplete() {}, onError() {} })
      expect(await handle.promise).toEqual({ status: 'completed' })
      expect(transport.calls[0]?.userTexts.join('\n')).toContain('core migration sentinel')
      expect(runtime.sessions.getMeta(session.id)?.sdkSessionId).toBe(sdkId)
      expect(runtime.sessions.getMeta(session.id)?.piSessionFile).toBe(seededFile)
      expect((await readFile(seededFile, 'utf8')).startsWith(seededContent)).toBe(true)

      transport = createScriptedTransport([{ textChunks: ['new reply'] }])
      const fresh = runtime.sessions.create({ title: 'fresh', runtime: 'pi', channelId: 'test-channel', modelId: 'claude-sonnet-4-5' })
      const freshHandle = runtime.coordinator.run(runtime.createQuery(fresh, 'fresh context sentinel'), { onEvent() {}, onComplete() {}, onError() {} })
      expect(await freshHandle.promise).toEqual({ status: 'completed' })
      const freshMeta = runtime.sessions.getMeta(fresh.id)!
      expect(freshMeta.piSessionFile?.startsWith(join(root, 'pi-sessions'))).toBe(true)
      transport = createScriptedTransport([{ textChunks: ['new continued'] }])
      const next = runtime.coordinator.run(runtime.createQuery(freshMeta, 'continue fresh session'), { onEvent() {}, onComplete() {}, onError() {} })
      expect(await next.promise).toEqual({ status: 'completed' })
      expect(transport.calls[0]?.userTexts.join('\n')).toContain('fresh context sentinel')
      expect(runtime.sessions.getMeta(fresh.id)?.sdkSessionId).toBe(freshMeta.sdkSessionId)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(completions).toHaveLength(3)
      expect(completions.every(event => event.resultSubtype === 'success' && event.resultErrors === undefined)).toBe(true)

      // 缺失上下文必须在模型请求前失败，不能重建空会话伪装成功。
      const missing = runtime.sessions.create({ title: 'missing', runtime: 'pi', channelId: 'test-channel', modelId: 'claude-sonnet-4-5' })
      runtime.sessions.updateMeta(missing.id, { sdkSessionId: 'missing-pi-session' })
      transport = createScriptedTransport([])
      const missingHandle = runtime.coordinator.run(runtime.createQuery(runtime.sessions.getMeta(missing.id)!, 'do not reset history'), { onEvent() {}, onComplete() {}, onError() {} })
      expect(await missingHandle.promise).toEqual({ status: 'failed', error: expect.stringContaining('未找到 Pi 上下文') })
      expect(transport.calls).toHaveLength(0)
      expect(runtime.sessions.getMeta(missing.id)?.sdkSessionId).toBe('missing-pi-session')

      // 用真实 coordinator 停止等待中的模型流，核对 WS 不会误报成功/异常。
      const stoppable = runtime.sessions.create({ title: 'stop', runtime: 'pi', channelId: 'test-channel', modelId: 'claude-sonnet-4-5' })
      transport = createScriptedTransport([{ pending: true }])
      const stopHandle = runtime.coordinator.run(runtime.createQuery(stoppable, 'wait for stop'), { onEvent() {}, onComplete() {}, onError() {} })
      for (let wait = 0; transport.calls.length === 0 && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(transport.calls).toHaveLength(1)
      const stopResponse = await fetch(`http://127.0.0.1:${port}/sessions/${stoppable.id}/stop`, {
        method: 'POST', headers: { authorization: 'Bearer test-only' },
      })
      expect(stopResponse.status).toBe(202)
      expect(await stopResponse.json()).toMatchObject({ stopped: true, sessionId: stoppable.id })
      expect(await stopHandle.promise).toEqual({ status: 'stopped' })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(completions).toHaveLength(5)
      expect(completions[3]).toMatchObject({ sessionId: missing.id, resultSubtype: 'error_during_execution', resultErrors: [expect.stringContaining('未找到 Pi 上下文')] })
      expect(completions[4]).toMatchObject({ sessionId: stoppable.id, stoppedByUser: true })
      expect(completions[4]?.resultSubtype).toBeUndefined()
    } finally {
      socket?.terminate()
      await closeCoreServer(server)
      runtime.dispose()
      provider.dispose()
      prototype.stream = originalStream
      prototype.streamSimple = originalSimple
      await rm(root, { recursive: true, force: true })
    }
  }, 20000)
})
