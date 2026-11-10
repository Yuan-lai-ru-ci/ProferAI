/**
 * 新链系统提示词装配：必须与旧链同一份实现，而不是「工作区 profile 正文」。
 *
 * 这里锁三件事：
 * 1. 有冻结策略快照时，产出的是完整系统提示词（核心规则 + 预设段），不是 profile 片段；
 * 2. Claude 拿 `claude_code` preset 形态，Pi 拿纯文本 + taskPrompt；
 * 3. 没有策略快照时返回 undefined —— 不允许按「猜一个默认预设」装配。
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntimeQuery } from '@profer/agent-runtime'
import type { AgentPreset } from '@profer/shared'

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
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

// 配置目录必须在**第一次** import 之前定好：会话索引在模块加载时解析路径。
// 同一文件内的模块实例必须共享（不做 cache-busting，否则内部相对 import 会拿到另一份注册表）。
const root = mkdtempSync(join(tmpdir(), 'profer-turn-prompt-'))
process.env.PROFER_CONFIG_DIR = root

const turnPrompt = await import('./agent-runtime-turn-prompt')
const policies = await import('./agent-runtime-policy-snapshot')
const sessions = await import('./agent-session-manager')
const preparation = await import('./agent-runtime-provider-preparation')
afterAll(() => {
  delete process.env.PROFER_CONFIG_DIR
  rmSync(root, { recursive: true, force: true })
})

function preset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'preset-turn-prompt',
    name: '提示词测试预设',
    description: '',
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function queryFor(sessionId: string, overrides: Partial<AgentRuntimeQuery> = {}): AgentRuntimeQuery {
  return {
    sessionId,
    prompt: '帮我看一下这个仓库',
    runtime: 'pi',
    ...overrides,
  } as AgentRuntimeQuery
}

function freezePolicy(sessionId: string, promptSections?: readonly string[]): void {
  policies.agentRuntimePolicyRuns.resolveForRun(sessionId, {
    preset: preset(promptSections ? { promptSections: [...promptSections] } : {}),
    presetReference: { presetId: 'preset-turn-prompt', presetScope: 'user-global' },
  })
}

describe('runtime turn prompt', () => {
  test('有策略快照时装配完整系统提示词（核心规则 + 预设段），而不是 profile 片段', () => {
    const meta = sessions.createAgentSession('提示词', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id, ['## 本预设专属段\n只做一件事。'])

    const result = turnPrompt.buildRuntimeTurnPrompt(queryFor(meta.id))
    expect(result).toBeDefined()
    const text = typeof result!.systemPrompt === 'string' ? result!.systemPrompt : result!.systemPrompt.append
    // 核心规则来自 buildSystemPrompt，不是工作区 profile。
    expect(text).toContain('你是 Profer 桌面应用中的通用 AI 助手')
    // 预设自定义段必须进 system（旧链同一份 builder）。
    expect(text).toContain('## 本预设专属段')
    expect(text.length).toBeGreaterThan(1000)
  })

  test('Claude 返回 claude_code preset 形态，Pi 返回纯文本', () => {
    const meta = sessions.createAgentSession('形态', undefined, undefined, 'claude-opus-4-7', 'claude')
    freezePolicy(meta.id)

    const claude = turnPrompt.buildRuntimeTurnPrompt(queryFor(meta.id, { runtime: 'claude' }))
    expect(typeof claude!.systemPrompt).toBe('object')
    expect((claude!.systemPrompt as { preset: string }).preset).toBe('claude_code')

    const pi = turnPrompt.buildRuntimeTurnPrompt(queryFor(meta.id, { runtime: 'pi' }))
    expect(typeof pi!.systemPrompt).toBe('string')
  })

  test('没有策略快照时不装配（不猜默认预设）', () => {
    const meta = sessions.createAgentSession('无快照', undefined, undefined, 'model-1', 'pi')
    expect(turnPrompt.buildRuntimeTurnPrompt(queryFor(meta.id))).toBeUndefined()
  })

  test('provider preparation 真的把装配结果交给 provider（不是只测模块）', async () => {
    const meta = sessions.createAgentSession('接线', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id, ['## 接线验证段'])
    const port = preparation.createElectronProviderQueryPreparation({
      resolveRuntimeEnv: (async () => ({ shellPath: '/bin/zsh' })) as never,
    })
    const result = await port.prepare(
      queryFor(meta.id),
      { credentials: { apiKey: 'k', baseUrl: 'https://example.invalid', provider: 'deepseek' } } as never,
      new AbortController().signal,
    )
    expect(String(result.systemPrompt)).toContain('你是 Profer 桌面应用中的通用 AI 助手')
    expect(String(result.systemPrompt)).toContain('## 接线验证段')
  })
})

describe('runtime turn user prompt', () => {
  test('动态上下文、@ 引用与历史回填都在本轮 prompt 里', () => {
    const meta = sessions.createAgentSession('用户消息侧', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    const referenced = sessions.createAgentSession('被引用的会话', undefined, undefined, 'model-1', 'pi')
    sessions.appendSDKMessages(meta.id, [
      { type: 'user', message: { content: [{ type: 'text', text: '上一轮的问题' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'text', text: '上一轮的回答' }] }, parent_tool_use_id: null },
    ] as never)

    const prompt = turnPrompt.buildRuntimeTurnUserPrompt(
      queryFor(meta.id, {
        workspaceId: undefined,
        providerInput: {
          mentionedSessionIds: [referenced.id],
          mentionedMcpServers: ['mcp-not-loaded'],
        },
      }),
      { hasResume: false, mcpServerNames: ['mcp-loaded'] },
    )

    // 历史回填在最外层（无 resume）。
    expect(prompt.startsWith('<conversation_history>')).toBe(true)
    expect(prompt).toContain('上一轮的问题')
    // 动态上下文包含当前时间与工作目录。
    expect(prompt).toContain('**当前时间:')
    // @ 会话引用。
    expect(prompt).toContain('被引用的会话')
    // 未被本轮加载的 MCP 不得出现在 mentioned_tools 里。
    expect(prompt).not.toContain('mcp-not-loaded')
  })

  test('空的实际 MCP 集不能作为 wildcard 接受未加载引用', () => {
    const meta = sessions.createAgentSession('MCP empty', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    const input = queryFor(meta.id, { providerInput: { mentionedMcpServers: ['SECRET_DISABLED_MCP'] } })
    const prompt = turnPrompt.buildRuntimeTurnUserPrompt(input, { hasResume: true, mcpServerNames: [] })
    expect(prompt).not.toContain('SECRET_DISABLED_MCP')
    expect(prompt).not.toContain('<mentioned_tools>')
  })

  test('有 resume 时不回填历史（provider 自己持有），但保留动态上下文', () => {
    const meta = sessions.createAgentSession('有 resume', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    sessions.appendSDKMessages(meta.id, [
      { type: 'user', message: { content: [{ type: 'text', text: '旧历史' }] }, parent_tool_use_id: null },
    ] as never)

    const prompt = turnPrompt.buildRuntimeTurnUserPrompt(
      queryFor(meta.id, { runtimeSessionId: 'sdk-1' }),
      { hasResume: true },
    )
    expect(prompt).not.toContain('<conversation_history>')
    expect(prompt).not.toContain('旧历史')
    expect(prompt).toContain('**当前时间:')
  })

  test('/compact 原样透传，不包动态上下文或历史回填', () => {
    const meta = sessions.createAgentSession('compact', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    sessions.appendSDKMessages(meta.id, [
      { type: 'user', message: { content: [{ type: 'text', text: '旧历史' }] }, parent_tool_use_id: null },
    ] as never)

    const prompt = turnPrompt.buildRuntimeTurnUserPrompt(
      queryFor(meta.id, { prompt: '/compact' }),
      { hasResume: false },
    )
    expect(prompt).toBe('/compact')
  })

  test('light 模式：用户消息原样透传，不拼动态上下文与历史', () => {
    const meta = sessions.createAgentSession('light', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    sessions.appendSDKMessages(meta.id, [
      { type: 'user', message: { content: [{ type: 'text', text: '旧历史' }] }, parent_tool_use_id: null },
    ] as never)

    const prompt = turnPrompt.buildRuntimeTurnUserPrompt(
      queryFor(meta.id, { prompt: '你好', metadata: { promptMode: 'light' } }),
      { hasResume: false },
    )
    expect(prompt).toBe('你好')
  })

  test('light 模式：系统提示词走精简版（不含完整核心规则）', () => {
    const meta = sessions.createAgentSession('light-system', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    const result = turnPrompt.buildRuntimeTurnPrompt(
      queryFor(meta.id, { metadata: { promptMode: 'light' } }),
    )
    const text = typeof result!.systemPrompt === 'string' ? result!.systemPrompt : result!.systemPrompt.append
    expect(text).toContain('简短对话')
    expect(text).not.toContain('## 做事方式')
  })

  test('Pi 的 skill catalog 进入 system（Claude 由 SDK 自己发现）', () => {
    const meta = sessions.createAgentSession('skill-catalog', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    const catalog = '<skill_catalog>\n<skill name="demo" location="demo/SKILL.md">示例</skill>\n</skill_catalog>'
    const result = turnPrompt.buildRuntimeTurnPrompt(queryFor(meta.id, { runtime: 'pi' }), { skillCatalog: catalog })
    const text = typeof result!.systemPrompt === 'string' ? result!.systemPrompt : result!.systemPrompt.append
    expect(text).toContain('<skill_catalog>')
    expect(text).toContain('name="demo"')
  })

  test('@ MCP 引用在已加载时进入 mentioned_tools', () => {
    const meta = sessions.createAgentSession('MCP 引用', undefined, undefined, 'model-1', 'pi')
    freezePolicy(meta.id)
    const prompt = turnPrompt.buildRuntimeTurnUserPrompt(
      queryFor(meta.id, { providerInput: { mentionedMcpServers: ['mcp-loaded'] } }),
      { hasResume: true, mcpServerNames: ['mcp-loaded'] },
    )
    expect(prompt).toContain('<mentioned_tools>')
    expect(prompt).toContain('mcp-loaded')
  })
})
