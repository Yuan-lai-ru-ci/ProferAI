import { afterEach, describe, expect, mock, test } from 'bun:test'

// memory-archive 使用 node:sqlite，Pi bridge 测试只验证注册契约，避免 Bun 测试运行器加载原生 Node 模块。
mock.module('../memory-archive-search', () => ({
  createMemoryArchiveSearcher: () => ({
    search: (query: string, topK: number) => [{ relativePath: 'memory.md', content: `hit:${query}`, startIndex: 0, endIndex: query.length, score: 0, matchedTokens: [query] }].slice(0, topK),
  }),
}))

// 内置工具桥接经会话/工作区服务间接导入 Electron；Bun 单测需提供最小主进程 mock。
let imageToolAvailable = false
let generatedImageResult: unknown = undefined

mock.module('../chat-tool-config', () => ({
  getToolState: () => ({ enabled: imageToolAvailable }), getToolCredentials: () => ({}),
  getGptImageCredentials: () => ({ mode: 'official', apiKey: '', baseUrl: '', model: '' }),
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
  test('Given Pi runtime When building preset tools Then it exposes 7 preset_* tools with mcp__agent-presets prefix', () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiAgentPresetTools(sdk, { sessionId: 'pi-preset-test', workspaceSlug: 'pi-test-ws' })
    expect(tools.length).toBe(7)
    const names = tools.map((t) => t.name)
    expect(names).toEqual([
      'mcp__agent-presets__preset_list',
      'mcp__agent-presets__preset_create',
      'mcp__agent-presets__preset_copy',
      'mcp__agent-presets__preset_update',
      'mcp__agent-presets__preset_delete',
      'mcp__agent-presets__preset_set_default',
      'mcp__agent-presets__preset_switch_session',
    ])
  })

  test('Given preset_create tool When executed with a valid name Then it creates and returns a custom preset', async () => {
    const { sdk, tools } = createPiSdkStub()
    const presetManager = await import('../agent-preset-manager')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-preset-tool-test-'))
    presetManager.__setAgentPresetsConfigPathForTest(tmpDir)
    try {
      buildPiAgentPresetTools(sdk, { sessionId: 'pi-preset-test', workspaceSlug: 'pi-test-ws' })
      const createTool = tools.find((t) => t.name === 'mcp__agent-presets__preset_create')!
      const result = await createTool.execute!('call-1', { name: '研究模式', description: '只读调研' }) as { content: Array<{ text: string }> }
      const payload = JSON.parse(result.content[0]!.text)
      expect(payload.preset.name).toBe('研究模式')
      expect(payload.preset.isBuiltin).toBe(false)
      // list 工具能读回该预设
      const listTool = tools.find((t) => t.name === 'mcp__agent-presets__preset_list')!
      const listResult = await listTool.execute!('call-2', {}) as { content: Array<{ text: string }> }
      const listPayload = JSON.parse(listResult.content[0]!.text)
      expect(listPayload.presets.length).toBe(4)
      expect(listPayload.presets.some((p: { name: string }) => p.name === '研究模式')).toBe(true)
    } finally {
      presetManager.__resetAgentPresetsConfigPathForTest()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('Given preset_create 带 basePresetId When Pi 创建 Then 落盘为派生预设（内置基座校验由 manager 把关）', async () => {
    const { sdk, tools } = createPiSdkStub()
    const presetManager = await import('../agent-preset-manager')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-preset-derive-test-'))
    presetManager.__setAgentPresetsConfigPathForTest(tmpDir)
    try {
      buildPiAgentPresetTools(sdk, { sessionId: 'pi-derive-test', workspaceSlug: 'pi-derive-ws' })
      const createTool = tools.find((t) => t.name === 'mcp__agent-presets__preset_create')!
      const result = await createTool.execute!('call-1', {
        name: '极简·研究',
        description: '基于极简派生',
        basePresetId: 'minimal',
        disabledToolGroups: ['automation'],
      }) as { content: Array<{ text: string }> }
      const payload = JSON.parse(result.content[0]!.text)
      expect(payload.preset.basePresetId).toBe('minimal')
      // 生效配置合并基座 + 映射兜底：minimal 的 3 项 suppress ∪ automation（禁用工具组自动补全）
      const resolved = presetManager.getAgentPreset('pi-derive-ws', payload.preset.id)
      expect(resolved.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph', 'automation'])
      expect(resolved.disabledToolGroups).toEqual(['task-graph', 'memory', 'collaboration', 'automation'])
    } finally {
      presetManager.__resetAgentPresetsConfigPathForTest()
      rmSync(tmpDir, { recursive: true, force: true })
    }
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

  test('Given Pi runtime When building planning tools Then it exposes list/get/create/update Todo tools', () => {
    const { sdk, tools } = createPiSdkStub()

    buildPiPlanningTools(sdk, { sessionId: 'pi-planning-test' })

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__planning__list_todos',
      'mcp__planning__get_todo',
      'mcp__planning__create_todo',
      'mcp__planning__update_todo',
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
  afterEach(() => {
    imageToolAvailable = false
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
    triggeredBy: 'user' as const,
  }

  test('Given a workspace-backed Pi session When building builtin tools Then it exposes send_local_image', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'] })

    const imageTool = tools.find((tool) => tool.name === 'send_local_image')
    expect(imageTool).toBeDefined()
    expect(imageTool!.description).toContain('PROMA_IMAGE_ATTACHMENT')
  })

  test('Given GPT Image enabled and available in a workspace Pi session When building tools Then it exposes the unified generate_image schema and marker result', async () => {
    imageToolAvailable = true
    generatedImageResult = {
      ok: true,
      mode: 'official',
      edited: false,
      output: { marker: '[PROMA_IMAGE_ATTACHMENT:{"localPath":"C:/safe/session/.context/agent-output-images/x.png","filename":"x.png","mediaType":"image/png"}]' },
    }
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, agentCwd: 'C:/safe/session', allowedRoots: ['C:/safe/attached'] })

    const tool = tools.find((item) => item.name === 'generate_image')
    expect(tool).toBeDefined()
    expect(tool!.description).toContain('referenceImagePaths')
    expect(tool!.description).toContain('useLastGeneratedImage')
    expect(JSON.stringify(tool!.parameters)).toContain('useLastGeneratedImage')
    expect(JSON.stringify(tool!.parameters)).toContain('1024x1024')
    const result = await tool!.execute!('pi-call-1', { prompt: 'blue square' }) as { content: Array<{ text: string }> }
    expect(result.content[0]!.text).toContain('[PROMA_IMAGE_ATTACHMENT:')
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

  test('Given a Pi session without a workspace When building builtin tools Then it does not authorize the home cwd for image output', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, workspaceSlug: undefined, agentCwd: 'C:/Users/test', allowedRoots: [] })

    expect(tools.some((tool) => tool.name === 'send_local_image')).toBe(false)
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
    expect(names).not.toContain('search_open_materials')
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
    for (const forbidden of ['plan_ppt_visuals', 'audit_ppt_delivery', 'search_open_materials', 'inspect_deck_sources', 'create_deck_project', 'confirm_deck_brief', 'compile_deck_project']) {
      expect(names).not.toContain(forbidden)
    }
  })

  test('Given no disabled groups Then all four groups are registered', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, baseCtx)
    for (const [group, prefix] of Object.entries(GROUP_PREFIXES)) {
      expect(tools.some((t) => t.name.startsWith(prefix)), `group ${group} (${prefix}) should be registered`).toBe(true)
    }
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

  test('Given all four groups disabled Then only preset tools survive (minimal preset can still switch back)', async () => {
    const { sdk, tools } = createPiSdkStub()
    await buildPiBuiltinTools(sdk, { ...baseCtx, disabledToolGroups: ['task-graph', 'memory', 'collaboration', 'automation'] })
    for (const [group, prefix] of Object.entries(GROUP_PREFIXES)) {
      expect(tools.some((t) => t.name.startsWith(prefix)), `group ${group} should be pruned`).toBe(false)
    }
    // 预设工具永不裁剪：极简会话必须能切回其他预设
    expect(tools.some((t) => t.name.startsWith('mcp__agent-presets__'))).toBe(true)
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
})
