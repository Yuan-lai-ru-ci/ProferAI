import { describe, expect, mock, test } from 'bun:test'
import type { ClaudeAgentQueryOptions } from './claude-agent-adapter'

let capturedSdkQueryOptions: Record<string, unknown> | undefined

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    capturedSdkQueryOptions = options
    return (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 'test-session', terminal_reason: 'completed' }
    })()
  },
}))

const { friendlyErrorMessage, getWindowsPowerShellPath, mapSDKErrorToTypedError, SDK_SETTING_SOURCES, ClaudeAgentAdapter } = await import('./claude-agent-adapter')

describe('Claude 适配器 Skill 白名单最终透传', () => {
  for (const { label, skills } of [
    { label: '未指定白名单', skills: undefined },
    { label: '空白名单', skills: [] },
    { label: '非空白名单', skills: ['code-honor', 'plugin:review'] },
  ]) {
    test(`Given ${label} When 发起查询 Then sdk.query 收到原始白名单状态`, async () => {
      capturedSdkQueryOptions = undefined
      const adapter = new ClaudeAgentAdapter()
      const input: ClaudeAgentQueryOptions = {
        sessionId: `claude-skills-${label}`,
        prompt: '检查白名单',
        sdkCliPath: '/unused/mock-claude',
        env: {},
        sdkPermissionMode: 'auto',
        allowDangerouslySkipPermissions: false,
        systemPrompt: 'test',
        skills,
      }
      try {
        const messages = []
        for await (const message of adapter.query(input)) messages.push(message)
        expect(messages).toHaveLength(1)
        expect(capturedSdkQueryOptions).toBeDefined()
        if (skills === undefined) {
          expect(capturedSdkQueryOptions).not.toHaveProperty('skills')
        } else {
          expect(capturedSdkQueryOptions).toHaveProperty('skills', skills)
          expect(capturedSdkQueryOptions!.skills).not.toBe(skills)
        }
      } finally {
        adapter.dispose()
      }
    })
  }
})

describe('Claude 本轮工具装载', () => {
  test('纯对话空工具数组透传，后续标准请求省略该覆盖', async () => {
    const adapter = new ClaudeAgentAdapter()
    const input: ClaudeAgentQueryOptions = {
      sessionId: 'light-tools', prompt: '你好', sdkCliPath: '/unused/mock-claude', env: {},
      sdkPermissionMode: 'auto', allowDangerouslySkipPermissions: false, systemPrompt: 'short prompt', tools: [],
    }
    try {
      for await (const _message of adapter.query(input)) { /* 消费 */ }
      expect(capturedSdkQueryOptions?.tools).toEqual([])
      const standardInput: ClaudeAgentQueryOptions = { ...input, tools: undefined }
      for await (const _message of adapter.query(standardInput)) { /* 消费 */ }
      expect(capturedSdkQueryOptions).not.toHaveProperty('tools')
    } finally { adapter.dispose() }
  })
})

describe('Claude 适配器 Windows 清理命令', () => {
  test('Given PowerShell 未加入 PATH 但系统组件存在 When 解析 Then 使用 SystemRoot 下的绝对路径', () => {
    const path = getWindowsPowerShellPath(
      { SystemRoot: 'C:\\Windows' },
      (candidate) => candidate === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(path).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  test('Given 系统组件不可用 When 解析 Then 安全降级为 null', () => {
    expect(getWindowsPowerShellPath({ SystemRoot: 'C:\\Windows' }, () => false)).toBeNull()
    expect(getWindowsPowerShellPath({}, () => true)).toBeNull()
  })
})

describe('Claude 适配器 SDK 设置隔离', () => {
  test('Given Profer Agent SDK 查询 When 配置设置来源 Then 不加载用户级 Claude 设置', () => {
    expect(SDK_SETTING_SOURCES).toEqual(['project'])
    expect(SDK_SETTING_SOURCES).not.toContain('user')
  })
})

describe('Claude 适配器 Ollama 工具流错误', () => {
  test('Given Ollama tool-result stream error When mapping Then do not classify as transient network retry', () => {
    const message = 'API Error: 500 no user query found in messages'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('Ollama 工具流兼容性错误')
    expect(error.canRetry).toBe(false)
    expect(friendlyErrorMessage(message)).toContain('Ollama')
  })
})

describe('Claude 适配器 OpenAI 上游繁忙错误', () => {
  test('Given OpenAI 官方上游请求量较大 When 映射错误 Then 使用统一文案并允许重试', () => {
    const message = 'OpenAI 官方上游服务当前请求量较大，请稍后重试。'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('OpenAI 官方服务繁忙')
    expect(error.message).toContain('与您的账户及卡扣AI无关')
    expect(error.canRetry).toBe(true)
  })
})

describe('Claude 适配器上游额度错误', () => {
  test('Given 独立上游 billing 页面 402 When 映射错误 Then 识别为不可自动重试的额度不足', () => {
    const message = 'API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('insufficient_credits')
    expect(error.title).toBe('额度不足')
    expect(error.canRetry).toBe(false)
  })

  test('Given 上游供应通道账户余额不足 When 映射错误 Then 不引导用户充值且可重试', () => {
    const message = 'API Error: 403 {"error":"当前模型供应通道额度不足","code":"upstream_channel_insufficient"}'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('模型供应通道暂不可用')
    expect(error.canRetry).toBe(true)
    expect(error.actions.some((action) => action.action === 'open_credits')).toBe(false)
  })
})
