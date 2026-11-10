import { describe, expect, mock, test } from 'bun:test'
import type { AgentPreset, AgentSessionMeta, AgentStreamPayload, SDKMessage } from '@profer/shared'
import { AgentFilePreviewSessionManager, agentFilePreviewSessionManager } from './agent-file-preview-session'

const meta: AgentSessionMeta = {
  id: 'session-1',
  title: 'Fixture',
  workspaceId: 'workspace-1',
  createdAt: 1,
  updatedAt: 1,
}
const messages: SDKMessage[] = []
const appended: SDKMessage[][] = []
const metaUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []

mock.module('./agent-session-manager', () => ({
  // 产品能力现在会解析会话写入布局（storageDir / plansDir）；测试里给确定值，
  // 免得能力表断言依赖真实工作区索引。
  resolveAgentSessionWriteLayout: (slug: string, sessionId: string) => ({
    storageDir: `/tmp/${slug}/${sessionId}`,
    contextDir: `/tmp/${slug}/${sessionId}/.context`,
    plansDir: `/tmp/${slug}/${sessionId}/.context/plan`,
    imageOutputDir: `/tmp/${slug}/${sessionId}/.context/agent-output-images`,
    errorsLogPath: `/tmp/${slug}/${sessionId}/.context/session-errors.log`,
    claudeSettingsPath: `/tmp/${slug}/${sessionId}/.claude/settings.json`,
    plansDirectory: '.context',
  }),
  lockAgentSessionRuntime: () => ({ ...meta, agentRuntimeLocked: true }),
  getAgentSessionMeta: (id: string) => id === meta.id
    ? meta
    : id === 'pi-session' ? { ...meta, id: 'pi-session', agentRuntime: 'pi' } : undefined,
  getAgentSessionMessages: () => [],
  getAgentSessionSDKMessages: () => messages,
  appendSDKMessages: (_id: string, next: SDKMessage[]) => appended.push(next),
  // 2026-11-06 起运行消息走异步持久化旁路，host 优先调用 enqueueSDKMessages。
  enqueueSDKMessages: (_id: string, next: SDKMessage[]) => appended.push(next),
  updateAgentSessionMeta: (id: string, patch: Record<string, unknown>) => {
    metaUpdates.push({ id, patch })
    return { ...meta, ...patch }
  },
}))
mock.module('./agent-runtime-credentials', () => ({
  resolveRuntimeCredentials: async () => ({
    ok: true as const,
    credentials: { apiKey: 'fixture-key', baseUrl: 'https://api.fixture.invalid', provider: 'custom', forceBearerAuth: false },
  }),
}))
mock.module('./channel-manager', () => ({
  getChannelById: (id: string) => id === 'channel-1' ? { id, provider: 'custom', baseUrl: 'https://api.fixture.invalid' } : undefined,
  // 内置 7 服务器走真实注入器时会读渠道密钥；测试里给一个确定值，让它们能真的完成注册。
  decryptApiKey: () => 'fixture-key',
}))
mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (id: string) => id === 'workspace-1' ? { id, slug: 'fixture-workspace' } : undefined,
  readWorkspaceProfile: () => ({ content: 'project instructions', relativePath: 'workspace-profile.md', isText: true, size: 20 }),
  getWorkspaceSkills: () => [{ slug: 'skill-a', enabled: true }, { slug: 'skill-disabled', enabled: false }],
  getWorkspaceMcpConfig: () => ({ servers: { fixture: { enabled: true, command: 'fixture' }, disabled: { enabled: false, command: 'disabled' } } }),
  getWorkspaceMemoryArchivePath: (slug: string) => `/fixture/${slug}/.context/memory-archive`,
  // provider preparation 在 project 模式下用它与 settings 文件同值下发 autoMemoryDirectory。
  getWorkspaceAutoMemoryDir: (slug: string) => `/fixture/${slug}/.profer/memory`,
  // B8：宿主现在会通过 `agent-directory-utils` 收集产品服务器的授权根（预览 / 图片 / 浏览器）。
  getWorkspaceAttachedDirectories: () => [],
  getWorkspaceAttachedFiles: () => [],
}))

/**
 * 内置 7 服务器的注入器替身。
 *
 * 为什么在这里 mock：真实注入器会把 `agent-collaboration-tools → agent-service → agent-orchestrator`
 * 整条旧链拉进来（本文件已有模块 mock，不匹配时只会看到一堆无关的 `injector-failed` 噪声）。
 * 「默认端口确实接线到生产注入器」的证据在 `agent-runtime-mcp-injection.test.ts`。
 */
for (const [modulePath, exportName, serverId] of [
  ['./automation-agent-tools', 'injectAutomationMcpServer', 'automation'],
  ['./memory-archive-agent-tools', 'injectMemoryArchiveMcpServer', 'memory-archive'],
  ['./agent-collaboration-tools', 'injectAgentCollaborationMcpServer', 'collaboration'],
  ['./task-graph-agent-tools', 'injectTaskGraphMcpServer', 'task-graph'],
  ['./goal-tools', 'injectGoalMcpServer', 'goal'],
  ['./agent-preset-tools', 'injectAgentPresetMcpServer', 'agent-presets'],
  ['./planning-agent-tools', 'injectPlanningMcpServer', 'planning'],
] as const) {
  mock.module(modulePath, () => ({
    [exportName]: async (_sdk: unknown, table: Record<string, Record<string, unknown>>, ...args: readonly unknown[]) => {
      void args
      table[serverId] = { fixture: true }
    },
  }))
}

const { createElectronAgentHost, createElectronEventPort, createElectronPreviewPort, createElectronToolAssemblyPort, createElectronAgentRuntimeQuery, createElectronProductMcpCapabilities, createElectronResourcePort, loadBuiltinMcpResources, loadProductMcpResources, isRuntimeRunActive, getAgentRuntimeRunFacts, setAgentRuntimeRunFacts, clearAgentRuntimeRunFacts } = await import('./agent-runtime-host')
const { BUILTIN_MCP_INJECTION_ORDER, createElectronBuiltinMcpInjectionPort } = await import('./agent-runtime-mcp-injection')
const { PRODUCT_MCP_INJECTION_ORDER, createElectronProductMcpInjectionPort } = await import('./agent-runtime-product-mcp-injection')
const { agentRuntimePolicyRuns } = await import('./agent-runtime-policy-snapshot')

describe('Electron Agent host ports', () => {

  test('Given a headless send input When creating a runtime query Then runtime-neutral fields and provider policy are preserved', () => {
    const query = createElectronAgentRuntimeQuery({
      sessionId: 'session-query',
      userMessage: 'visible prompt',
      internalPrompt: 'runtime prompt',
      channelId: 'channel-1',
      modelId: 'fixture-model',
      additionalDirectories: ['/tmp/extra'],
      runtimeSessionId: 'sdk-session',
      isolatedRuntimeSession: true,
      permissionModeOverride: 'bypassPermissions',
      mentionedSkills: ['skill-a'],
      mentionedMcpServers: ['fixture'],
      customMcpServers: { bridge: { command: 'fixture' } },
      uuid: 'user-uuid',
      triggeredBy: 'goal',
      goalIteration: 4,
    }, { runtime: 'pi', cwd: '/tmp/work', providerInput: { marker: 'fixture' } })
    expect(query).toMatchObject({
      sessionId: 'session-query',
      prompt: 'runtime prompt',
      runtime: 'pi',
      channelId: 'channel-1',
      modelId: 'fixture-model',
      cwd: '/tmp/work',
      additionalDirectories: ['/tmp/extra'],
      runtimeSessionId: 'sdk-session',
      isolatedRuntimeSession: true,
      providerInput: {
        marker: 'fixture',
        customMcpServers: { bridge: { command: 'fixture' } },
        permissionMode: 'bypassPermissions',
        mentionedSkills: ['skill-a'],
        mentionedMcpServers: ['fixture'],
      },
    })
    expect(query.persistedUserMessage).toMatchObject({ type: 'user', uuid: 'user-uuid', _goalIteration: 4, parent_tool_use_id: null })
    expect((query.persistedUserMessage as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text).toBe('visible prompt')
    expect(query).toMatchObject({ title: 'visible prompt', workspaceId: undefined, initiator: 'goal' })
  })

  test('Given a frozen auto policy When the host receives raw bypass fields Then query and run facts keep the effective mode', () => {
    const sessionId = 'effective-permission-host-query'
    agentRuntimePolicyRuns.releaseRun(sessionId)
    clearAgentRuntimeRunFacts(sessionId)
    const snapshot = agentRuntimePolicyRuns.resolveForRun(sessionId, {
      preset: { id: 'preset-policy', name: 'auto', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, permissionMode: 'auto' },
      presetReference: { presetId: 'preset-policy', presetScope: 'user-global' },
    })
    try {
      const query = createElectronAgentRuntimeQuery({
        sessionId,
        userMessage: 'fixture',
        channelId: 'channel-1',
        permissionModeOverride: 'bypassPermissions',
      } as never, {
        runtime: 'claude',
        providerInput: { permissionMode: 'bypassPermissions' },
      })
      expect(snapshot.policy.permissionMode).toBe('auto')
      expect(query.providerInput?.permissionMode).toBe('auto')
      expect(getAgentRuntimeRunFacts(sessionId)?.permissionModeOverride).toBe('auto')
    } finally {
      clearAgentRuntimeRunFacts(sessionId)
      agentRuntimePolicyRuns.releaseRun(sessionId)
    }
  })

  test('Given a frozen auto policy and bypass facts When Write requests permission Then real approval is still required', async () => {
    const { permissionService } = await import('./agent-permission-service')
    const sessionId = 'host-policy-approval'
    agentRuntimePolicyRuns.releaseRun(sessionId)
    agentRuntimePolicyRuns.resolveForRun(sessionId, {
      preset: { id: 'approval', name: 'approval', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, permissionMode: 'auto' },
      presetReference: { presetId: 'approval', presetScope: 'user-global' },
    })
    setAgentRuntimeRunFacts(sessionId, { permissionModeOverride: 'bypassPermissions' })
    const requests: import('@profer/shared').PermissionRequest[] = []
    const host = createElectronAgentHost()
    const canUseTool = host.ports.permissions!.createCanUseTool!({ sessionId, sendPermissionRequest: request => requests.push(request) })
    try {
      const decision = canUseTool('Write', { file_path: '/fixture/approval', content: 'not written' }, { signal: new AbortController().signal })
      expect(requests).toHaveLength(1)
      permissionService.respondToPermission(requests[0]!.requestId, 'deny', false)
      await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
    } finally {
      permissionService.clearSessionPending(sessionId)
      permissionService.clearSessionWhitelist(sessionId)
      clearAgentRuntimeRunFacts(sessionId)
      agentRuntimePolicyRuns.releaseRun(sessionId)
    }
  })

  test('Given a renderer run timestamp When creating a runtime query Then it is carried into runtime metadata', () => {
    const query = createElectronAgentRuntimeQuery({
      sessionId: 'session-started-at',
      userMessage: 'fixture',
      channelId: 'channel-1',
      startedAt: 1234,
    }, { runtime: 'pi' })
    expect(query.metadata).toEqual({ startedAt: 1234 })
  })

  test('Given suppressed user persistence When creating a runtime query Then no transcript message is attached', () => {
    const query = createElectronAgentRuntimeQuery({ sessionId: 'suppressed', userMessage: 'hidden', internalPrompt: 'runtime hidden', channelId: 'channel-1', suppressUserMessagePersistence: true }, { runtime: 'pi' })
    expect(query.persistedUserMessage).toBeUndefined()
  })

  test('Given an Electron session port When runtime reads and writes Then it delegates to session manager', () => {
    const host = createElectronAgentHost()
    expect(host.sessions.getMeta('session-1')).toEqual(meta)
    expect(host.sessions.getMessages?.('session-1')).toBe(messages)
    expect(host.sessions.lockRuntime?.('session-1', 'pi')).toMatchObject({ agentRuntimeLocked: true })

    const message = { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } } as unknown as SDKMessage
    host.sessions.appendMessages('session-1', [message])
    host.sessions.updateMeta('session-1', { title: 'Updated' })
    expect(appended).toEqual([[message]])
    expect(metaUpdates).toEqual([{ id: 'session-1', patch: { title: 'Updated' } }])
  })

  test('Given a session workspace When resources load Then host resolves profile, enabled skills and MCP entries', async () => {
    // 资源端口现为异步（GAP-4 内置 MCP 注入）：无冻结策略快照时不注入内置服务器，形状保持不变。
    const resources = await createElectronAgentHost().resources.load({ sessionId: 'session-1' })
    expect(resources).toEqual({
      projectInstructions: ['project instructions'],
      skills: ['skill-a'],
      mcpResources: [{ name: 'fixture', enabled: true, command: 'fixture' }],
    })
  })

  test('GAP-4：有冻结策略快照时宿主注入内置 MCP 服务器（键名与顺序与旧链一致；无快照不猜）', async () => {
    const preset: AgentPreset = { id: 'preset-policy', name: '内置 MCP 预设', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 }
    agentRuntimePolicyRuns.resolveForRun('session-1', {
      preset,
      presetReference: { presetId: 'preset-policy', presetScope: 'user-global' },
    })
    setAgentRuntimeRunFacts('session-1', { triggeredBy: 'user', userMessage: 'hello', sourceRunId: 'host-run' })

    const injected: string[] = []
    const sourceRuns: unknown[] = []
    const injectors = Object.fromEntries(
      BUILTIN_MCP_INJECTION_ORDER.map(id => [
        id,
        async (_sdk: unknown, table: Record<string, Record<string, unknown>>, ctx: { sourceRunId?: string }) => {
          injected.push(id)
          if (id === 'automation' || id === 'collaboration') sourceRuns.push(ctx.sourceRunId)
          table[id] = { type: 'sdk', name: id }
        },
      ]),
    ) as NonNullable<Parameters<typeof createElectronBuiltinMcpInjectionPort>[0]>['injectors']
    const port = createElectronBuiltinMcpInjectionPort({
      injectors,
      resolveMemoryArchivePath: async () => '/tmp/parity-memory-archive',
    })

    // meta 无 agentRuntime ⇒ 默认 claude；goal 因未提供报告回调而不注入，其余 6 个按旧链顺序注入；
    // global-memory 走独立的 injectGlobalMemoryTools，追加在旧链之后（不在 BUILTIN_MCP_INJECTION_ORDER 内）。
    const withSnapshot = await loadBuiltinMcpResources('session-1', meta, 'fixture-workspace', port)
    expect(withSnapshot.map(entry => entry.name)).toEqual([
      'automation', 'memory-archive', 'collaboration', 'task-graph', 'agent-presets', 'planning', 'global-memory',
    ])
    expect(injected).toEqual(['automation', 'memory-archive', 'collaboration', 'task-graph', 'agent-presets', 'planning'])
    expect(sourceRuns).toEqual(['host-run', 'host-run'])

    // 无策略快照：不猜、不注入（与「策略缺失不得静默放行」同一原则）。
    agentRuntimePolicyRuns.releaseRun('session-1')
    const withoutSnapshot = await loadBuiltinMcpResources('session-1', meta, 'fixture-workspace', port)
    expect(withoutSnapshot).toEqual([])
    clearAgentRuntimeRunFacts('session-1')
  })

  test('Given a channel When credentials resolve Then the host returns runtime-safe credential fields', async () => {
    const credentials = await createElectronAgentHost().credentials.resolve({
      sessionId: 'session-1',
      runtime: 'pi',
      channelId: 'channel-1',
      modelId: 'fixture-model',
    })
    expect(credentials).toEqual({
      ok: true,
      credentials: { apiKey: 'fixture-key', baseUrl: 'https://api.fixture.invalid', provider: 'custom', forceBearerAuth: false },
    })
  })

  test('Given runtime events When the host event port emits Then it projects them to the Electron event bus', () => {
    const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    const port = createElectronEventPort({ emit: (sessionId: string, payload: AgentStreamPayload) => events.push({ sessionId, payload }) } as never)
    const message = { type: 'result', session_id: 'session-1', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } } as unknown as SDKMessage

    port.emit({ type: 'message', sessionId: 'session-1', message })
    port.emit({ type: 'host_event', sessionId: 'session-1', event: { type: 'run_resumed', sessionId: 'session-1' } })
    port.emit({ type: 'stream_payload', sessionId: 'session-1', payload: { kind: 'run_error', error: 'fixture error' } })
    port.emit({ type: 'runtime_started', sessionId: 'session-1', runtime: 'pi', startedAt: 123, title: 'Fixture title', workspaceId: 'workspace-1', modelId: 'model-1', initiator: 'automation' })
    port.emit({ type: 'runtime_finished', sessionId: 'session-1', outcome: { status: 'failed', error: 'terminal fixture error' }, finishedAt: 456, title: 'Fixture title', workspaceId: 'workspace-1', modelId: 'model-1', initiator: 'automation' })

    expect(events).toHaveLength(5)
    expect(events[0]).toEqual({ sessionId: 'session-1', payload: { kind: 'sdk_message', message } })
    expect(events[1]?.sessionId).toBe('session-1')
    expect(events[2]?.payload).toEqual({ kind: 'run_error', error: 'fixture error' })
    expect(events[3]?.payload).toEqual({ kind: 'profer_event', event: { type: 'external_run_started', source: 'bridge', sessionId: 'session-1', startedAt: 123, title: 'Fixture title', workspaceId: 'workspace-1', modelId: 'model-1', initiator: 'automation' } })
    expect(events[4]?.payload).toMatchObject({ kind: 'profer_event', event: { type: 'run_completed', sessionId: 'session-1', stoppedByUser: false, title: 'Fixture title', workspaceId: 'workspace-1', modelId: 'model-1', initiator: 'automation', resultErrors: ['terminal fixture error'] } })
  })

  test('late persistence ACK is forwarded with its run identity after terminal and cannot finish a newer owner', () => {
    const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    const port = createElectronEventPort({ emit: (sessionId: string, payload: AgentStreamPayload) => events.push({ sessionId, payload }) } as never)
    port.emit({ type: 'runtime_claimed', sessionId: 'ack-session', runId: 'run-a', runtime: 'pi', startedAt: 1 })
    port.emit({ type: 'runtime_finished', sessionId: 'ack-session', runId: 'run-a', outcome: { status: 'completed' }, finishedAt: 2 })
    port.emit({ type: 'runtime_claimed', sessionId: 'ack-session', runId: 'run-b', runtime: 'pi', startedAt: 3 })
    port.emit({ type: 'runtime_persistence', sessionId: 'ack-session', runId: 'run-a', persistence: { status: 'saved', watermark: 7 } })
    expect(isRuntimeRunActive('ack-session')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      sessionId: 'ack-session',
      payload: { kind: 'profer_event', event: { type: 'session_persistence', runId: 'run-a', status: 'saved', watermark: 7 } },
    })
  })

  test('Given a message whose native session id differs When the host event port emits Then it routes by the agent session id', () => {
    const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    const port = createElectronEventPort({ emit: (sessionId: string, payload: AgentStreamPayload) => events.push({ sessionId, payload }) } as never)
    // 真实形状：内核消息带的是**原生**会话 id（Pi 的 sdkSessionId / Claude 的 SDK session id），
    // 与 agent 会话 id 不同。夹具里两者取同一个值会掩盖路由键缺陷。
    const message = { type: 'assistant', session_id: 'pi-native-session-9', message: { content: [{ type: 'text', text: 'hi' }] } } as unknown as SDKMessage

    port.emit({ type: 'message', sessionId: 'agent-session-1', message })

    expect(events).toHaveLength(1)
    expect(events[0]?.sessionId).toBe('agent-session-1')
    expect(events[0]?.payload).toEqual({ kind: 'sdk_message', message })
  })

  test('Given a result message with a foreign native session id When the run finishes Then the terminal observation is still found', () => {
    const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    const port = createElectronEventPort({ emit: (sessionId: string, payload: AgentStreamPayload) => events.push({ sessionId, payload }) } as never)
    const message = { type: 'result', session_id: 'pi-native-session-9', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } } as unknown as SDKMessage

    port.emit({ type: 'message', sessionId: 'agent-session-1', message })
    port.emit({ type: 'runtime_started', sessionId: 'agent-session-1', runtime: 'pi', startedAt: 123 })
    port.emit({ type: 'runtime_finished', sessionId: 'agent-session-1', outcome: { status: 'completed' }, finishedAt: 456 })

    const started = events.find(item => (item.payload as { event?: { type?: string } }).event?.type === 'external_run_started')
    const completed = events.find(item => (item.payload as { event?: { type?: string } }).event?.type === 'run_completed')
    expect(started?.sessionId).toBe('agent-session-1')
    expect(completed?.sessionId).toBe('agent-session-1')
    // `startedAt` 只能来自本轮 observation；若 result 存进了别的键，observation 被删后仍应保留 startedAt。
    expect((completed?.payload as { event?: Record<string, unknown> }).event).toMatchObject({ type: 'run_completed', sessionId: 'agent-session-1', stoppedByUser: false })
  })

  test('Given an injected execution service When the command port executes and cancels Then it preserves the structured execution contract', async () => {
    const calls: string[] = []
    const execution = {
      execute: async (request: { command: string }) => { calls.push(request.command); return { stdout: 'ok', stderr: '', exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, shell: '/bin/bash', cwd: '/tmp', truncated: false } },
      cancel: async (handleId: string) => { calls.push(`cancel:${handleId}`) },
      get: (handleId: string) => ({ handleId }),
    }
    const host = createElectronAgentHost({ execution: execution as never })
    const result = await host.ports.commands?.execute({ sessionId: 'session-1', command: 'printf ok', cwd: '/tmp', shell: '/bin/bash' })
    await host.ports.commands?.cancel('handle-1')
    expect(result?.stdout).toBe('ok')
    expect(calls).toEqual(['printf ok', 'cancel:handle-1'])
  })

  test('Given a preview request When the event consumer acknowledges synchronously Then registration precedes emission and the result is preserved', async () => {
    const manager = new AgentFilePreviewSessionManager(100)
    const emitted: AgentStreamPayload[] = []
    const port = createElectronPreviewPort({ emit(sessionId, payload) {
      expect(sessionId).toBe('session-preview')
      emitted.push(payload)
      if (payload.kind !== 'profer_event') throw new Error('缺少 preview event')
      if (payload.event.type === 'preview_requested') {
        manager.reportReady({ ...payload.event, status: 'ready', slideCount: 2, currentSlide: 1 })
      } else if (payload.event.type === 'preview_inspection_requested') {
        manager.reportInspection({ ...payload.event.request, slideCount: 2, currentSlide: 1, images: [{ page: 2, data: 'fixture-image', mediaType: 'image/png' }] })
      }
    } }, manager)
    const identity = { sessionId: 'session-preview', filePath: '/safe/deck.pptx', revision: 'sha256:preview' }
    const open = { ...identity, type: 'preview_requested' as const, requestId: 'open-preview', readOnly: true }
    await expect(port.open(open)).resolves.toMatchObject({ ...identity, status: 'ready', slideCount: 2 })
    const inspect = { ...identity, requestId: 'inspect-preview', scope: 'page' as const, page: 2 }
    await expect(port.inspect(inspect)).resolves.toMatchObject({ images: [{ page: 2, data: 'fixture-image' }] })
    expect(emitted).toEqual([
      { kind: 'profer_event', event: open },
      { kind: 'profer_event', event: { type: 'preview_inspection_requested', request: inspect } },
    ])
    manager.dispose()
  })

  test('Given Electron host composition When preview opens Then the existing IPC manager receives the request and rejects stale receipts', async () => {
    const host = createElectronAgentHost({ eventBus: { emit(sessionId: string, payload: AgentStreamPayload) {
      expect(sessionId).toBe('session-host-preview')
      if (payload.kind === 'profer_event' && payload.event.type === 'preview_requested') {
        agentFilePreviewSessionManager.reportReady({ ...payload.event, revision: 'sha256:stale', status: 'ready', slideCount: 1, currentSlide: 1 })
      }
    } } as never })
    await expect(host.ports.preview!.open({ type: 'preview_requested', requestId: 'host-preview', sessionId: 'session-host-preview', filePath: '/safe/deck.pptx', revision: 'sha256:current', readOnly: true })).rejects.toThrow('viewer revision 与磁盘文件不一致')
  })

  test('Given an event projection failure When preview opens Then the adapter rejects and removes the pending request', async () => {
    const manager = new AgentFilePreviewSessionManager(100)
    const port = createElectronPreviewPort({ emit() { throw new Error('projection failed') } }, manager)
    const request = { type: 'preview_requested' as const, requestId: 'failed-preview', sessionId: 's', filePath: '/safe/deck.pptx', revision: 'sha256:current', readOnly: true }
    await expect(port.open(request)).rejects.toThrow('projection failed')
    expect(manager.reportReady({ ...request, status: 'ready', slideCount: 1, currentSlide: 1 })).toBe(false)
    manager.dispose()
  })

  test('Given injected preview and tool assembly ports When composing a host Then injection and builder outputs are preserved', async () => {
    const preview = { open: async () => { throw new Error('fake preview') }, inspect: async () => { throw new Error('fake inspection') } }
    const sdk = { fixture: 'sdk' }
    const context = { fixture: 'context' }
    const result = { tools: [{ name: 'fixture-tool' }], collaborationAvailable: true }
    const toolAssembly = createElectronToolAssemblyPort(async (actualSdk, actualContext) => {
      expect(actualSdk).toBe(sdk)
      expect(actualContext).toBe(context)
      return result
    })
    const host = createElectronAgentHost({ preview, toolAssembly })
    expect(host.ports.preview).toBe(preview)
    expect(host.ports.toolAssembly).toBe(toolAssembly)
    expect(await host.ports.toolAssembly!.build({ sdk, context })).toBe(result)
  })

  test('Given injected background task host When composing Then the task authority stays unchanged', () => {
    const backgroundTasks = { begin() {}, append() {}, attachProcess() {}, complete() {}, getOutput: async () => ({ output: '', isComplete: true, status: 'completed' as const }), stop: async () => {} }
    expect(createElectronAgentHost({ backgroundTasks }).ports.backgroundTasks).toBe(backgroundTasks)
  })

  test('Given the default Electron host When exposing process registration Then only the opaque registry adapter is visible', () => {
    const host = createElectronAgentHost()
    expect(Object.keys(host.ports.processRegistration ?? {}).sort()).toEqual(['registerPending', 'registerShell'])
    expect(host.ports.processRegistration?.registerPending({ sessionId: 'session-1', command: 'printf fixture', cwd: '/tmp', launcher: 'bash' })).toBeUndefined()
  })
  test('Given an injected tool assembly and context When query preparation runs Then prepared tools and collaboration metadata are returned', async () => {
    const input = { sdk: { fixture: 'sdk' }, context: { sessionId: 's' } }
    const toolAssembly = { build: async (actual: typeof input) => {
      expect(actual).toBe(input)
      expect(actual.sdk).toBe(input.sdk)
      expect(actual.context).toBe(input.context)
      return { tools: [{ name: 'prepared-tool' }], collaborationAvailable: true }
    } }
    const host = createElectronAgentHost({ toolAssembly, eventBus: { emit() {} } as never })
    agentRuntimePolicyRuns.resolveForRun('s', {
      preset: { id: 'fixture-assembly', name: 'fixture', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 },
      presetReference: { presetId: 'fixture-assembly', presetScope: 'user-global' },
    })
    try {
      await expect(host.ports.queryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'fixture', toolAssemblyContext: input }, new AbortController().signal)).resolves.toMatchObject({ tools: [{ name: 'prepared-tool' }], collaborationAvailable: true })
    } finally { agentRuntimePolicyRuns.releaseRun('s') }
  })
  test('Given an injected query preparation port When composing a host Then it remains the runtime preparation authority', async () => {
    const queryPreparation = { prepare: async () => ({ resources: { systemPrompt: 'prepared' } }) }
    const host = createElectronAgentHost({ queryPreparation })
    expect(host.ports.queryPreparation).toBe(queryPreparation)
    await expect(host.ports.queryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'fixture' }, new AbortController().signal)).resolves.toEqual({ resources: { systemPrompt: 'prepared' } })
  })
  test('Given the default host When provider query preparation runs Then it builds Pi options from prepared credentials and prompt', async () => {
    const host = createElectronAgentHost()
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'fixture', providerInput: { permissionMode: 'bypassPermissions' } }, { credentials: { apiKey: 'fixture-key', baseUrl: 'https://api.fixture.invalid', provider: 'custom', forceBearerAuth: false }, systemPrompt: 'prepared prompt' }, new AbortController().signal)).resolves.toMatchObject({
      apiKey: 'fixture-key',
      baseUrl: 'https://api.fixture.invalid',
      provider: 'custom',
      permissionMode: 'bypassPermissions',
      systemPrompt: 'prepared prompt',
    })
  })
  test('Given prepared provider policy When provider query preparation runs Then tools and resource policy are preserved', async () => {
    const host = createElectronAgentHost()
    const canUseTool = async () => ({ behavior: 'allow' as const, updatedInput: {} })
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'fixture' }, {
      credentials: { apiKey: 'fixture-key', baseUrl: undefined, provider: 'custom', forceBearerAuth: false },
      systemPrompt: 'prepared prompt',
      tools: [{ name: 'tool' }],
      mcpServers: { fixture: { type: 'stdio', command: 'fixture' } },
      plugins: [{ type: 'local', path: '/plugin' }],
      skills: ['skill-a'],
      allowedTools: ['Read'],
      disallowedTools: ['Write'],
      canUseTool,
    }, new AbortController().signal)).resolves.toMatchObject({
      customTools: [{ name: 'tool' }],
      mcpServers: { fixture: { command: 'fixture' } },
      plugins: [{ type: 'local', path: '/plugin' }],
      skills: ['skill-a'],
      allowedTools: ['Read'],
      disallowedTools: ['Write'],
      canUseTool,
    })
  })
  test('Given prepared Claude policy When provider query preparation runs Then SDK options preserve prompt, MCP, plugins, skills and permissions', async () => {
    const host = createElectronAgentHost()
    const canUseTool = async () => ({ behavior: 'allow' as const, updatedInput: {} })
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'claude', prompt: 'fixture', providerInput: { permissionMode: 'plan' } }, {
      credentials: { apiKey: 'fixture-key', baseUrl: 'https://api.fixture.invalid', provider: 'anthropic', forceBearerAuth: false },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'prepared policy' },
      mcpServers: { fixture: { type: 'http', url: 'https://mcp.invalid' } },
      plugins: [{ type: 'local', path: '/plugin' }],
      skills: ['skill-a'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      canUseTool,
    }, new AbortController().signal)).resolves.toMatchObject({
      sdkPermissionMode: 'plan',
      allowDangerouslySkipPermissions: false,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'prepared policy' },
      mcpServers: { fixture: { url: 'https://mcp.invalid' } },
      plugins: [{ type: 'local', path: '/plugin' }],
      skills: ['skill-a'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      canUseTool,
    })
  })
  test('Given advanced providerInput options When provider query preparation runs Then resume, transport and output settings survive', async () => {
    const host = createElectronAgentHost()
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'fixture', providerInput: {
      permissionMode: 'plan',
      resumeSessionId: 'resume-1',
      transport: 'sse',
      httpIdleTimeoutMs: 1234,
      maxBudgetUsd: 2,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    } }, { credentials: { apiKey: 'fresh-key', baseUrl: 'https://fresh.invalid', provider: 'custom', forceBearerAuth: false }, systemPrompt: 'fresh prompt' }, new AbortController().signal)).resolves.toMatchObject({
      apiKey: 'fresh-key',
      baseUrl: 'https://fresh.invalid',
      permissionMode: 'plan',
      systemPrompt: 'fresh prompt',
      resumeSessionId: 'resume-1',
      transport: 'sse',
      httpIdleTimeoutMs: 1234,
      maxBudgetUsd: 2,
      outputFormat: { type: 'json_schema' },
    })
  })
  test('Given runtime session resume inputs When provider query preparation runs Then Claude and Pi preserve resume targets', async () => {
    const host = createElectronAgentHost()
    const prepared = { credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'custom' as const, forceBearerAuth: false }, systemPrompt: 'prompt' }
    for (const runtime of ['claude', 'pi'] as const) {
      await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime, prompt: 'fixture', runtimeSessionId: 'session-1', providerInput: { resumeSessionAt: 'message-1' } }, prepared, new AbortController().signal)).resolves.toMatchObject({ resumeSessionId: 'session-1', resumeSessionAt: 'message-1' })
    }
  })
  test('Given session lifecycle providerInput When provider query preparation runs Then fork/persist/sdk session options survive and runtime session wins resume', async () => {
    const host = createElectronAgentHost()
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'claude', prompt: 'fixture', runtimeSessionId: 'runtime-session', providerInput: {
      resumeSessionId: 'stale-session',
      sdkSessionId: 'sdk-session',
      forkSession: true,
      persistSession: false,
    } }, { credentials: { apiKey: 'fixture-key', baseUrl: undefined, provider: 'anthropic', forceBearerAuth: false }, systemPrompt: 'prompt' }, new AbortController().signal)).resolves.toMatchObject({
      resumeSessionId: 'runtime-session',
      sdkSessionId: 'sdk-session',
      forkSession: true,
      persistSession: false,
    })
  })
  test('Given reasoning budget and output providerInput When provider query preparation runs Then Claude and Pi preserve advanced model options', async () => {
    const host = createElectronAgentHost()
    const advanced = {
      thinking: { type: 'adaptive' },
      effort: 'high',
      maxBudgetUsd: 3,
      outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    }
    const prepared = { credentials: { apiKey: 'fresh-key', baseUrl: undefined, provider: 'custom' as const, forceBearerAuth: false }, systemPrompt: 'fresh prompt' }
    for (const runtime of ['claude', 'pi'] as const) {
      await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime, prompt: 'fixture', providerInput: advanced }, prepared, new AbortController().signal)).resolves.toMatchObject({
        ...advanced,
        systemPrompt: 'fresh prompt',
      })
    }
  })
  test('Given explicit empty prepared arrays When provider query preparation runs Then disabled tool and skill semantics are preserved', async () => {
    const host = createElectronAgentHost()
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'fixture' }, {
      credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'custom' as const, forceBearerAuth: false },
      systemPrompt: 'prompt',
      tools: [],
      plugins: [],
      skills: [],
      allowedTools: [],
      disallowedTools: [],
    }, new AbortController().signal)).resolves.toMatchObject({
      customTools: [],
      plugins: [],
      skills: [],
      allowedTools: [],
      disallowedTools: [],
    })
  })
  test('Given explicit empty MCP and plugin policy When provider query preparation runs Then empty containers are preserved', async () => {
    const host = createElectronAgentHost()
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'claude', prompt: 'fixture' }, {
      credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'anthropic', forceBearerAuth: false },
      systemPrompt: 'prompt', mcpServers: {}, plugins: [], skills: [],
    }, new AbortController().signal)).resolves.toMatchObject({ mcpServers: {}, plugins: [], skills: [] })
  })
  test('Given no prepared permission callback When provider query preparation runs Then no canUseTool override is injected', async () => {
    const host = createElectronAgentHost()
    await expect(host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'input prompt' }, {
      credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'custom' as const, forceBearerAuth: false },
      resources: { systemPrompt: 'resource prompt' },
    }, new AbortController().signal)).resolves.toMatchObject({ systemPrompt: 'resource prompt' })
    const result = await host.ports.providerQueryPreparation!.prepare({ sessionId: 's', runtime: 'pi', prompt: 'input prompt' }, {
      credentials: { apiKey: 'fixture', baseUrl: undefined, provider: 'custom' as const, forceBearerAuth: false },
    }, new AbortController().signal)
    expect('canUseTool' in result).toBe(false)
    expect(result.systemPrompt).toBe('input prompt')
  })
  test('Given injected permission and file ports When host is composed Then it keeps those ports unchanged', () => {
    const permission = { canUseTool: () => 'allow' as const }
    const files = { read: () => new Uint8Array([1]), write: () => {} }
    const host = createElectronAgentHost({ permission, files })
    expect(host.ports.permissions?.canUseTool?.({ sessionId: 's', toolName: 'Read', input: {} })).toBe('allow')
    expect(host.ports.files).toBe(files)
  })
})

/**
 * B8：产品 MCP 服务器（visualization / agent-preview / agent-image-output / agent-gpt-image /
 * agent-skin / ppt-delivery / clipboard / browser）的宿主接线。
 *
 * 与内置 7 服务器的区别：它们各自需要不同的**宿主资源**，所以宿主用能力表决定提供哪些，
 * 缺能力时逐条记为「能力不可用」（既不静默跳过也不整体失败）。
 */
describe('B8 · 产品 MCP 注入的宿主接线', () => {
  const preset: AgentPreset = { id: 'preset-policy', name: '内置 MCP 预设', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 }
  const enabledPolicy = {
    preset,
    presetReference: { presetId: 'preset-policy', presetScope: 'user-global' as const },
    pptCapabilityActive: true,
  }
  /** 与本文件顶部 mock 的 meta 对齐的会话工作目录。 */
  const sessionCwd = '/tmp/fixture-session-cwd'

  function prepareRun(sessionId: string, patch: Parameters<typeof agentRuntimePolicyRuns.resolveForRun>[1] = enabledPolicy) {
    // 注册表按 runKey 冻结：测试之间必须显式释放，否则会拿到上一条用例缓存的策略。
    agentRuntimePolicyRuns.releaseRun(sessionId)
    agentRuntimePolicyRuns.resolveForRun(sessionId, patch)
    setAgentRuntimeRunFacts(sessionId, { triggeredBy: 'user', userMessage: 'hello' })
  }

  function namesOf(resources: { mcpResources?: readonly unknown[] }): string[] {
    return (resources.mcpResources ?? []).map(entry => (entry as { name?: string }).name ?? '')
  }

  test('Given 完整宿主能力 When 资源加载 Then 外部 MCP → 内置 → 产品 三段顺序与旧链一致', async () => {
    prepareRun('session-1')
    const host = createElectronAgentHost({
      eventBus: { emit() {} } as never,
      productCapabilityDeps: {
        isGptImageAvailable: () => true,
        isPlanModeActive: () => false,
        isRuntimeRunActive: () => true,
      },
    })
    const names = namesOf(await host.resources.load({ sessionId: 'session-1', cwd: sessionCwd }))
    const productNames = names.filter(name => (PRODUCT_MCP_INJECTION_ORDER as readonly string[]).includes(name))
    expect(names[0]).toBe('fixture')
    // 内置：meta 无 agentRuntime ⇒ claude，goal 因无报告回调不注入。
    expect(names.slice(1, 7)).toEqual(['automation', 'memory-archive', 'collaboration', 'task-graph', 'agent-presets', 'planning'])
    // 产品：八条全部按旧链顺序追加在内置之后。
    expect(productNames).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
    expect(names.indexOf('fixture')).toBeLessThan(names.indexOf('automation'))
    expect(names.indexOf('planning')).toBeLessThan(names.indexOf('visualization'))
    clearAgentRuntimeRunFacts('session-1')
    agentRuntimePolicyRuns.releaseRun('session-1')
  })

  test('Given 预设禁用产品工具组 When 资源加载 Then 对应服务器消失，其余不受影响（不放宽门禁）', async () => {
    const disabledPolicy = {
      ...enabledPolicy,
      preset: { ...preset, disabledToolGroups: ['preview', 'image', 'clipboard', 'browser'] satisfies import('@profer/shared').AgentPresetToolGroup[] },
    }
    prepareRun('session-1', disabledPolicy)
    const host = createElectronAgentHost({
      eventBus: { emit() {} } as never,
      productCapabilityDeps: { isGptImageAvailable: () => true, isPlanModeActive: () => false, isRuntimeRunActive: () => true },
    })
    const productNames = namesOf(await host.resources.load({ sessionId: 'session-1', cwd: sessionCwd }))
      .filter(name => (PRODUCT_MCP_INJECTION_ORDER as readonly string[]).includes(name))
    expect(productNames).toEqual(['ppt-delivery'])
    clearAgentRuntimeRunFacts('session-1')
    agentRuntimePolicyRuns.releaseRun('session-1')
  })

  test('Given 宿主不提供任何产品能力 When 资源加载 Then 逐条记为能力不可用，不静默、不整体失败', async () => {
    prepareRun('session-1')
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const resources = await createElectronResourcePort({ productCapabilities: () => ({}) })
        .load({ sessionId: 'session-1', cwd: sessionCwd })
      const productNames = namesOf(resources).filter(name => (PRODUCT_MCP_INJECTION_ORDER as readonly string[]).includes(name))
      // ppt-delivery 不需要宿主资源，因此仍然注入（与旧链一致）；其余七条全部被记录。
      expect(productNames).toEqual(['ppt-delivery'])
      expect(warnings.some(line => line.includes('[Agent 产品 MCP] 能力不可用'))).toBe(true)
      expect(warnings.join('\n')).toContain('"reason":"capability-missing"')
    } finally {
      console.warn = originalWarn
      clearAgentRuntimeRunFacts('session-1')
      agentRuntimePolicyRuns.releaseRun('session-1')
    }
  })

  test('Given 只提供剪贴板能力 When 资源加载 Then 只有 clipboard 注入（能力粒度是逐条的）', async () => {
    prepareRun('session-1')
    const resources = await createElectronResourcePort({
      productCapabilities: () => ({ clipboard: true }),
    }).load({ sessionId: 'session-1', cwd: sessionCwd })
    const productNames = namesOf(resources).filter(name => (PRODUCT_MCP_INJECTION_ORDER as readonly string[]).includes(name))
    expect(productNames).toEqual(['ppt-delivery', 'clipboard'])
    clearAgentRuntimeRunFacts('session-1')
    agentRuntimePolicyRuns.releaseRun('session-1')
  })

  test('Given 没有冻结策略快照 When 资源加载 Then 一个产品服务器都不注入（不猜禁用工具组）', async () => {
    agentRuntimePolicyRuns.releaseRun('session-1')
    const resources = await createElectronAgentHost({
      eventBus: { emit() {} } as never,
      productCapabilityDeps: { isGptImageAvailable: () => true, isPlanModeActive: () => false, isRuntimeRunActive: () => true },
    }).resources.load({ sessionId: 'session-1', cwd: sessionCwd })
    const productNames = namesOf(resources).filter(name => (PRODUCT_MCP_INJECTION_ORDER as readonly string[]).includes(name))
    expect(productNames).toEqual([])
    clearAgentRuntimeRunFacts('session-1')
  })

  test('Given 无工作区 When 资源加载 Then 仍走内置路径但不注入依赖工作区的产品服务器', async () => {
    prepareRun('no-workspace-session')
    const resources = await createElectronResourcePort({
      productCapabilities: createElectronProductMcpCapabilities({
        events: { emit() {} },
        isGptImageAvailable: () => true,
        isPlanModeActive: () => false,
        isRuntimeRunActive: () => true,
      }),
    }).load({ sessionId: 'no-workspace-session' })
    // meta mock 只认 'session-1' ⇒ 无 meta、无 workspaceSlug、无 cwd：只剩不依赖工作区的服务器。
    const productNames = namesOf(resources).filter(name => (PRODUCT_MCP_INJECTION_ORDER as readonly string[]).includes(name))
    expect(productNames).toEqual(['ppt-delivery', 'clipboard', 'browser'])
    clearAgentRuntimeRunFacts('no-workspace-session')
    agentRuntimePolicyRuns.releaseRun('no-workspace-session')
  })

  test('Given runtime 为 pi When 资源加载 Then 只有 image-output 与 ppt-delivery（旧链同样没有 claude 门禁）', async () => {
    prepareRun('pi-session')
    const resources = await createElectronResourcePort({
      productCapabilities: createElectronProductMcpCapabilities({
        events: { emit() {} },
        isGptImageAvailable: () => true,
        isPlanModeActive: () => false,
        isRuntimeRunActive: () => true,
      }),
    }).load({ sessionId: 'pi-session', cwd: sessionCwd })
    const productNames = namesOf(resources).filter(name => (PRODUCT_MCP_INJECTION_ORDER as readonly string[]).includes(name))
    expect(productNames).toEqual(['agent-image-output', 'ppt-delivery'])
    clearAgentRuntimeRunFacts('pi-session')
    agentRuntimePolicyRuns.releaseRun('pi-session')
  })

  test('Given 运行级附加目录与权限覆盖 When 构造 runtime query Then 写入宿主 per-run 注册表并进入产品授权根', async () => {
    const query = createElectronAgentRuntimeQuery({
      sessionId: 'facts-session',
      userMessage: 'visible',
      channelId: 'channel-1',
      additionalDirectories: ['/tmp/extra-dir'],
      permissionModeOverride: 'plan',
    }, { runtime: 'pi' })
    expect(query.additionalDirectories).toEqual(['/tmp/extra-dir'])
    expect(getAgentRuntimeRunFacts('facts-session')).toEqual({
      additionalDirectories: ['/tmp/extra-dir'],
      permissionModeOverride: 'plan',
    })
    // 入口先写 triggeredBy/userMessage，query 构造只做合并（不覆盖入口事实）。
    setAgentRuntimeRunFacts('merge-session', { triggeredBy: 'automation', userMessage: 'scheduled' })
    createElectronAgentRuntimeQuery({ sessionId: 'merge-session', userMessage: 'scheduled', channelId: 'channel-1' }, { runtime: 'claude' })
    expect(getAgentRuntimeRunFacts('merge-session')).toEqual({ triggeredBy: 'automation', userMessage: 'scheduled' })

    // 能力提供器收到的输入包含运行级附加目录（授权根采集的输入，不是第二份判定）。
    let captured: { additionalDirectories?: readonly string[] } | undefined
    await createElectronResourcePort({
      productCapabilities: (input) => { captured = input; return {} },
    }).load({ sessionId: 'facts-session', cwd: sessionCwd })
    expect(captured?.additionalDirectories).toEqual(['/tmp/extra-dir'])

    clearAgentRuntimeRunFacts('facts-session')
    clearAgentRuntimeRunFacts('merge-session')
  })

  test('Given host event port When runtime_started / runtime_finished 到达 Then 运行态表同步更新', () => {
    const port = createElectronEventPort({ emit() {} } as never)
    expect(isRuntimeRunActive('run-activity')).toBe(false)
    port.emit({ type: 'runtime_started', sessionId: 'run-activity', runtime: 'claude', startedAt: 1 })
    expect(isRuntimeRunActive('run-activity')).toBe(true)
    port.emit({ type: 'runtime_finished', sessionId: 'run-activity', outcome: { status: 'completed' }, finishedAt: 2 })
    expect(isRuntimeRunActive('run-activity')).toBe(false)
  })

  test('Given runtime_claimed When 到达 Then 只标记运行态快照，不广播 external_run_started', () => {
    // claim 不等于 provider 已启动：准备阶段（凭证 / 资源 / 工具装配）可能失败，
    // 渲染层不得在准备期间就被置为「运行已开始」。
    const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    const port = createElectronEventPort({ emit: (sessionId: string, payload: AgentStreamPayload) => events.push({ sessionId, payload }) } as never)
    const claimedAt = 987
    port.emit({ type: 'runtime_claimed', sessionId: 'claim-session', runtime: 'pi', startedAt: claimedAt, title: 'Claimed' })
    expect(isRuntimeRunActive('claim-session')).toBe(true)
    expect(events).toEqual([])

    // 准备失败也必须有终态，且只投递一次。
    port.emit({ type: 'runtime_finished', sessionId: 'claim-session', outcome: { status: 'failed', error: 'Credential resolution failed: token_expired' }, finishedAt: claimedAt + 1, title: 'Claimed' })
    expect(isRuntimeRunActive('claim-session')).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      kind: 'profer_event',
      event: { type: 'run_completed', sessionId: 'claim-session', stoppedByUser: false, endReason: 'error' },
    })

    // 成功路径：runtime_started 才广播 external_run_started，并复用 claim 时的 startedAt。
    const startedEvents: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    const startedPort = createElectronEventPort({ emit: (sessionId: string, payload: AgentStreamPayload) => startedEvents.push({ sessionId, payload }) } as never)
    startedPort.emit({ type: 'runtime_claimed', sessionId: 'claim-session-2', runtime: 'pi', startedAt: claimedAt })
    startedPort.emit({ type: 'runtime_started', sessionId: 'claim-session-2', runtime: 'pi', startedAt: claimedAt, title: 'Claimed' })
    startedPort.emit({ type: 'runtime_finished', sessionId: 'claim-session-2', outcome: { status: 'completed' }, finishedAt: claimedAt + 2, title: 'Claimed' })
    expect(startedEvents.map(entry => (entry.payload as { kind: string }).kind)).toEqual(['profer_event', 'profer_event'])
    expect(startedEvents[0]?.payload).toMatchObject({ kind: 'profer_event', event: { type: 'external_run_started', sessionId: 'claim-session-2', startedAt: claimedAt } })
    expect(startedEvents[1]?.payload).toMatchObject({ kind: 'profer_event', event: { type: 'run_completed', sessionId: 'claim-session-2', stoppedByUser: false, startedAt: claimedAt } })
  })

  test('Given 可视化能力 When 公布门禁求值 Then 已取消 / 计划模式分别给出旧链同一句错误', async () => {
    const make = (runActive: boolean, planMode: boolean) => createElectronProductMcpCapabilities({
      events: { emit() {} },
      isRuntimeRunActive: () => runActive,
      isPlanModeActive: () => planMode,
    })
    const cancelled = await make(false, false)({ sessionId: 'guard-session', workspaceSlug: 'fixture-workspace', cwd: sessionCwd })
    expect(cancelled.visualization).toBeDefined()
    expect(() => cancelled.visualization!.assertCanPresent()).toThrow('本轮已取消，不能公布可视化')
    const planMode = await make(true, true)({ sessionId: 'guard-session', workspaceSlug: 'fixture-workspace', cwd: sessionCwd })
    expect(() => planMode.visualization!.assertCanPresent()).toThrow('计划模式不能公布可视化；请先完成计划审批')
    const allowed = await make(true, false)({ sessionId: 'guard-session', workspaceSlug: 'fixture-workspace', cwd: sessionCwd })
    expect(() => allowed.visualization!.assertCanPresent()).not.toThrow()
  })

  test('Given 无事件出口或非 Electron 宿主 When 求能力 Then 相关能力整体缺失（不是空实现）', async () => {
    const noEvents = await createElectronProductMcpCapabilities({ isPlanModeActive: () => false })({
      sessionId: 'caps-session',
      workspaceSlug: 'fixture-workspace',
      cwd: sessionCwd,
    })
    expect(noEvents.visualization).toBeUndefined()
    expect(noEvents['file-preview']).toBeUndefined()
    expect(noEvents['ai-image-generation']).toBeUndefined()
    // 图片根只依赖目录事实，因此仍然提供（宿主能读文件系统就够用）；
    // 除旧链根列表外还带上会话存储根（project 下生图产物/记录的落点）。
    const imageRoots = noEvents['image-output-roots']!
    expect(imageRoots.allowedRoots).toContain(sessionCwd)
    expect(imageRoots.allowedRoots).toContain('/tmp/fixture-workspace/caps-session')
    expect(imageRoots.storageDir).toBe('/tmp/fixture-workspace/caps-session')
    expect(noEvents.clipboard).toBe(true)
    expect(noEvents.browser).toBeDefined()
  })

  test('Given 本轮冻结权限为 plan When 内置 collaboration 注入 Then 继承冻结快照而不重算权限', async () => {
    prepareRun('collab-session', { ...enabledPolicy, permissionModeOverride: 'plan' })
    // 入口顺序：先由 createRuntimeEntryQuery 写基本事实，再由 query 构造补运行级事实。
    createElectronAgentRuntimeQuery({
      sessionId: 'collab-session',
      userMessage: 'delegate',
      channelId: 'channel-1',
      permissionModeOverride: 'plan',
    }, { runtime: 'claude' })

    const captured: Array<{ serverId: string; args: readonly unknown[] }> = []
    const injectors = Object.fromEntries(BUILTIN_MCP_INJECTION_ORDER.map(id => [
      id,
      async (_sdk: unknown, table: Record<string, Record<string, unknown>>, ...args: readonly unknown[]) => {
        captured.push({ serverId: id, args })
        table[id] = { fixture: true }
      },
    ]))
    const port = createElectronBuiltinMcpInjectionPort({
      injectors: injectors as never,
      resolveMemoryArchivePath: async () => '/tmp/fixture-memory-archive',
    })
    await loadBuiltinMcpResources('collab-session', { ...meta, id: 'collab-session' }, 'fixture-workspace', port)

    const collaboration = captured.find(call => call.serverId === 'collaboration')
    expect((collaboration?.args[0] as { permissionMode?: string } | undefined)?.permissionMode).toBe('plan')
    // 其他来源字段仍保持本轮原有事实。
    const automation = captured.find(call => call.serverId === 'automation')
    expect((automation?.args[0] as { triggeredBy?: string } | undefined)?.triggeredBy).toBe('user')
    clearAgentRuntimeRunFacts('collab-session')
    agentRuntimePolicyRuns.releaseRun('collab-session')
  })

  test('Given 产品注入端口默认实现 When 注入真实服务器 Then 注入顺序与键名与旧链一致', async () => {
    prepareRun('session-1')
    const port = createElectronProductMcpInjectionPort()
    const mcpServers: Record<string, Record<string, unknown>> = {}
    const context = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspaceSlug: 'fixture-workspace',
      agentCwd: sessionCwd,
      triggeredBy: 'user' as const,
    }
    const { runProductMcpInjection, productMcpPlanInputFromContext } = await import('./agent-runtime-product-mcp-injection')
    const outcome = await runProductMcpInjection(port, {
      context,
      mcpServers,
      sdk: (await import('@anthropic-ai/claude-agent-sdk')) as never,
      planInput: productMcpPlanInputFromContext(context, 'claude', 'standard', [], true),
      capabilities: {
        visualization: { storageDir: '/tmp/visualizations', allowedRoots: [sessionCwd], onUpdate: () => {}, assertCanPresent: () => {} },
        'file-preview': { allowedRoots: [sessionCwd], open: async () => ({}) as never, inspect: async () => ({}) as never },
        'image-output-roots': { allowedRoots: [sessionCwd] },
        'ai-image-generation': { isGptImageAvailable: () => true, onGenerationUpdate: () => {} },
        clipboard: true,
        browser: { allowedRoots: [sessionCwd] },
      },
    })
    expect(outcome.injected).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
    expect(Object.keys(mcpServers)).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
    clearAgentRuntimeRunFacts('session-1')
    agentRuntimePolicyRuns.releaseRun('session-1')
  })

  test('Given loadProductMcpResources When 无快照 Then 不注入（保守默认，不猜禁用工具组）', async () => {
    agentRuntimePolicyRuns.releaseRun('session-1')
    const resources = await loadProductMcpResources('session-1', meta, sessionCwd, 'fixture-workspace', {
      clipboard: true,
    })
    expect(resources).toEqual([])
  })
})

describe('trusted runtime Run context', () => {
  test('query 构造真实来源但不预造 Run ID，准入回写后资源可见同一 ID', async () => {
    const input = createElectronAgentRuntimeQuery({
      sessionId: 'trusted-query', userMessage: 'scheduled work', channelId: 'channel-1', uuid: 'trusted-message',
      taskId: 'task', triggerId: 'schedule-trigger', triggeredBy: 'automation',
      taskOrigin: { actor: { type: 'automation', id: 'schedule' }, source: { type: 'automation', id: 'schedule' } },
      taskAuthorization: { kind: 'scheduled' }, messageAuthor: { type: 'user' },
    }, { runtime: 'pi', toolAssemblyContext: { sessionId: 'trusted-query' } })
    expect(input.runId).toBeUndefined()
    expect(input.context).toMatchObject({ taskId: 'task', messageAuthor: { type: 'user' }, trigger: { id: 'schedule-trigger', actor: { type: 'automation', id: 'schedule' }, authorization: { kind: 'scheduled' } } })
    expect(getAgentRuntimeRunFacts('trusted-query')?.sourceRunId).toBeUndefined()
    await input.onRunAdmitted?.({ ...input, runId: 'real-run' })
    expect(getAgentRuntimeRunFacts('trusted-query')).toMatchObject({ sourceRunId: 'real-run' })
    clearAgentRuntimeRunFacts('trusted-query')
  })
})

describe('真实权限请求的运行生命周期', () => {
  test('只读自动放行不写 waiting，真实审批请求与完成才通知等待和恢复', async () => {
    const { permissionService } = await import('./agent-permission-service')
    const transitions: string[] = []
    const { AgentEventBus } = await import('./agent-event-bus')
    const host = createElectronAgentHost({ eventBus: new AgentEventBus() })
    const prepared = await host.ports.queryPreparation!.prepare({
      sessionId: 'permission-lifecycle', runtime: 'pi', prompt: 'fixture', prepared: { resources: {} },
      runLifecycle: { wait: id => { transitions.push(`wait:${id}`) }, resume: id => { transitions.push(`resume:${id}`) } },
    }, new AbortController().signal)
    await prepared.canUseTool!('Read', { file_path: '/tmp/read' }, { signal: new AbortController().signal })
    expect(transitions).toEqual([])
    const pending = prepared.canUseTool!('Write', { file_path: '/tmp/write', content: 'fixture' }, { signal: new AbortController().signal })
    await Promise.resolve()
    const request = permissionService.getPendingRequests().find(item => item.sessionId === 'permission-lifecycle')!
    expect(request).toBeDefined()
    expect(transitions).toEqual([`wait:${request.requestId}`])
    permissionService.respondToPermission(request.requestId, 'allow', false)
    await pending
    expect(transitions).toEqual([`wait:${request.requestId}`, `resume:${request.requestId}`])
  })
})
