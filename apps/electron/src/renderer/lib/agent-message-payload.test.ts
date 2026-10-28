import { describe, expect, test } from 'bun:test'

import type { QuotedSelection } from '@/atoms/preview-atoms'
import { buildAgentMessagePayload, parseMessageMentions } from './agent-message-payload'

const quote = (over: Partial<QuotedSelection> = {}): QuotedSelection => ({
  text: '被引用的那段',
  filePath: '/tmp/demo.md',
  sourceType: 'file',
  capturedAt: 1,
  ...over,
})

describe('发送文本拼装', () => {
  test('引用块在正文之前，正文原样保留', () => {
    const payload = buildAgentMessagePayload('按这三处一起改', [quote()])
    expect(payload.rawText.startsWith('<quoted_file')).toBe(true)
    expect(payload.rawText.endsWith('按这三处一起改')).toBe(true)
  })

  test('只发引用（正文为空）时 rawText 仍非空，可被发送链路接受', () => {
    const payload = buildAgentMessagePayload('', [quote()])
    expect(payload.rawText.length).toBeGreaterThan(0)
    expect(payload.rawText).toContain('被引用的那段')
  })

  test('多条引用保持传入顺序', () => {
    const payload = buildAgentMessagePayload('看这三处', [
      quote({ filePath: '/a.md', text: 'A' }),
      quote({ filePath: '/b.md', text: 'B' }),
      quote({ filePath: '/c.md', text: 'C' }),
    ])
    const order = ['/a.md', '/b.md', '/c.md'].map((path) => payload.rawText.indexOf(path))
    expect(order[0]).toBeLessThan(order[1]!)
    expect(order[1]).toBeLessThan(order[2]!)
  })

  test('无引用时与纯文本一致', () => {
    const payload = buildAgentMessagePayload('  只有正文  ')
    expect(payload.rawText).toBe('只有正文')
    expect(payload.sdkText).toBe('只有正文')
  })

  test('sdkText 剥掉 mention 标记，rawText 保留原文', () => {
    const payload = buildAgentMessagePayload('看 /skill:demo 和 &session:abc123', [quote()])
    expect(payload.rawText).toContain('/skill:demo')
    expect(payload.sdkText).not.toContain('/skill:demo')
    expect(payload.mentions.mentionedSkills).toEqual(['demo'])
    expect(payload.mentions.mentionedSessionIds).toEqual(['abc123'])
    expect(payload.sdkText.startsWith('<quoted_file')).toBe(true)
  })

  test('引用块按 ref 升序展开，正文里的 [n] 原样保留', () => {
    const payload = buildAgentMessagePayload('这两处 [1] 和 [2] 不一致，按 [2] 改', [
      quote({ ref: 2, filePath: '/b.md', text: 'B' }),
      quote({ ref: 1, filePath: '/a.md', text: 'A' }),
    ])
    expect(payload.rawText.indexOf('ref="1"')).toBeLessThan(payload.rawText.indexOf('ref="2"'))
    expect(payload.rawText).toContain('按 [2] 改')
  })

  test('正文与引用都为空时拼出空串', () => {
    expect(buildAgentMessagePayload('', []).rawText).toBe('')
  })
})

describe('mention 解析', () => {
  test('三种引用各自归位并从正文剥离', () => {
    const parsed = parseMessageMentions('/skill:a #mcp:b &session:c')
    expect(parsed.mentionedSkills).toEqual(['a'])
    expect(parsed.mentionedMcpServers).toEqual(['b'])
    expect(parsed.mentionedSessionIds).toEqual(['c'])
    expect(parsed.cleanedText).toBe('')
  })
})
