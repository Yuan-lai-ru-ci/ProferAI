import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONTEXT_WINDOW,
  buildModel,
  buildPiRequestHeaders,
  getCodexCatalogModels,
  listCodexModels,
  requiresPromaUserAgent,
  resolvePiApiKey,
  stripAgentSdkContextSuffix,
} from './pi-model-registry'

describe('Pi runtime 智谱团队版认证', () => {
  test('Given 团队版复合凭据 When resolvePiApiKey Then 提取出真实 apiKey', () => {
    const secret = 'apiKey=model-key; bigmodel_organization=org; bigmodel_project=proj'

    expect(resolvePiApiKey('zhipu-coding-team', secret)).toBe('model-key')
  })

  test('Given 团队版 JSON 凭据 When resolvePiApiKey Then 提取出真实 apiKey', () => {
    const secret = '{"apiKey":"model-key","organization":"org","project":"proj"}'

    expect(resolvePiApiKey('zhipu-coding-team', secret)).toBe('model-key')
  })

  test('Given 团队版复合凭据 When buildPiRequestHeaders Then Bearer 头只含真实 token 且带 Proma UA', () => {
    const secret = 'apiKey=model-key; bigmodel_organization=org'
    const resolved = resolvePiApiKey('zhipu-coding-team', secret)

    const headers = buildPiRequestHeaders('zhipu-coding-team', resolved)

    expect(headers?.Authorization).toBe('Bearer model-key')
    expect(headers?.Authorization).not.toContain('organization')
    expect(headers?.['User-Agent']).toBeDefined()
  })

  test('Given zhipu-coding-team When requiresPromaUserAgent Then true', () => {
    expect(requiresPromaUserAgent('zhipu-coding-team')).toBe(true)
  })

  test.each(['kimi-coding', 'zhipu-coding', 'xiaomi-token-plan'] as const)('Given %s When requiresPromaUserAgent Then true', (provider) => {
      expect(requiresPromaUserAgent(provider)).toBe(true)
  })

  test('Given 普通 anthropic 渠道 When resolvePiApiKey Then 原样返回', () => {
    expect(resolvePiApiKey('anthropic', 'plain-key')).toBe('plain-key')
    expect(requiresPromaUserAgent('anthropic')).toBe(false)
  })
})

describe('Pi runtime 模型 ID [1m] 剥离', () => {
  test('Given 带 [1m] 后缀的模型 ID When strip Then 剥离后缀', () => {
    expect(stripAgentSdkContextSuffix('glm-5.2[1m]')).toBe('glm-5.2')
  })

  test('Given 大写 [1M] 后缀 When strip Then 大小写不敏感剥离', () => {
    expect(stripAgentSdkContextSuffix('glm-5.2[1M]')).toBe('glm-5.2')
  })

  test('Given 无后缀模型 ID When strip Then 原样返回', () => {
    expect(stripAgentSdkContextSuffix('glm-4.6')).toBe('glm-4.6')
  })

  test('Given [1m] 出现在中间(非结尾) When strip Then 不剥离', () => {
    expect(stripAgentSdkContextSuffix('foo[1m]-bar')).toBe('foo[1m]-bar')
  })

  test('Given undefined When strip Then 返回 undefined', () => {
    expect(stripAgentSdkContextSuffix(undefined)).toBeUndefined()
  })
})

describe('Pi runtime DeepSeek V4 1M 上下文', () => {
  test('Given DeepSeek provider 的 V4 Pro When catalog 未命中网关前缀 Then 仍注册 1M contextWindow', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-deepseek-v4',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'gateway/deepseek-v4-pro',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.id).toBe('gateway/deepseek-v4-pro')
    expect(result.model.contextWindow).toBe(1_000_000)
  })

  test('Given custom provider 填写完整 Chat Completions 端点 When 注册 Pi 模型 Then 保留协议根地址并使用保守窗口', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-custom-v4',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1/chat/completions',
      model: 'gateway/deepseek-v4-pro',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.baseUrl).toBe('https://gateway.example.com/v1')
    expect(result.model.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given anthropic-compatible provider 的 V4 When 未显式声明 1M Then 不继承全局 catalog 窗口', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-anthropic-compatible-v4',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'anthropic-compatible',
      baseUrl: 'https://gateway.example.com',
      model: 'deepseek-v4-pro',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given custom provider 显式配置 [1m] When Pi 剥离 SDK 后缀 Then 保留 1M 能力声明', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-custom-v4-explicit',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gateway/deepseek-v4-flash[1m]',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.id).toBe('gateway/deepseek-v4-flash')
    expect(result.model.contextWindow).toBe(1_000_000)
  })
})

describe('Pi runtime GLM-5.3 fallback and reasoning metadata', () => {
  test('Given GLM-5.3 is absent from the Pi catalog When registered for Zhipu Then preserves 1M context, 128K output, and official thinking toggle', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-glm-5.3',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.contextWindow).toBe(1_000_000)
    expect(result.model.maxTokens).toBe(131_072)
    expect(result.model.thinkingLevelMap).toMatchObject({
      minimal: null,
      low: null,
      medium: null,
      xhigh: null,
      max: null,
    })
    expect(result.model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: 'zai',
      zaiToolStream: true,
    })
  })

  test('Given GLM-5.3 on a Volcengine-compatible channel When registered Then caps output at that endpoint maximum', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-ark-glm-5.3',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'ark-coding-plan',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
      model: 'glm-5.3',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.contextWindow).toBe(1_000_000)
    expect(result.model.maxTokens).toBe(128_000)
  })
})

describe('Pi runtime OpenAI Completions 渠道', () => {
  test.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const)(
    'Given 官方渠道的 %s When buildModel Then 注册 1.05M 上下文窗口',
    async (model) => {
      const sdk = await import('@earendil-works/pi-coding-agent')
      const result = await buildModel(sdk, {
        sessionId: `session-official-${model}`,
        prompt: 'hi',
        apiKey: 'sk-test',
        provider: 'openai',
        channelId: 'newapi-8',
        baseUrl: 'https://team.example.com/v1/proxy',
        model,
        permissionMode: 'plan',
        systemPrompt: 'system',
        piAgentDir: '/tmp/pi-agent',
        piSessionDir: '/tmp/pi-session',
      })

      expect(result.model.contextWindow).toBe(1_050_000)
    },
  )

  test('Given 自配 OpenAI 的同名模型 When buildModel Then 保留 Pi catalog 的保守窗口', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-self-hosted-gpt',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'openai',
      channelId: 'user-openai-channel',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gpt-5.6-terra',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.contextWindow).toBe(272_000)
  })

  test('Given OpenAI 协议渠道 When buildModel Then 注册为 Pi OpenAI Completions 并保留 Base URL', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')

    for (const [provider, baseUrl] of [
      ['openai', 'https://gateway.example.com/v1'],
      ['opencode-go-openai', 'https://gateway.example.com/v1'],
      ['zhipu', 'https://gateway.example.com/api/paas/v4'],
      ['doubao', 'https://gateway.example.com/api/v3'],
      ['qwen', 'https://gateway.example.com/compatible-mode/v1'],
      ['custom', 'https://gateway.example.com/v1/chat/completions'],
    ] as const) {
      const result = await buildModel(sdk, {
        sessionId: `session-${provider}`,
        prompt: 'hi',
        apiKey: 'sk-test',
        provider,
        baseUrl,
        model: 'test-model',
        permissionMode: 'plan',
        systemPrompt: 'system',
        piAgentDir: '/tmp/pi-agent',
        piSessionDir: '/tmp/pi-session',
      })

      expect(result.model.api).toBe('openai-completions')
      expect(result.model.baseUrl).toBe(provider === 'custom' ? 'https://gateway.example.com/v1' : baseUrl)
    }
  })
})

describe('Pi runtime OpenAI Responses 渠道', () => {
  test('Given openai-responses 渠道 When buildModel Then 注册为 Pi openai-responses 协议', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-responses',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1/responses',
      model: 'gpt-5.1',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.id).toBe('gpt-5.1')
    expect(result.model.api).toBe('openai-responses')
    expect(result.model.baseUrl).toBe('https://api.openai.com/v1')
  })
})

describe('ChatGPT Codex 模型目录补丁', () => {
  test('Given Pi SDK 内置目录缺少 5.6 When listCodexModels Then 补齐 5.6 系列', async () => {
    const models = await listCodexModels()
    const ids = models.map((model) => model.id)

    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('gpt-5.6-terra')
    expect(ids).toContain('gpt-5.6-luna')
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('Given 选择 SDK 未收录的 5.6 模型 When buildModel Then 保留用户选择的模型 ID', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-1',
      prompt: 'hi',
      apiKey: 'oauth-access-token',
      provider: 'openai-codex',
      model: 'gpt-5.6-terra',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.id).toBe('gpt-5.6-terra')
    expect(result.model.provider).toBe('openai-codex')
  })

  test('Given Codex 补丁模型 When 读取目录 Then 使用 Codex Responses 协议和百万上下文', async () => {
    const models = await getCodexCatalogModels()
    const terra = models.find((model) => model.id === 'gpt-5.6-terra')

    expect(terra?.api).toBe('openai-codex-responses')
    expect(terra?.baseUrl).toBe('https://chatgpt.com/backend-api')
    expect(terra?.contextWindow).toBe(1_050_000)
    expect(terra?.maxTokens).toBe(128_000)
  })

  test('Given Pi SDK 内置 Codex 模型上下文过旧 When 读取目录 Then 使用当前 OpenAI 规格覆盖', async () => {
    const models = await getCodexCatalogModels()
    const byId = new Map(models.map((model) => [model.id, model.contextWindow]))

    expect(byId.get('gpt-5.4')).toBe(1_050_000)
    expect(byId.get('gpt-5.4-mini')).toBe(400_000)
    expect(byId.get('gpt-5.5')).toBe(1_050_000)
  })
})
