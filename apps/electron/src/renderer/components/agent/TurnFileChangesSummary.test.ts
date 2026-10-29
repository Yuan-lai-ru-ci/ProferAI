import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { buildTurnFileNameMap, collectAuthoritativeFileChanges, collectModifiedFilePaths } from './TurnFileChangesSummary'

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

function toolResultWithChanges(
  toolUseId: string,
  changes: Array<{ path: string; source: 'write' | 'edit' | 'bash' }>,
): SDKMessage {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', proferFileChanges: changes }],
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

  test('maps a lowercase Pi read to its absolute path for inline filename resolution', () => {
    const result = buildTurnFileNameMap([
      toolUse('read-1', 'read', { path: '/tmp/project/src/pi-settings.ts' }),
    ])

    expect(result.get('pi-settings.ts')).toBe('/tmp/project/src/pi-settings.ts')
  })

  test('does not map a file whose tool call failed', () => {
    const result = buildTurnFileNameMap([
      toolUse('read-1', 'Read', { file_path: '/tmp/project/missing.md' }),
      failedToolResult('read-1'),
    ])

    expect(result.has('missing.md')).toBe(false)
  })
})

describe('collectAuthoritativeFileChanges', () => {
  test('reads the main-process ledger from tool_result blocks in order', () => {
    const result = collectAuthoritativeFileChanges([
      toolResultWithChanges('write-1', [{ path: '/repo/a.ts', source: 'write' }]),
      toolResultWithChanges('bash-1', [
        { path: '/repo/b.ts', source: 'bash' },
        { path: '/repo/a.ts', source: 'bash' },
      ]),
    ])

    expect(result).toEqual(['/repo/a.ts', '/repo/b.ts'])
  })

  test('ignores turns without ledger data', () => {
    expect(collectAuthoritativeFileChanges([toolUse('write-1', 'write', { path: '/repo/a.ts' })])).toEqual([])
  })
})

describe('collectModifiedFilePaths', () => {
  test('prefers the ledger over tool_use arguments', () => {
    const result = collectModifiedFilePaths([
      toolUse('write-1', 'write', { path: '/repo/from-input.ts', content: 'a' }),
      toolResultWithChanges('write-1', [{ path: '/repo/from-ledger.ts', source: 'write' }]),
    ])

    expect(result).toEqual(['/repo/from-ledger.ts'])
  })

  test('collects Pi runtime lowercase write/edit tool calls when no ledger exists', () => {
    const result = collectModifiedFilePaths([
      toolUse('write-1', 'write', { path: '/tmp/project/a.ts', content: 'a' }),
      toolUse('edit-1', 'edit', { path: '/tmp/project/b.ts', oldText: 'b', newText: 'c' }),
      toolUse('edit-2', 'edit', { path: '/tmp/project/a.ts', oldText: 'a', newText: 'b' }),
    ])

    expect(result).toEqual(['/tmp/project/a.ts', '/tmp/project/b.ts'])
  })

  test('excludes failed lowercase edit and ignores read-only tools in the changes summary', () => {
    const result = collectModifiedFilePaths([
      toolUse('read-1', 'read', { path: '/tmp/project/read.ts' }),
      toolUse('edit-1', 'edit', { path: '/tmp/project/failed.ts', oldText: 'a', newText: 'b' }),
      failedToolResult('edit-1'),
    ])

    expect(result).toEqual([])
  })

  test('never derives paths from bash command text', () => {
    const result = collectModifiedFilePaths([
      toolUse('bash-1', 'Bash', { command: `cd /repo && sed -i '' 's/a/b/' src/a.ts` }),
      toolUse('bash-2', 'Bash', { command: `curl -sS -o /dev/null -w "%{http_code}" https://example.com` }),
    ])

    expect(result).toEqual([])
  })

  test('keeps bash writes that the main process observed through snapshots', () => {
    const result = collectModifiedFilePaths([
      toolUse('bash-1', 'bash', { command: 'python3 -c "open(\'report.md\',\'w\').write(\'x\')"' }),
      toolResultWithChanges('bash-1', [{ path: '/repo/report.md', source: 'bash' }]),
    ])

    expect(result).toEqual(['/repo/report.md'])
  })
})
