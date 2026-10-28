import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONTEXT_WINDOW,
  applyModel1MContextPreference,
  buildModel,
  buildPiRequestHeaders,
  getCodexCatalogModels,
  listCodexModels,
  normalizePiApi,
  requiresPromaUserAgent,
  resolvePiApiKey,
  stripAgentSdkContextSuffix,
} from './pi-model-registry'
import { IsolatedInMemoryCredentialStore } from '../pi-model-runtime-options'

const BASE_PI_AGENT_OPTIONS = {
  prompt: 'hi',
  permissionMode: 'plan' as const,
  systemPrompt: 'system',
  piAgentDir: '/tmp/pi-agent',
  piSessionDir: '/tmp/pi-session',
}

describe('Pi runtime 临时凭据隔离', () => {
  test.each([
    {
      name: 'ChatGPT Codex',
      input: {
        ...BASE_PI_AGENT_OPTIONS,
        sessionId: 'session-codex-sync-error',
        apiKey: 'oauth-access-token',
        provider: 'openai-codex' as const,
        model: 'gpt-5.6-terra',
      },
    },
    {
      name: '普通 API Key 渠道',
      input: {
        ...BASE_PI_AGENT_OPTIONS,
        sessionId: 'session-openai-sync-error',
        apiKey: 'sk-test',
        provider: 'openai' as const,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.1',
      },
    },
  ])('Given $name 的 runtime key 同步失败 When buildModel Then 使用内存存储并向调用方抛出', async ({ input }) => {
    const synchronizationError = new Error('runtime key synchronization failed')
    let createOptions: Record<string, unknown> | undefined
    const sdk = {
      ModelRuntime: {
        create: async (options: Record<string, unknown>) => {
          createOptions = options
          return {
            setRuntimeApiKey: async () => {
              throw synchronizationError
            },
          }
        },
      },
    } as unknown as Parameters<typeof buildModel>[0]

    await expect(buildModel(sdk, input)).rejects.toBe(synchronizationError)
    expect(createOptions).toMatchObject({
      modelsPath: null,
      allowModelNetwork: false,
    })
    expect(createOptions?.credentials).toBeInstanceOf(IsolatedInMemoryCredentialStore)
  })
})

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

  test('Given Ollama Agent When resolving empty key Then use local sentinel', () => {
    expect(resolvePiApiKey('ollama', '  ')).toBe('ollama')
  })

  test('Given local Ollama Agent When building headers Then use local sentinel Bearer without User-Agent requirement', () => {
    const headers = buildPiRequestHeaders('ollama', 'ollama', 'http://127.0.0.1:11434')
    expect(headers?.Authorization).toBe('Bearer ollama')
    expect(headers?.['User-Agent']).toBeUndefined()
  })
})

describe('渠道模型 1M 偏好归一', () => {
  test('Given 强制开启 When 归一窗口 Then 至少 1M', () => {
    expect(applyModel1MContextPreference(500_000, true)).toBe(1_000_000)
    // 本来就大于 1M 的窗口（Codex 1.05M）不得被降下来
    expect(applyModel1MContextPreference(1_050_000, true)).toBe(1_050_000)
  })

  test('Given 强制关闭 When 归一窗口 Then 压回保守默认窗口', () => {
    expect(applyModel1MContextPreference(1_000_000, false)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(applyModel1MContextPreference(500_000, false)).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given 未设置或 null When 归一窗口 Then 保持原值', () => {
    expect(applyModel1MContextPreference(500_000, undefined)).toBe(500_000)
    expect(applyModel1MContextPreference(1_000_000, null)).toBe(1_000_000)
  })
})

describe('Pi runtime xAI API Key provider', () => {
  test('Given xAI API Key When buildModel Then 使用 Pi 内置 xai Responses 模型并隔离 runtime key', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      ...BASE_PI_AGENT_OPTIONS,
      sessionId: 'session-xai-api-key',
      apiKey: 'xai-test-key',
      provider: 'xai',
      xaiCredentialMode: 'api-key',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
    })

    expect(result.model.provider).toBe('xai')
    expect(result.model.api).toBe('openai-responses')
    expect(result.model.id).toBe('grok-4.6')
  })

  test('Given xAI 渠道模型勾选了 1M When buildModel Then 抬到 1M 窗口', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      ...BASE_PI_AGENT_OPTIONS,
      sessionId: 'session-xai-api-key-1m-on',
      apiKey: 'xai-test-key',
      provider: 'xai',
      xaiCredentialMode: 'api-key',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
      context1m: true,
    })

    expect(result.model.contextWindow).toBe(1_000_000)
  })

  test('Given xAI 渠道模型关掉了 1M When buildModel Then 压回保守窗口', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      ...BASE_PI_AGENT_OPTIONS,
      sessionId: 'session-xai-api-key-1m-off',
      apiKey: 'xai-test-key',
      provider: 'xai',
      xaiCredentialMode: 'api-key',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
      context1m: false,
    })

    expect(result.model.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given xAI Responses 中转站的未知模型 When buildModel Then 在隔离 runtime 注册该模型并复用中转 Base URL', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      ...BASE_PI_AGENT_OPTIONS,
      sessionId: 'session-xai-relay',
      apiKey: 'relay-test-key',
      provider: 'xai',
      xaiCredentialMode: 'api-key',
      baseUrl: 'https://relay.example.com/v1/responses',
      model: 'grok-4.6-relay',
    })

    expect(result.model.provider).toBe('xai')
    expect(result.model.api).toBe('openai-responses')
    expect(result.model.id).toBe('grok-4.6-relay')
    expect(result.model.baseUrl).toBe('https://relay.example.com/v1')
  })

  test('Given 只支持 Chat Completions 的 Grok 中转 When buildModel Then 注册 openai-completions 而非 Responses', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      ...BASE_PI_AGENT_OPTIONS,
      sessionId: 'session-xai-chat-completions',
      apiKey: 'relay-test-key',
      provider: 'xai',
      xaiCredentialMode: 'api-key',
      xaiApiProtocol: 'chat-completions',
      baseUrl: 'https://relay.example.com/v1/chat/completions',
      model: 'grok-4.3',
    })

    expect(result.model.provider).toBe('xai')
    expect(result.model.api).toBe('openai-completions')
    expect(result.model.id).toBe('grok-4.3')
    expect(result.model.baseUrl).toBe('https://relay.example.com/v1')
  })
})

describe('Pi runtime Ollama 双协议注册', () => {
  test('Given commercial Anthropic relay base URL When buildModel Then keep relay base without duplicating messages path', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-anthropic-relay',
      prompt: 'hi',
      apiKey: 'relay-token',
      provider: 'anthropic',
      baseUrl: 'https://team.example.com/v1/proxy',
      model: 'claude-opus-4-8',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('anthropic-messages')
    expect(result.model.baseUrl).toBe('https://team.example.com/v1/proxy')
  })

  test('Given 本机 Ollama channel When buildModel Then preserve Anthropic messages and root Agent URL', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-ollama',
      prompt: 'hi',
      apiKey: '',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:8b',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('anthropic-messages')
    expect(result.model.baseUrl).toBe('http://127.0.0.1:11434')
    expect(result.model.id).toBe('qwen3:8b')
  })

  test('Given 远程 Ollama 完整 Chat Completions 地址 When buildModel Then 不重复追加 /v1', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-ollama-remote-full-endpoint',
      prompt: 'hi',
      apiKey: '',
      provider: 'ollama',
      baseUrl: 'https://ollama.example.com/v1/chat/completions',
      model: 'qwen3:8b',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('openai-completions')
    expect(result.model.baseUrl).toBe('https://ollama.example.com/v1')
  })
  test('Given 远程 Ollama channel When buildModel Then use OpenAI completions with /v1 Base URL', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-ollama-remote',
      prompt: 'hi',
      apiKey: '',
      provider: 'ollama',
      baseUrl: 'https://ollama.example.com/v1/',
      model: 'qwen3:8b',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('openai-completions')
    expect(result.model.baseUrl).toBe('https://ollama.example.com/v1')
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

  test('Given DeepSeek 正式 ID deepseek-flash When 注册 Pi 模型 Then 沿用 catalog 元数据但保留原始模型 ID', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-deepseek-short-name',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    // 请求仍用用户填写的 ID（DeepSeek 上游与 Pi catalog 0.86 起的正式 ID 都是它），
    // 元数据直接取 catalog 条目。
    expect(result.model.id).toBe('deepseek-flash')
    expect(result.model.contextWindow).toBe(1_000_000)
    expect(result.model.maxTokens).toBe(384_000)
    // 0.86 catalog 的 deepseek-flash 是 DeepSeek V4.1 Flash，定价比旧代 deepseek-v4-flash
    // （$0.14/M 输入）高：$0.30/M。这里跟随上游报价，不保留旧代价格。
    expect(result.model.cost.input).toBe(0.3)
    expect(result.model.reasoning).toBe(true)
  })

  test('Given DeepSeek 旧代写法 deepseek-v4-flash When 注册 Pi 模型 Then 归一后仍拿到含图片能力的 catalog 元数据', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-deepseek-legacy-id',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    // 渠道里仍可能填 0.86 之前的写法：元数据必须归一到新 catalog 条目，
    // 尤其是 input 含 image——这直接决定 DeepSeek 能否收到图片而不是被降级成占位文本。
    expect(result.model.id).toBe('deepseek-v4-flash')
    expect(result.model.input).toContain('image')
    expect(result.model.contextWindow).toBe(1_000_000)
    expect(result.model.maxTokens).toBe(384_000)
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

  test('Given 渠道模型勾选了 1M When 未验证的第三方网关 Then 也按 1M 注册窗口', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-custom-v4-toggled-on',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gateway/deepseek-v4-pro',
      context1m: true,
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.id).toBe('gateway/deepseek-v4-pro')
    expect(result.model.contextWindow).toBe(1_000_000)
  })

  test('Given 渠道模型关掉了 1M When 官方 DeepSeek V4 Then 退回保守窗口', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-deepseek-v4-toggled-off',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      context1m: false,
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

describe('Pi runtime DeepSeek 双协议端点判定', () => {
  // 背景：DeepSeek 同时提供 OpenAI 兼容与 Anthropic 兼容两套入口。旧实现把协议写死在
  // provider 上（deepseek → anthropic-messages），导致把 DeepSeek 渠道指向只提供
  // OpenAI 端点的第三方网关时，Agent 会向它发送 /v1/messages，完全不可用；
  // 而 Chat 走 OpenAI 适配器却正常，两者不一致。
  test('Given 端点形态不同 When 判定协议 Then 跟随端点而非 provider', () => {
    expect(normalizePiApi('deepseek', 'https://api.deepseek.com/anthropic')).toBe('anthropic-messages')
    expect(normalizePiApi('deepseek', 'https://gateway.example.com/anthropic')).toBe('anthropic-messages')
    expect(normalizePiApi('deepseek', 'https://gateway.example.com/v1')).toBe('openai-completions')
    expect(normalizePiApi('deepseek', 'https://gateway.example.com/v1/chat/completions')).toBe('openai-completions')
    // 缺省地址（未配置 / 历史配置）保持官方 Anthropic 行为
    expect(normalizePiApi('deepseek', undefined)).toBe('anthropic-messages')
    expect(normalizePiApi('deepseek', '')).toBe('anthropic-messages')
    // 商业代管 relay 由服务端路由决定协议，不得按端点形态改写
    expect(normalizePiApi('deepseek', 'https://server.example/v1/proxy')).toBe('anthropic-messages')
  })

  test('Given 第三方 OpenAI 兼容网关 When 注册 Pi 模型 Then 使用 openai-completions 且保留协议根地址', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-deepseek-thirdparty',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'deepseek',
      baseUrl: 'https://api.kakouai.com/v1',
      model: 'deepseek-v4.1-flash',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('openai-completions')
    expect(result.model.baseUrl).toBe('https://api.kakouai.com/v1')
  })

  test('Given 第三方网关但填写完整 Chat Completions 端点 When 注册 Pi 模型 Then 还原为协议根地址', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-deepseek-thirdparty-full',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'deepseek',
      baseUrl: 'https://gateway.example.com/v1/chat/completions',
      model: 'deepseek-v4.1-flash',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('openai-completions')
    expect(result.model.baseUrl).toBe('https://gateway.example.com/v1')
  })

  test('Given 端点不同 When 构建 Pi 请求头 Then 仅 Anthropic 端点附带 Anthropic 专用头', () => {
    // 第三方 OpenAI 端点必须交给 Pi 自带认证，不能带 Anthropic 专用头。
    expect(buildPiRequestHeaders('deepseek', 'sk-test', 'https://gateway.example.com/v1')).toBeUndefined()
    expect(buildPiRequestHeaders('deepseek', 'sk-test', 'https://api.deepseek.com/anthropic')).toMatchObject({
      Authorization: 'Bearer sk-test',
    })
  })

  test('Given DeepSeek 官方 Anthropic 入口 When 注册 Pi 模型 Then 保持 anthropic-messages', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-deepseek-official',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('anthropic-messages')
    expect(result.model.baseUrl).toBe('https://api.deepseek.com/anthropic')
  })
})

describe('Pi runtime Claude adaptive thinking metadata', () => {
  test('Given Claude Haiku 5.5 on an Anthropic channel When registered Then forces adaptive thinking and omits disabled thinking', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-claude-haiku-5-5',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'anthropic',
      baseUrl: 'https://www.anzhiyu.com/',
      model: 'claude-haiku-5-5',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('anthropic-messages')
    expect(result.model.compat).toMatchObject({ forceAdaptiveThinking: true })
    // off=null 让 Pi 省略 thinking 字段，而不是发送这些模型不接受的 disabled。
    expect(result.model.thinkingLevelMap).toMatchObject({ off: null, low: 'low', high: 'high', max: 'max' })
  })

  test('Given Claude Haiku 4.5 When registered Then keeps the legacy manual thinking path', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-claude-haiku-4-5',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'anthropic',
      baseUrl: 'https://www.anzhiyu.com/',
      model: 'claude-haiku-4-5',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.compat ?? {}).not.toMatchObject({ forceAdaptiveThinking: true })
  })
})

describe('Pi runtime GLM-5.3 fallback and reasoning metadata', () => {
  test('Given GLM-5.3 When registered for Zhipu Then uses the official low/high/max reasoning_effort encoding', async () => {
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
    // 官方文档：GLM-5.3 思考强制开启，reasoning_effort 为 low / high / max。
    expect(result.model.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: 'low',
      low: 'low',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
      max: 'max',
    })
    expect(result.model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
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

    // 火山 coding plan 在 Pi catalog 里没有专属 provider 条目，走全局兜底命中第三方条目：
    // 0.86 起该模型被记为 1MiB（1048576）而非 1M（1000000）。两者都满足 Profer 的 1M 下界，
    // 差异只影响展示与压缩阈值的尾数，因此跟随 catalog 声明值。
    expect(result.model.contextWindow).toBe(1_048_576)
    expect(result.model.maxTokens).toBe(128_000)
  })
})

describe('Pi runtime Kimi 模型数据补齐', () => {
  test('Given Kimi K3.1 Pro 尚未进 catalog When 注册到 Kimi API Then 按官方规格补齐窗口 / 输出 / 价格', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-kimi-k3.1-pro',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'kimi-api',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      model: 'kimi-k3.1-pro',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.contextWindow).toBe(1_048_576)
    expect(result.model.maxTokens).toBe(131_072)
    expect(result.model.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 })
    expect(result.model.input).toEqual(['text', 'image'])
    // K3 代际思考始终开启，只暴露 low / high / max。
    expect(result.model.thinkingLevelMap).toMatchObject({ off: null, low: 'low', high: 'high', max: 'max' })
  })

  test('Given Kimi K3 命中 profile When 注册 Then 保留 catalog 的 reasoning_content 回传要求', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-kimi-k3',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'kimi-api',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      model: 'kimi-k3',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    // profile 只负责档位编码，不能把 catalog 的 thinkingFormat / reasoning_content 要求覆盖掉。
    expect(result.model.compat).toMatchObject({ forceAdaptiveThinking: true })
  })

  test('Given Kimi K2.6 开关模型 When 注册 Then 保留 catalog 的 deepseek thinking 格式', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-kimi-k2.6',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'kimi-api',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      model: 'kimi-k2.6',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.thinkingLevelMap).toMatchObject({
      minimal: null,
      low: null,
      medium: null,
      xhigh: null,
      max: null,
    })
    expect(result.model.thinkingLevelMap?.off).toBeUndefined()
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

  test('Given OpenAI 兼容渠道填了完整 /responses 端点 When buildModel Then 按 Responses 协议注册', async () => {
    // 用户照网关文档把 `…/v1/responses` 直接填进渠道：端点形态必须覆盖静态协议，
    // 否则 Agent 会向 Responses 端点发 Chat Completions 请求体。
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-custom-responses',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'custom',
      baseUrl: 'https://codex.diraw.top/v1/responses',
      model: 'gpt-6-luna',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('openai-responses')
    expect(result.model.baseUrl).toBe('https://codex.diraw.top/v1')
  })
})

describe('ChatGPT Codex 模型目录补丁', () => {
  test('Given Codex 目录含 Astra When 列出 Then 所有条目都使用 Codex provider/协议/端点', async () => {
    const models = await getCodexCatalogModels()
    expect(models.some((model) => model.id === 'gpt-6-astra')).toBe(true)
    for (const model of models) {
      expect(model.provider).toBe('openai-codex')
      expect(model.api).toBe('openai-codex-responses')
      expect(model.baseUrl).toBe('https://chatgpt.com/backend-api')
    }
  })

  test('Given Pi SDK 内置目录缺少 5.6 When listCodexModels Then 补齐 5.6 系列', async () => {
    const models = await listCodexModels()
    const ids = models.map((model) => model.id)

    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('gpt-5.6-terra')
    expect(ids).toContain('gpt-5.6-luna')
    expect(ids).toContain('gpt-6-astra')
    // GPT-6.1 Sol 尚未进 Pi catalog，必须由 Profer 补丁补回，否则 Codex 用户看不到该型号。
    expect(ids).toContain('gpt-6.1-sol')
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('Given gpt-6.1-sol When 读取 Codex 目录 Then 使用官方 1.05M / 128K 与 GPT-6 档位', async () => {
    const models = await getCodexCatalogModels()
    const sol = models.find((model) => model.id === 'gpt-6.1-sol')

    expect(sol?.name).toBe('GPT-6.1 Sol')
    expect(sol?.contextWindow).toBe(1_050_000)
    expect(sol?.maxTokens).toBe(128_000)
    expect(sol?.cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 })
    // GPT-6 代际不支持 none / minimal。
    expect(sol?.thinkingLevelMap).toMatchObject({ off: null, minimal: 'low', low: 'low', max: 'max' })
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
    expect(result.model.contextWindow).toBe(1_050_000)
    expect(result.model.contextWindow).toBe(1_050_000)
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

    // 0.86 起上游 catalog 已移除 gpt-5.4 / gpt-5.4-mini：Profer 的窗口补丁只覆盖目录里仍存在的
    // 条目，不会凭空补回上游删掉的模型。
    expect(byId.has('gpt-5.4')).toBe(false)
    expect(byId.has('gpt-5.4-mini')).toBe(false)
    // 仍在目录里的同代模型必须被覆盖为当前 OpenAI 规格（上游内置值只有 272000）。
    expect(byId.get('gpt-5.5')).toBe(1_050_000)
    expect(byId.get('gpt-6-astra')).toBe(1_050_000)
  })
})

describe('Pi runtime OpenAI 兼容渠道 finish_reason 兜底', () => {
  /** model.compat 是各协议兼容位的联合类型，这里只取 OpenAI 侧的字段读值。 */
  const openAiCompat = (model: { compat?: unknown }): { supportsFinishReason?: boolean; supportsReasoningEffort?: boolean } | undefined =>
    model.compat as { supportsFinishReason?: boolean; supportsReasoningEffort?: boolean } | undefined

  test('Given 用户自配 OpenAI 兼容渠道 When 注册模型 Then 关闭 finish_reason 校验并保留推理兼容位', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-custom-finish-reason',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gpt-5.6',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    // 网关可能不发 finish_reason：缺了也不能让整轮失败。
    expect(openAiCompat(result.model)?.supportsFinishReason).toBe(false)
    // 推理档位能力不能被这次兜底覆盖掉。
    expect(openAiCompat(result.model)?.supportsReasoningEffort).toBe(true)
  })

  test('Given 官方 OpenAI 渠道 When 注册模型 Then 保持 finish_reason 校验默认行为', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-official-openai',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(openAiCompat(result.model)?.supportsFinishReason).not.toBe(false)
  })

  test('Given Anthropic 协议的兼容渠道 When 注册模型 Then 不注入 OpenAI 专属兼容位', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const result = await buildModel(sdk, {
      sessionId: 'session-anthropic-compat-finish-reason',
      prompt: 'hi',
      apiKey: 'sk-test',
      provider: 'anthropic-compatible',
      baseUrl: 'https://gateway.example.com',
      model: 'claude-opus-4-8',
      permissionMode: 'plan',
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(result.model.api).toBe('anthropic-messages')
    expect(openAiCompat(result.model)?.supportsFinishReason).not.toBe(false)
  })
})
