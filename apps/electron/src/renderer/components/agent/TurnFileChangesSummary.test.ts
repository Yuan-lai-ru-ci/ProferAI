import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { buildTurnFileNameMap, collectAuthoritativeFileChanges, collectModifiedFilePaths, resolveVisibleFileChanges } from './TurnFileChangesSummary'

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

  test.each(['Write', 'write'])('同轮有部分账本时仍保留未覆盖的 %s/Edit 路径', (writeName) => {
    const editName = writeName === 'Write' ? 'Edit' : 'edit'
    expect(collectModifiedFilePaths([
      toolUse('write-1', writeName, { path: '/repo/input.ts' }),
      toolResultWithChanges('write-1', [{ path: '/repo/observed.ts', source: 'write' }]),
      toolUse('edit-1', editName, { path: '/repo/edited.ts' }),
      toolUse('edit-2', editName, { path: '/repo/failed.ts' }),
      failedToolResult('edit-2'),
    ])).toEqual(['/repo/observed.ts', '/repo/edited.ts'])
  })

  test('账本仅覆盖对应 tool_use_id，不覆盖同路径的其他调用', () => {
    expect(collectModifiedFilePaths([
      toolUse('write-1', 'write', { path: '/repo/input.ts' }),
      toolResultWithChanges('write-1', [{ path: '/repo/observed.ts', source: 'write' }]),
      toolUse('edit-1', 'edit', { path: '/repo/input.ts' }),
    ])).toEqual(['/repo/observed.ts', '/repo/input.ts'])
  })

  test('混合账本与回退路径按文件去重，不从 Bash 命令补路径', () => {
    expect(collectModifiedFilePaths([
      toolResultWithChanges('bash-1', [{ path: '/repo/observed.ts', source: 'bash' }]),
      toolUse('edit-1', 'Edit', { path: '/repo/observed.ts' }),
      toolUse('write-1', 'Write', { path: '/repo/other.ts' }),
      toolUse('bash-2', 'bash', { command: 'echo x > /repo/not-observed.ts' }),
    ])).toEqual(['/repo/observed.ts', '/repo/other.ts'])
  })

  test('显式空账本也覆盖对应调用，不把未发生写入的参数补成 chip', () => {
    expect(collectModifiedFilePaths([
      toolUse('write-1', 'write', { path: '/repo/not-written.ts' }),
      toolResultWithChanges('write-1', []),
      toolUse('edit-1', 'edit', { path: '/repo/edited.ts' }),
    ])).toEqual(['/repo/edited.ts'])
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

describe('文件改动 chip 不追踪会话工作目录里的草稿文件', () => {
  const sessionPath = '/Users/me/.profer/agent-workspaces/profer/0ad480b7'

  test('会话目录内的截图与临时产物不显示，项目改动保留', () => {
    expect(resolveVisibleFileChanges(
      [`${sessionPath}/mem-v2.png`, '/Users/me/profer/profer-main/src/a.ts', `${sessionPath}/.context/plan/x.md`],
      sessionPath,
    )).toEqual(['/Users/me/profer/profer-main/src/a.ts'])
  })

  test('会话目录前缀相同但并非子目录时不误伤', () => {
    expect(resolveVisibleFileChanges(['/Users/me/.profer/agent-workspaces/profer/0ad480b7-backup/a.ts'], sessionPath))
      .toEqual(['/Users/me/.profer/agent-workspaces/profer/0ad480b7-backup/a.ts'])
  })

  test('没有会话目录时保持原样；相对路径无法判断归属，保持可见', () => {
    expect(resolveVisibleFileChanges([`${sessionPath}/mem-v2.png`])).toEqual([`${sessionPath}/mem-v2.png`])
    expect(resolveVisibleFileChanges(['src/a.ts'], sessionPath)).toEqual(['src/a.ts'])
  })
})

/**
 * P1-6 / FIX-B 回归：project 下草稿区是 storageDir，不是用户可见的项目根。
 *
 * 修前 `TurnFileChangesSummary` 拿 `sessionPath`（project 下 = 项目根）当草稿区，
 * 项目内改动全被当成草稿隐藏，文件改动 chip 变空。
 */
describe('草稿区基准必须是 storageDir（project 下不再是 UI 根）', () => {
  const projectRoot = '/Users/me/profer/profer-main'
  const projectStorageDir = '/Users/me/.profer/agent-workspaces/proj/sessions/0ad480b7'

  test('project：项目内改动看得见', () => {
    expect(resolveVisibleFileChanges(
      [`${projectRoot}/src/a.ts`, `${projectRoot}/README.md`],
      projectStorageDir,
    )).toEqual([`${projectRoot}/src/a.ts`, `${projectRoot}/README.md`])
  })

  test('project：storageDir 内的截图与 .context 草稿仍被隐藏', () => {
    expect(resolveVisibleFileChanges(
      [`${projectStorageDir}/mem-v2.png`, `${projectStorageDir}/.context/plan/x.md`, `${projectRoot}/src/a.ts`],
      projectStorageDir,
    )).toEqual([`${projectRoot}/src/a.ts`])
  })

  test('project：拿 UI 根当基准会把项目改动全部吃掉（修前的 bug，用基准反证）', () => {
    expect(resolveVisibleFileChanges([`${projectRoot}/src/a.ts`], projectRoot)).toEqual([])
  })

  test('managed：storageDir 就是会话目录，行为与改造前一致', () => {
    expect(resolveVisibleFileChanges(
      [`${projectStorageDir}/mem-v2.png`, '/Users/me/profer/profer-main/src/a.ts'],
      projectStorageDir,
    )).toEqual(['/Users/me/profer/profer-main/src/a.ts'])
  })

  test('拿不到 storageDir 时不做草稿过滤（绝不回退到 UI 根）', () => {
    expect(resolveVisibleFileChanges([
      `${projectRoot}/src/a.ts`,
      `${projectStorageDir}/mem-v2.png`,
    ])).toEqual([`${projectRoot}/src/a.ts`, `${projectStorageDir}/mem-v2.png`])
  })
})
