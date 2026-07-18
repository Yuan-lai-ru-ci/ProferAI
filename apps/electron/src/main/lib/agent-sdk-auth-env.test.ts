import { describe, expect, test } from 'bun:test'
import { applyAgentSdkAuthEnv, usesAgentSdkBearerWithUserAgent } from './agent-sdk-auth-env'

describe('Agent SDK auth env', () => {
  test('Given concurrent request-local envs When credentials are applied Then secrets remain isolated from each other and process.env', () => {
    const before = process.env.ANTHROPIC_API_KEY
    const first: Record<string, string | undefined> = {}
    const second: Record<string, string | undefined> = {}

    applyAgentSdkAuthEnv(first, 'anthropic', 'first-secret')
    applyAgentSdkAuthEnv(second, 'kimi-coding', 'second-secret')

    expect(first.ANTHROPIC_API_KEY).toBe('first-secret')
    expect(first.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(second.ANTHROPIC_AUTH_TOKEN).toBe('second-secret')
    expect(second.ANTHROPIC_API_KEY).toBeUndefined()
    expect(second.ANTHROPIC_CUSTOM_HEADERS).toContain('User-Agent:')
    expect(process.env.ANTHROPIC_API_KEY).toBe(before)
  })

  test('Given a commercial team proxy When forced Bearer auth Then does not apply a provider-specific header', () => {
    const env: Record<string, string | undefined> = {}
    applyAgentSdkAuthEnv(env, 'anthropic', 'team-proxy-token', true)
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'team-proxy-token' })
  })

  test('Given provider rules When checking Bearer User-Agent support Then only plan providers opt in', () => {
    expect(usesAgentSdkBearerWithUserAgent('kimi-coding')).toBe(true)
    expect(usesAgentSdkBearerWithUserAgent('anthropic')).toBe(false)
  })
})
