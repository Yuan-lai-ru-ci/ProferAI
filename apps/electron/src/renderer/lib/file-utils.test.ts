import { describe, expect, test } from 'bun:test'
import { getFileBaseName, getFileParentPath, getLastPathSegments, isAbsoluteFilePath } from './file-utils'

describe('getFileBaseName（R1 统一实现）', () => {
  test('正斜杠路径', () => {
    expect(getFileBaseName('/a/b/report.md')).toBe('report.md')
    expect(getFileBaseName('a/b/c.txt')).toBe('c.txt')
  })

  test('Windows 反斜杠路径', () => {
    expect(getFileBaseName('C:\\workspace\\报告.md')).toBe('报告.md')
  })

  test('混合分隔符与尾部斜杠', () => {
    expect(getFileBaseName('C:/a//b/')).toBe('b')
  })

  test('无分隔符返回原串', () => {
    expect(getFileBaseName('report.md')).toBe('report.md')
  })
})

describe('isAbsoluteFilePath（R2 统一实现）', () => {
  test('Windows 盘符路径', () => {
    expect(isAbsoluteFilePath('C:\\workspace\\report.md')).toBe(true)
    expect(isAbsoluteFilePath('C:/workspace/report.md')).toBe(true)
  })

  test('根斜杠路径', () => {
    expect(isAbsoluteFilePath('/workspace/report.md')).toBe(true)
  })

  test('UNC 网络路径', () => {
    expect(isAbsoluteFilePath('\\\\server\\share\\file.md')).toBe(true)
  })

  test('相对路径与普通文本', () => {
    expect(isAbsoluteFilePath('.context/report.md')).toBe(false)
    expect(isAbsoluteFilePath('report.md')).toBe(false)
    expect(isAbsoluteFilePath('src/lib/file-utils.ts')).toBe(false)
  })
})

describe('getLastPathSegments（R5 面包屑公共实现）', () => {
  test('多于 n 段时返回省略号形式', () => {
    expect(getLastPathSegments('/a/b/c/d')).toBe('.../c/d')
    expect(getLastPathSegments('/a/b/c/d', 3)).toBe('.../b/c/d')
  })

  test('段数不足 n 时返回原路径', () => {
    expect(getLastPathSegments('/a/b')).toBe('/a/b')
    expect(getLastPathSegments('/a')).toBe('/a')
  })

  test('空值与空串', () => {
    expect(getLastPathSegments(null)).toBe('')
    expect(getLastPathSegments(undefined)).toBe('')
    expect(getLastPathSegments('')).toBe('')
  })

  test('过滤空段（连续斜杠/尾部斜杠）', () => {
    expect(getLastPathSegments('C:/a//b/')).toBe('.../a/b')
    expect(getLastPathSegments('C:/a/b', 5)).toBe('C:/a/b')
  })
})

describe('getFileParentPath', () => {
  test('正斜杠与反斜杠', () => {
    expect(getFileParentPath('/a/b/c.md')).toBe('/a/b')
    expect(getFileParentPath('C:\\a\\b\\c.md')).toBe('C:\\a\\b')
  })

  test('无分隔符返回 null', () => {
    expect(getFileParentPath('report.md')).toBe(null)
  })
})
