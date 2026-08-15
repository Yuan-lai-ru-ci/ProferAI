import { describe, expect, test } from 'bun:test'
import { isAbsoluteFilePath, isRelativeFilePath } from './file-path-chip'

describe('isRelativeFilePath 路径检测', () => {
  test('识别英文文件名相对路径', () => {
    expect(isRelativeFilePath('test-note.md')).toBe(true)
  })

  test('识别英文相对路径（含目录层级）', () => {
    expect(isRelativeFilePath('docs/guide/intro.md')).toBe(true)
  })

  // 注：反斜杠相对路径（docs\guide\intro.md）有意不识别——反斜杠在 inline code 中
  // 常见于转义符/Windows 命令，放开会引入误伤；相对路径仅支持正斜杠分隔。

  test('识别中文文件名相对路径（回归：ASCII 正则误排除）', () => {
    expect(isRelativeFilePath('测试.md')).toBe(true)
  })

  test('识别含中文目录的相对路径（回归：ASCII 正则误排除）', () => {
    expect(isRelativeFilePath('文档/需求说明.md')).toBe(true)
  })

  test('识别含中文的隐藏目录相对路径', () => {
    expect(isRelativeFilePath('.context/中文笔记.md')).toBe(true)
  })

  test('识别含中文带行号后缀的相对路径', () => {
    expect(isRelativeFilePath('源码/工具.ts:42')).toBe(true)
  })

  test('排除不带扩展名的中文文案', () => {
    expect(isRelativeFilePath('这是一段中文文案')).toBe(false)
  })

  test('排除命令（不带可预览扩展名）', () => {
    expect(isRelativeFilePath('bun run dev')).toBe(false)
  })

  test('排除变量名（不带可预览扩展名）', () => {
    expect(isRelativeFilePath('someVariable')).toBe(false)
  })
})

describe('isAbsoluteFilePath 路径检测', () => {
  test('识别含中文的 Windows 绝对路径', () => {
    expect(isAbsoluteFilePath('C:\\用户\\文档\\测试.md')).toBe(true)
  })

  test('识别含中文的 Unix 绝对路径', () => {
    expect(isAbsoluteFilePath('/Users/admin/文档/测试.md')).toBe(true)
  })
})
