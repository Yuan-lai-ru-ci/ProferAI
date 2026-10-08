import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { normalizeAnthropicBaseUrlForSdk, normalizeOpenAIBaseUrlForSdk } from '@profer/core'

interface SdkClient { buildURL(path: string, query: undefined): string }
interface SdkConstructor { new(options: { apiKey: string; baseURL: string }): SdkClient }
// 从 Pi 实际依赖目录加载它使用的 SDK；只调用 URL 构建，不发请求。
const piUrl = import.meta.resolve('@earendil-works/pi-ai/compat')
const piRequire = createRequire(piUrl)
const OpenAI = piRequire('openai').default as SdkConstructor
const Anthropic = piRequire('@anthropic-ai/sdk').default as SdkConstructor

test('F20：本地 Pi 所用 SDK 字符串拼接会把请求路径放进 query/hash，helper 拒绝而不删除路由', () => {
  for (const [Constructor, normalize, path] of [
    [OpenAI, normalizeOpenAIBaseUrlForSdk, '/chat/completions'],
    [Anthropic, normalizeAnthropicBaseUrlForSdk, '/v1/messages'],
  ] as const) {
    for (const suffix of ['?route=fixture', '#fixture']) {
      const baseUrl = `https://fixture.invalid/v1${suffix}`
      const client = new Constructor({ apiKey: 'fixture-key', baseURL: baseUrl })
      const actual = new URL(client.buildURL(path, undefined))
      expect(actual.pathname).toBe('/v1')
      expect(() => normalize(baseUrl)).toThrow('query/hash')
    }
    const baseUrl = normalize(`https://fixture.invalid${path === '/chat/completions' ? '/v1' : ''}${path}`)
    const client = new Constructor({ apiKey: 'fixture-key', baseURL: baseUrl })
    expect(new URL(client.buildURL(path, undefined)).pathname).toBe(path === '/chat/completions' ? '/v1/chat/completions' : '/v1/messages')
  }
})
