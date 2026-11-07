import { describe, expect, test } from 'bun:test'

import {
  QUICK_FIELD_FILES,
  freeTextPreview,
  normalizeFieldValue,
  plainText,
  readField,
  writeField,
} from './profile-fields'

const INITIAL_PROFILE = '# 用户背景\n\n<!-- 用户明确提供或确认的信息。 -->\n'
const INITIAL_PREFS = '# 稳定偏好\n\n<!-- 用户明确表达或确认的跨工作区偏好。 -->\n'

describe('字段所在文件', () => {
  test('去重后只包含两个既有全局记忆文件', () => {
    expect(QUICK_FIELD_FILES).toEqual(['user-profile.md', 'preferences.md'])
  })
})

describe('normalizeFieldValue', () => {
  test('折叠换行与连续空白', () => {
    expect(normalizeFieldValue('  独立 \n 开发者  ')).toBe('独立 开发者')
  })
})

describe('初始模板写入', () => {
  test('按标题追加字段，主标题与注释原样保留', () => {
    const doc = writeField(INITIAL_PROFILE, '称呼', '老源')
    expect(doc).toContain('# 用户背景')
    expect(doc).toContain('<!-- 用户明确提供或确认的信息。 -->')
    expect(readField(doc, '称呼')).toBe('老源')
  })

  test('空值写入不改动原文', () => {
    expect(writeField(INITIAL_PROFILE, '称呼', '   ')).toBe(INITIAL_PROFILE)
  })

  test('连续写入多个字段互不覆盖', () => {
    let doc = INITIAL_PROFILE
    doc = writeField(doc, '称呼', '老源')
    doc = writeField(doc, '职业与领域', '独立开发者')
    doc = writeField(doc, '常用语言', '中文')
    expect(readField(doc, '称呼')).toBe('老源')
    expect(readField(doc, '职业与领域')).toBe('独立开发者')
    expect(readField(doc, '常用语言')).toBe('中文')
  })
})

describe('已有同名小节（用户手写内容）', () => {
  const handWritten =
    '# 用户背景\n\n' +
    '我是独立开发者，主要做桌面应用。\n\n' +
    '## 称呼\n\n' +
    '- 老源\n' +
    '- 补充说明：正式场合用全名\n\n' +
    '<!-- 常用语言：中文 -->\n\n' +
    '## 设备\n\n' +
    'MacBook Pro · macOS\n'

  test('读取只取第一个值行并去掉列表前缀', () => {
    expect(readField(handWritten, '称呼')).toBe('老源')
  })

  test('编辑字段保留补充行、注释、自由正文与其它小节', () => {
    const doc = writeField(handWritten, '称呼', '源哥')
    expect(readField(doc, '称呼')).toBe('源哥')
    expect(doc).toContain('- 补充说明：正式场合用全名')
    expect(doc).toContain('<!-- 常用语言：中文 -->')
    expect(doc).toContain('我是独立开发者，主要做桌面应用。')
    expect(doc).toContain('## 设备')
    expect(doc).toContain('MacBook Pro · macOS')
  })

  test('编辑后列表前缀保留，不变成裸文本', () => {
    const doc = writeField(handWritten, '称呼', '源哥')
    expect(doc).toContain('- 源哥')
  })

  test('清空字段只删值行，补充行仍保留', () => {
    const doc = writeField(handWritten, '称呼', '')
    expect(readField(doc, '称呼')).toBe('补充说明：正式场合用全名')
    expect(doc).toContain('## 设备')
    expect(doc).toContain('MacBook Pro · macOS')
  })

  test('只剩注释的空节会被整节清掉', () => {
    const doc = '# 稳定偏好\n\n<!-- 备注 -->\n\n## 协作偏好\n\n<!-- 待补充 -->\n'
    const next = writeField(doc, '协作偏好', '')
    expect(next).not.toContain('## 协作偏好')
    expect(next).toContain('<!-- 备注 -->')
    expect(next).not.toContain('<!-- 待补充 -->')
  })

  test('小节只有注释、无值行时插入值', () => {
    const doc = '# 用户背景\n\n## 称呼\n\n<!-- 待补充 -->\n'
    const next = writeField(doc, '称呼', '老源')
    expect(readField(next, '称呼')).toBe('老源')
    expect(next).toContain('<!-- 待补充 -->')
  })
})

describe('边界', () => {
  test('字段值里的换行被折叠为单行，不会切碎小节', () => {
    const doc = writeField(INITIAL_PROFILE, '称呼', '老源\n## 假标题\n内容')
    expect(readField(doc, '称呼')).toBe('老源 ## 假标题 内容')
    expect(doc.match(/^## /gm)?.length).toBe(1)
  })

  test('三级标题不参与分节', () => {
    const doc = '# 用户背景\n\n## 称呼\n\n老源\n\n### 备注\n\n正式场合用全名\n'
    expect(readField(doc, '称呼')).toBe('老源')
    expect(writeField(doc, '称呼', '源哥')).toContain('### 备注')
  })

  test('CRLF 文档写回后仍可读', () => {
    const doc = '# 用户背景\r\n\r\n## 称呼\r\n\r\n老源\r\n'
    expect(readField(doc, '称呼')).toBe('老源')
    expect(readField(writeField(doc, '称呼', '源哥'), '称呼')).toBe('源哥')
  })

  test('写入是幂等的：相同值重复写入结果一致', () => {
    const once = writeField(INITIAL_PROFILE, '称呼', '老源')
    expect(writeField(once, '称呼', '老源')).toBe(once)
  })
})

describe('概览辅助', () => {
  test('freeTextPreview 跳过结构化字段小节，保留自由正文与自定义小节', () => {
    const doc =
      '# 用户背景\n\n' +
      '我是独立开发者。\n\n' +
      '## 称呼\n\n老源\n\n' +
      '## 备注\n\n偏好夜间工作\n'
    expect(freeTextPreview(doc)).toContain('我是独立开发者。')
    expect(freeTextPreview(doc)).toContain('偏好夜间工作')
    expect(freeTextPreview(doc)).not.toContain('老源')
  })

  test('plainText 去掉标题、链接与强调标记', () => {
    expect(plainText('# 标题\n\n**加粗** 与 [链接](https://example.com)')).toBe('加粗 与 链接')
  })
})
