import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { getOfficialChannelDisplayName, isModelFamilyChannel } from './channel-model-groups'

function channel(overrides: Partial<Channel>): Pick<Channel, 'id' | 'name' | 'managedType'> {
  return {
    id: 'newapi-family-gpt',
    name: 'GPT',
    managedType: 'model-family',
    ...overrides,
  }
}

describe('官方模型池展示元数据', () => {
  test('Given 服务端标记 model-family When 渲染名称 Then 显示模型池而不是物理渠道', () => {
    const value = channel({})
    expect(isModelFamilyChannel(value)).toBe(true)
    expect(getOfficialChannelDisplayName(value)).toBe('GPT 模型池')
  })

  test('Given 旧版官方渠道 When 渲染名称 Then 保持兼容的官方渠道名称', () => {
    const value = channel({ id: 'newapi-8', name: 'GPT', managedType: 'legacy' })
    expect(isModelFamilyChannel(value)).toBe(false)
    expect(getOfficialChannelDisplayName(value)).toBe('GPT')
  })

  test('Given 服务端未返回 managedType 但使用稳定模型池 ID When 判断 Then 仍识别为模型池', () => {
    const value = channel({ id: 'newapi-family-claude', name: 'Claude', managedType: undefined })
    expect(isModelFamilyChannel(value)).toBe(true)
    expect(getOfficialChannelDisplayName(value)).toBe('Claude 模型池')
  })
})
