import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Channel, CodexOAuthCredentials } from '@profer/shared'
import type { CredentialStore } from '@earendil-works/pi-ai'
import { inferAgentBaseUrl } from './channel-url-routing'
import { applySdkCredentials } from './agent-orchestrator-p0-guards'

const codex: CodexOAuthCredentials = {
  access: 'fixture-resolved-access', refresh: 'fixture-resolved-refresh',
  expires: Date.now() + 3_600_000, accountId: 'fixture-account',
}
let secret = 'fixture-api-key'
let decryptFails = false
let codexFails = false
let commercial = false
const resolveCodex = mock(async () => {
  if (codexFails) throw new Error('fixture refresh rejected')
  return { ...codex }
})
const persistCodex = mock((_channelId: string, _credentials: CodexOAuthCredentials) => {})
const teamAuth = mock(async () => ({ token: 'fixture-team-token', proxyToken: 'fixture-proxy-token', baseUrl: 'https://relay.fixture.invalid' }))
mock.module('./channel-manager', () => ({
  decryptApiKey: () => { if (decryptFails) throw new Error('fixture decrypt failed'); return secret },
  isCommercialMode: () => commercial,
  resolveChannelAgentBaseUrl: (channel: Channel) => inferAgentBaseUrl(channel.provider, channel.baseUrl, channel.agentBaseUrl),
  resolveCodexOAuthCredentials: resolveCodex,
  persistCodexOAuthCredentials: persistCodex,
  resolveXaiOAuthCredentials: async () => ({ ...codex }),
  persistXaiOAuthCredentials: () => {},
}))
mock.module('./auth-service', () => ({ getTeamAuthWithRefresh: teamAuth }))
mock.module('./build-target', () => ({ isCommercialBuild: () => false }))
const { buildPiRuntimeCredentialOptions, resolveRuntimeCredentials } = await import('./agent-runtime-credentials')
const { buildModel } = await import('./adapters/pi-model-registry')

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'fixture-channel', name: 'Fixture', provider: 'custom',
    baseUrl: 'https://openai.fixture.invalid/v1', agentBaseUrl: 'https://anthropic.fixture.invalid',
    apiKey: 'fixture-encrypted', enabled: true, models: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  secret = 'fixture-api-key'
  decryptFails = false
  codexFails = false
  commercial = false
  resolveCodex.mockClear()
  persistCodex.mockClear()
  teamAuth.mockClear()
})

describe('Agent 请求凭据解析与协议端点', () => {
  test.each(['custom', 'openai', 'openai-responses', 'google', 'qwen', 'xai'] as const)(
    'Given %s 双端点 When Pi/Claude 解析 Then 分别使用原生/Anthropic 地址', async (provider) => {
      const value = channel({ provider })
      expect(await resolveRuntimeCredentials(value, 'pi')).toMatchObject({
        ok: true, credentials: { apiKey: secret, baseUrl: value.baseUrl },
      })
      expect(await resolveRuntimeCredentials(value, 'claude')).toMatchObject({
        ok: true, credentials: { baseUrl: value.agentBaseUrl },
      })
    },
  )

  test.each([
    { name: '官方 DeepSeek', provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', pi: 'https://api.deepseek.com', claude: 'https://api.deepseek.com/anthropic' },
    { name: '第三方 DeepSeek', provider: 'deepseek' as const, baseUrl: 'https://gateway.fixture.invalid/v1', pi: 'https://gateway.fixture.invalid/v1', claude: 'https://gateway.fixture.invalid/v1' },
    { name: '本地 Ollama', provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', pi: 'http://127.0.0.1:11434/v1', claude: 'http://127.0.0.1:11434' },
    { name: 'Anthropic 默认', provider: 'anthropic' as const, baseUrl: '', pi: 'https://api.anthropic.com', claude: 'https://api.anthropic.com' },
  ])('Given $name 未配独立端点 When 解析 Then 保留协议推导', async ({ provider, baseUrl, pi, claude }) => {
    const value = channel({ provider, baseUrl, agentBaseUrl: undefined })
    expect(await resolveRuntimeCredentials(value, 'pi')).toMatchObject({ ok: true, credentials: { baseUrl: pi } })
    expect(await resolveRuntimeCredentials(value, 'claude')).toMatchObject({ ok: true, credentials: { baseUrl: claude } })
  })

  test('Given Anthropic 原生渠道 When 指定独立 Anthropic 端点 Then 两内核均使用它', async () => {
    const value = channel({ provider: 'anthropic-compatible' })
    for (const runtime of ['pi', 'claude'] as const) {
      expect(await resolveRuntimeCredentials(value, runtime)).toMatchObject({ ok: true, credentials: { baseUrl: value.agentBaseUrl } })
    }
  })

  test('Given 商业 Relay/直连 When 解析 Then Relay URL 与 Bearer 不受双端点回归影响', async () => {
    commercial = true
    const value = channel({ id: 'newapi-fixture' })
    expect(await resolveRuntimeCredentials(value, 'pi')).toMatchObject({
      ok: true, credentials: { apiKey: 'fixture-proxy-token', baseUrl: 'https://relay.fixture.invalid/v1/proxy', forceBearerAuth: true },
    })
    expect(await resolveRuntimeCredentials({ ...value, directDataPlane: true }, 'pi')).toMatchObject({
      ok: true, credentials: { apiKey: secret, baseUrl: value.baseUrl, forceBearerAuth: false },
    })
  })

  test('Given 解密/刷新失败 When 解析 Then 返回失败而不回退发送 JSON', async () => {
    decryptFails = true
    expect(await resolveRuntimeCredentials(channel(), 'pi')).toEqual({ ok: false, code: 'api_key_decrypt_failed' })
    codexFails = true
    expect(await resolveRuntimeCredentials(channel({ provider: 'openai-codex' }), 'pi')).toEqual({ ok: false, code: 'api_key_decrypt_failed' })
  })

  test.each([
    { provider: 'custom' as const, api: 'openai-completions', baseUrl: 'https://openai.fixture.invalid/v1' },
    { provider: 'openai-responses' as const, api: 'openai-responses', baseUrl: 'https://openai.fixture.invalid/v1' },
    { provider: 'deepseek' as const, api: 'openai-completions', baseUrl: 'https://deepseek.fixture.invalid/v1' },
    { provider: 'ollama' as const, api: 'openai-completions', baseUrl: 'https://ollama.fixture.invalid/v1' },
  ])('Given $provider 双端点 When 构造隔离 Pi 模型与 Claude env Then 协议地址各自正确', async ({ provider, api, baseUrl }) => {
    const value = channel({ provider, baseUrl })
    const pi = await resolveRuntimeCredentials(value, 'pi')
    const claude = await resolveRuntimeCredentials(value, 'claude')
    if (!pi.ok || !claude.ok) throw new Error('fixture resolve failed')
    const sdk = await import('@earendil-works/pi-coding-agent')
    const built = await buildModel(sdk, {
      ...buildPiRuntimeCredentialOptions(value.id, pi.credentials),
      sessionId: 'fixture-endpoint-session', prompt: 'Fixture', model: 'fixture-selected-model',
      permissionMode: 'plan', systemPrompt: 'Fixture', piAgentDir: '/tmp/fixture-pi', piSessionDir: '/tmp/fixture-pi-sessions',
    })
    expect(built.model.id).toBe('fixture-selected-model')
    expect(built.model.api).toBe(api)
    expect(built.model.baseUrl).toBe(baseUrl)
    const env: Record<string, string | undefined> = {}
    applySdkCredentials(env, claude.credentials.apiKey, claude.credentials.baseUrl, provider)
    expect(env.ANTHROPIC_BASE_URL).toBe(value.agentBaseUrl)
    expect(pi.credentials.codexOAuthCredentials).toBeUndefined()
  })
})

describe('普通 Codex Agent OAuth store 接线', () => {
  test('Given 已保存 JSON When 普通轮次构造 Pi 模型 Then 使用解析后的 OAuth store 并回写刷新', async () => {
    secret = JSON.stringify({ ...codex, access: 'fixture-old-access' })
    const result = await resolveRuntimeCredentials(channel({ provider: 'openai-codex' }), 'pi')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('fixture resolve failed')
    expect(result.credentials.apiKey).toBe(codex.access)
    expect(result.credentials.apiKey).not.toContain('{')
    expect(resolveCodex).toHaveBeenCalledWith('fixture-channel')
    const options = buildPiRuntimeCredentialOptions('fixture-channel', result.credentials)
    let store: CredentialStore | undefined
    const model = {
      id: 'gpt-5.5', name: 'Fixture Codex', api: 'openai-codex-responses' as const,
      provider: 'openai-codex', baseUrl: 'https://chatgpt.fixture.invalid/backend-api',
      reasoning: true, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000, maxTokens: 32_000,
    }
    const setKey = mock(async () => {})
    const sdk = {
      ModelRuntime: {
        create: async (createOptions: { credentials: CredentialStore; modelsPath: string | null; allowModelNetwork: boolean }) => {
          store = createOptions.credentials
          expect(createOptions.modelsPath).toBeNull()
          expect(createOptions.allowModelNetwork).toBe(false)
          return { getModel: () => model, getModels: () => [model], setRuntimeApiKey: setKey }
        },
      },
    } as unknown as Parameters<typeof buildModel>[0]
    const built = await buildModel(sdk, {
      ...options, sessionId: 'fixture-session', prompt: 'Fixture', permissionMode: 'plan',
      systemPrompt: 'Fixture', piAgentDir: '/tmp/fixture-pi', piSessionDir: '/tmp/fixture-pi-sessions', model: model.id,
    })
    expect(built.model.id).toBe(model.id)
    expect(setKey).not.toHaveBeenCalled()
    expect(await store?.read('openai-codex')).toEqual({ type: 'oauth', ...codex })
    const refreshed = { ...codex, access: 'fixture-new-access', refresh: 'fixture-new-refresh', expires: codex.expires + 3600 }
    await store?.modify('openai-codex', async () => ({ type: 'oauth', ...refreshed }))
    expect(persistCodex).toHaveBeenCalledTimes(1)
    expect(persistCodex).toHaveBeenCalledWith('fixture-channel', { type: 'oauth', ...refreshed })
    expect(await store?.read('openai-codex')).toMatchObject({ access: refreshed.access, accountId: codex.accountId })
  })

  test('Given Relay 恢复为普通 API key When 重建选项 Then 清除旧 OAuth store/callback', () => {
    const options = buildPiRuntimeCredentialOptions('fixture-channel', {
      apiKey: 'fixture-relay-token', provider: 'custom', baseUrl: 'https://relay.fixture.invalid/v1/proxy', forceBearerAuth: true,
    })
    expect(options.codexOAuthCredentials).toBeUndefined()
    expect(options.onCodexOAuthCredentialsRefreshed).toBeUndefined()
    expect(options.xaiOAuthCredentials).toBeUndefined()
    expect(options.onXaiOAuthCredentialsRefreshed).toBeUndefined()
  })
})
