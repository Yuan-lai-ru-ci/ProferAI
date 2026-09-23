import { describe, expect, test } from 'bun:test'
import {
  DEEPSEEK_V4_MODEL_ALIASES,
  DEEPSEEK_V4_SHORT_MODEL_NAMES,
  isDeepSeekV4Alias,
  normalizeModelIdTail,
  resolveDeepSeekV4ModelId,
} from './deepseek-model-alias'

describe('DeepSeek 模型 ID 归一', () => {
  test('Given 旧代写法与官方短名 When 归一 Then 解析为 0.86 catalog 正式 ID', () => {
    // 0.86 起 Flash 的 catalog ID 去掉了版本号，旧写法必须归一到它。
    expect(resolveDeepSeekV4ModelId('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(resolveDeepSeekV4ModelId('deepseek-pro')).toBe('deepseek-v4-pro')
    expect(DEEPSEEK_V4_MODEL_ALIASES['deepseek-v4-flash']).toBe('deepseek-flash')
    expect(DEEPSEEK_V4_MODEL_ALIASES['deepseek-pro']).toBe('deepseek-v4-pro')
  })

  test('Given catalog 正式 ID When 归一 Then 原样返回，不再二次改写', () => {
    expect(resolveDeepSeekV4ModelId('deepseek-flash')).toBe('deepseek-flash')
    expect(resolveDeepSeekV4ModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(DEEPSEEK_V4_MODEL_ALIASES['deepseek-flash']).toBeUndefined()
  })

  test('Given 网关前缀、大小写或 SDK 后缀 When 归一 Then 仍能解析', () => {
    expect(normalizeModelIdTail(' Gateway/DeepSeek-Flash[1m] ')).toBe('deepseek-flash')
    expect(resolveDeepSeekV4ModelId('Gateway/DeepSeek-Pro')).toBe('deepseek-v4-pro')
    expect(resolveDeepSeekV4ModelId('deepseek-v4-flash[1m]')).toBe('deepseek-flash')
    expect(resolveDeepSeekV4ModelId('gateway/deepseek-flash[1m]')).toBe('deepseek-flash')
  })

  test('Given 新旧写法 When 归一 Then 收敛到同一个 catalog ID', () => {
    // 这是「同一个模型不因写法不同而拿到不同窗口 / 价格 / 图片能力」的核心契约。
    expect(resolveDeepSeekV4ModelId('deepseek-flash')).toBe(resolveDeepSeekV4ModelId('deepseek-v4-flash'))
    expect(resolveDeepSeekV4ModelId('deepseek-pro')).toBe(resolveDeepSeekV4ModelId('deepseek-v4-pro'))
  })

  test('Given 无关模型 When 归一 Then 原样返回，不误改写其它 DeepSeek 模型', () => {
    expect(resolveDeepSeekV4ModelId('deepseek-chat')).toBe('deepseek-chat')
    expect(resolveDeepSeekV4ModelId('deepseek-reasoner')).toBe('deepseek-reasoner')
    expect(resolveDeepSeekV4ModelId('deepseek-turbo')).toBe('deepseek-turbo')
    expect(resolveDeepSeekV4ModelId(undefined)).toBeUndefined()
    expect(resolveDeepSeekV4ModelId('   ')).toBeUndefined()
  })

  test('Given 各类写法 When 判断是否需要归一 Then 只认别名表里的写法', () => {
    expect(isDeepSeekV4Alias('deepseek-v4-flash')).toBe(true)
    expect(isDeepSeekV4Alias('gateway/deepseek-pro[1m]')).toBe(true)
    // deepseek-flash 自 0.86 起是 catalog 正式 ID，不再是需要归一的别名。
    expect(isDeepSeekV4Alias('deepseek-flash')).toBe(false)
    expect(isDeepSeekV4Alias('deepseek-chat')).toBe(false)
  })

  test('Given 官方无版本号短名清单 Then 与别名表分离维护', () => {
    // 短名清单供 context-window 的代际 1M 规则使用，必须包含 catalog 正式 ID `deepseek-flash`。
    expect(DEEPSEEK_V4_SHORT_MODEL_NAMES).toContain('deepseek-flash')
    expect(DEEPSEEK_V4_SHORT_MODEL_NAMES).toContain('deepseek-pro')
    expect(Object.keys(DEEPSEEK_V4_MODEL_ALIASES)).not.toContain('deepseek-flash')
  })
})
