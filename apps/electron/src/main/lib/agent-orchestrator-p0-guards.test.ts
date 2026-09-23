import { describe, expect, test } from 'bun:test'
import { isAgentEnabledForChannel, SAFE_TOOLS } from '@profer/shared'
import {
  AgentRunAlreadyActiveError,
  applySdkCredentials,
  buildPiSkillMentionOptions,
  isBrowserToolName,
  isPartialSDKMessage,
  isPlanModeMarkdownPath,
  isPlanModeMcpTool,
  isXaiChannelAvailableForRuntime,
  PLAN_MODE_READ_ONLY_BROWSER_TOOLS,
  releaseActiveSession,
  resolvePlanModeBrowserPermission,
  tryAcquireActiveSession,
  tryReserveQueuedMessage,
  shouldPreInterruptQueuedMessage,
} from './agent-orchestrator-p0-guards'

describe('AgentOrchestrator P0 guards', () => {
  test('Given 同一 session 已有 owner run When 新请求未启动 Then 返回可识别的普通拒绝', () => {
    const activeError = new AgentRunAlreadyActiveError(false)
    const stoppingError = new AgentRunAlreadyActiveError(true)

    expect(activeError.code).toBe('AGENT_RUN_ALREADY_ACTIVE')
    expect(activeError.message).toContain('上一条消息仍在处理中')
    expect(stoppingError.message).toContain('Agent 正在停止')
  })

  test('Given 同一 session 已在运行 When 再次占用 Then 拒绝并保留原运行令牌', () => {
    const sessions = new Map<string, string>()

    expect(tryAcquireActiveSession(sessions, 'session-1', 'run-a')).toBe(true)
    expect(tryAcquireActiveSession(sessions, 'session-1', 'run-b')).toBe(false)
    expect(sessions.get('session-1')).toBe('run-a')
  })

  test('Given 运行异常后持有当前令牌 When finally 释放 Then 同 session 可再次占用', () => {
    const sessions = new Map<string, string>()
    tryAcquireActiveSession(sessions, 'session-1', 'run-a')

    expect(releaseActiveSession(sessions, 'session-1', 'run-a')).toBe(true)
    expect(tryAcquireActiveSession(sessions, 'session-1', 'run-b')).toBe(true)
  })

  test('Given 旧运行 finally 晚于新运行 When 旧令牌尝试释放 Then 不清除新运行', () => {
    const sessions = new Map<string, string>([['session-1', 'run-b']])

    expect(releaseActiveSession(sessions, 'session-1', 'run-a')).toBe(false)
    expect(sessions.get('session-1')).toBe('run-b')
  })

  test('Given 同一 queue UUID 被重复提交 When 预留消息 Then 只接受一次', () => {
    const uuids = new Set<string>()

    expect(tryReserveQueuedMessage(uuids, 'message-1')).toBe(true)
    expect(tryReserveQueuedMessage(uuids, 'message-1')).toBe(false)
    expect(uuids).toEqual(new Set(['message-1']))
  })

  test('Given queue 注入失败后已释放 UUID When 重试 Then 可再次预留', () => {
    const uuids = new Set<string>()
    expect(tryReserveQueuedMessage(uuids, 'message-1')).toBe(true)

    uuids.delete('message-1')

    expect(tryReserveQueuedMessage(uuids, 'message-1')).toBe(true)
  })

  test('Given Pi interrupt queue When deciding pre-interrupt Then reserve-and-abort stays inside Pi adapter', () => {
    expect(shouldPreInterruptQueuedMessage('pi', true)).toBe(false)
    expect(shouldPreInterruptQueuedMessage('claude', true)).toBe(true)
    expect(shouldPreInterruptQueuedMessage('pi', false)).toBe(false)
  })

  test('Given 本轮 SDK env When 注入凭证 Then 仅写入 query env 且 process env 不变', () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    const sdkEnv: Record<string, string | undefined> = { PATH: process.env.PATH }

    applySdkCredentials(sdkEnv, 'session-only-secret', 'https://gateway.example/v1', 'anthropic')

    expect(sdkEnv.ANTHROPIC_API_KEY).toBe('session-only-secret')
    expect(sdkEnv.ANTHROPIC_BASE_URL).toBe('https://gateway.example')
    expect(process.env.ANTHROPIC_API_KEY).toBe(originalApiKey)
    expect(process.env.ANTHROPIC_BASE_URL).toBe(originalBaseUrl)
  })

  test('Given Pi partial preview When checking persistence eligibility Then identifies it as non-persistable', () => {
    expect(isPartialSDKMessage({ type: 'assistant', _partial: true } as never)).toBe(true)
    expect(isPartialSDKMessage({ type: 'assistant', _partial: false } as never)).toBe(false)
    expect(isPartialSDKMessage({ type: 'assistant' } as never)).toBe(false)
  })

  test('Given Plan 模式 When 写入当前 cwd/.context/plan 下 Markdown Then 允许', () => {
    expect(isPlanModeMarkdownPath('/workspace/session', '.context/plan/p0-regression.md')).toBe(true)
  })

  test('Given Plan 模式 When 路径越界或不是 Markdown Then 拒绝', () => {
    expect(isPlanModeMarkdownPath('/workspace/session', '.context/plan/../outside.md')).toBe(false)
    expect(isPlanModeMarkdownPath('/workspace/session', '.context/plan/notes.txt')).toBe(false)
    expect(isPlanModeMarkdownPath('/workspace/session', '/workspace/other/.context/plan/plan.md')).toBe(false)
  })

  test('Given Plan 模式 When 调用 MCP 工具 Then 拒绝', () => {
    expect(isPlanModeMcpTool('mcp__automation__create_automation')).toBe(true)
    expect(isPlanModeMcpTool('Read')).toBe(false)
  })

  test('Given 工具名 When 判断是否受管浏览器工具 Then 只认 Browser 前缀的 Pi-native 工具', () => {
    expect(isBrowserToolName('BrowserListTabs')).toBe(true)
    expect(isBrowserToolName('BrowserNavigate')).toBe(true)
    expect(isBrowserToolName('Read')).toBe(false)
    expect(isBrowserToolName('mcp__browser__BrowserListTabs')).toBe(false)
  })

  test('Given Plan 模式 When 调用只读浏览器工具 Then 允许', () => {
    for (const toolName of PLAN_MODE_READ_ONLY_BROWSER_TOOLS) {
      expect(resolvePlanModeBrowserPermission(toolName)).toEqual({ behavior: 'allow' })
    }
    expect([...PLAN_MODE_READ_ONLY_BROWSER_TOOLS]).toEqual([
      'BrowserObserve',
      'BrowserScreenshot',
      'BrowserListTabs',
      'BrowserPreviewOpen',
    ])
  })

  test('Given Plan 模式 When 调用交互式浏览器工具 Then 拒绝并给出提示', () => {
    const interactive = [
      'BrowserNavigate',
      'BrowserWaitFor',
      'BrowserClick',
      'BrowserFill',
      'BrowserDomAction',
      'BrowserExecuteJavaScript',
      'BrowserPress',
      'BrowserNewTab',
      'BrowserSelectTab',
      'BrowserCloseTab',
    ]
    for (const toolName of interactive) {
      const decision = resolvePlanModeBrowserPermission(toolName)
      expect(decision.behavior).toBe('deny')
      expect(decision.message).toBeTruthy()
    }
  })

  test('Given Plan 模式浏览器白名单 When 与 auto 安全工具集比对 Then auto 仍允许同一批工具', () => {
    // auto 模式经 autoCanUseTool -> SAFE_TOOLS 自动放行；白名单必须是其子集，
    // 否则会出现「Plan 允许、auto 反而弹审批」的规则漂移。
    for (const toolName of PLAN_MODE_READ_ONLY_BROWSER_TOOLS) {
      expect(SAFE_TOOLS).toContain(toolName)
    }
  })

  test('Given 用户显式引用 Skill When 构造 Pi 选项 Then 透传 skillMentions，未引用时不产生字段', () => {
    expect(buildPiSkillMentionOptions(['in-app-browser'])).toEqual({ skillMentions: ['in-app-browser'] })
    // 空数组不产生字段，保持未显式引用时的 query 形态
    expect(buildPiSkillMentionOptions([])).toEqual({})
  })

  test('Given 调用方持有 preset policy When 构造 Pi 选项 Then 使用副本，后续修改不污染白名单', () => {
    const policySkillSlugs = ['in-app-browser']
    const options = buildPiSkillMentionOptions(policySkillSlugs)

    policySkillSlugs.push('pptx')

    expect(options.skillMentions).toEqual(['in-app-browser'])
  })
})

describe('xAI Agent 预检', () => {
  const xaiChannel = {
    provider: 'xai' as const,
    enabled: true,
    agentExperimentalEnabled: true,
    agentRuntimes: ['pi'] as Array<'pi' | 'claude'>,
  }

  test('Given xAI 渠道已开启实验开关并勾选 Pi 内核 When Pi 运行时预检 Then 放行', () => {
    expect(isXaiChannelAvailableForRuntime(xaiChannel, 'pi')).toBe(true)
  })

  test('Given xAI 渠道未开启实验开关 When Pi 运行时预检 Then 拦截并提示开启实验模式', () => {
    expect(isXaiChannelAvailableForRuntime(
      { ...xaiChannel, agentExperimentalEnabled: false, agentRuntimes: undefined },
      'pi',
    )).toBe(false)
  })

  test('Given xAI 渠道被停用 When Pi 运行时预检 Then 拦截', () => {
    expect(isXaiChannelAvailableForRuntime({ ...xaiChannel, enabled: false }, 'pi')).toBe(false)
  })

  test('Given xAI 渠道 When Claude 运行时预检 Then 拦截（xAI 无 Anthropic 端点）', () => {
    expect(isXaiChannelAvailableForRuntime(xaiChannel, 'claude')).toBe(false)
  })

  test('Given 非 xAI 渠道 When 预检 Then 交给各自 provider 门禁，不在此拦截', () => {
    expect(isXaiChannelAvailableForRuntime(
      { provider: 'deepseek', enabled: true, agentExperimentalEnabled: false, agentRuntimes: ['pi'] },
      'pi',
    )).toBe(true)
    expect(isXaiChannelAvailableForRuntime(
      { provider: 'deepseek', enabled: true, agentExperimentalEnabled: false, agentRuntimes: ['pi'] },
      'claude',
    )).toBe(true)
  })

  test('回归：旧判据对 xAI 恒为 false，预检不得再使用它', () => {
    // 根因锁：isAgentEnabledForChannel 已是「是否勾选 Claude 内核」的 @deprecated 别名，
    // xAI 按设计永远拿不到 claude 内核，所以它恒为 false。
    // 一旦有调用方把它当成「xAI 实验开关是否开启」，xAI + Pi 链路会永久被拦截。
    expect(isAgentEnabledForChannel(xaiChannel)).toBe(false)
    expect(isXaiChannelAvailableForRuntime(xaiChannel, 'pi')).toBe(true)
  })
})
