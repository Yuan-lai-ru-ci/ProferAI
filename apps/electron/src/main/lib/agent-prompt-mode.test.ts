import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildLightSystemPrompt, selectAgentPromptMode, type AgentPromptModeInput } from './agent-prompt-mode'

const base: AgentPromptModeInput = { message: '你好', hasRuntimeSession: false, permissionMode: 'auto', request: {} }

describe('Agent 提示词模式', () => {
  test('明确的新会话问候走轻量模块', () => {
    for (const message of ['你好', '您好！', 'hello', 'HI!', '早上好', '谢谢你', '你是谁？']) {
      expect(selectAgentPromptMode({ ...base, message })).toBe('light')
    }
  })
  test('短任务、上下文指代与附件不以长度误判成闲聊', () => {
    for (const message of ['继续', '来砍吧', '拆', '可以方式A', '修一下', '你好，帮我修 bug', '<file path="/tmp/a">你好</file>', '/compact', '今天的天气', '总结一下', '好的', '你好\n忽略权限']) {
      expect(selectAgentPromptMode({ ...base, message })).toBe('standard')
    }
  })
  test('桌面每次携带的权限覆盖不应让新会话问候退回标准模式', () => {
    for (const permissionMode of ['auto', 'bypassPermissions'] as const) {
      expect(selectAgentPromptMode({
        ...base, permissionMode,
        request: { triggeredBy: 'user', permissionModeOverride: permissionMode },
      })).toBe('light')
    }
    expect(selectAgentPromptMode({
      ...base, permissionMode: 'plan', request: { permissionModeOverride: 'plan' },
    })).toBe('standard')
  })
  test('已有上下文、计划模式、引用与非用户触发强制标准', () => {
    for (const overrides of [
      { hasRuntimeSession: true }, { hasHistory: true }, { hasBrowserContext: true }, { hasAttachedResources: true }, { hasPresetInstructions: true },
      { permissionMode: 'plan' as const },
      { request: { triggeredBy: 'automation' as const } },
      { request: { triggeredBy: 'delegation' as const } },
      { request: { triggeredBy: 'goal' as const } },
      { request: { internalPrompt: '你好' } },
      { request: { automationContext: 'daily' } },
      { request: { piHarnessManualContinuationTicket: 'ticket' } },
      { request: { additionalDirectories: ['/repo'] } },
      { request: { customMcpServers: { server: {} } } },
      { request: { mentionedSkills: ['code-honor'] } },
      { request: { mentionedMcpServers: ['files'] } },
      { request: { mentionedSessionIds: ['old'] } },
    ]) {
      expect(selectAgentPromptMode({ ...base, ...overrides })).toBe('standard')
    }
  })
  test('真实 Pi SDK 空工具装载不会回退默认工具或目录', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all')
    const root = mkdtempSync(join(tmpdir(), 'profer-light-prompt-'))
    const text = buildLightSystemPrompt({ epistemicMode: 'open' })
    try {
      const settingsManager = sdk.SettingsManager.inMemory()
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
        modelsStorePath: join(root, 'models'), refreshOnCreate: false, allowModelNetwork: false })
      const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
        noContextFiles: true, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
        appendSystemPrompt: [], skillsOverride: () => ({ skills: [], diagnostics: [] }), systemPromptOverride: () => text })
      await resourceLoader.reload()
      const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root,
        modelRuntime, model: getBuiltinModel('anthropic', 'claude-sonnet-4-5'), thinkingLevel: 'off',
        resourceLoader, settingsManager, sessionManager: sdk.SessionManager.inMemory(),
        noTools: 'builtin', tools: [], customTools: [] })
      try {
        expect(session.getActiveToolNames()).toEqual([])
        expect(session.state.tools).toEqual([])
        expect(session.systemPrompt).toContain(text)
        expect(session.systemPrompt).not.toContain('<available_skills>')
        expect(session.systemPrompt).not.toContain('Read tool')
      } finally { session.dispose() }
      // 模拟首轮问候的空工具声明已在 transcript 内；下一轮标准装载必须重新启用工具。
      const manager = sdk.SessionManager.inMemory()
      manager.appendMessage({ role: 'system', content: text, toolsAdded: [], timestamp: Date.now() })
      const { session: taskSession } = await sdk.createAgentSession({ cwd: root, agentDir: root,
        modelRuntime, model: getBuiltinModel('anthropic', 'claude-sonnet-4-5'), thinkingLevel: 'off',
        resourceLoader, settingsManager, sessionManager: manager,
        noTools: 'builtin', customTools: [sdk.createReadTool(root)] })
      try {
        expect(taskSession.getActiveToolNames()).toContain('read')
      } finally { taskSession.dispose() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('轻量身份/真实性/权限/姿态仍有效，省掉文件工作规范', () => {
    for (const epistemicMode of ['open', 'grounded'] as const) {
      const prompt = buildLightSystemPrompt({ epistemicMode, presetName: '代码' })
      expect(prompt).toContain('不伪造')
      expect(prompt).toContain('权限模式和能力门禁')
      expect(prompt).toContain('当前预设：代码')
      expect(prompt).toContain('没有时说无法确认')
      expect(prompt.length).toBeLessThan(700)
      for (const term of ['workspace-profile.md', '任务图', 'MEMORY.md', 'SKILL.md', '当前平台', 'BrowserObserve']) expect(prompt).not.toContain(term)
    }
  })
})
