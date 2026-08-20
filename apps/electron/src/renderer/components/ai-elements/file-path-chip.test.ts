import { describe, expect, test } from 'bun:test'
import { isAbsoluteFilePath, isRelativeFilePath, shouldSearchFileCandidate } from './file-path-chip'

describe('isRelativeFilePath 路径检测', () => {
  test('识别英文文件名相对路径', () => {
    expect(isRelativeFilePath('test-note.md')).toBe(true)
  })

  test('识别英文相对路径（含目录层级）', () => {
    expect(isRelativeFilePath('docs/guide/intro.md')).toBe(true)
  })

  test('识别带空格的中文目录和文件名相对路径', () => {
    expect(isRelativeFilePath('新建文件夹/新建文件夹/新建 Microsoft Word 文档.docx')).toBe(true)
  })

  test('识别 Windows 反斜杠相对路径', () => {
    expect(isRelativeFilePath('docs\\guide\\intro.md')).toBe(true)
  })

  test('识别带空格和行号的 Windows 相对路径', () => {
    expect(isRelativeFilePath('新建文件夹\\新建 Microsoft Word 文档.docx:42')).toBe(true)
  })

  test('排除单个带空格的文件名，避免扩大普通文案误识别', () => {
    expect(isRelativeFilePath('新建 Microsoft Word 文档.docx')).toBe(false)
  })

  test('允许输入首尾空格，解析前会统一 trim', () => {
    expect(isRelativeFilePath(' docs/guide/intro.md ')).toBe(true)
  })

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

describe('FilePathChip 候选搜索策略', () => {
  test('工具调用已提供绝对路径时直接预览，不按同名文件搜索', () => {
    expect(shouldSearchFileCandidate(true)).toBe(false)
  })

  test('仅有相对路径或裸文件名时才搜索候选', () => {
    expect(shouldSearchFileCandidate(false)).toBe(true)
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
