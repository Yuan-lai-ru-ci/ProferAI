import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// memory-archive 使用 node:sqlite，Pi bridge 测试只验证注册契约，避免 Bun 测试运行器加载原生 Node 模块。
mock.module('../memory-archive-search', () => ({
  createMemoryArchiveSearcher: () => ({
    search: (query: string, topK: number) => [{ relativePath: 'memory.md', content: `hit:${query}`, startIndex: 0, endIndex: query.length, score: 0, matchedTokens: [query] }].slice(0, topK),
  }),
}))

// 内置工具桥接经会话/工作区服务间接导入 Electron；Bun 单测需提供最小主进程 mock。
let imageToolAvailable = false
let webSearchToolAvailable = false
let generatedImageResult: unknown = undefined

mock.module('../chat-tool-config', () => ({
  getToolState: (toolId: string) => ({ enabled: toolId === 'web-search' ? webSearchToolAvailable : imageToolAvailable }),
  getToolCredentials: (toolId: string) => toolId === 'web-search' && webSearchToolAvailable ? { apiKey: 'test-tavily-key' } : {},
  getGptImageCredentials: () => ({ provider: 'openai', mode: 'official', apiKey: '', baseUrl: '', model: '' }),
}))
mock.module('../auth-service', () => ({
  getTeamAuth: () => ({ token: 'test' }), getTeamAuthWithRefresh: async () => undefined,
  refreshAuthToken: async () => false, getAccessToken: () => null, getAuthStatus: () => ({ isLoggedIn: false }), recoverCommercialProxyAuth: async () => null,
}))
mock.module('../chat-tools/gpt-image-tool', () => ({ isGptImageAvailable: () => imageToolAvailable }))
mock.module('../agent-gpt-image-service', () => ({
  generateAgentGptImage: async () => generatedImageResult,
}))

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

const {
  buildPiBuiltinTools,
  buildPiMemoryArchiveTools,
  buildPiPlanningTools,
  buildPiTaskGraphTools,
  buildPiAgentPresetTools,
} = await import('./pi-builtin-tools')

interface CapturedTool {
  name: string
  description: string
  parameters?: unknown
  execute?: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>
}

function createPiSdkStub(): {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  tools: CapturedTool[]
} {
  const tools: CapturedTool[] = []
  const sdk = {
    defineTool(tool: CapturedTool): CapturedTool {
      tools.push(tool)
      return tool
    },
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
  return { sdk, tools }
}

describe('Pi Profer in-process tool bridges', () => {
  test('Given no explicit preset mutation intent When building Pi preset tools Then only preset_list is exposed', () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiAgentPresetTools(sdk, {
      sessionId: 'pi-preset-test',
      workspaceSlug: 'pi-test-ws',
      triggeredBy: 'user',
      allowedPresetOperations: [],
    })
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__agent-presets__preset_list'])
  })

  test('Given explicit create or copy intent When building Pi preset tools Then only that operation is exposed', () => {
    const create = createPiSdkStub()
    buildPiAgentPresetTools(create.sdk, {
      sessionId: 'pi-preset-test',
      workspaceSlug: 'pi-test-ws',
      triggeredBy: 'user',
      allowedPresetOperations: ['create'],
    })
    expect(create.tools.map((tool) => tool.name)).toEqual([
      'mcp__agent-presets__preset_list',
      'mcp__agent-presets__preset_create',
    ])

    const copy = createPiSdkStub()
    buildPiAgentPresetTools(copy.sdk, {
      sessionId: 'pi-preset-test',
      workspaceSlug: 'pi-test-ws',
      triggeredBy: 'user',
      allowedPresetOperations: ['copy'],
    })
    expect(copy.tools.map((tool) => tool.name)).toEqual([
      'mcp__agent-presets__preset_list',
      'mcp__agent-presets__preset_copy',
    ])
  })

  test('Given explicit switch intent and frozen reference When building Pi tools Then switch is exposed', () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiAgentPresetTools(sdk, {
      sessionId: 'pi-preset-switch',
      workspaceSlug: 'pi-test-ws',
      triggeredBy: 'user',
      allowedPresetOperations: ['switch'],
      currentPresetReference: { presetId: 'minimal', presetScope: 'builtin-meta' },
      presetOperationUserMessage: '切换到标准预设',
    })
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__agent-presets__preset_list',
      'mcp__agent-presets__preset_switch_session',
    ])
  })

  test('Given explicit update or default intent When building Pi preset tools Then only the matching proposal tool is exposed', () => {
    const update = createPiSdkStub()
    buildPiAgentPresetTools(update.sdk, {
      sessionId: 'pi-preset-update', workspaceSlug: 'pi-test-ws', triggeredBy: 'user',
      allowedPresetOperations: ['propose_update'], presetOperationUserMessage: '请修改研究预设',
    })
    expect(update.tools.map((tool) => tool.name)).toEqual([
      'mcp__agent-presets__preset_list', 'mcp__agent-presets__preset_propose_update',
    ])

    const defaultChange = createPiSdkStub()
    buildPiAgentPresetTools(defaultChange.sdk, {
      sessionId: 'pi-preset-default', workspaceSlug: 'pi-test-ws', triggeredBy: 'user',
      allowedPresetOperations: ['propose_default'], presetOperationUserMessage: '把研究预设设为默认',
    })
    expect(defaultChange.tools.map((tool) => tool.name)).toEqual([
      'mcp__agent-presets__preset_list', 'mcp__agent-presets__preset_request_default_change',
    ])
  })

  test('Given a pending proposal and confirmation When building Pi preset tools Then only commit is exposed', () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiAgentPresetTools(sdk, {
      sessionId: 'pi-preset-commit', workspaceSlug: 'pi-test-ws', triggeredBy: 'user',
      allowedPresetOperations: ['commit_change'], presetOperationUserMessage: '确认',
      pendingPresetChange: {
        proposalId: 'proposal-1', kind: 'default', sessionId: 'pi-preset-commit', workspaceSlug: 'pi-test-ws',
        target: { presetId: 'standard', presetScope: 'builtin-meta' },
        currentDefault: { presetId: 'minimal', presetScope: 'builtin-meta' },
        proposalAuditEventId: 'audit-1', createdAt: Date.now(),
      },
    })
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__agent-presets__preset_list', 'mcp__agent-presets__preset_commit_change',
    ])
  })

  test('Given automation, delegation, or no workspace When building Pi preset tools Then mutation tools stay absent', () => {
    for (const context of [
      { sessionId: 'auto', workspaceSlug: 'pi-test-ws', triggeredBy: 'automation' as const, allowedPresetOperations: ['create', 'copy'] as const },
      { sessionId: 'child', workspaceSlug: 'pi-test-ws', triggeredBy: 'delegation' as const, allowedPresetOperations: ['create', 'copy'] as const },
      { sessionId: 'no-workspace', triggeredBy: 'user' as const, allowedPresetOperations: ['create', 'copy'] as const },
    ]) {
      const { sdk, tools } = createPiSdkStub()
      buildPiAgentPresetTools(sdk, context)
      expect(tools.map((tool) => tool.name)).toEqual(['mcp__agent-presets__preset_list'])
    }
  })

  test('Given any allowed intent When building Pi preset tools Then unconfirmed high-risk mutation tools are absent', () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiAgentPresetTools(sdk, {
      sessionId: 'pi-preset-test',
      workspaceSlug: 'pi-test-ws',
      triggeredBy: 'user',
      allowedPresetOperations: ['create', 'copy', 'switch'],
      currentPresetReference: { presetId: 'minimal', presetScope: 'builtin-meta' },
      presetOperationUserMessage: '切换到标准预设',
    })
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain('mcp__agent-presets__preset_update')
    expect(names).not.toContain('mcp__agent-presets__preset_delete')
    expect(names).not.toContain('mcp__agent-presets__preset_set_default')
    expect(names).toContain('mcp__agent-presets__preset_switch_session')
  })

  test('Given orchestrator-approved create intent When building all Pi builtin tools Then create reaches the final tool set', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, {
      sessionId: 'pi-preset-integration',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      workspaceSlug: 'pi-test-ws',
      triggeredBy: 'user',
      allowedPresetOperations: ['create'],
    })
    expect(tools.map((tool) => tool.name)).toContain('mcp__agent-presets__preset_create')
    expect(tools.map((tool) => tool.name)).not.toContain('mcp__agent-presets__preset_copy')
  })

  test('Given Pi runtime When building memory tools without a workspace Then it does not expose personal memory search', () => {
    const { sdk, tools } = createPiSdkStub()

    buildPiMemoryArchiveTools(sdk, {})

    expect(tools).toEqual([])
  })

  test('Given Pi runtime When building memory tools with a workspace Then it exposes read-only archive search', async () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiMemoryArchiveTools(sdk, { workspaceSlug: 'profer' })
    expect(tools.map((tool) => tool.name)).toContain('mcp__memory-archive__search_memory')
    const search = tools.find((tool) => tool.name === 'mcp__memory-archive__search_memory')
    const result = await search?.execute?.('call-1', { query: 'Pi', topK: 1 }) as { details?: { hits?: Array<{ file: string; content: string }> } }
    expect(result.details?.hits?.[0]).toMatchObject({ file: 'memory.md', content: 'hit:Pi' })
  })

  test('Given Pi runtime When building planning tools Then it exposes Todo and local calendar tools', () => {
    const { sdk, tools } = createPiSdkStub()

    buildPiPlanningTools(sdk, { sessionId: 'pi-planning-test' })

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__planning__list_todos',
      'mcp__planning__get_todo',
      'mcp__planning__create_todo',
      'mcp__planning__update_todo',
      'mcp__planning__list_calendar_events',
      'mcp__planning__get_calendar_event',
      'mcp__planning__create_calendar_event',
      'mcp__planning__update_calendar_event',
      'mcp__planning__delete_calendar_event',
    ])
  })

  test('Given Pi runtime When building task graph tools Then it exposes Profer structured task tools', () => {
    const { sdk, tools } = createPiSdkStub()

    buildPiTaskGraphTools(sdk, { sessionId: 'pi-task-graph-test' })

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__task-graph__proma_task_create',
      'mcp__task-graph__proma_task_update',
    ])
  })

  test('Given an unknown task ID When Pi requests an update Then it rejects without creating a graph node', async () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiTaskGraphTools(sdk, { sessionId: 'pi-task-graph-unknown-task' })
    const update = tools.find((tool) => tool.name === 'mcp__task-graph__proma_task_update')

    const result = await update?.execute?.('call-1', { taskId: 'not-created', status: 'completed' }) as { details?: { error?: string } }

    expect(result.details?.error).toBe('TASK_NOT_FOUND')
  })
})

describe('Pi builtin tools disabledToolGroups pruning (preset capability pruning)', () => {
  beforeEach(() => {
    webSearchToolAvailable = true
  })

  afterEach(() => {
    imageToolAvailable = false
    webSearchToolAvailable = false
    generatedImageResult = undefined
  })
  /** 工具组 → 工具名前缀映射（与 buildPiBuiltinTools 中的注册前缀一致） */
  const GROUP_PREFIXES = {
    memory: 'mcp__memory-archive__',
    'task-graph': 'mcp__task-graph__',
    automation: 'mcp__automation__',
    collaboration: 'mcp__collaboration__',
  } as const
  type Group = keyof typeof GROUP_PREFIXES

  const baseCtx = {
    sessionId: 'prune-test',
    channelId: 'ch-1',
    workspaceId: 'ws-1',
    workspaceSlug: 'prune-ws',
    // 可视化记录存储根与工作区分离（配置目录）；缺失时可视化工具不注册。
    visualizationStorageDir: 'C:/safe/agent-visualizations/prune-test',
    triggeredBy: 'user' as const,
  }

  test('Given a workspace-backed Pi session When building builtin tools Then it exposes local image output and inspect_preview', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'] })

    expect(tools.find((tool) => tool.name === 'present_visualization')).toBeDefined()
    expect(tools.find((tool) => tool.name === 'inspect_visualization')).toBeDefined()
    expect(tools.find((tool) => tool.name === 'present_visualization')!.description).toContain('stateUpdated')
    expect(JSON.stringify(tools.find((tool) => tool.name === 'present_visualization')!.parameters)).toContain('baseRevision')
    const imageTool = tools.find((tool) => tool.name === 'send_local_image')
    const previewTool = tools.find((tool) => tool.name === 'inspect_preview')
    const openPreviewTool = tools.find((tool) => tool.name === 'open_file_preview')
    const inspectOfficialPreviewTool = tools.find((tool) => tool.name === 'inspect_file_preview')
    expect(imageTool).toBeDefined()
    expect(tools.find((tool) => tool.name === 'create_skin')).toBeDefined()
    expect(imageTool!.description).not.toContain('IMAGE_ATTACHMENT')
    expect(previewTool).toBeDefined()
    expect(JSON.stringify(previewTool!.parameters)).toContain('previousRevision')
    expect(openPreviewTool).toBeDefined()
    expect(openPreviewTool!.description).toContain('official current-session file preview')
    expect(inspectOfficialPreviewTool).toBeDefined()
    expect(inspectOfficialPreviewTool!.description).toContain('same ready viewer')
  })

  test('Given GPT Image enabled and available in a workspace Pi session When building tools Then it exposes the unified generate_image schema and structured image result', async () => {
    imageToolAvailable = true
    generatedImageResult = {
      ok: true,
      mode: 'official',
      edited: false,
      output: { image: { localPath: 'C:/safe/session/.context/agent-output-images/x.png', relativePath: '.context/agent-output-images/x.png', filename: 'x.png', mediaType: 'image/png' } },
    }
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'] })

    const tool = tools.find((item) => item.name === 'generate_image')
    expect(tool).toBeDefined()
    expect(tool!.description).toContain('referenceImagePaths')
    expect(tool!.description).toContain('useLastGeneratedImage')
    expect(JSON.stringify(tool!.parameters)).toContain('useLastGeneratedImage')
    expect(JSON.stringify(tool!.parameters)).toContain('1024x1024')
    const result = await tool!.execute!('pi-call-1', { prompt: 'blue square' }) as { content: Array<{ text: string }>; details?: { image?: { filename?: string } } }
    expect(result.content[0]!.text).not.toContain('IMAGE_ATTACHMENT')
    expect(result.details).toMatchObject({ image: { filename: 'x.png' } })
  })

  test('Given GPT Image disabled or no workspace When building Pi tools Then generate_image is absent', async () => {
    const disabled = createPiSdkStub()
    await buildPiBuiltinTools(disabled.sdk, { ...baseCtx, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'] })
    expect(disabled.tools.some((tool) => tool.name === 'generate_image')).toBe(false)

    imageToolAvailable = true
    const noWorkspace = createPiSdkStub()
    await buildPiBuiltinTools(noWorkspace.sdk, { ...baseCtx, workspaceSlug: undefined, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'] })
    expect(noWorkspace.tools.some((tool) => tool.name === 'generate_image')).toBe(false)
  })

  test('Given a Pi session without a workspace When building builtin tools Then it keeps inspect_preview but does not authorize home image output', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, workspaceSlug: undefined, agentCwd: 'C:/Users/test', allowedRoots: [] })

    expect(tools.some((tool) => tool.name === 'present_visualization')).toBe(false)
    expect(tools.some((tool) => tool.name === 'inspect_visualization')).toBe(false)
    expect(tools.some((tool) => tool.name === 'send_local_image')).toBe(false)
    expect(tools.some((tool) => tool.name === 'inspect_preview')).toBe(true)
  })

  test('Given PPT capability inactive Then PPT-specific tools are not registered', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, {
      ...baseCtx,
      pptCapabilityActive: false,
    })
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain('plan_ppt_visuals')
    expect(names).not.toContain('audit_ppt_delivery')
  })

  test('Given PPT capability active Then PPT-specific tools are registered', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, {
      ...baseCtx,
      agentCwd: 'C:/safe/session',
      allowedRoots: ['C:/safe/attached'],
      pptCapabilityActive: true,
    })
    const names = tools.map((tool) => tool.name)
    for (const expected of ['plan_ppt_visuals', 'audit_ppt_delivery']) {
      expect(names).toContain(expected)
    }
    for (const forbidden of ['inspect_deck_sources', 'create_deck_project', 'confirm_deck_brief', 'compile_deck_project']) {
      expect(names).not.toContain(forbidden)
    }
  })

  test('Given PPT capability active but ppt-materials disabled Then PPT-specific tools are absent', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, {
      ...baseCtx,
      agentCwd: 'C:/safe/session',
      allowedRoots: ['C:/safe/attached'],
      pptCapabilityActive: true,
      disabledToolGroups: ['ppt-materials'],
    })
    expect(tools.some((tool) => tool.name === 'plan_ppt_visuals')).toBe(false)
    expect(tools.some((tool) => tool.name === 'audit_ppt_delivery')).toBe(false)
  })

  test('Given no disabled groups Then all four groups are registered', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, baseCtx)
    for (const [group, prefix] of Object.entries(GROUP_PREFIXES)) {
      expect(tools.some((t) => t.name.startsWith(prefix)), `group ${group} (${prefix}) should be registered`).toBe(true)
    }
  })

  test('Given each new capability group disabled Then only its registered tools are pruned', async () => {
    const cases = [
      { group: 'browser', names: ['BrowserObserve', 'BrowserNavigate'] },
      { group: 'clipboard', names: ['clipboard_read_text', 'clipboard_write_text'] },
      { group: 'preview', names: ['inspect_preview', 'open_file_preview', 'inspect_file_preview', 'present_visualization', 'inspect_visualization'] },
      { group: 'image', names: ['send_local_image', 'generate_image', 'create_skin'] },
      { group: 'web', names: ['WebSearch', 'WebFetch'] },
    ] as const
    for (const { group, names: disabledNames } of cases) {
      const { sdk, tools } = createPiSdkStub()
      await buildPiBuiltinTools(sdk, { ...baseCtx, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'], disabledToolGroups: [group] })
      const registered = new Set(tools.map((tool) => tool.name))
      for (const name of disabledNames) expect(registered.has(name), `${group}/${name} should be disabled`).toBe(false)
      expect(registered.has('mcp__agent-presets__preset_list')).toBe(true)
    }
  })

  test('Given automation disabled Then planning Todo and calendar tools are also pruned', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, disabledToolGroups: ['automation'] })
    expect(tools.some((tool) => tool.name.startsWith('mcp__automation__'))).toBe(false)
    expect(tools.some((tool) => tool.name.startsWith('mcp__planning__'))).toBe(false)
  })

  test('Given each group disabled individually Then only that group is pruned', async () => {
    for (const group of Object.keys(GROUP_PREFIXES) as Group[]) {
      const { sdk, tools } = createPiSdkStub()
      await buildPiBuiltinTools(sdk, { ...baseCtx, disabledToolGroups: [group] })
      for (const [other, prefix] of Object.entries(GROUP_PREFIXES)) {
        const expected = other !== group
        expect(
          tools.some((t) => t.name.startsWith(prefix)),
          `group ${other} registered=${expected} when disabling ${group}`,
        ).toBe(expected)
      }
    }
  })

  test('Given all four groups disabled Then only preset list survives without explicit mutation intent', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, disabledToolGroups: ['task-graph', 'memory', 'collaboration', 'automation'] })
    for (const [group, prefix] of Object.entries(GROUP_PREFIXES)) {
      expect(tools.some((t) => t.name.startsWith(prefix)), `group ${group} should be pruned`).toBe(false)
    }
    // 预设工具永不裁剪：极简会话必须能切回其他预设
    expect(tools.some((t) => t.name.startsWith('mcp__agent-presets__'))).toBe(true)
  })

  test('Given code-mode non-development groups disabled When building Pi tools Then research and image presentation remain available', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, {
      ...baseCtx,
      agentCwd: 'C:/safe/session',
      allowedRoots: ['C:/safe/attached'],
      pptCapabilityActive: true,
      disabledToolGroups: ['automation', 'browser', 'clipboard', 'ppt-materials'],
      disabledTools: ['generate_image'],
    })
    const names = new Set(tools.map((tool) => tool.name))
    for (const forbidden of [
      'mcp__automation__create_automation',
      'mcp__planning__create_todo',
      'BrowserObserve',
      'clipboard_read_text',
      'generate_image',
      'plan_ppt_visuals',
    ]) {
      expect(names.has(forbidden), `${forbidden} should be pruned in code mode`).toBe(false)
    }
    for (const engineeringTool of [
      'mcp__task-graph__proma_task_create',
      'mcp__memory-archive__search_memory',
      'mcp__collaboration__delegate_agent',
      'inspect_preview',
      'WebSearch',
      'WebFetch',
      'send_local_image',
    ]) {
      expect(names.has(engineeringTool), `${engineeringTool} should remain in code mode`).toBe(true)
    }
  })

  test('Given all ten product groups disabled When building Pi builtin tools Then only core and preset tools remain', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, {
      ...baseCtx,
      agentCwd: 'C:/safe/session',
      allowedRoots: ['C:/safe/attached'],
      pptCapabilityActive: true,
      disabledToolGroups: ['task-graph', 'memory', 'collaboration', 'automation', 'browser', 'clipboard', 'preview', 'image', 'web', 'ppt-materials'],
    })
    const names = new Set(tools.map((tool) => tool.name))
    for (const forbidden of [
      'mcp__task-graph__proma_task_create',
      'mcp__memory-archive__search_memory',
      'mcp__collaboration__delegate_agent',
      'mcp__automation__create_automation',
      'mcp__planning__create_todo',
      'BrowserObserve',
      'clipboard_read_text',
      'inspect_preview',
      'open_file_preview',
      'inspect_file_preview',
      'send_local_image',
      'generate_image',
      'WebSearch',
      'WebFetch',
      'plan_ppt_visuals',
      'audit_ppt_delivery',
    ]) {
      expect(names.has(forbidden), `${forbidden} should be pruned in minimal mode`).toBe(false)
    }
    // 预设工具不属于普通裁剪组：用户必须能够切换到其它预设。
    expect(names.has('mcp__agent-presets__preset_list')).toBe(true)
  })

  test('Given disabledTools 单工具短名 When building Pi builtin tools Then 只过滤列出的工具且同组其余工具保留', async () => {
    const { sdk } = createPiSdkStub()
    const result = await buildPiBuiltinTools(sdk, {
      ...baseCtx,
      disabledTools: ['proma_task_create', 'delegate_agent'],
    })
    const names = result.tools.map((t) => t.name)
    expect(names).not.toContain('mcp__task-graph__proma_task_create')
    expect(names).toContain('mcp__task-graph__proma_task_update')
    expect(names).not.toContain('mcp__collaboration__delegate_agent')
    expect(names).toContain('mcp__collaboration__delegate_agents')
  })

  test('Given disabledTools 与 disabledToolGroups 叠加 When building Pi builtin tools Then 组裁剪优先于单工具清单', async () => {
    const { sdk } = createPiSdkStub()
    const result = await buildPiBuiltinTools(sdk, {
      ...baseCtx,
      disabledToolGroups: ['task-graph'],
      disabledTools: ['proma_task_create', 'delegate_agent'],
    })
    const names = result.tools.map((t) => t.name)
    expect(names.some((n) => n.startsWith('mcp__task-graph__'))).toBe(false)
    expect(names).not.toContain('mcp__collaboration__delegate_agent')
  })

  test('Given 没有浏览器会话 When BrowserListTabs 执行 Then 返回 exists=false 且不创建标签', async () => {
    const { sdk, tools } = createPiSdkStub()
    const sessionId = 'browser-list-tabs-contract'
    await buildPiBuiltinTools(sdk, { ...baseCtx, sessionId, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'] })

    const listTabs = tools.find((tool) => tool.name === 'BrowserListTabs')
    expect(listTabs).toBeDefined()
    expect(listTabs!.description).toContain('read-only')

    const result = await listTabs!.execute!('call-1', {}) as {
      details?: { sessionId?: string; exists?: boolean; activeTabId?: string | null; agentTabId?: string | null; tabs?: unknown[] }
    }

    expect(result.details?.sessionId).toBe(sessionId)
    expect(result.details?.exists).toBe(false)
    expect(result.details?.activeTabId).toBeNull()
    expect(result.details?.agentTabId).toBeNull()
    expect(result.details?.tabs).toEqual([])
  })
})
