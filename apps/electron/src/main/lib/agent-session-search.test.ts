import { describe, expect, test } from 'bun:test'
import { createSnippet, extractTextFromPersistedMessage, matchAgentJsonlLine } from './agent-session-search'

describe('单行 JSONL 匹配', () => {
  test('短文本命中：片段不加省略号，matchStart 为原始偏移', () => {
    const line = JSON.stringify({ role: 'user', id: 'u1', content: 'say Hello world' })
    expect(matchAgentJsonlLine(line, 'hello', 5)).toEqual({
      messageId: 'u1',
      role: 'user',
      author: { type: 'unknown' },
      snippet: 'say Hello world',
      matchStart: 4,
    })
  })

  test('长文本命中：前后各 40 字符，前缀省略号计入 matchStart 偏移 +3', () => {
    const line = JSON.stringify({ role: 'assistant', uuid: 'a1', content: 'x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100) })
    const hit = matchAgentJsonlLine(line, 'needle', 6)
    expect(hit?.messageId).toBe('a1')
    expect(hit?.snippet).toBe('...' + 'x'.repeat(40) + 'NEEDLE' + 'y'.repeat(40) + '...')
    expect(hit?.matchStart).toBe(43)
  })

  test('SDKMessage 格式：从 message.content 的文本块中匹配，多个文本块以换行连接', () => {
    const line = JSON.stringify({
      message: { role: 'user', id: 'm1', content: [{ type: 'text', text: 'alpha' }, { type: 'tool_use' }, { type: 'text', text: 'beta NEEDLE' }] },
    })
    expect(matchAgentJsonlLine(line, 'needle', 6)?.snippet).toBe('alpha\nbeta NEEDLE')
  })

  test('search recognizes SDK protocol role first and includes author provenance separately', () => {
    const provenance = { schemaVersion: 1, messageId: 'm1', author: { type: 'agent', id: 'worker' }, runId: 'run-1' }
    const result = matchAgentJsonlLine(JSON.stringify({
      type: 'user',
      role: 'assistant',
      uuid: 'sdk-uuid',
      _provenance: provenance,
      message: { role: 'assistant', content: [{ type: 'text', text: 'needle in handoff' }] },
    }), 'needle', 6)
    expect(result).toMatchObject({ messageId: 'sdk-uuid', role: 'user', provenance, author: { type: 'agent', id: 'worker' } })
  })

  test('角色不在白名单时退化为 assistant', () => {
    const line = JSON.stringify({ role: 'weird', id: 'w', content: 'needle at start' })
    expect(matchAgentJsonlLine(line, 'needle', 6)?.role).toBe('assistant')
  })

  test('缺失 role 时取 message.role，再退化为 assistant', () => {
    expect(matchAgentJsonlLine(JSON.stringify({ content: 'needle' }), 'needle', 6)?.role).toBe('assistant')
    expect(matchAgentJsonlLine(JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'needle' }] } }), 'needle', 6)?.role).toBe('user')
  })

  test('id 缺失时依次回退到 uuid、message.id，最后为空串', () => {
    expect(matchAgentJsonlLine(JSON.stringify({ uuid: 'u', content: 'needle' }), 'needle', 6)?.messageId).toBe('u')
    expect(matchAgentJsonlLine(JSON.stringify({ message: { id: 'mid', content: [{ type: 'text', text: 'needle' }] } }), 'needle', 6)?.messageId).toBe('mid')
    expect(matchAgentJsonlLine(JSON.stringify({ content: 'needle' }), 'needle', 6)?.messageId).toBe('')
  })

  test('大小写不敏感：调用方传入小写 query，文本大小写混合仍命中', () => {
    expect(matchAgentJsonlLine(JSON.stringify({ content: 'NeEdLe mixed' }), 'needle', 6)).not.toBeNull()
  })

  test('空行、损坏行、无文本与未命中都返回 null，不抛异常', () => {
    expect(matchAgentJsonlLine('', 'needle', 6)).toBeNull()
    expect(matchAgentJsonlLine('   ', 'needle', 6)).toBeNull()
    expect(matchAgentJsonlLine('not json', 'needle', 6)).toBeNull()
    expect(matchAgentJsonlLine(JSON.stringify({ content: '' }), 'needle', 6)).toBeNull()
    expect(matchAgentJsonlLine(JSON.stringify({ content: 'nothing here' }), 'needle', 6)).toBeNull()
  })
})

describe('文本抽取与片段', () => {
  test('extractTextFromPersistedMessage：字符串 content 原样返回，块数组只取 text 块', () => {
    expect(extractTextFromPersistedMessage({ content: 'plain' })).toBe('plain')
    expect(extractTextFromPersistedMessage({ message: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } })).toBe('a\nb')
    expect(extractTextFromPersistedMessage(null)).toBe('')
    expect(extractTextFromPersistedMessage({})).toBe('')
  })

  test('createSnippet：命中前后各 48 字符，两端截断时加省略号', () => {
    expect(createSnippet('abc', 1, 1)).toBe('abc')
    const text = 'a'.repeat(60) + 'HIT' + 'b'.repeat(60)
    expect(createSnippet(text, 60, 3)).toBe('...' + 'a'.repeat(48) + 'HIT' + 'b'.repeat(48) + '...')
  })
})
