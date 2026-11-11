import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

let credentials = { provider: 'openai' as 'openai' | 'xai', mode: 'official' as 'official' | 'byok', apiKey: '', baseUrl: '', model: '' }
let auth: { baseUrl: string; token: string } | null = {
  baseUrl: 'https://team.example/',
  token: 'team-token',
}
let legacyCredentials: Record<string, string> = {}

mock.module('./chat-tool-config', () => ({
  getGptImageCredentials: () => credentials,
  getToolCredentials: () => legacyCredentials,
}))
// 账号能力已收口到发行版契约：mock 接缝从 auth-service 移到 ./edition。
mock.module('./edition', () => ({
  editionProviders: {
    id: 'commercial',
    account: {
      getSession: async () => auth,
      recoverSession: async () => auth,
      getSessionSnapshot: () => auth,
      getSessionGeneration: () => (auth ? 1 : null),
      refreshSession: async () => true,
      restoreSession: async () => false,
      scheduleAutoRefresh: () => {},
      getMembership: () => ({ commercialMode: true, membershipTier: 'pro', canSelfConfig: true }),
    },
    credentials: {
      shouldUseManagedRoute: () => true,
      shouldUseBearerAuth: () => true,
      managedPath: (kind: string) =>
        ({ messages: '/v1/proxy/messages', chat: '/v1/proxy/chat', images: '/v1/proxy/images/generations', imageEdits: '/v1/proxy/images/edits', root: '/v1/proxy' } as Record<string, string>)[kind] ?? '',
      managedImageOperationPath: (operation: string, key: string) =>
        `/v1/proxy/images/operations/by-idempotency/${operation}/${key}`,
    },
    errors: { detectInsufficientCredits: () => null },
    remote: { getRelayTicket: async () => null },
    registerIpc: () => {},
  },
}))

const { testGptImageConnection, testLegacyImageToolConnection } = await import('./gpt-image-connection')
const originalFetch = globalThis.fetch

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  credentials = { provider: 'openai', mode: 'official', apiKey: '', baseUrl: '', model: '' }
  auth = { baseUrl: 'https://team.example/', token: 'team-token' }
  legacyCredentials = {}
})

describe('GPT Image 连接测试', () => {
  test('官方模式不要求 OpenAI API Key，使用团队账号健康接口', async () => {
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(new Request(input, init))
      return jsonResponse({ commercialMode: true, channels: [] })
    }) as typeof fetch

    await expect(testGptImageConnection()).resolves.toEqual({
      success: true,
      message: '连接成功，Profer 官方生图服务可用',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://team.example/v1/account/channels/health')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer team-token')
  })

  test('官方模式未登录时提示登录而不是 API Key', async () => {
    auth = null
    globalThis.fetch = (async () => {
      throw new Error('不应发起网络请求')
    }) as unknown as typeof fetch

    await expect(testGptImageConnection()).resolves.toEqual({
      success: false,
      message: '请先登录 Profer 团队账号',
    })
  })

  test('官方模式账号失效时提示重新登录', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'unauthorized' }, 401)) as unknown as typeof fetch

    await expect(testGptImageConnection()).resolves.toEqual({
      success: false,
      message: 'Profer 团队账号登录已失效，请重新登录',
    })
  })

  test('自带 Key 模式仍使用 OpenAI Images models 接口', async () => {
    credentials = {
      provider: 'openai',
      mode: 'byok',
      apiKey: 'sk-test',
      baseUrl: 'https://byok.example/',
      model: 'custom-image',
    }
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(new Request(input, init))
      return jsonResponse({ data: [] })
    }) as typeof fetch

    await expect(testGptImageConnection()).resolves.toEqual({
      success: true,
      message: '连接成功，OpenAI Images API 可用',
    })
    expect(calls[0]!.url).toBe('https://byok.example/v1/models')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-test')
  })

  test('xAI Grok 模式会去掉用户填写地址末尾的 /v1', async () => {
    credentials = {
      provider: 'xai',
      mode: 'byok',
      apiKey: 'xai-test',
      baseUrl: 'https://api.x.ai/v1/',
      model: 'grok-imagine-image-2.0',
    }
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(new Request(input, init))
      return jsonResponse({ data: [] })
    }) as typeof fetch

    await expect(testGptImageConnection()).resolves.toEqual({
      success: true,
      message: '连接成功，xAI Grok Images API 可用',
    })
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/models')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer xai-test')
  })

  test('旧版 nano-banana 测试仍要求 OpenAI API Key', async () => {
    legacyCredentials = { apiKey: 'sk-legacy', baseUrl: 'https://legacy.example/' }
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(new Request(input, init))
      return jsonResponse({ data: [] })
    }) as typeof fetch

    await expect(testLegacyImageToolConnection('nano-banana')).resolves.toEqual({
      success: true,
      message: '连接成功，OpenAI API 可用',
    })
    expect(calls[0]!.url).toBe('https://legacy.example/v1/models')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-legacy')
  })
})
