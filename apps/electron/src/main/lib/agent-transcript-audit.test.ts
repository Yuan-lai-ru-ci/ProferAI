import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyTranscriptEvidence, countPiConversationMessages } from './agent-transcript-audit'

function piFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-audit-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

function message(role: string): string {
  return JSON.stringify({ type: 'message', id: `${role}-${Math.random().toString(16).slice(2, 8)}`, parentId: null, message: { role } })
}

describe('Pi 对话条数统计', () => {
  test('只数 user/assistant/toolResult，不数 header、模型变更、压缩与 system', () => {
    const file = piFile([
      JSON.stringify({ type: 'session', version: 3, id: 's1' }),
      JSON.stringify({ type: 'model_change', id: 'm0' }),
      JSON.stringify({ type: 'thinking_level_change', id: 't0' }),
      message('system'),
      message('user'),
      message('assistant'),
      message('toolResult'),
      JSON.stringify({ type: 'compaction', id: 'c1' }),
      JSON.stringify({ type: 'label', id: 'l1' }),
    ])
    expect(countPiConversationMessages(file).count).toBe(3)
  })

  test('坏行被跳过而不是让整份统计失败', () => {
    const file = piFile([
      JSON.stringify({ type: 'session', version: 3, id: 's1' }),
      '{ 这不是 JSON',
      message('user'),
      '',
      message('assistant'),
    ])
    expect(countPiConversationMessages(file).count).toBe(2)
  })

  test('跨读取分块仍然逐行统计（长文件不整份读入内存）', () => {
    const big = Array.from({ length: 800 }, () => message('assistant'))
    const file = piFile([JSON.stringify({ type: 'session', version: 3, id: 's1' }), ...big])
    expect(countPiConversationMessages(file).count).toBe(800)
  })
})

describe('内核 / transcript 一致性判定', () => {
  test('Pi 会话 + 只有 Claude 记录 → 跨内核产物', () => {
    expect(classifyTranscriptEvidence({ runtime: 'pi', piTranscript: false, claudeTranscript: true }))
      .toEqual({ kind: 'cross-runtime-artifact', detail: expect.stringContaining('Claude') })
  })

  test('Pi 会话 + 没有任何原生记录 → 不报（可能刚开始，或历史迁移中）', () => {
    expect(classifyTranscriptEvidence({ runtime: 'pi', piTranscript: false, claudeTranscript: false })).toBeNull()
  })

  test('Pi 记录条数与 Profer 历史不一致 → 报条数不符，并给出两侧数字', () => {
    const verdict = classifyTranscriptEvidence({
      runtime: 'pi', piTranscript: true, claudeTranscript: false,
      piMessageCount: 15, proferMessageCount: 113,
    })
    expect(verdict?.kind).toBe('transcript-message-mismatch')
    expect(verdict?.detail).toContain('15')
    expect(verdict?.detail).toContain('113')
  })

  test('条数一致时不报（含空会话 0=0）', () => {
    expect(classifyTranscriptEvidence({
      runtime: 'pi', piTranscript: true, claudeTranscript: false,
      piMessageCount: 4, proferMessageCount: 4,
    })).toBeNull()
    expect(classifyTranscriptEvidence({
      runtime: 'pi', piTranscript: true, claudeTranscript: false,
      piMessageCount: 0, proferMessageCount: 0,
    })).toBeNull()
  })

  test('Claude 会话 + 同 id Pi 记录 → 跨内核产物', () => {
    expect(classifyTranscriptEvidence({ runtime: 'claude', piTranscript: true, claudeTranscript: true })?.kind)
      .toBe('cross-runtime-artifact')
    expect(classifyTranscriptEvidence({ runtime: 'claude', piTranscript: false, claudeTranscript: true })).toBeNull()
  })
})
