import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeQuery, AgentRuntimePreparedContext } from './contract'
import type { AgentStreamPayload, PermissionRequest } from '@profer/shared'
import { createAgentQueryPreparationPort } from './query-preparation'

const input: AgentRuntimeQuery = { sessionId: 's', runtime: 'pi', prompt: 'fixture', channelId: 'channel' }
const credential = { apiKey: 'fixture', baseUrl: undefined, provider: 'anthropic' as const, forceBearerAuth: false }

describe('Runtime query preparation', () => {
  test('Given resolved snapshots When preparing Then dynamic policy and exact tools are retained without reloading host state', async () => {
    const canUseTool = async () => ({ behavior: 'allow' as const, updatedInput: {} })
    const snapshot: AgentRuntimePreparedContext = {
      credentials: credential, resources: {}, canUseTool,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'policy' },
      tools: [], collaborationAvailable: false, mcpServers: {}, plugins: [], skills: [], allowedTools: [], disallowedTools: [],
    }
    const fail = () => { throw new Error('snapshot unexpectedly reloaded') }
    const port = createAgentQueryPreparationPort({ credentials: { resolve: fail }, resources: { load: fail }, permissions: { createCanUseTool: fail }, toolAssembly: { build: fail } })
    const result = await port.prepare({ ...input, prepared: snapshot, toolAssemblyContext: { sdk: {}, context: {} } }, new AbortController().signal)
    expect(result).toEqual(snapshot)
    expect(result).not.toBe(snapshot)
    expect(result.canUseTool).toBe(canUseTool)
    expect(result.tools).toBe(snapshot.tools)
  })

  test('Given missing fields When preparing Then host order and explicit SDK/context identities are preserved', async () => {
    const calls: string[] = []
    const assembly = { sdk: { defineTool: 'sdk' }, context: { sessionId: 's' } }
    const resources = { systemPrompt: 'loaded' }
    const tools = [{ name: 'Read' }]
    const port = createAgentQueryPreparationPort({
      credentials: { resolve: async actual => { expect(actual.channelId).toBe('channel'); calls.push('credential'); return { ok: true, credentials: credential } } },
      resources: { load: actual => { expect(actual.sessionId).toBe('s'); calls.push('resource'); return resources } },
      events: { emit() {} },
      permissions: { createCanUseTool: () => { calls.push('permission'); return async () => ({ behavior: 'allow' }) } },
      toolAssembly: { build: async actual => { expect(actual).toBe(assembly); calls.push('tools'); return { tools, collaborationAvailable: true } } },
    })
    const result = await port.prepare({ ...input, toolAssemblyContext: assembly }, new AbortController().signal)
    expect(calls).toEqual(['credential', 'resource', 'permission', 'tools'])
    expect(result.credentials).toBe(credential)
    expect(result.resources).toBe(resources)
    expect(result.tools).toBe(tools)
    expect(result.collaborationAvailable).toBe(true)
  })

  test('Given resources are undefined When preparing Then ResourcePort loads exactly once', async () => {
    let loads = 0
    const resources = { systemPrompt: 'loaded', skills: ['loaded-skill'] }
    const port = createAgentQueryPreparationPort({ resources: { load: () => { loads += 1; return resources } } })
    await expect(port.prepare({ ...input, prepared: { credentials: credential } }, new AbortController().signal)).resolves.toMatchObject({ resources })
    expect(loads).toBe(1)
  })
  test('Given loaded workspace resources When provider fields are missing Then runtime projects instructions, skills and MCP servers', async () => {
    const resources = {
      projectInstructions: ['project rules', 'more rules'],
      skills: ['skill-a'],
      mcpResources: [{ name: 'fixture', command: 'run-fixture', enabled: true }],
    }
    const port = createAgentQueryPreparationPort({ resources: { load: () => resources } })
    const result = await port.prepare({ ...input, prepared: { credentials: credential } }, new AbortController().signal)
    expect(result.systemPrompt).toBe('project rules\n\nmore rules')
    expect(result.skills).toEqual(['skill-a'])
    expect(result.mcpServers).toEqual({ fixture: { command: 'run-fixture', enabled: true } })
  })

  test('Given deferred tool context When provider SDK becomes ready Then host assembly receives that SDK exactly on demand', async () => {
    const sdk = { defineTool: 'fixture-sdk' }
    const context = { sessionId: 's', workspaceSlug: 'workspace' }
    const calls: unknown[] = []
    const port = createAgentQueryPreparationPort({ toolAssembly: { build: async input => {
      calls.push(input)
      return { tools: [{ name: 'deferred-tool' }], collaborationAvailable: true }
    } } })
    const prepared = await port.prepare({ ...input, deferredToolAssemblyContext: context }, new AbortController().signal)
    expect(calls).toEqual([])
    const result = await prepared.deferredToolAssembly!.build(sdk)
    expect(calls).toEqual([{ sdk, context }])
    expect(result).toEqual({ tools: [{ name: 'deferred-tool' }], collaborationAvailable: true })
  })


  test('Given permission and AskUser requests When prepared callbacks execute Then EventPort receives host requests and result metadata survives', async () => {
    const events: AgentStreamPayload[] = []
    const request: PermissionRequest = { requestId: 'approval', sessionId: 's', toolName: 'Write', toolInput: { path: 'test' }, description: 'fixture', dangerLevel: 'normal' }
    const port = createAgentQueryPreparationPort({
      events: { emit: (sessionId, event) => { expect(sessionId).toBe('s'); events.push(event) } },
      permissions: {
        createCanUseTool: opts => async (name, toolInput, options) => {
          if (name === 'AskUserQuestion') return opts.handleAskUser!('s', toolInput, options.signal, opts.sendAskUserRequest!)
          opts.sendPermissionRequest(request)
          return { behavior: 'allow', updatedInput: toolInput, toolUseID: options.toolUseID, decisionClassification: 'user_temporary' }
        },
        handleAskUserQuestion: async opts => {
          opts.sendToRenderer({ requestId: 'question', sessionId: 's', questions: [], toolInput: opts.toolInput })
          return { behavior: 'allow', updatedInput: { answer: 'confirmed' } }
        },
      },
    })
    const signal = new AbortController().signal
    const prepared = await port.prepare(input, signal)
    expect(await prepared.canUseTool!('Write', { path: 'test' }, { signal, toolUseID: 'call' })).toMatchObject({ behavior: 'allow', toolUseID: 'call', decisionClassification: 'user_temporary' })
    expect(await prepared.canUseTool!('AskUserQuestion', {}, { signal })).toMatchObject({ updatedInput: { answer: 'confirmed' } })
    expect(events).toEqual([
      { kind: 'profer_event', event: { type: 'permission_request', request } },
      { kind: 'profer_event', event: { type: 'ask_user_request', request: { requestId: 'question', sessionId: 's', questions: [], toolInput: {} } } },
    ])
  })

  test('Given 已准入Run When 构造权限门禁 Then 原Run、取消信号及等待生命周期保持原对象', async () => {
    const controller = new AbortController()
    const lifecycle = { wait(_id: string) {}, resume(_id: string) {} }
    let received: Parameters<NonNullable<import('./ports').PermissionPort['createCanUseTool']>>[0] | undefined
    const port = createAgentQueryPreparationPort({ events: { emit() {} }, permissions: {
      createCanUseTool: options => { received = options; return async () => ({ behavior: 'deny', message: 'fixture' }) },
    } })
    await port.prepare({ ...input, runId: 'admitted-run', runLifecycle: lifecycle }, controller.signal)
    expect(received?.runId).toBe('admitted-run')
    expect(received?.signal).toBe(controller.signal)
    expect(received?.runLifecycle).toBe(lifecycle)
  })

  test('Given a permission host without a notification port When preparing Then failure is explicit before creating pending requests', async () => {
    let invoked = false
    const port = createAgentQueryPreparationPort({ permissions: { createCanUseTool: () => { invoked = true; return async () => ({ behavior: 'allow' }) } } })
    await expect(port.prepare(input, new AbortController().signal)).rejects.toThrow('event host is not configured')
    expect(invoked).toBe(false)
  })

  test('Given explicit empty resources snapshot When preparing Then runtime does not reload host resources or replace the empty policy', async () => {
    const port = createAgentQueryPreparationPort({ resources: { load: () => { throw new Error('must not reload') } } })
    await expect(port.prepare({ ...input, prepared: { credentials: credential, resources: {}, skills: [], mcpServers: {} } }, new AbortController().signal)).resolves.toMatchObject({ resources: {}, skills: [], mcpServers: {} })
  })
  test('Given explicit empty tools snapshot When a tool assembly context is present Then host tool assembly is not invoked', async () => {
    let builds = 0
    const port = createAgentQueryPreparationPort({ toolAssembly: { build: async () => { builds += 1; return { tools: [{ name: 'unexpected' }] } } } })
    const result = await port.prepare({ ...input, prepared: { credentials: credential, tools: [] }, toolAssemblyContext: { sdk: {}, context: {} } }, new AbortController().signal)
    expect(result.tools).toEqual([])
    expect(builds).toBe(0)
  })

  test('Given no tool assembly context When tools are missing Then preparation leaves tools undefined', async () => {
    let builds = 0
    const port = createAgentQueryPreparationPort({ toolAssembly: { build: async () => { builds += 1; return { tools: [{ name: 'unexpected' }] } } } })
    const result = await port.prepare({ ...input, prepared: { credentials: credential } }, new AbortController().signal)
    expect(result.tools).toBeUndefined()
    expect(builds).toBe(0)
  })
  test('Given abort while credentials resolve When awaiting preparation Then no later resource/tool is invoked', async () => {
    const controller = new AbortController()
    const port = createAgentQueryPreparationPort({
      credentials: { resolve: async () => { controller.abort(new Error('stopped')); return { ok: true, credentials: credential } } },
      resources: { load: () => { throw new Error('resource must not run') } },
      toolAssembly: { build: async () => { throw new Error('tools must not run') } },
    })
    await expect(port.prepare({ ...input, toolAssemblyContext: { sdk: {}, context: {} } }, controller.signal)).rejects.toThrow('stopped')
  })
})
