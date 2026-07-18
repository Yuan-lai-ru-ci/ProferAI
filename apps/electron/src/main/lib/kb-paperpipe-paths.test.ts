import { describe, expect, test } from 'bun:test'
import { resolvePaperDir } from './config-paths'

describe('Paperpipe 本地论文路径', () => {
  test('Given 路径穿越或绝对路径 When 解析 Then 拒绝且不创建目录', () => {
    expect(() => resolvePaperDir('../outside')).toThrow('论文标识无效')
    expect(() => resolvePaperDir('C:\\outside')).toThrow('论文标识无效')
    expect(() => resolvePaperDir('00000000-0000-0000-0000-000000000000')).toThrow('论文标识无效')
  })

  test('Given 应用生成的 UUID When 解析 Then 保持在 papers 根目录内', () => {
    expect(resolvePaperDir('550e8400-e29b-41d4-a716-446655440000')).toMatch(/knowledge-base[\\/]papers[\\/]550e8400-e29b-41d4-a716-446655440000$/)
  })
})
