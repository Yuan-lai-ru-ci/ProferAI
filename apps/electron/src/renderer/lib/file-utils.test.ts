import { describe, expect, test } from 'bun:test'
import { getFileBaseName, getFileParentPath, getLastPathSegments, isAbsoluteFilePath, isMissingAttachmentData, normalizeFilePathSegments, resolveRelativeToAbsolute } from './file-utils'

describe('isMissingAttachmentData（附件数据完整性）', () => {
  test('Given 0 字节文件 When 数据为空 Then 不判定为失效附件', () => {
    expect(isMissingAttachmentData(0, '')).toBe(false)
  })

  test('Given 非空文件 When 数据为空 Then 判定为失效附件', () => {
    expect(isMissingAttachmentData(12, '')).toBe(true)
    expect(isMissingAttachmentData(12, undefined)).toBe(true)
  })

  test('Given 非空文件 When 数据存在 Then 不判定为失效附件', () => {
    expect(isMissingAttachmentData(12, 'YWJj')).toBe(false)
  })
})

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

  test('用户主目录缩写 ~/ 路径（Agent 输出的皮肤目录等写法）', () => {
    expect(isAbsoluteFilePath('~/.profer/skins/demo-skin/skin.css')).toBe(true)
    expect(isAbsoluteFilePath('~\\.profer-dev\\skins\\demo-skin\\skin.css')).toBe(true)
  })

  test('单独的 ~ 与 ~other 写法不当作绝对路径', () => {
    expect(isAbsoluteFilePath('~')).toBe(false)
    expect(isAbsoluteFilePath('~other/report.md')).toBe(false)
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

describe('resolveRelativeToAbsolute（R4 统一拼接实现）', () => {
  test('无候选 base 时返回原路径', () => {
    expect(resolveRelativeToAbsolute('src/a.md', [])).toBe('src/a.md')
  })

  test('首段未命中时退化拼接第一个 base', () => {
    expect(resolveRelativeToAbsolute('src/a.md', ['C:/ws/profer'])).toBe('C:/ws/profer/src/a.md')
  })

  test('首段命中 base 目录名时不重复嵌套', () => {
    expect(resolveRelativeToAbsolute('profer/src/a.md', ['C:/ws/profer'])).toBe('C:/ws/profer/src/a.md')
  })

  test('多候选 base 匹配第二个', () => {
    expect(resolveRelativeToAbsolute('workspace-files/x.md', ['C:/ws/profer', 'C:/ws/profer/workspace-files']))
      .toBe('C:/ws/profer/workspace-files/x.md')
  })

  test('Windows 反斜杠 base 与中文路径', () => {
    expect(resolveRelativeToAbsolute('docs/方案.md', ['C:\\ws\\项目\\workspace-files']))
      .toBe('C:\\ws\\项目\\workspace-files/docs/方案.md')
  })

  test('Windows 反斜杠相对路径与正斜杠写法解析到同一目标', () => {
    expect(resolveRelativeToAbsolute('1233\\2344\\4566.txt', ['C:/ws/profer']))
      .toBe('C:/ws/profer/1233/2344/4566.txt')
  })

  test('尾部斜杠 base', () => {
    expect(resolveRelativeToAbsolute('src/a.md', ['C:/ws/profer/'])).toBe('C:/ws/profer/src/a.md')
  })

  test('父级相对路径折叠到 base 上一级（回归：展示/复制带 /../ 的半截路径）', () => {
    expect(resolveRelativeToAbsolute('../合并_20261027_时间轴.txt', ['C:\\Users\\Admin\\.profer\\agent-workspaces\\5714\\8333efcc']))
      .toBe('C:\\Users\\Admin\\.profer\\agent-workspaces\\5714\\合并_20261027_时间轴.txt')
    expect(resolveRelativeToAbsolute('../out/a.md', ['/Users/mac/ws/session']))
      .toBe('/Users/mac/ws/out/a.md')
  })

  test('当前目录与嵌套父级相对路径同样折叠', () => {
    expect(resolveRelativeToAbsolute('./a/b.md', ['/Users/mac/ws/session'])).toBe('/Users/mac/ws/session/a/b.md')
    expect(resolveRelativeToAbsolute('a/../../b.md', ['/Users/mac/ws/session'])).toBe('/Users/mac/ws/b.md')
  })
})

describe('normalizeFilePathSegments（展示/复制路径规范化）', () => {
  test('不含点段时原样返回（保留调用方分隔符风格）', () => {
    expect(normalizeFilePathSegments('C:\\ws\\项目\\workspace-files/docs/方案.md'))
      .toBe('C:\\ws\\项目\\workspace-files/docs/方案.md')
    expect(normalizeFilePathSegments('/Users/mac/ws/a.md')).toBe('/Users/mac/ws/a.md')
    expect(normalizeFilePathSegments('report.md')).toBe('report.md')
    expect(normalizeFilePathSegments('')).toBe('')
  })

  test('Windows 盘符路径折叠并沿盘符后的分隔符风格重建', () => {
    expect(normalizeFilePathSegments('C:\\ws\\5714\\8333efcc/../合并.txt')).toBe('C:\\ws\\5714\\合并.txt')
    expect(normalizeFilePathSegments('C:/ws/5714/8333efcc/../合并.txt')).toBe('C:/ws/5714/合并.txt')
  })

  test('UNC 路径保留 server\\share 根', () => {
    expect(normalizeFilePathSegments('\\\\server\\share\\a\\..\\b.md')).toBe('\\\\server\\share\\b.md')
    expect(normalizeFilePathSegments('\\\\server\\share\\..\\..\\b.md')).toBe('\\\\server\\share\\b.md')
  })

  test('主目录缩写不展开', () => {
    expect(normalizeFilePathSegments('~/.profer/skins/../skins/demo/skin.css'))
      .toBe('~/.profer/skins/demo/skin.css')
  })

  test('绝对路径根之上的 .. 丢弃，相对路径开头的 .. 保留', () => {
    expect(normalizeFilePathSegments('/../a.md')).toBe('/a.md')
    expect(normalizeFilePathSegments('../a/../../b.md')).toBe('../../b.md')
  })

  test('连续分隔符与末尾点段一并收敛', () => {
    expect(normalizeFilePathSegments('/ws//a///./b.md')).toBe('/ws/a/b.md')
    expect(normalizeFilePathSegments('/ws/a/..')).toBe('/ws')
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
