import { describe, expect, test } from 'bun:test'
import {
  isAgentEnabledForChannel,
  resolveXaiCredentialMode,
  type AgentRuntimeMode,
} from './channel'

const oauthSecret = JSON.stringify({
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
})

function channel(overrides: Partial<{
  provider: 'xai' | 'anthropic'
  enabled: boolean
  agentExperimentalEnabled: boolean
  agentRuntimes: AgentRuntimeMode[]
}> = {}) {
  return {
    provider: 'xai' as const,
    enabled: true,
    ...overrides,
  }
}

describe('xAI 凭据模式与 Agent 内核资格', () => {
  test('Given 历史 xAI OAuth JSON When 未声明模式 Then 自动识别为 oauth', () => {
    expect(resolveXaiCredentialMode(undefined, oauthSecret)).toBe('oauth')
  })

  test('Given 普通 xAI API Key When 未声明模式 Then 自动识别为 api-key', () => {
    expect(resolveXaiCredentialMode(undefined, 'xai-api-key')).toBe('api-key')
  })

  test('Given 明确模式与密文内容冲突 When 解析模式 Then OAuth 结构优先保护 refresh token', () => {
    expect(resolveXaiCredentialMode('api-key', oauthSecret)).toBe('oauth')
    expect(resolveXaiCredentialMode('oauth', 'xai-api-key')).toBe('oauth')
  })

  // isAgentEnabledForChannel 现在只是「该渠道是否勾选了 Claude 内核」的兼容别名，
  // Agent 资格完全以内核勾选（agentRuntimes）为准，不再看渠道类型或实验开关。
  test('Given 渠道没有任何勾选信息 When 判断 Claude 内核资格 Then 按 provider 推导等价结果', () => {
    // xAI 无 Anthropic 端点，推导结果里没有 claude
    expect(isAgentEnabledForChannel(channel())).toBe(false)
    // 既有兼容渠道推导结果含 claude，保持原有语义
    expect(isAgentEnabledForChannel(channel({ provider: 'anthropic' }))).toBe(true)
  })

  test('Given xAI 勾选 Claude When 判断资格 Then 与真实发送守卫一致拒绝', () => {
    expect(isAgentEnabledForChannel(channel({ agentRuntimes: ['pi', 'claude'] }))).toBe(false)
  })

  test('Given 渠道只勾选 Pi 内核 When 判断 Claude 内核资格 Then 拒绝', () => {
    expect(isAgentEnabledForChannel(channel({ agentRuntimes: ['pi'] }))).toBe(false)
  })

  test('Given xAI 只开了实验开关但没有勾选 When 判断 Claude 内核资格 Then 开关不再决定资格', () => {
    // 实验开关的历史作用是把 xAI 老配置迁移为 Pi 内核（agentRuntimes: ['pi']），
    // 它不代表用户勾选了 Claude 内核，因此这里必须是 false。
    expect(isAgentEnabledForChannel(channel({ agentExperimentalEnabled: true }))).toBe(false)
    expect(isAgentEnabledForChannel(channel({ agentExperimentalEnabled: true, agentRuntimes: ['pi'] }))).toBe(false)
  })
})
