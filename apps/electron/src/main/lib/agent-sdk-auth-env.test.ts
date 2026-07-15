import { describe, expect, test } from 'bun:test'
import { applyAgentSdkAuthEnv, usesAgentSdkBearerWithUserAgent } from './agent-sdk-auth-env'

describe('Agent SDK 认证环境变量', () => {
  test.each(['kimi-coding', 'zhipu-coding', 'xiaomi-token-plan'] as const)(
    'Given %s When 写入 SDK 认证 env Then 使用 Bearer 与 Proma User-Agent',
    (provider) => {
      const env: Record<string, string | undefined> = {}

      applyAgentSdkAuthEnv(env, provider, 'test-key', 'Proma/test')

      expect(usesAgentSdkBearerWithUserAgent(provider)).toBe(true)
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('test-key')
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('User-Agent: Proma/test')
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    },
  )

  test('Given 普通 Anthropic 渠道 When 写入 SDK 认证 env Then 使用 API Key', () => {
    const env: Record<string, string | undefined> = {}

    applyAgentSdkAuthEnv(env, 'anthropic', 'test-key', 'Proma/test')

    expect(env.ANTHROPIC_API_KEY).toBe('test-key')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })
})
