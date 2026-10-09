import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PROVIDER_CAPABILITIES, PROVIDER_DEFAULT_URLS, PROVIDER_LABELS, getProviderChatProtocol, inferAgentRuntimeModes, isChannelEnabledForChat, isChannelEnabledForRuntime, type ProviderType } from '@profer/shared'
import { getAdapter } from '@profer/core'

// 测试用的协议标签从能力描述符派生（单一事实源），不再维护私有副本。
// Chat adapter 维度的分类与 chatProtocol 对齐；Codex 无 Chat adapter 单列 'oauth'，
// xAI 用 Responses adapter，Ollama 有自己的 adapter，均按测试原语义标注。
const nativeProtocols = Object.fromEntries(
  (Object.keys(PROVIDER_CAPABILITIES) as ProviderType[]).map((provider) => {
    if (provider === 'openai-codex') return [provider, 'oauth']
    if (provider === 'xai') return [provider, 'responses']
    if (provider === 'ollama') return [provider, 'ollama']
    // Chat adapter 维度：deepseek 走 OpenAI 兼容（chatProtocol=openai），
    // openai-responses 的 Chat 也是 responses adapter，单独标出。
    if (provider === 'openai-responses') return [provider, 'responses']
    const chatProtocol = getProviderChatProtocol(provider)
    return [provider, chatProtocol === 'anthropic' ? 'anthropic' : chatProtocol === 'google' ? 'google' : 'openai']
  }),
) as Record<ProviderType, string>
const requests: Array<{ url: string; init: RequestInit }> = []
let payload: unknown
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('./proxy-fetch', () => ({ getFetchFn: () => async (url: string | URL, init: RequestInit) => {
  requests.push({ url: String(url), init })
  return new Response(JSON.stringify(payload), { status: 200 })
} }))
mock.module('./codex-oauth-service', () => ({ loginCodexOAuth: async () => { throw new Error('禁止真实 OAuth') }, refreshCodexOAuth: async () => { throw new Error('禁止真实 OAuth') } }))
mock.module('./xai-oauth-service', () => ({ refreshXaiOAuth: async () => { throw new Error('禁止真实 OAuth') } }))
const { fetchModels, testChannelDirect } = await import('./channel-manager')
const { normalizePiApi } = await import('./adapters/pi-model-registry')
const source = readFileSync(new URL('../../renderer/components/chat/ModelSelector.tsx', import.meta.url), 'utf8')
const start = source.indexOf('function buildModelOptions(')
const end = source.indexOf('/** 按渠道分组模型选项 */', start)
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
const selector = new Function('isChannelEnabledForChat', 'getChannelProtocol', 'supportsChannelProtocol', 'getChannelSource', `${js}; return buildModelOptions`)(
  isChannelEnabledForChat, () => 'openai', (channel: Parameters<typeof isChannelEnabledForRuntime>[0], protocol: string) => isChannelEnabledForRuntime(channel, protocol === 'anthropic' ? 'claude' : 'pi'), () => 'self-configured',
) as (channels: unknown[], id?: string, ids?: string[], protocol?: string, strict?: boolean) => unknown[]

describe('F10/F13/F19：23 Provider 表驱动本地协议矩阵', () => {
  test('枚举、默认 URL、标签、设置入口覆盖一致；Chat adapter 只有 Codex 明确缺席', () => {
    expect(Object.keys(nativeProtocols)).toHaveLength(23)
    expect(Object.keys(nativeProtocols).sort()).toEqual(Object.keys(PROVIDER_LABELS).sort())
    expect(Object.keys(PROVIDER_DEFAULT_URLS).sort()).toEqual(Object.keys(nativeProtocols).sort())
    const form = readFileSync(new URL('../../renderer/components/settings/ChannelForm.tsx', import.meta.url), 'utf8')
    const options = form.match(/const (?:CN|GLOBAL)_PROVIDERS: ProviderType\[\] = \[([^\]]+)\]/g)!
    const listed = [...options.join('').matchAll(/'([^']+)'/g)].map((match) => match[1]!)
    expect(listed.sort()).toEqual(Object.keys(nativeProtocols).sort())
  })

  for (const [id, protocol] of Object.entries(nativeProtocols)) {
    const provider = id as ProviderType
    test(`${provider}：认证/目录/生成/Chat/Pi/Claude 均沿用实际 adapter`, async () => {
      const baseUrl = provider === 'anthropic-compatible' ? 'https://fixture.invalid/v1/messages'
        : provider === 'custom' ? 'https://fixture.invalid/v1/chat/completions'
        : provider === 'google' ? 'https://fixture.invalid' : 'https://fixture.invalid/v1'
      const apiKey = provider === 'zhipu-coding-team' ? 'api_key=fixture-key;organization=fixture-org' : 'fixture-key'
      const channel = { provider, enabled: true, agentRuntimes: ['pi', 'claude'] as Array<'pi' | 'claude'> }
      expect(isChannelEnabledForChat(channel)).toBe(provider !== 'openai-codex')
      expect(isChannelEnabledForRuntime(channel, 'pi')).toBe(true)
      expect(isChannelEnabledForRuntime(channel, 'claude')).toBe(provider !== 'xai' && provider !== 'openai-codex')
      expect(inferAgentRuntimeModes({ provider }).includes('pi')).toBe(provider !== 'xai')
      if (protocol === 'oauth') {
        expect(() => getAdapter(provider)).toThrow()
        requests.length = 0
        expect((await fetchModels({ provider, baseUrl: '', apiKey: '' })).success).toBe(false)
        expect((await testChannelDirect({ provider, baseUrl: '', apiKey: '' })).success).toBe(false)
        expect(requests).toHaveLength(0)
        return
      }
      const adapter = getAdapter(provider)
      expect(adapter.providerType).toBe(provider)
      const stream = adapter.buildStreamRequest({ baseUrl, apiKey, modelId: 'fixture-model', userMessage: 'fixture', history: [], readImageAttachments: () => [] })
      expect(stream.url).toContain(protocol === 'anthropic' ? '/messages' : protocol === 'responses' ? '/responses' : protocol === 'google' ? ':streamGenerateContent' : '/chat/completions')
      if (provider === 'zhipu-coding-team') {
        expect(stream.headers.Authorization).toBe('Bearer fixture-key')
        expect(stream.headers['x-api-key']).toBeUndefined()
      }
      if (!['xai', 'ollama'].includes(provider)) expect(normalizePiApi(provider, baseUrl)).toBe(protocol === 'anthropic' ? 'anthropic-messages' : protocol === 'google' ? 'google-generative-ai' : protocol === 'responses' ? 'openai-responses' : 'openai-completions')
      requests.length = 0
      payload = protocol === 'google' ? { models: [{ name: 'models/fixture-model', supportedGenerationMethods: ['generateContent'] }] }
        : protocol === 'ollama' ? { models: [{ name: 'fixture-model' }] } : { data: [{ id: 'fixture-model' }] }
      expect((await fetchModels({ provider, baseUrl, apiKey })).success).toBe(true)
      expect((await testChannelDirect({ provider, baseUrl, apiKey })).success).toBe(true)
      expect(requests).toHaveLength(2)
      expect(requests[0]!.url).toBe(requests[1]!.url)
      payload = protocol === 'anthropic' || protocol === 'ollama' ? { content: [{ type: 'text', text: 'fixture' }] }
        : protocol === 'google' ? { candidates: [{ content: { parts: [{ text: 'fixture' }] } }] }
          : protocol === 'responses' ? { output: [{ type: 'message', content: [{ text: 'fixture' }] }] } : { choices: [{ message: { content: 'fixture' } }] }
      expect((await testChannelDirect({ provider, baseUrl, apiKey, modelId: 'fixture-model' })).success).toBe(true)
      if (provider === 'zhipu-coding-team') for (const { init } of requests) expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-key')
    })
  }

  test('真实 ModelSelector：Chat 排除订阅，Pi 保留订阅，Claude 拒绝 xAI/Codex', () => {
    const common = { enabled: true, apiKey: 'fixture-encrypted', models: [{ id: 'fixture-model', enabled: true, name: 'Fixture' }], agentRuntimes: ['pi', 'claude'] }
    const channels = [
      { ...common, id: 'fixture-codex', provider: 'openai-codex' },
      { ...common, id: 'fixture-xai-oauth', provider: 'xai', credentialMode: 'oauth' },
      { ...common, id: 'fixture-xai-key', provider: 'xai', credentialMode: 'api-key' },
      { ...common, id: 'fixture-openai', provider: 'openai' },
    ]
    expect(selector(channels)).toHaveLength(2)
    expect(selector(channels, undefined, undefined, 'openai', true)).toHaveLength(4)
    expect(selector(channels, undefined, undefined, 'anthropic', true)).toHaveLength(1)
  })
})
