import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  inferContextWindow,
  isDeepSeekV4Model,
  normalizeContextModelId,
  resolveAgentSdkModelId,
  resolveContextWindowFromModelUsage,
  supports1MContext,
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

  test('Given 非精确 V4 Pro/Flash 的 DeepSeek 模型 When 推断 Then 保持默认 200K', () => {
    expect(isDeepSeekV4Model('deepseek-v4')).toBe(false)
    expect(isDeepSeekV4Model('deepseek-v4-unknown')).toBe(false)
    expect(isDeepSeekV4Model('deepseek-v4-pro-max')).toBe(false)
    expect(isDeepSeekV4Model('deepseek-v4-flash:free')).toBe(false)
    expect(isDeepSeekV4Model('my-deepseek-v4-pro')).toBe(false)
    expect(inferContextWindow('deepseek-reasoner')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('Given GLM 显式 1M 变体 When 规范化 Then 保持其 1M 能力', () => {
    expect(supports1MContext('glm-x-preview[1m]')).toBe(true)
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

  test('Given DeepSeek provider 的非精确 V4 名称 When 转换 Then 不误加 1M 后缀', () => {
    expect(resolveAgentSdkModelId('deepseek-v4-pro-max', 'deepseek')).toBe('deepseek-v4-pro-max')
    expect(resolveAgentSdkModelId('gateway/deepseek-v4-flash', 'deepseek')).toBe('gateway/deepseek-v4-flash[1m]')
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
})
