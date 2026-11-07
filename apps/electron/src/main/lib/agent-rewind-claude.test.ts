import { describe, expect, test } from 'bun:test'
import type { ClaudeRewindToolEvidence } from '@profer/agent-provider-claude'
import { resolveClaudeRewind, type ClaudeRewindResolveInput } from './agent-rewind-claude'

function evidence(
  turnId: string,
  path: string,
  before: { revision: string; exists: boolean; backupRef?: string },
  after: { revision: string; exists: boolean; backupRef?: string },
  toolUseId = `write-${turnId}`,
): ClaudeRewindToolEvidence {
  return {
    sessionId: 'session',
    toolUseId,
    toolName: 'Write',
    path,
    before: { path, ...before },
    after: { path, ...after },
    status: 'complete',
  }
}

function base(overrides: Partial<ClaudeRewindResolveInput> = {}): ClaudeRewindResolveInput {
  return {
    sessionId: 'session',
    mode: 'both',
    target: { kind: 'after-turn', turnId: 'T1' },
    turns: [
      { turnId: 'T1', userMessageUuid: 'u1', assistantMessageUuid: 'a1' },
      { turnId: 'T2', userMessageUuid: 'u2', assistantMessageUuid: 'a2' },
      { turnId: 'T3', userMessageUuid: 'u3', assistantMessageUuid: 'a3' },
    ],
    currentSdkSessionId: 'sdk-session',
    currentSdkEntries: [
      { uuid: 'a1', type: 'assistant' },
      { uuid: 'a2', type: 'assistant' },
      { uuid: 'a3', type: 'assistant' },
    ],
    currentFileSnapshots: {
      '/workspace/tracked.txt': { path: '/workspace/tracked.txt', revision: 'D', exists: true, backupRef: 'backup-D' },
    },
    fileEvidence: [
      { turnId: 'T2', evidence: evidence('T2', '/workspace/tracked.txt', { revision: 'B', exists: true, backupRef: 'backup-B' }, { revision: 'C', exists: true, backupRef: 'backup-C' }) },
      { turnId: 'T3', evidence: evidence('T3', '/workspace/tracked.txt', { revision: 'C', exists: true, backupRef: 'backup-C' }, { revision: 'D', exists: true, backupRef: 'backup-D' }) },
    ],
    ...overrides,
  }
}

describe('Claude rewind target resolver', () => {
  test('after T1 与 before T2 共享 B 边界，both 提供 conversation 与 file candidate', () => {
    const after = resolveClaudeRewind(base({ target: { kind: 'after-turn', turnId: 'T1' } }))
    const before = resolveClaudeRewind(base({ target: { kind: 'before-turn', turnId: 'T2' } }))
    expect(after.supported).toBe(true)
    expect(before.supported).toBe(true)
    expect(after.conversation?.resumeAt).toBe('a1')
    expect(before.conversation?.resumeAt).toBe('a1')
    expect(after.fileCandidates).toEqual(before.fileCandidates)
    expect(after.fileCandidates).toMatchObject([{ path: '/workspace/tracked.txt', action: 'restore', targetRevision: 'B', currentRevision: 'D' }])
  })

  test('新建文件可由第一轮 before 快照证明删除，删除/缺失 after 不伪造 hash', () => {
    const result = resolveClaudeRewind(base({
      target: { kind: 'session-start' },
      currentFileSnapshots: {
        '/workspace/new.txt': { path: '/workspace/new.txt', revision: 'N', exists: true, backupRef: 'backup-N' },
      },
      fileEvidence: [
        { turnId: 'T1', evidence: evidence('T1', '/workspace/new.txt', { revision: 'missing', exists: false }, { revision: 'N', exists: true, backupRef: 'backup-N' }) },
      ],
    }))
    expect(result.supported).toBe(true)
    expect(result.fileCandidates).toMatchObject([{ action: 'delete', targetRevision: 'missing', currentRevision: 'N' }])
    expect(result.fileCandidates?.[0]?.targetBackupRef).toBeUndefined()
  })

  test('文件已处于目标状态时不生成伪 delete，可靠删除保留删除前备份供重建', () => {
    const createdThenDeleted = resolveClaudeRewind(base({
      target: { kind: 'after-turn', turnId: 'T1' },
      currentFileSnapshots: {
        '/workspace/new.txt': { path: '/workspace/new.txt', revision: 'deleted', exists: false },
      },
      fileEvidence: [
        { turnId: 'T2', evidence: evidence('T2', '/workspace/new.txt', { revision: 'missing', exists: false }, { revision: 'N', exists: true, backupRef: 'backup-N' }) },
        { turnId: 'T3', evidence: evidence('T3', '/workspace/new.txt', { revision: 'N', exists: true, backupRef: 'backup-N' }, { revision: 'deleted', exists: false }, 'delete-T3') },
      ],
    }))
    expect(createdThenDeleted.supported).toBe(true)
    expect(createdThenDeleted.fileCandidates).toEqual([])

    const deletedAfterTarget = resolveClaudeRewind(base({
      target: { kind: 'after-turn', turnId: 'T2' },
      currentFileSnapshots: {
        '/workspace/deleted.txt': { path: '/workspace/deleted.txt', revision: 'missing', exists: false },
      },
      fileEvidence: [
        { turnId: 'T1', evidence: evidence('T1', '/workspace/deleted.txt', { revision: 'A', exists: true, backupRef: 'backup-A' }, { revision: 'B', exists: true, backupRef: 'backup-B' }) },
        { turnId: 'T3', evidence: evidence('T3', '/workspace/deleted.txt', { revision: 'B', exists: true, backupRef: 'backup-B' }, { revision: 'missing', exists: false }, 'delete-T3') },
      ],
    }))
    expect(deletedAfterTarget.fileCandidates).toMatchObject([{ action: 'restore', targetRevision: 'B', targetBackupRef: 'backup-B' }])
  })

  test('conversation 模式不解析或输出文件动作，files 模式不输出 resume 锚点', () => {
    const conversation = resolveClaudeRewind(base({ mode: 'conversation' }))
    const files = resolveClaudeRewind(base({ mode: 'files' }))
    expect(conversation.supported).toBe(true)
    expect(conversation.fileCandidates).toBeUndefined()
    expect(conversation.conversation?.resumeAt).toBe('a1')
    expect(files.supported).toBe(true)
    expect(files.conversation).toBeUndefined()
    expect(files.fileCandidates).toHaveLength(1)
  })

  test('末轮文件回退为空动作集；首轮失败且无终态/文件证据时不支持文件回退', () => {
    const lastTurn = resolveClaudeRewind(base({
      mode: 'files',
      target: { kind: 'after-turn', turnId: 'T3' },
    }))
    expect(lastTurn.supported).toBe(true)
    expect(lastTurn.fileCandidates).toEqual([])
    expect(lastTurn.conversation).toBeUndefined()

    const failedFirstTurn = resolveClaudeRewind(base({
      mode: 'files',
      target: { kind: 'session-start' },
      turns: [],
      currentSdkEntries: [],
      currentFileSnapshots: {},
      fileEvidence: [],
    }))
    expect(failedFirstTurn.supported).toBe(false)
    expect(failedFirstTurn.capability.supportsFiles).toBe(false)
    expect(failedFirstTurn.reason).toContain('没有受控 Write/Edit')
  })

  test('缺当前文件 hash 或版本链断裂时拒绝恢复，不覆盖外部改动', () => {
    const noCurrentSnapshot = resolveClaudeRewind(base({ currentFileSnapshots: undefined }))
    expect(noCurrentSnapshot.capability.supportsFiles).toBe(false)
    expect(noCurrentSnapshot.reason).toContain('当前文件版本快照')

    const externalEdit = resolveClaudeRewind(base({
      currentFileSnapshots: {
        '/workspace/tracked.txt': { path: '/workspace/tracked.txt', revision: 'manual-edit', exists: true, backupRef: 'manual-backup' },
      },
    }))
    expect(externalEdit.capability.supportsFiles).toBe(false)
    expect(externalEdit.reason).toContain('外部修改')

    const brokenChain = resolveClaudeRewind(base({
      fileEvidence: [
        { turnId: 'T2', evidence: evidence('T2', '/workspace/tracked.txt', { revision: 'B', exists: true, backupRef: 'backup-B' }, { revision: 'C', exists: true, backupRef: 'backup-C' }) },
        { turnId: 'T3', evidence: evidence('T3', '/workspace/tracked.txt', { revision: 'manual', exists: true, backupRef: 'manual-backup' }, { revision: 'D', exists: true, backupRef: 'backup-D' }) },
      ],
    }))
    expect(brokenChain.capability.supportsFiles).toBe(false)
    expect(brokenChain.reason).toContain('版本链不一致')
  })

  test('Shell-only 与未知 MCP 写入明确降级为 files/both 不支持', () => {

    const result = resolveClaudeRewind(base({
      currentSdkEntries: [{ uuid: 'a1', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }],
    }))
    expect(result.supported).toBe(false)
    expect(result.capability.supportsFiles).toBe(false)
    expect(result.capability.supportsBoth).toBe(false)
    expect(result.reason).toContain('Shell')
  })

  test('未知 MCP 写入也明确降级为 files/both 不支持', () => {
    const mcpResult = resolveClaudeRewind(base({
      currentSdkEntries: [{ uuid: 'a1', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__workspace__write' }] } }],
    }))
    expect(mcpResult.capability.supportsFiles).toBe(false)
    expect(mcpResult.reason).toContain('MCP')
  })

  test('缺 backup、未知目标、缺 SDK ID 与 fork UUID 映射都拒绝而非猜测', () => {
    const missingBackup = resolveClaudeRewind(base({
      currentFileSnapshots: {
        '/workspace/tracked.txt': { path: '/workspace/tracked.txt', revision: 'C', exists: true, backupRef: 'backup-C' },
      },
      fileEvidence: [
        { turnId: 'T2', evidence: evidence('T2', '/workspace/tracked.txt', { revision: 'B', exists: true }, { revision: 'C', exists: true, backupRef: 'backup-C' }) },
      ],
    }))
    expect(missingBackup.capability.supportsFiles).toBe(false)
    expect(missingBackup.reason).toContain('备份')

    const unknown = resolveClaudeRewind(base({ target: { kind: 'after-turn', turnId: 'T9' } }))
    expect(unknown.supported).toBe(false)
    expect(unknown.reason).toContain('目标')

    const noSdk = resolveClaudeRewind(base({ currentSdkEntries: [] }))
    expect(noSdk.capability.supportsConversation).toBe(false)
    const noSessionId = resolveClaudeRewind(base({ currentSdkSessionId: undefined }))
    expect(noSessionId.capability.supportsConversation).toBe(false)
    expect(noSessionId.capability.reasons?.conversation).toContain('session ID')

    const fork = resolveClaudeRewind(base({
      currentSdkSessionId: 'fork-sdk',
      currentSdkEntries: [{ uuid: 'fork-a1', type: 'assistant' }],
      forkSourceSdkSessionId: 'source-sdk',
      forkSourceSdkEntries: [{ uuid: 'a1', type: 'assistant' }],
    }))
    expect(fork.capability.supportsConversation).toBe(false)
    expect(fork.capability.reasons?.conversation).toContain('UUID')

    const mappedFork = resolveClaudeRewind(base({
      currentSdkSessionId: 'fork-sdk',
      currentSdkEntries: [{ uuid: 'fork-a1', type: 'assistant' }, { uuid: 'fork-a2', type: 'assistant' }, { uuid: 'fork-a3', type: 'assistant' }],
      forkSourceSdkSessionId: 'source-sdk',
      forkSourceSdkEntries: [{ uuid: 'a1', type: 'assistant' }, { uuid: 'a2', type: 'assistant' }, { uuid: 'a3', type: 'assistant' }],
      forkMessageUuidMap: { a1: 'fork-a1', a2: 'fork-a2', a3: 'fork-a3' },
    }))
    expect(mappedFork.capability.supportsConversation).toBe(true)
    expect(mappedFork.conversation?.resumeAt).toBe('fork-a1')
  })
})
