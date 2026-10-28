import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { buildTurnFileNameMap, collectModifiedFilePaths, extractBashWritePaths } from './TurnFileChangesSummary'

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

  test('collects Pi runtime lowercase write/edit tool calls', () => {
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

  test('maps a lowercase Pi read to its absolute path for inline filename resolution', () => {
    const result = buildTurnFileNameMap([
      toolUse('read-1', 'read', { path: '/tmp/project/src/pi-settings.ts' }),
    ])

    expect(result.get('pi-settings.ts')).toBe('/tmp/project/src/pi-settings.ts')
  })

  test('extracts python Path write_text files from a bash command', () => {
    const command = `cd /Users/mac/profer/profer-main/apps/electron && python3 - <<'PY'
from pathlib import Path
p = Path('src/renderer/components/agent/TurnFileChangesSummary.tsx')
p.write_text('x')
PY`
    expect(extractBashWritePaths(command)).toEqual([
      '/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/TurnFileChangesSummary.tsx',
    ])
  })

  test('extracts sed -i and cat redirect paths from bash commands', () => {
    expect(extractBashWritePaths(`cd /repo && sed -i '' 's/a/b/' src/a.ts`)).toEqual(['/repo/src/a.ts'])
    expect(extractBashWritePaths(`cd /repo && cat > src/b.ts <<'EOF'\nhello\nEOF`)).toEqual(['/repo/src/b.ts'])
  })

  test('ignores read-only bash commands', () => {
    expect(extractBashWritePaths(`cd /repo && grep -n "write" src/a.ts`)).toEqual([])
    expect(extractBashWritePaths(`cd /repo && git status --porcelain`)).toEqual([])
  })

  test('collects bash write paths but excludes a failed bash call', () => {
    const result = collectModifiedFilePaths([
      toolUse('bash-1', 'Bash', { command: `cd /repo && sed -i '' 's/a/b/' src/a.ts` }),
      toolUse('bash-2', 'Bash', { command: `cd /repo && sed -i '' 's/a/b/' src/b.ts` }),
      failedToolResult('bash-2'),
    ])

    expect(result).toEqual(['/repo/src/a.ts'])
  })

  test('does not map a file whose tool call failed', () => {
    const result = buildTurnFileNameMap([
      toolUse('read-1', 'Read', { file_path: '/tmp/project/missing.md' }),
      failedToolResult('read-1'),
    ])

    expect(result.has('missing.md')).toBe(false)
  })
})
