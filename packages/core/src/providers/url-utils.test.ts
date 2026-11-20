import { test, expect, describe } from 'bun:test'
import {
  normalizeAnthropicBaseUrl,
  normalizeVersionedAnthropicBaseUrl,
  normalizeAnthropicBaseUrlForSdk,
  normalizeOpenAIBaseUrlForSdk,
  normalizeBaseUrl,
  normalizeGoogleBaseUrl,
  normalizeAnthropicProviderUrl,
  resolveOpenAIChatCompletionsUrl,
  resolveOpenAIResponsesUrl,
  resolveOpenAIModelsUrl,
  resolveAnthropicMessagesUrl,
  resolveAnthropicModelsUrl,
  migrateCompatibleChannelBaseUrl,
} from './url-utils.ts'

describe('normalizeAnthropicBaseUrl', () => {
  test('纯域名追加 /v1', () => {
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1')
  })

  test('已有 /v1 保持不变', () => {
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1')
  })

  test('去除尾部斜杠并保留版本号', () => {
    expect(normalizeAnthropicBaseUrl('https://proxy.example.com/v2/')).toBe('https://proxy.example.com/v2')
  })

  test('去除误填的 /messages 后缀', () => {
    expect(normalizeAnthropicBaseUrl('https://proxy.example.com/v1/messages')).toBe('https://proxy.example.com/v1')
    expect(normalizeAnthropicBaseUrl('https://proxy.example.com/v1/messages/')).toBe('https://proxy.example.com/v1')
  })

  test('已有非版本路径保持原样（不追加 /v1）', () => {
    expect(normalizeAnthropicBaseUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com/anthropic')
  })
})

describe('normalizeVersionedAnthropicBaseUrl', () => {
  test('协议根路径追加 /v1', () => {
    expect(normalizeVersionedAnthropicBaseUrl('https://api.minimaxi.com/anthropic')).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    )
  })

  test('已含 /v1 的路径不重复追加', () => {
    expect(normalizeVersionedAnthropicBaseUrl('https://api.kimi.com/coding/v1')).toBe('https://api.kimi.com/coding/v1')
  })

  test('去除误填的 /messages 后缀并保留版本号', () => {
    expect(normalizeVersionedAnthropicBaseUrl('https://api.minimaxi.com/anthropic/v1/messages')).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    )
  })

  test('纯域名追加 /v1', () => {
    expect(normalizeVersionedAnthropicBaseUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1')
  })
})

describe('normalizeAnthropicBaseUrlForSdk', () => {
  test('纯域名保持不变', () => {
    expect(normalizeAnthropicBaseUrlForSdk('https://api.anthropic.com')).toBe('https://api.anthropic.com')
  })

  test('去除 /v1 后缀', () => {
    expect(normalizeAnthropicBaseUrlForSdk('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com')
  })

  test('去除 /v1/messages 后缀', () => {
    expect(normalizeAnthropicBaseUrlForSdk('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com')
  })

  test('保留 /anthropic 协议根路径', () => {
    expect(normalizeAnthropicBaseUrlForSdk('https://gateway.example.com/anthropic/v1/messages')).toBe(
      'https://gateway.example.com/anthropic',
    )
    expect(normalizeAnthropicBaseUrlForSdk('https://gateway.example.com/anthropic/')).toBe(
      'https://gateway.example.com/anthropic',
    )
  })
})

describe('normalizeOpenAIBaseUrlForSdk', () => {
  test('去除 Responses 中转站完整端点，供 Pi runtime 重新拼接', () => {
    expect(normalizeOpenAIBaseUrlForSdk('https://relay.example.com/grok/v1/responses')).toBe('https://relay.example.com/grok/v1')
  })

  test('去除完整 /chat/completions 端点', () => {
    expect(normalizeOpenAIBaseUrlForSdk('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1')
  })
})

describe('normalizeBaseUrl', () => {
  test('仅去除尾部斜杠', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
  })
})

describe('normalizeGoogleBaseUrl', () => {
  test('剥掉误填的版本段，统一回到协议根', () => {
    expect(normalizeGoogleBaseUrl('https://api.fluxlane.cn/v1')).toBe('https://api.fluxlane.cn')
    expect(normalizeGoogleBaseUrl('https://api.fluxlane.cn/v1/')).toBe('https://api.fluxlane.cn')
    expect(normalizeGoogleBaseUrl('https://api.fluxlane.cn')).toBe('https://api.fluxlane.cn')
    // Google 文档与部分网关直接给 /v1beta，不剥会拼成 /v1beta/v1beta
    expect(normalizeGoogleBaseUrl('https://api.fluxlane.cn/v1beta')).toBe('https://api.fluxlane.cn')
    expect(normalizeGoogleBaseUrl('https://api.fluxlane.cn/v1beta/')).toBe('https://api.fluxlane.cn')
    expect(normalizeGoogleBaseUrl('https://api.fluxlane.cn/v1beta/models')).toBe('https://api.fluxlane.cn')
    // 自定义前缀保留，只剥版本段
    expect(normalizeGoogleBaseUrl('https://gw.example.com/tenant/v1beta')).toBe('https://gw.example.com/tenant')
    expect(normalizeGoogleBaseUrl('https://api.fluxlane.cn/v1/?route=fixture#anchor')).toBe('https://api.fluxlane.cn?route=fixture#anchor')
  })
})

describe('normalizeAnthropicProviderUrl', () => {
  // 回归测试：deepseek / kimi-api 的默认 /anthropic 端点必须补 /v1，
  // 否则 Chat 模式拼出 .../anthropic/messages 会 404。
  test('deepseek 默认端点补全 /v1', () => {
    const url = normalizeAnthropicProviderUrl('https://api.deepseek.com/anthropic', 'deepseek')
    expect(url).toBe('https://api.deepseek.com/anthropic/v1')
    // 拼接 /messages 后得到正确的完整端点
    expect(`${url}/messages`).toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  test('kimi-api 默认端点补全 /v1', () => {
    const url = normalizeAnthropicProviderUrl('https://api.moonshot.cn/anthropic', 'kimi-api')
    expect(url).toBe('https://api.moonshot.cn/anthropic/v1')
    expect(`${url}/messages`).toBe('https://api.moonshot.cn/anthropic/v1/messages')
  })

  test('kimi-coding 默认端点已含 /v1，不重复追加', () => {
    const url = normalizeAnthropicProviderUrl('https://api.kimi.com/coding/v1', 'kimi-coding')
    expect(url).toBe('https://api.kimi.com/coding/v1')
    expect(`${url}/messages`).toBe('https://api.kimi.com/coding/v1/messages')
  })

  test('用户手动填写不带 /v1 的 kimi-coding 地址也会补全', () => {
    const url = normalizeAnthropicProviderUrl('https://api.kimi.com/coding', 'kimi-coding')
    expect(url).toBe('https://api.kimi.com/coding/v1')
  })

  test('Ollama 根地址与 /v1 地址均规范为 Anthropic /v1', () => {
    expect(normalizeAnthropicProviderUrl('http://127.0.0.1:11434', 'ollama')).toBe('http://127.0.0.1:11434/v1')
    expect(normalizeAnthropicProviderUrl('http://127.0.0.1:11434/v1', 'ollama')).toBe('http://127.0.0.1:11434/v1')
  })

  test('minimax 协议根路径补全 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://api.minimaxi.com/anthropic', 'minimax')).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    )
  })

  test('anthropic-compatible 不再走 versioned 分支（PR: 改为完整请求地址，运行时由 resolveAnthropicMessagesUrl 短路）', () => {
    // anthropic-compatible 已从 normalizeAnthropicProviderUrl 的 versioned 列表移除，
    // 落到通用 normalizeAnthropicBaseUrl：对已有非版本路径（/anthropic）不再追加 /v1。
    expect(normalizeAnthropicProviderUrl('https://gateway.example.com/anthropic', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/anthropic',
    )
  })

  test('qwen-anthropic 补全 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://dashscope.aliyuncs.com/apps/anthropic', 'qwen-anthropic')).toBe(
      'https://dashscope.aliyuncs.com/apps/anthropic/v1',
    )
  })

  test('xiaomi / xiaomi-token-plan 补全 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://api.xiaomimimo.com/anthropic', 'xiaomi')).toBe(
      'https://api.xiaomimimo.com/anthropic/v1',
    )
    expect(
      normalizeAnthropicProviderUrl('https://token-plan-cn.xiaomimimo.com/anthropic', 'xiaomi-token-plan'),
    ).toBe('https://token-plan-cn.xiaomimimo.com/anthropic/v1')
  })

  test('zhipu-coding 补全 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://open.bigmodel.cn/api/anthropic', 'zhipu-coding')).toBe(
      'https://open.bigmodel.cn/api/anthropic/v1',
    )
  })

  test('ark-coding-plan 补全 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://ark.cn-beijing.volces.com/api/plan', 'ark-coding-plan')).toBe(
      'https://ark.cn-beijing.volces.com/api/plan/v1',
    )
  })

  test('原生 anthropic 纯域名补全 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com/v1')
  })

  test('原生 anthropic 已含 /v1 保持不变', () => {
    expect(normalizeAnthropicProviderUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('https://api.anthropic.com/v1')
  })
})

describe('resolveOpenAIChatCompletionsUrl', () => {
  test('custom 原样使用完整端点（去尾斜杠）', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://api.example.com/v1/chat/completions', 'custom')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(resolveOpenAIChatCompletionsUrl('https://api.example.com/v1/chat/completions/', 'custom')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })

  test('custom 协议根地址按形态补全 /chat/completions', () => {
    // 同一个 Base URL 还要供 Pi（Agent）消费，而 Pi 需要协议根地址，
    // 所以用户把 custom 渠道填成 /v1 是常见写法；直接 POST /v1 会落到站点路由（Go 网关返回 404 page not found）。
    expect(resolveOpenAIChatCompletionsUrl('https://api.example.com/v1', 'custom')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(resolveOpenAIChatCompletionsUrl('https://api.example.com/api/v1/', 'custom')).toBe(
      'https://api.example.com/api/v1/chat/completions',
    )
  })

  test('custom 裸域名按 OpenAI 兼容约定补 /v1/chat/completions', () => {
    expect(resolveOpenAIChatCompletionsUrl('http://192.168.1.10:7863', 'custom')).toBe(
      'http://192.168.1.10:7863/v1/chat/completions',
    )
  })

  test('custom 自定义路由原样请求，不猜用户路径', () => {
    // 商业代管 relay 与 Responses 端点不能被子串匹配误改。
    expect(resolveOpenAIChatCompletionsUrl('https://gateway.example.com/v1/proxy/chat', 'custom')).toBe(
      'https://gateway.example.com/v1/proxy/chat',
    )
    expect(resolveOpenAIChatCompletionsUrl('https://gateway.example.com/v1/responses', 'custom')).toBe(
      'https://gateway.example.com/v1/responses',
    )
  })

  test('custom 未配置地址保持空值语义', () => {
    expect(resolveOpenAIChatCompletionsUrl('', 'custom')).toBe('')
  })

  test('custom 补全后的端点经 Pi 归一化仍还原为协议根（Chat 与 Agent 互不影响）', () => {
    const root = 'https://api.example.com/v1'
    expect(normalizeOpenAIBaseUrlForSdk(resolveOpenAIChatCompletionsUrl(root, 'custom'))).toBe(
      normalizeOpenAIBaseUrlForSdk(root),
    )
  })

  test('内置 openai 协议根地址补全 /chat/completions', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://api.openai.com/v1', 'openai')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  test('内置 openai 已是完整端点不重复追加', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://api.openai.com/v1/chat/completions', 'openai')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  test('Ollama 根地址与 /v1 地址解析为 OpenAI chat completions', () => {
    expect(resolveOpenAIChatCompletionsUrl('http://127.0.0.1:11434', 'ollama')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    )
    expect(resolveOpenAIChatCompletionsUrl('http://127.0.0.1:11434/v1', 'ollama')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    )
  })

  test('本地服务根地址自动补 /v1，已带版本段或完整端点不重复拼接', () => {
    expect(resolveOpenAIChatCompletionsUrl('http://127.0.0.1:1234', 'local')).toBe(
      'http://127.0.0.1:1234/v1/chat/completions',
    )
    expect(resolveOpenAIChatCompletionsUrl('http://127.0.0.1:1234/v1', 'local')).toBe(
      'http://127.0.0.1:1234/v1/chat/completions',
    )
    expect(resolveOpenAIChatCompletionsUrl('http://127.0.0.1:8888/v1/chat/completions', 'local')).toBe(
      'http://127.0.0.1:8888/v1/chat/completions',
    )
    expect(resolveOpenAIChatCompletionsUrl('http://127.0.0.1:8080/api', 'local')).toBe(
      'http://127.0.0.1:8080/api/chat/completions',
    )
  })

  test('保留查询参数', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://api.example.com/v1/chat/completions?api-version=2024', 'custom')).toBe(
      'https://api.example.com/v1/chat/completions?api-version=2024',
    )
  })
})

describe('resolveOpenAIResponsesUrl', () => {
  test('Responses 中转站协议根地址补全 /responses', () => {
    expect(resolveOpenAIResponsesUrl('https://api.openai.com/v1', 'openai-responses')).toBe(
      'https://api.openai.com/v1/responses',
    )
  })

  test('完整 /responses 端点不重复追加', () => {
    expect(resolveOpenAIResponsesUrl('https://api.openai.com/v1/responses/', 'openai-responses')).toBe(
      'https://api.openai.com/v1/responses',
    )
  })
})

describe('resolveOpenAIModelsUrl', () => {
  test('完整 chat/completions 端点回到同级 /models', () => {
    expect(resolveOpenAIModelsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/models',
    )
  })

  test('完整 responses 端点回到同级 /models', () => {
    expect(resolveOpenAIModelsUrl('https://api.example.com/v1/responses')).toBe(
      'https://api.example.com/v1/models',
    )
  })

  test('协议根地址推导 /models', () => {
    expect(resolveOpenAIModelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models')
  })

  test('本地服务根地址自动补 /v1/models，完整端点回退同级', () => {
    expect(resolveOpenAIModelsUrl('http://127.0.0.1:1234', 'local')).toBe('http://127.0.0.1:1234/v1/models')
    expect(resolveOpenAIModelsUrl('http://127.0.0.1:1234/v1/', 'local')).toBe('http://127.0.0.1:1234/v1/models')
    expect(resolveOpenAIModelsUrl('http://127.0.0.1:1234/v1/chat/completions', 'local')).toBe(
      'http://127.0.0.1:1234/v1/models',
    )
  })

  test('保留查询参数', () => {
    expect(resolveOpenAIModelsUrl('https://api.example.com/v1/chat/completions?x=1')).toBe(
      'https://api.example.com/v1/models?x=1',
    )
  })
})

describe('resolveAnthropicMessagesUrl', () => {
  test('anthropic-compatible 原样使用完整端点', () => {
    expect(resolveAnthropicMessagesUrl('https://gateway.example.com/v1/messages', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/v1/messages',
    )
    expect(resolveAnthropicMessagesUrl('https://gateway.example.com/v1/messages/', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/v1/messages',
    )
  })

  test('anthropic-compatible 非端点路径按协议根补全 /v1/messages', () => {
    // 统一语义后只有「已填完整端点（…/messages）」才原样使用：其它路径按协议根补全，
    // 否则 Chat 会像修复前那样直接请求协议根（例如 /anthropic 根本没有 messages 端点）。
    expect(resolveAnthropicMessagesUrl('https://gateway.example.com/custom-path', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/custom-path/v1/messages',
    )
  })

  test('内置 minimax 协议根地址补全 /v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://api.minimaxi.com/anthropic', 'minimax')).toBe(
      'https://api.minimaxi.com/anthropic/v1/messages',
    )
  })

  test('火山方舟 Coding Plan 协议根地址补全 /v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://ark.cn-beijing.volces.com/api/plan', 'ark-coding-plan')).toBe(
      'https://ark.cn-beijing.volces.com/api/plan/v1/messages',
    )
  })

  test('小米 Token Plan 从 OpenAI Base URL 纠正到 Anthropic messages 端点', () => {
    expect(resolveAnthropicMessagesUrl('https://token-plan-cn.xiaomimimo.com/v1', 'xiaomi-token-plan')).toBe(
      'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages',
    )
  })

  test('小米 API 从 OpenAI Base URL 纠正到 Anthropic messages 端点', () => {
    expect(resolveAnthropicMessagesUrl('https://api.xiaomimimo.com/v1', 'xiaomi')).toBe(
      'https://api.xiaomimimo.com/anthropic/v1/messages',
    )
  })

  test('内置 anthropic 已是完整端点不重复追加', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1/messages', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/messages',
    )
  })

  test('Ollama 根地址与 /v1 地址均解析到 Anthropic messages', () => {
    expect(resolveAnthropicMessagesUrl('http://127.0.0.1:11434', 'ollama')).toBe('http://127.0.0.1:11434/v1/messages')
    expect(resolveAnthropicMessagesUrl('http://127.0.0.1:11434/v1', 'ollama')).toBe('http://127.0.0.1:11434/v1/messages')
  })
})

describe('resolveAnthropicModelsUrl', () => {
  test('anthropic-compatible 从完整 messages 端点推导同级 /models', () => {
    expect(resolveAnthropicModelsUrl('https://gateway.example.com/v1/messages', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/v1/models',
    )
  })

  test('anthropic-compatible 协议根地址推导 /models', () => {
    expect(resolveAnthropicModelsUrl('https://gateway.example.com/v1', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/v1/models',
    )
  })

  test('anthropic-compatible 推导模型端点时保留查询参数', () => {
    expect(resolveAnthropicModelsUrl('https://gateway.example.com/v1/messages?api-version=2024', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/v1/models?api-version=2024',
    )
  })

  test('内置完整 messages 端点回到同级 /models', () => {
    expect(resolveAnthropicModelsUrl('https://api.anthropic.com/v1/messages', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/models',
    )
  })

  test('内置协议根地址推导 /models', () => {
    expect(resolveAnthropicModelsUrl('https://api.minimaxi.com/anthropic', 'minimax')).toBe(
      'https://api.minimaxi.com/anthropic/v1/models',
    )
  })

  test('火山方舟 Coding Plan 协议根地址推导 /v1/models', () => {
    expect(resolveAnthropicModelsUrl('https://ark.cn-beijing.volces.com/api/plan', 'ark-coding-plan')).toBe(
      'https://ark.cn-beijing.volces.com/api/plan/v1/models',
    )
  })

  test('Ollama 模型列表使用 OpenAI-compatible /v1/models', () => {
    expect(resolveAnthropicModelsUrl('http://127.0.0.1:11434', 'ollama')).toBe('http://127.0.0.1:11434/v1/models')
  })
})

describe('统一 Anthropic 端点推导（chat / sdk）', () => {
  // P0-3：Chat 与 Claude/Pi 必须用同一份推导。四种常见输入在两种模式下结果一致，
  // 只有「用户直接填了非 /v1 版本的完整端点」这类 SDK 无法消费的输入才保留差异。
  const providers = ['anthropic', 'anthropic-compatible', 'custom', 'deepseek', 'minimax'] as const
  const cases = [
    ['https://gw.example.com/anthropic', 'https://gw.example.com/anthropic/v1/messages', 'https://gw.example.com/anthropic/v1/models'],
    ['https://gw.example.com', 'https://gw.example.com/v1/messages', 'https://gw.example.com/v1/models'],
    ['https://gw.example.com/v1', 'https://gw.example.com/v1/messages', 'https://gw.example.com/v1/models'],
    ['https://gw.example.com/v1/messages', 'https://gw.example.com/v1/messages', 'https://gw.example.com/v1/models'],
  ] as const

  for (const provider of providers) {
    test(`${provider}: /anthropic、根、/v1、/v1/messages 在 chat 与 sdk 下结果一致`, () => {
      for (const [input, messages, models] of cases) {
        expect(resolveAnthropicMessagesUrl(input, provider, 'chat')).toBe(messages)
        expect(resolveAnthropicMessagesUrl(input, provider, 'sdk')).toBe(messages)
        expect(resolveAnthropicModelsUrl(input, provider, 'chat')).toBe(models)
        expect(resolveAnthropicModelsUrl(input, provider, 'sdk')).toBe(models)
      }
    })
  }

  test('sdk 模式严格等于 normalizeAnthropicBaseUrlForSdk + /v1/<kind>', () => {
    const inputs = [
      'https://gw.example.com',
      'https://gw.example.com/',
      'https://gw.example.com/anthropic',
      'https://gw.example.com/anthropic/',
      'https://gw.example.com/anthropic/v1',
      'https://gw.example.com/anthropic/v1/messages',
      'https://gw.example.com/coding/v1',
      'https://gw.example.com/v1/proxy',
    ]
    for (const input of inputs) {
      const sdkBase = normalizeAnthropicBaseUrlForSdk(input)
      expect(resolveAnthropicMessagesUrl(input, 'anthropic', 'sdk')).toBe(`${sdkBase}/v1/messages`)
      expect(resolveAnthropicModelsUrl(input, 'anthropic', 'sdk')).toBe(`${sdkBase}/v1/models`)
    }
  })

  test('sdk 模式拒绝 query/hash，chat 模式保留路由', () => {
    const routed = 'https://gw.example.com/anthropic?route=fixture#anchor'
    expect(resolveAnthropicMessagesUrl(routed, 'anthropic', 'chat')).toBe(
      'https://gw.example.com/anthropic/v1/messages?route=fixture#anchor',
    )
    expect(() => resolveAnthropicMessagesUrl(routed, 'anthropic', 'sdk')).toThrow('query/hash')
    expect(() => resolveAnthropicModelsUrl(routed, 'anthropic', 'sdk')).toThrow('query/hash')
  })

  test('小米系列：chat 保留 /anthropic 纠正，sdk 保持纯 SDK 语义（已知例外）', () => {
    // Chat 历史行为把小米的 OpenAI 兼容 /v1 纠正到 /anthropic；SDK 侧只接受根地址，
    // 无法还原这个纠正（normalizeAnthropicBaseUrlForSdk 不含 provider 信息）。
    expect(resolveAnthropicMessagesUrl('https://api.xiaomimimo.com/v1', 'xiaomi', 'chat')).toBe(
      'https://api.xiaomimimo.com/anthropic/v1/messages',
    )
    expect(resolveAnthropicMessagesUrl('https://api.xiaomimimo.com/v1', 'xiaomi', 'sdk')).toBe(
      'https://api.xiaomimimo.com/v1/messages',
    )
    // 官方默认地址（含 /anthropic）两种模式一致。
    expect(resolveAnthropicMessagesUrl('https://api.xiaomimimo.com/anthropic', 'xiaomi', 'chat')).toBe(
      'https://api.xiaomimimo.com/anthropic/v1/messages',
    )
    expect(resolveAnthropicMessagesUrl('https://api.xiaomimimo.com/anthropic', 'xiaomi', 'sdk')).toBe(
      'https://api.xiaomimimo.com/anthropic/v1/messages',
    )
  })

  test('Kimi / MiniMax 协议根路径在两种模式下都不回归', () => {
    const cases = [
      ['kimi-api', 'https://api.moonshot.cn/anthropic', 'https://api.moonshot.cn/anthropic/v1/messages'],
      ['kimi-coding', 'https://api.kimi.com/coding/v1', 'https://api.kimi.com/coding/v1/messages'],
      ['minimax', 'https://api.minimaxi.com/anthropic', 'https://api.minimaxi.com/anthropic/v1/messages'],
    ] as const
    for (const [provider, input, expected] of cases) {
      expect(resolveAnthropicMessagesUrl(input, provider, 'chat')).toBe(expected)
      expect(resolveAnthropicMessagesUrl(input, provider, 'sdk')).toBe(expected)
    }
  })

  test('chat 模式保留非 /v1 版本段的完整端点，sdk 模式按 SDK 只认 /v1', () => {
    expect(resolveAnthropicMessagesUrl('https://gw.example.com/tenant/v2/messages', 'anthropic-compatible', 'chat')).toBe(
      'https://gw.example.com/tenant/v2/messages',
    )
    expect(resolveAnthropicMessagesUrl('https://gw.example.com/tenant/v2/messages', 'anthropic-compatible', 'sdk')).toBe(
      'https://gw.example.com/tenant/v1/messages',
    )
  })
})

describe('migrateCompatibleChannelBaseUrl', () => {
  // 迁移目标 = 复现 PR 之前旧代码「实际请求过」的完整 URL，保证升级后运行时行为不变。

  test('custom: 旧 Base URL 补全为 /chat/completions（与旧 OpenAIAdapter 一致）', () => {
    expect(migrateCompatibleChannelBaseUrl('https://api.example.com/v1', 'custom')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })

  test('custom: 去尾斜杠后再补全', () => {
    expect(migrateCompatibleChannelBaseUrl('https://api.example.com/v1/', 'custom')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })

  test('custom: 幂等 —— 已是完整端点不重复追加', () => {
    expect(migrateCompatibleChannelBaseUrl('https://api.example.com/v1/chat/completions', 'custom')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })

  test('anthropic-compatible: 协议根地址补全为 /v1/messages（与旧 versioned 分支一致）', () => {
    // 旧代码：normalizeAnthropicProviderUrl 把 anthropic-compatible 走 versioned 分支 → 补 /v1 再拼 /messages
    expect(migrateCompatibleChannelBaseUrl('https://gateway.example.com/anthropic', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/anthropic/v1/messages',
    )
  })

  test('anthropic-compatible: 已含 /v1 的地址只补 /messages', () => {
    expect(migrateCompatibleChannelBaseUrl('https://gateway.example.com/v1', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/v1/messages',
    )
  })

  test('anthropic-compatible: 幂等 —— 已是完整端点不重复追加', () => {
    expect(migrateCompatibleChannelBaseUrl('https://gateway.example.com/v1/messages', 'anthropic-compatible')).toBe(
      'https://gateway.example.com/v1/messages',
    )
  })

  test('迁移后的 anthropic-compatible 端点经 SDK 归一化可还原为升级前的根地址', () => {
    // 关键不变量：channel.baseUrl 同时被 Agent SDK 路径消费（normalizeAnthropicBaseUrlForSdk 剥除 /v\d+/messages）
    const migrated = migrateCompatibleChannelBaseUrl('https://gateway.example.com/anthropic', 'anthropic-compatible')
    expect(normalizeAnthropicBaseUrlForSdk(migrated)).toBe(
      normalizeAnthropicBaseUrlForSdk('https://gateway.example.com/anthropic'),
    )
  })

  test('空 Base URL 原样返回（未配置渠道不迁移）', () => {
    expect(migrateCompatibleChannelBaseUrl('', 'custom')).toBe('')
    expect(migrateCompatibleChannelBaseUrl('   ', 'anthropic-compatible')).toBe('   ')
  })

  test('非通用兼容 provider 原样返回（语义未变）', () => {
    expect(migrateCompatibleChannelBaseUrl('https://api.openai.com/v1', 'openai')).toBe('https://api.openai.com/v1')
    expect(migrateCompatibleChannelBaseUrl('https://api.deepseek.com/anthropic', 'deepseek')).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })
})

describe('query/hash 仅属于 URL 尾部，不参与端点拼接', () => {
  test('Anthropic 根/版本/完整端点的 query 路由一致', () => {
    expect(normalizeAnthropicBaseUrl('https://fixture.invalid/?route=fixture#anchor')).toBe('https://fixture.invalid/v1?route=fixture#anchor')
    expect(normalizeVersionedAnthropicBaseUrl('https://fixture.invalid/anthropic/?route=fixture#anchor')).toBe('https://fixture.invalid/anthropic/v1?route=fixture#anchor')
    expect(resolveAnthropicMessagesUrl('https://fixture.invalid/v1/?route=fixture#anchor', 'anthropic')).toBe('https://fixture.invalid/v1/messages?route=fixture#anchor')
    expect(resolveAnthropicModelsUrl('https://fixture.invalid/v1/messages/?route=fixture#anchor', 'anthropic')).toBe('https://fixture.invalid/v1/models?route=fixture#anchor')
    expect(resolveAnthropicModelsUrl('https://fixture.invalid/v1/?route=fixture#anchor', 'anthropic')).toBe('https://fixture.invalid/v1/models?route=fixture#anchor')
    expect(resolveAnthropicMessagesUrl('https://fixture.invalid/tenant/messages/?route=fixture#anchor', 'anthropic-compatible')).toBe('https://fixture.invalid/tenant/messages?route=fixture#anchor')
  })

  test('OpenAI 请求/目录只在 pathname 拼接，不重复 models', () => {
    expect(resolveOpenAIModelsUrl('https://fixture.invalid/v1/?route=fixture#anchor')).toBe('https://fixture.invalid/v1/models?route=fixture#anchor')
    expect(resolveOpenAIModelsUrl('https://fixture.invalid/v1/models/?route=fixture#anchor')).toBe('https://fixture.invalid/v1/models?route=fixture#anchor')
    expect(resolveOpenAIModelsUrl('https://fixture.invalid/v1/responses/?route=fixture#anchor')).toBe('https://fixture.invalid/v1/models?route=fixture#anchor')
    expect(resolveOpenAIChatCompletionsUrl('https://fixture.invalid/v1/?route=fixture#anchor')).toBe('https://fixture.invalid/v1/chat/completions?route=fixture#anchor')
    expect(resolveOpenAIResponsesUrl('https://fixture.invalid/v1/?route=fixture#anchor')).toBe('https://fixture.invalid/v1/responses?route=fixture#anchor')
  })
})

test('Ollama/小米/旧兼容迁移的 query/hash 不参与 pathname 拼接', () => {
  expect(resolveAnthropicMessagesUrl('http://127.0.0.1:11434/v1/?route=fixture#anchor', 'ollama')).toBe('http://127.0.0.1:11434/v1/messages?route=fixture#anchor')
  expect(resolveAnthropicModelsUrl('http://127.0.0.1:11434/v1/?route=fixture#anchor', 'ollama')).toBe('http://127.0.0.1:11434/v1/models?route=fixture#anchor')
  expect(resolveOpenAIChatCompletionsUrl('http://127.0.0.1:11434/v1/?route=fixture#anchor', 'ollama')).toBe('http://127.0.0.1:11434/v1/chat/completions?route=fixture#anchor')
  expect(resolveAnthropicMessagesUrl('https://fixture.invalid/v1/?route=fixture#anchor', 'xiaomi')).toBe('https://fixture.invalid/anthropic/v1/messages?route=fixture#anchor')
  expect(migrateCompatibleChannelBaseUrl('https://fixture.invalid/v1/?route=fixture#anchor', 'custom')).toBe('https://fixture.invalid/v1/chat/completions?route=fixture#anchor')
  expect(migrateCompatibleChannelBaseUrl('https://fixture.invalid/anthropic/?route=fixture#anchor', 'anthropic-compatible')).toBe('https://fixture.invalid/anthropic/v1/messages?route=fixture#anchor')
})

test('F20：SDK helper 显式拒绝根/完整端点的 query/hash，保留无路由的完整端点规范化', () => {
  for (const normalize of [normalizeAnthropicBaseUrlForSdk, normalizeOpenAIBaseUrlForSdk]) {
    for (const path of ['', '/v1/', '/v1/messages/', '/v1/chat/completions/', '/v1/responses/']) {
      for (const suffix of ['?route=fixture-secret', '#fixture-secret', '?', '#']) {
        try { normalize(`https://fixture.invalid${path}${suffix}`); throw new Error('未拒绝 SDK 路由') }
        catch (error) {
          expect((error as Error).message).toContain('query/hash')
          expect((error as Error).message).not.toContain('fixture-secret')
        }
      }
    }
  }
  expect(normalizeAnthropicBaseUrlForSdk('https://fixture.invalid/anthropic/v1/messages/')).toBe('https://fixture.invalid/anthropic')
  expect(normalizeOpenAIBaseUrlForSdk('https://fixture.invalid/v1/responses/')).toBe('https://fixture.invalid/v1')
})
