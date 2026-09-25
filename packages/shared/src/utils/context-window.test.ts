import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  CODEX_GPT_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  inferContextWindow,
  inferAgentSdkContextWindow,
  isDeepSeekV4Model,
  isNextGeneration1MContextModel,
  normalizeContextModelId,
  resolveAgentSdkModelId,
  resolveAgentSdk1MSelection,
  resolveContextWindowFromModelUsage,
  resolveOneMillionContextDecision,
  strip1MContextSuffix,
  supports1MContext,
  supportsVerified1MContext,
} from './context-window'

describe('DeepSeek V4 1M 上下文能力', () => {
  test('Given DeepSeek V4 Pro 与 Flash When 识别能力 Then 两者均为 1M', () => {
    expect(isDeepSeekV4Model('deepseek-v4-pro')).toBe(true)
    expect(isDeepSeekV4Model('deepseek-v4-flash')).toBe(true)
    expect(inferContextWindow('deepseek-v4-pro')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('deepseek-v4-flash')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given 网关前缀、大小写或 SDK 后缀 When 规范化 Then 仍正确识别 DeepSeek V4', () => {
    expect(normalizeContextModelId(' Gateway/DeepSeek-V4-Pro[1m] ')).toBe('deepseek-v4-pro')
    expect(isDeepSeekV4Model('gateway/deepseek-v4-flash')).toBe(true)
  })

  test('Given 非精确 V4 Pro/Flash 的 DeepSeek 模型 When 识别推理 SKU Then 仍按精确匹配', () => {
    expect(isDeepSeekV4Model('deepseek-v4')).toBe(false)
    expect(isDeepSeekV4Model('deepseek-v4-unknown')).toBe(false)
    expect(isDeepSeekV4Model('deepseek-v4-pro-max')).toBe(false)
    expect(isDeepSeekV4Model('deepseek-v4-flash:free')).toBe(false)
    expect(isDeepSeekV4Model('my-deepseek-v4-pro')).toBe(false)
    expect(inferContextWindow('deepseek-reasoner')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given DeepSeek 官方短名 When 识别推理 SKU Then 与同代正式 ID 同等处理', () => {
    // 思考协议（output_config.effort）只看这个判定，短名漏了会导致同一模型拿不到 effort 映射
    expect(isDeepSeekV4Model('deepseek-flash')).toBe(true)
    expect(isDeepSeekV4Model('deepseek-pro')).toBe(true)
    expect(isDeepSeekV4Model('Gateway/DeepSeek-Flash[1m]')).toBe(true)
    expect(isDeepSeekV4Model('deepseek-chat')).toBe(false)
    expect(isDeepSeekV4Model('deepseek-turbo')).toBe(false)
  })

  test('Given GLM-5.3 or an explicit 1M GLM variant When normalizing Then preserves its 1M capability', () => {
    expect(supports1MContext('glm-5.3')).toBe(true)
    expect(inferContextWindow('gateway/glm-5.3')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(supports1MContext('glm-x-preview[1m]')).toBe(true)
  })

  test('Given ChatGPT Codex Terra When renderer requires a temporary fallback Then use the verified 1.05M window', () => {
    expect(inferContextWindow('gpt-5.6-terra')).toBe(CODEX_GPT_CONTEXT_WINDOW)
  })

  test('Given GPT-6 Astra When renderer requires a fallback Then use the verified 1.05M window', () => {
    expect(supports1MContext('gpt-6-astra')).toBe(true)
    expect(inferContextWindow('gpt-6-astra')).toBe(CODEX_GPT_CONTEXT_WINDOW)
  })
})

describe('代际默认 1M 规则（DeepSeek 一代及之后）', () => {
  test('Given DeepSeek 一代及之后的家族新版本 When 识别 Then 自动继承 1M', () => {
    expect(isNextGeneration1MContextModel('deepseek-v5')).toBe(true)
    expect(isNextGeneration1MContextModel('kimi-k3')).toBe(true)
    expect(isNextGeneration1MContextModel('kimi-k4-thinking')).toBe(true)
    expect(isNextGeneration1MContextModel('glm-5.4')).toBe(true)
    expect(isNextGeneration1MContextModel('glm-6')).toBe(true)
    expect(isNextGeneration1MContextModel('mimo-v3')).toBe(true)
    expect(isNextGeneration1MContextModel('minimax-m4')).toBe(true)
    expect(isNextGeneration1MContextModel('grok-4.6')).toBe(true)
    expect(isNextGeneration1MContextModel('grok-5')).toBe(true)
  })

  test('Given DeepSeek 官方无版本号短名 When 识别 Then 按同代 1M 处理（含同代新变体）', () => {
    // 渠道里手填的模型 ID 就是短名（deepseek-flash / deepseek-pro），不能因少了版本号就落回 200K
    expect(isNextGeneration1MContextModel('deepseek-flash')).toBe(true)
    expect(isNextGeneration1MContextModel('deepseek-pro')).toBe(true)
    expect(isNextGeneration1MContextModel('deepseek-flash-latest')).toBe(true)
    expect(inferContextWindow('deepseek-flash')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('deepseek-pro')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(supportsVerified1MContext('deepseek-flash', 'deepseek')).toBe(true)
    expect(supportsVerified1MContext('deepseek-pro', 'deepseek')).toBe(true)
    expect(resolveAgentSdkModelId('deepseek-flash', 'deepseek')).toBe('deepseek-flash[1m]')
    // 经未验证网关仍保守，只有显式 `[1m]` 才认
    expect(supportsVerified1MContext('deepseek-flash', 'custom')).toBe(false)
    expect(resolveAgentSdkModelId('deepseek-flash', 'custom')).toBe('deepseek-flash')
  })

  test('Given DeepSeek 旧世代模型 When 识别 Then 短名规则不误升', () => {
    // deepseek-chat / deepseek-reasoner / deepseek-v3.x 属于短名前代，不应被 1M 规则收编
    expect(isNextGeneration1MContextModel('deepseek-chat')).toBe(false)
    expect(isNextGeneration1MContextModel('deepseek-reasoner')).toBe(false)
    expect(inferContextWindow('deepseek-chat')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('deepseek-reasoner')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(supportsVerified1MContext('deepseek-chat', 'deepseek')).toBe(false)
  })

  test('Given 低于代际基线的旧 SKU When 识别 Then 保持默认 200K', () => {
    expect(inferContextWindow('kimi-k2.6')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('kimi-for-coding')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('glm-5.1')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('MiniMax-M2.7')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('mimo-v2-flash')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('mimo-v2-omni')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('deepseek-v3.2')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('claude-opus-4-5')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given 已确认但版本号低于阈值的 SKU When 识别 Then 仍按 1M', () => {
    expect(inferContextWindow('mimo-v2-pro')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('claude-opus-4-6')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given GPT-5.4 mini When 推断 Then 使用已验证的 400K 而不是 1M', () => {
    expect(supports1MContext('gpt-5.4-mini')).toBe(false)
    expect(inferContextWindow('gpt-5.4-mini')).toBe(CODEX_GPT_54_MINI_CONTEXT_WINDOW)
  })

  test('Given 用户显式开启未知模型 When 推断 Agent SDK 窗口 Then 采用 1M', () => {
    expect(inferAgentSdkContextWindow('glm-4.6', 'custom', true)).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given 用户显式关闭已识别 1M 模型 When 推断 Agent SDK 窗口 Then 回到默认窗口', () => {
    expect(inferAgentSdkContextWindow('deepseek-v4-pro', 'deepseek', false)).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given provider + 模型 When 判定已验证 1M Then 只认可已验证的组合', () => {
    expect(supportsVerified1MContext('deepseek-v4-pro', 'deepseek')).toBe(true)
    expect(supportsVerified1MContext('glm-5.4', 'zhipu-coding')).toBe(true)
    expect(supportsVerified1MContext('kimi-k4', 'kimi-api')).toBe(true)
    expect(supportsVerified1MContext('k3', 'kimi-coding')).toBe(true)
    expect(supportsVerified1MContext('deepseek-v4-pro', 'custom')).toBe(false)
    expect(supportsVerified1MContext('glm-5.3', 'anthropic-compatible')).toBe(false)
    expect(supportsVerified1MContext('kimi-k2.6', 'kimi-api')).toBe(false)
  })
})

describe('Agent SDK 1M 模型转换', () => {
  test('Given 允许 1M 的模型 When 显式启用 Then 追加 1M 后缀', () => {
    expect(resolveAgentSdkModelId('claude-sonnet-4-6', true)).toBe('claude-sonnet-4-6[1m]')
  })

  test('Given DeepSeek 原始模型 When provider 策略禁用 1M Then 保持用户模型 ID', () => {
    expect(resolveAgentSdkModelId('deepseek-v4-pro', false)).toBe('deepseek-v4-pro')
  })

  test('Given 1M 已启用的模型 When 再次转换 Then 保持幂等', () => {
    expect(resolveAgentSdkModelId('claude-sonnet-4-6[1m]', true)).toBe('claude-sonnet-4-6[1m]')
  })

  test('Given DeepSeek V4 经 custom 兼容网关 When provider 未验证 Then 不擅自追加 SDK 后缀', () => {
    expect(resolveAgentSdkModelId('gateway/deepseek-v4-pro', 'custom')).toBe('gateway/deepseek-v4-pro')
  })

  test('Given a verified GLM-5.3 provider/model pair When converting Then appends the Agent SDK 1M suffix', () => {
    expect(resolveAgentSdkModelId('glm-5.3', 'zhipu')).toBe('glm-5.3[1m]')
    expect(resolveAgentSdkModelId('glm-5.3', 'zhipu-coding')).toBe('glm-5.3[1m]')
  })

  test('Given DeepSeek provider 的世代模型（含后续新版本）When 转换 Then 追加 1M 后缀', () => {
    expect(resolveAgentSdkModelId('deepseek-v4-pro-max', 'deepseek')).toBe('deepseek-v4-pro-max[1m]')
    expect(resolveAgentSdkModelId('deepseek-v5-turbo', 'deepseek')).toBe('deepseek-v5-turbo[1m]')
    expect(resolveAgentSdkModelId('gateway/deepseek-v4-flash', 'deepseek')).toBe('gateway/deepseek-v4-flash[1m]')
  })

  test('Given 低于基线的旧模型 When 转换 Then 不误加 1M 后缀', () => {
    expect(resolveAgentSdkModelId('deepseek-reasoner', 'deepseek')).toBe('deepseek-reasoner')
    expect(resolveAgentSdkModelId('kimi-k2.6', 'kimi-api')).toBe('kimi-k2.6')
    expect(resolveAgentSdkModelId('glm-5.1', 'zhipu-coding')).toBe('glm-5.1')
  })

  test('Given 已验证家族的新版本 When 转换 Then 自动继承 1M 后缀', () => {
    expect(resolveAgentSdkModelId('glm-5.4', 'zhipu-coding')).toBe('glm-5.4[1m]')
    expect(resolveAgentSdkModelId('minimax-m4', 'minimax')).toBe('minimax-m4[1m]')
    expect(resolveAgentSdkModelId('mimo-v2.5-pro', 'xiaomi')).toBe('mimo-v2.5-pro[1m]')
  })
})

describe('多模型 result 上下文窗口解析', () => {
  test('Given 子模型 200K 排在第一项 When 主模型为 DeepSeek V4 Then 选择主模型 1M', () => {
    expect(resolveContextWindowFromModelUsage({
      'small-subagent': { contextWindow: DEFAULT_CONTEXT_WINDOW },
      'deepseek-v4-pro': { contextWindow: ONE_MILLION_CONTEXT_WINDOW },
    }, 'deepseek-v4-pro')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given custom DeepSeek 主模型 usage 缺失 When 只有子模型实测窗口 Then 不按名称臆测 1M', () => {
    expect(resolveContextWindowFromModelUsage({
      'small-subagent': { contextWindow: DEFAULT_CONTEXT_WINDOW },
    }, 'gateway/deepseek-v4-flash')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(resolveContextWindowFromModelUsage(undefined, 'gateway/deepseek-v4-flash')).toBeUndefined()
  })

  test('Given 完整路径不同但模型尾段相同 When 主模型精确存在 Then 选择完整 ID 对应窗口', () => {
    expect(resolveContextWindowFromModelUsage({
      'gateway-a/deepseek-v4-pro': { contextWindow: DEFAULT_CONTEXT_WINDOW },
      'gateway-b/deepseek-v4-pro': { contextWindow: ONE_MILLION_CONTEXT_WINDOW },
    }, 'gateway-b/deepseek-v4-pro')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given 主模型只有尾段且存在多个同名网关 When 无法唯一匹配 Then 使用最大实测窗口', () => {
    expect(resolveContextWindowFromModelUsage({
      'gateway-a/deepseek-v4-pro': { contextWindow: DEFAULT_CONTEXT_WINDOW },
      'gateway-b/deepseek-v4-pro': { contextWindow: 400_000 },
    }, 'deepseek-v4-pro')).toBe(400_000)
  })

  test('Given 未知主模型 When 多模型 usage 存在有效窗口 Then 使用最大实测窗口兜底', () => {
    expect(resolveContextWindowFromModelUsage({
      'small-subagent': { contextWindow: DEFAULT_CONTEXT_WINDOW },
      'larger-model': { contextWindow: 400_000 },
    }, 'unknown-model')).toBe(400_000)
  })

  test('Given GLM-X-Preview result key loses its 1M suffix When configured model preserves it Then retain 1M', () => {
    expect(resolveContextWindowFromModelUsage({
      'glm-x-preview': {},
    }, 'glm-x-preview[1m]')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })
})

describe('渠道模型 1M 三态偏好', () => {
  test('Given 已验证组合未手动设置 When 解析 Then 回落到自动判定', () => {
    expect(resolveOneMillionContextDecision('deepseek-v4-pro', 'deepseek', undefined)).toEqual({
      enabled: true,
      source: 'auto',
      autoEnabled: true,
    })
  })

  test('Given 未验证的第三方网关 When 强制开启 Then 生效且标记来源', () => {
    expect(resolveOneMillionContextDecision('deepseek-v4-pro', 'custom', true)).toEqual({
      enabled: true,
      source: 'forced-on',
      autoEnabled: false,
    })
  })

  test('Given 已验证组合 When 手动关闭 Then 按非 1M 处理', () => {
    expect(resolveOneMillionContextDecision('deepseek-v4-pro', 'deepseek', false)).toEqual({
      enabled: false,
      source: 'forced-off',
      autoEnabled: true,
    })
  })

  test('Given 缺省的 null When 解析 Then 等同于未设置', () => {
    expect(resolveOneMillionContextDecision('deepseek-v4-pro', 'deepseek', null).source).toBe('auto')
  })
})

describe('Agent SDK 1M 选择（模型 ID + beta 同步）', () => {
  test('Given 模型 ID 带 SDK 专用后缀 When 去除 Then 只去掉 [1m] 后缀', () => {
    expect(strip1MContextSuffix('deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro')
    expect(strip1MContextSuffix('gateway/deepseek-v4-flash[1M]')).toBe('gateway/deepseek-v4-flash')
    // 网关路径前缀必须保留：标题生成等请求需要完整真实 ID
    expect(strip1MContextSuffix('gateway/deepseek-v4-pro')).toBe('gateway/deepseek-v4-pro')
  })

  test('Given 已验证组合 When 未手动设置 Then 追加后缀并开启 beta', () => {
    expect(resolveAgentSdk1MSelection('deepseek-v4-pro', 'deepseek')).toEqual({
      modelId: 'deepseek-v4-pro[1m]',
      oneMillionContextEnabled: true,
      source: 'auto',
    })
  })

  test('Given 未验证网关 When 强制开启 Then 也追加后缀并开启 beta', () => {
    expect(resolveAgentSdk1MSelection('glm-4.6', 'custom', true)).toEqual({
      modelId: 'glm-4.6[1m]',
      oneMillionContextEnabled: true,
      source: 'forced-on',
    })
  })

  test('Given 已验证组合 When 手动关闭 Then 不改模型 ID 也不发 beta', () => {
    expect(resolveAgentSdk1MSelection('deepseek-v4-pro', 'deepseek', false)).toEqual({
      modelId: 'deepseek-v4-pro',
      oneMillionContextEnabled: false,
      source: 'forced-off',
    })
  })

  test('Given 模型 ID 已带 [1m] When 自动判定生效 Then 不重复追加且补上 beta', () => {
    expect(resolveAgentSdk1MSelection('deepseek-v4-pro[1m]', 'deepseek')).toEqual({
      modelId: 'deepseek-v4-pro[1m]',
      oneMillionContextEnabled: true,
      source: 'auto',
    })
  })
})
