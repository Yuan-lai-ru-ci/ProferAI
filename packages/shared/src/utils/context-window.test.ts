import { describe, expect, test } from 'bun:test'
import { resolveAgentSdkModelId } from './context-window'

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
})
