import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { buildTurnFileNameMap } from './TurnFileChangesSummary'

function toolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as unknown as SDKMessage
}

function failedToolResult(toolUseId: string): SDKMessage {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: 'failed' }],
    },
  } as unknown as SDKMessage
}

describe('buildTurnFileNameMap', () => {
  test('maps a file read in the current turn to its absolute path', () => {
    const result = buildTurnFileNameMap([
      toolUse('read-1', 'Read', { file_path: 'D:\\profer\\workspace-files\\.context\\user-profile.md' }),
    ])

    expect(result.get('user-profile.md')).toBe('D:\\profer\\workspace-files\\.context\\user-profile.md')
  })

  test('preserves a line-number compatible source path after a Write', () => {
    const result = buildTurnFileNameMap([
      toolUse('write-1', 'Write', { file_path: '/tmp/project/src/settings.ts', content: 'export {}' }),
    ])

    expect(result.get('settings.ts')).toBe('/tmp/project/src/settings.ts')
  })

  test('does not map an ambiguous filename from different directories', () => {
    const result = buildTurnFileNameMap([
      toolUse('read-1', 'Read', { file_path: '/tmp/project-a/config.json' }),
      toolUse('read-2', 'Read', { file_path: '/tmp/project-b/config.json' }),
    ])

    expect(result.has('config.json')).toBe(false)
  })

  test('does not map a file whose tool call failed', () => {
    const result = buildTurnFileNameMap([
      toolUse('read-1', 'Read', { file_path: '/tmp/project/missing.md' }),
      failedToolResult('read-1'),
    ])

    expect(result.has('missing.md')).toBe(false)
  })
})
