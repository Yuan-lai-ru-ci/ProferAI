import { describe, expect, test } from 'bun:test'
import type { ChannelModel } from '@profer/shared'
import { addManualModel } from './channel-manual-model'

describe('addManualModel', () => {
  test('Given 正常输入 When 添加 Then 追加 enabled 的 manual 模型', () => {
    const result = addManualModel([], ' gpt-4o-mini ', '')
    expect(result).toEqual({
      kind: 'added',
      id: 'gpt-4o-mini',
      models: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini', enabled: true, source: 'manual' }],
    })
  })

  test('Given 输入了可选显示名 When 添加 Then 使用显示名', () => {
    const result = addManualModel([], 'claude-opus-4-6', ' Opus 4.6 ')
    expect(result.kind).toBe('added')
    if (result.kind === 'added') {
      expect(result.models[0]).toEqual({
        id: 'claude-opus-4-6',
        name: 'Opus 4.6',
        enabled: true,
        source: 'manual',
      })
    }
  })

  test('Given 输入法组词中残留文字带空格 When 添加 Then 拒绝且不改变列表', () => {
    const current: ChannelModel[] = [
      { id: 'ok-model', name: 'ok-model', enabled: true, source: 'manual' },
    ]
    expect(addManualModel(current, 'cl aude', '').kind).toBe('invalid')
  })

  test('Given 粘贴的多行文本 When 添加 Then 含内部换行视为非法', () => {
    expect(addManualModel([], 'gpt-4o\ngpt-4o-mini', '').kind).toBe('invalid')
  })

  test('Given 空输入或纯空白输入 When 添加 Then 拒绝', () => {
    expect(addManualModel([], '', '').kind).toBe('empty')
    expect(addManualModel([], '   ', '').kind).toBe('empty')
  })

  test('Given 已存在同 ID 模型 When 重复添加 Then 不再追加重复条目', () => {
    const current: ChannelModel[] = [
      { id: 'gpt-4o', name: 'GPT-4o', enabled: true, source: 'manual' },
    ]
    const result = addManualModel(current, 'gpt-4o', '')
    expect(result).toEqual({ kind: 'duplicate', models: current, id: 'gpt-4o' })
  })
})
