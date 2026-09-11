import { describe, expect, test } from 'bun:test'
import {
  MAX_TITLE_LENGTH,
  SHORT_MESSAGE_THRESHOLD,
  buildTitlePrompt,
  createFallbackTitle,
  sanitizeGeneratedTitle,
} from './title-generation'

/** Chat 与 Agent 统一后的唯一标题生成 prompt。 */
const UNIFIED_TITLE_PROMPT =
  '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。如果消息内容过短或无明确主题，直接使用原始消息作为标题。\n\n用户消息：'

describe('buildTitlePrompt', () => {
  test('Given 用户消息 When 构建 Then 使用 Chat/Agent 统一 prompt', () => {
    expect(buildTitlePrompt('帮我修复登录')).toBe(UNIFIED_TITLE_PROMPT + '帮我修复登录')
  })

  test('Given 多行用户消息 When 构建 Then 原样保留换行', () => {
    expect(buildTitlePrompt('第一行\n第二行')).toBe(UNIFIED_TITLE_PROMPT + '第一行\n第二行')
  })

  test('Given 任意长度消息 When 构建 Then 始终包含短消息回退约束', () => {
    expect(buildTitlePrompt('1')).toContain('如果消息内容过短或无明确主题，直接使用原始消息作为标题。')
  })
})

describe('sanitizeGeneratedTitle', () => {
  test('Given 字符串标题 When 清洗 Then 去首尾引号并保留正文', () => {
    expect(sanitizeGeneratedTitle('"直引号标题"')).toBe('直引号标题')
  })

  // 回归：内联副本的正则曾在编码往返中把 “”‘’ 退化成重复直引号，
  // 导致中文弯引号与书名号无法被剥离。收敛到共享模块后必须能正确剥离。
  test('Given 中文弯引号 When 清洗 Then 剥离弯引号', () => {
    expect(sanitizeGeneratedTitle('“修复 OAuth 登录”')).toBe('修复 OAuth 登录')
    expect(sanitizeGeneratedTitle('‘单引号标题’')).toBe('单引号标题')
  })

  test('Given 中文书名号 When 清洗 Then 剥离书名号', () => {
    expect(sanitizeGeneratedTitle('「标题」')).toBe('标题')
    expect(sanitizeGeneratedTitle('《标题》')).toBe('标题')
  })

  // 回归：部分 OpenAI 兼容端点把 message.content 返回为内容块数组，
  // 旧实现直接 .trim() 会抛异常并被 catch 静默丢弃标题。
  test('Given 内容块数组 When 清洗 Then 拼接 text 字段而不抛异常', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'text', text: '修复' },
      { type: 'text', text: '登录问题' },
    ])).toBe('修复登录问题')
  })

  test('Given reasoning/thinking/tool 块含 text When 清洗 Then 只保留显式 text 块', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'thinking', text: '让我先分析用户意图' },
      { type: 'reasoning', text: '再推理一下' },
      { type: 'toolCall', text: '工具调用内容' },
      { type: 'text', text: '登录修复' },
    ])).toBe('登录修复')
  })

  test('Given 内容块数组只有非文本类型 When 清洗 Then 返回 null', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'thinking', text: '内部推理' },
      { type: 'toolCall', text: '工具内容' },
    ])).toBeNull()
  })

  test('Given 无 type 的兼容内容块 When 清洗 Then 保留 text 字段', () => {
    expect(sanitizeGeneratedTitle([{ text: '兼容标题' }])).toBe('兼容标题')
    expect(sanitizeGeneratedTitle({ text: '对象标题' })).toBe('对象标题')
  })

  test('Given 显式 text 块和无 type 块混合 When 清洗 Then 仅采用显式 text 块', () => {
    expect(sanitizeGeneratedTitle([
      { text: '非权威兼容文本' },
      { type: 'text', text: '权威标题' },
    ])).toBe('权威标题')
  })

  test('Given 单个非文本类型对象含 text When 清洗 Then 返回 null', () => {
    expect(sanitizeGeneratedTitle({ type: 'thinking', text: '内部推理' })).toBeNull()
  })

  test('Given 数组内块无 text 字段 When 清洗 Then 跳过该块', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'toolCall' },
      { type: 'text', text: '标题' },
    ])).toBe('标题')
  })

  test('Given 非文本内容 When 清洗 Then 返回 null', () => {
    expect(sanitizeGeneratedTitle([{ type: 'toolCall' }])).toBeNull()
    expect(sanitizeGeneratedTitle('')).toBeNull()
    expect(sanitizeGeneratedTitle('""')).toBeNull()
    expect(sanitizeGeneratedTitle(null)).toBeNull()
    expect(sanitizeGeneratedTitle(undefined)).toBeNull()
  })

  test('Given 超长标题 When 清洗 Then 截断到 MAX_TITLE_LENGTH', () => {
    const long = '一'.repeat(50)
    expect(sanitizeGeneratedTitle(long)).toHaveLength(MAX_TITLE_LENGTH)
  })
})

describe('createFallbackTitle', () => {
  test('Given 多行消息 When 兜底 Then 取第一个非空行', () => {
    expect(createFallbackTitle('\n\n第一行主题\n第二行细节')).toBe('第一行主题')
  })

  test('Given Markdown 前缀 When 兜底 Then 去掉前缀与多余空白', () => {
    expect(createFallbackTitle('##   标题   内容  ')).toBe('标题 内容')
  })

  test('Given 超长首行 When 兜底 Then 截断到 MAX_TITLE_LENGTH', () => {
    expect(createFallbackTitle('一'.repeat(50))).toHaveLength(MAX_TITLE_LENGTH)
  })

  test('Given 空白消息 When 兜底 Then 返回 null', () => {
    expect(createFallbackTitle('   ')).toBeNull()
    expect(createFallbackTitle('')).toBeNull()
  })
})

describe('常量', () => {
  test('短消息阈值与标题长度保持既有取值', () => {
    expect(SHORT_MESSAGE_THRESHOLD).toBe(4)
    expect(MAX_TITLE_LENGTH).toBe(20)
  })
})
