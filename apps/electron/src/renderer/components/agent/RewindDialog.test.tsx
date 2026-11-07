import { describe, expect, test } from 'bun:test'
import { getRewindDialogModeOptions, type RewindDialogIntent } from './RewindDialog'

describe('RewindDialog mode model', () => {
  test('默认回退范围为 conversation，其他模式可见但仅显式 rewind 可选', () => {
    const options = getRewindDialogModeOptions('edit-resend')
    expect(options.map((option) => option.mode)).toEqual(['conversation', 'files', 'both'])
    expect(options[0]?.disabled).toBe(false)
    expect(options[1]?.disabled).toBe(true)
    expect(options[2]?.disabled).toBe(true)
  })

  test('回退入口允许文件模式，供 D4/D6 计划执行器接入', () => {
    const options = getRewindDialogModeOptions('rewind' satisfies RewindDialogIntent)
    expect(options.every((option) => option.disabled === false)).toBe(true)
    expect(options[1]?.description).toContain('暂未开放')
  })
})
