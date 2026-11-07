import { describe, expect, test } from 'bun:test'
import {
  createClaudeRewindEvidenceHooks,
  type ClaudeRewindEvidenceCaptureInput,
  type ClaudeRewindFileSnapshot,
  type ClaudeRewindToolEvidence,
} from './rewind-evidence'

function snapshot(input: ClaudeRewindEvidenceCaptureInput): ClaudeRewindFileSnapshot {
  return {
    path: input.path,
    revision: `${input.phase}:${input.toolUseId}`,
    exists: true,
    backupRef: `backup:${input.phase}:${input.toolUseId}`,
    contentRef: `content:${input.phase}:${input.toolUseId}`,
  }
}

describe('Claude rewind evidence hooks', () => {
  test('用 SDK tool_use_id 配对 Write 前后版本，并忽略 Shell/MCP', async () => {
    const captures: ClaudeRewindEvidenceCaptureInput[] = []
    const records: ClaudeRewindToolEvidence[] = []
    const hooks = createClaudeRewindEvidenceHooks({
      async capture(input) {
        captures.push(input)
        return snapshot(input)
      },
      record(evidence) {
        records.push(evidence)
      },
    }, { sessionId: 'product-session' })

    await hooks.PreToolUse[0]!.hooks[0]!({
      hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      prompt_id: 'turn-1', tool_name: 'Write', tool_use_id: 'write-1',
      tool_input: { file_path: 'tracked.txt' },
    }, undefined, { signal: new AbortController().signal })
    await hooks.PostToolUse[0]!.hooks[0]!({
      hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      prompt_id: 'turn-1', tool_name: 'Write', tool_use_id: 'write-1',
      tool_input: { file_path: 'tracked.txt' }, tool_response: 'ok',
    }, undefined, { signal: new AbortController().signal })
    await hooks.PreToolUse[0]!.hooks[0]!({
      hook_event_name: 'PreToolUse', session_id: 'native', transcript_path: '/tmp/s', cwd: '/tmp',
      prompt_id: 'turn-2', tool_name: 'Edit', tool_use_id: 'write-1',
      tool_input: { file_path: 'other.txt' },
    }, 'sdk-callback-id', { signal: new AbortController().signal })
    expect(captures.at(-1)?.toolUseId).toBe('write-1')
    await hooks.PostToolUse[0]!.hooks[0]!({
      hook_event_name: 'PostToolUse', session_id: 'native', transcript_path: '/tmp/s', cwd: '/tmp',
      prompt_id: 'turn-2', tool_name: 'Edit', tool_use_id: 'write-1',
      tool_input: { file_path: 'other.txt' }, tool_response: 'ok',
    }, 'sdk-callback-id', { signal: new AbortController().signal })
    expect(records.at(-1)).toMatchObject({ sessionId: 'product-session', promptId: 'turn-2', path: '/tmp/other.txt', status: 'complete' })
    await hooks.PreToolUse[0]!.hooks[0]!({
      hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Bash', tool_use_id: 'bash-1', tool_input: { command: 'printf x > tracked.txt' },
    }, undefined, { signal: new AbortController().signal })

    expect(captures.map(capture => [capture.phase, capture.toolUseId, capture.toolName])).toEqual([
      ['before', 'write-1', 'Write'],
      ['after', 'write-1', 'Write'],
      ['before', 'write-1', 'Edit'],
      ['after', 'write-1', 'Edit'],
    ])
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ toolUseId: 'write-1', path: '/tmp/tracked.txt', status: 'complete' })
    expect(records[1]).toMatchObject({ toolUseId: 'write-1', path: '/tmp/other.txt', status: 'complete' })
    expect(records[0]?.before?.revision).toBe('before:write-1')
    expect(records[0]?.after?.revision).toBe('after:write-1')
  })

  test('同一路径存在并发 Write/Edit 时将两份证据降级', async () => {
    const records: ClaudeRewindToolEvidence[] = []
    const hooks = createClaudeRewindEvidenceHooks({
      async capture(input) { return snapshot(input) },
      record(evidence) { records.push(evidence) },
    }, { sessionId: 'product-session' })
    const pre = hooks.PreToolUse[0]!.hooks[0]!
    const post = hooks.PostToolUse[0]!.hooks[0]!
    const common = { session_id: 'sdk', transcript_path: '/tmp/s', cwd: '/tmp', prompt_id: 'parallel' }
    await pre({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'write-a', tool_input: { file_path: 'same.txt' } }, undefined, { signal: new AbortController().signal })
    await pre({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'edit-b', tool_input: { file_path: 'same.txt' } }, undefined, { signal: new AbortController().signal })
    await post({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'write-a', tool_input: { file_path: 'same.txt' }, tool_response: 'ok' }, undefined, { signal: new AbortController().signal })
    await post({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'edit-b', tool_input: { file_path: 'same.txt' }, tool_response: 'ok' }, undefined, { signal: new AbortController().signal })
    expect(records).toHaveLength(2)
    expect(records.every(record => record.status === 'unsupported' && record.reason?.includes('并发'))).toBe(true)
  })

  test('缺少 backup 或前置配对时返回 unsupported，不阻断原工具', async () => {
    const records: ClaudeRewindToolEvidence[] = []
    const hooks = createClaudeRewindEvidenceHooks({
      async capture(input) {
        return input.phase === 'before'
          ? { path: input.path, revision: 'before', exists: true }
          : { path: input.path, revision: 'after', exists: true, backupRef: 'after-backup', contentRef: 'after-content' }
      },
      record(evidence) {
        records.push(evidence)
      },
    })
    const callback = hooks.PostToolUse[0]!.hooks[0]!
    await callback({
      hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Edit', tool_use_id: 'orphan', tool_input: { file_path: 'new.txt' }, tool_response: 'ok',
    }, undefined, { signal: new AbortController().signal })
    expect(records[0]).toMatchObject({ toolUseId: 'orphan', status: 'unsupported' })

    await hooks.PreToolUse[0]!.hooks[0]!({
      hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Edit', tool_use_id: 'edit-1', tool_input: { file_path: 'tracked.txt' },
    }, undefined, { signal: new AbortController().signal })
    await hooks.PostToolUse[0]!.hooks[0]!({
      hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Edit', tool_use_id: 'edit-1', tool_input: { file_path: 'tracked.txt' }, tool_response: 'ok',
    }, undefined, { signal: new AbortController().signal })
    expect(records.at(-1)).toMatchObject({ toolUseId: 'edit-1', status: 'unsupported' })
  })

  test('PostToolUseFailure 保留 before 证据但不猜测 after', async () => {

    const records: ClaudeRewindToolEvidence[] = []
    const hooks = createClaudeRewindEvidenceHooks({
      async capture(input) {
        return { path: input.path, revision: 'before', exists: true, backupRef: 'backup', contentRef: 'before-content' }
      },
      record(evidence) {
        records.push(evidence)
      },
    })
    await hooks.PreToolUse[0]!.hooks[0]!({
      hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Write', tool_use_id: 'failed-1', tool_input: { file_path: 'tracked.txt' },
    }, undefined, { signal: new AbortController().signal })
    await hooks.PostToolUseFailure[0]!.hooks[0]!({
      hook_event_name: 'PostToolUseFailure', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Write', tool_use_id: 'failed-1', tool_input: { file_path: 'tracked.txt' }, error: 'failed',
    }, undefined, { signal: new AbortController().signal })
    expect(records[0]).toMatchObject({ toolUseId: 'failed-1', status: 'failed' })
    expect(records[0]?.after).toBeUndefined()
  })

  test('Edit 后文件不存在时保留可靠的删除后状态与 before backup', async () => {
    const records: ClaudeRewindToolEvidence[] = []
    const hooks = createClaudeRewindEvidenceHooks({
      async capture(input) {
        return input.phase === 'before'
          ? { path: input.path, revision: 'present-v1', exists: true, backupRef: 'backup-before', contentRef: 'before-content' }
          : { path: input.path, revision: 'absent-v2', exists: false }
      },
      record(evidence) {
        records.push(evidence)
      },
    })
    await hooks.PreToolUse[0]!.hooks[0]!({
      hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Edit', tool_use_id: 'edit-delete', tool_input: { file_path: 'tracked.txt' },
    }, undefined, { signal: new AbortController().signal })
    await hooks.PostToolUse[0]!.hooks[0]!({
      hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '/tmp/s', cwd: '/tmp',
      tool_name: 'Edit', tool_use_id: 'edit-delete', tool_input: { file_path: 'tracked.txt' }, tool_response: 'deleted',
    }, undefined, { signal: new AbortController().signal })
    expect(records[0]).toMatchObject({ status: 'complete', before: { exists: true, backupRef: 'backup-before' }, after: { exists: false, revision: 'absent-v2' } })
  })
})
