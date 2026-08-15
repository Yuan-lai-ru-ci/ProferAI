import { describe, expect, test } from 'bun:test'
import { normalizeThinkTagsInContentBlocks, parseThinkTagsFromText } from './thinking-tag-parser'

describe('parseThinkTagsFromText', () => {
  test('Given <thinking> 包裹思考并跟随正文 Then 拆为思考块和文本块', () => {
    expect(parseThinkTagsFromText('<thinking>规划实现</thinking>开始写代码')).toEqual([
      { type: 'thinking', thinking: '规划实现' },
      { type: 'text', text: '开始写代码' },
    ])
  })

  test('Given 流式未闭合 <thinking> Then 将剩余内容作为思考块', () => {
    expect(parseThinkTagsFromText('前言<thinking>仍在思考')).toEqual([
      { type: 'text', text: '前言' },
      { type: 'thinking', thinking: '仍在思考' },
    ])
  })

  test('Given <think> 旧格式 Then 保持兼容', () => {
    expect(normalizeThinkTagsInContentBlocks([
      { type: 'text', text: '<think>兼容旧标签</think>正文' },
    ])).toEqual([
      { type: 'thinking', thinking: '兼容旧标签' },
      { type: 'text', text: '正文' },
    ])
  })
})
