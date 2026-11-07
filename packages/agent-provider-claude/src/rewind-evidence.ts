import type {
  HookCallbackMatcher,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'
import { resolve } from 'node:path'

export type ClaudeRewindToolName = 'Write' | 'Edit'

export interface ClaudeRewindFileSnapshot {
  path: string
  revision: string
  exists: boolean
  /** Immutable content object reference when the file existed. */
  contentRef?: string
  /** D1-compatible recovery reference for the pre-write version. */
  backupRef?: string
}

export interface ClaudeRewindEvidenceCaptureInput {
  phase: 'before' | 'after'
  sessionId: string
  promptId?: string
  toolUseId: string
  toolName: ClaudeRewindToolName
  toolInput: Record<string, unknown>
  path: string
  cwd: string
}

export interface ClaudeRewindToolEvidence {
  sessionId: string
  promptId?: string
  /** Host-assigned logical turn identity when available. */
  turnId?: string
  toolUseId?: string
  toolName: ClaudeRewindToolName
  path: string
  before?: ClaudeRewindFileSnapshot
  after?: ClaudeRewindFileSnapshot
  status: 'complete' | 'failed' | 'unsupported'
  reason?: string
}

/** Host-owned port for immutable snapshots and paired evidence records. */
export interface ClaudeRewindEvidencePort {
  capture(input: ClaudeRewindEvidenceCaptureInput): Promise<ClaudeRewindFileSnapshot | null>
  record(evidence: ClaudeRewindToolEvidence): Promise<void> | void
}

interface PendingToolEvidence {
  input: PreToolUseHookInput
  toolName: ClaudeRewindToolName
  path: string
  before?: ClaudeRewindFileSnapshot
  reason?: string
}

function isWriteTool(toolName: string): toolName is ClaudeRewindToolName {
  return toolName === 'Write' || toolName === 'Edit'
}

function toolPath(input: Record<string, unknown>, cwd: string): string | undefined {
  const rawPath = input.file_path ?? input.path
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return undefined
  return resolve(cwd, rawPath)
}

function isUsableSnapshot(snapshot: ClaudeRewindFileSnapshot | null, expectedPath: string): snapshot is ClaudeRewindFileSnapshot {
  return snapshot !== null
    && snapshot.path === expectedPath
    && typeof snapshot.revision === 'string'
    && snapshot.revision.length > 0
    && (!snapshot.exists || (
      typeof snapshot.contentRef === 'string' && snapshot.contentRef.length > 0
      && typeof snapshot.backupRef === 'string' && snapshot.backupRef.length > 0
    ))
}

/**
 * Pair Write/Edit snapshots by the SDK tool-use id. Shell and MCP tools stay unsupported.
 * Evidence failures are deliberately swallowed so the model's file tool is never blocked.
 */
export function createClaudeRewindEvidenceHooks(
  port: ClaudeRewindEvidencePort,
  identity?: { sessionId: string },
): {
  PreToolUse: HookCallbackMatcher[]
  PostToolUse: HookCallbackMatcher[]
  PostToolUseFailure: HookCallbackMatcher[]
} {
  const pending = new Map<string, PendingToolEvidence>()
  const pendingKey = (promptId: string | undefined, toolUseId: string): string => `${promptId ?? ''}\u0000${toolUseId}`
  const sessionIdOf = (input: { session_id: string }): string => identity?.sessionId ?? input.session_id

  async function record(evidence: ClaudeRewindToolEvidence): Promise<void> {
    try {
      await port.record(evidence)
    } catch {
      // Evidence persistence is best-effort and must not alter an agent tool call.
    }
  }

  const preToolUse = async (rawInput: unknown, toolUseID?: string): Promise<{ continue: true }> => {
    const input = rawInput as PreToolUseHookInput
    if (!isWriteTool(input.tool_name)) return { continue: true }
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
    const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input as Record<string, unknown> : {}
    const path = toolPath(toolInput, cwd)
    const toolUseId = input.tool_use_id || toolUseID
    if (!path || !toolUseId) {
      await record({
        sessionId: sessionIdOf(input),
        ...(input.prompt_id && { promptId: input.prompt_id }),
        ...(toolUseId && { toolUseId }),
        toolName: input.tool_name,
        path: path ?? '',
        status: 'unsupported',
        reason: !path ? '受控工具输入缺少文件路径' : 'SDK 未提供 tool_use_id，无法配对工具前后状态',
      })
      return { continue: true }
    }

    const item: PendingToolEvidence = { input, toolName: input.tool_name, path }
    const key = pendingKey(input.prompt_id, toolUseId)
    for (const [otherKey, other] of pending) {
      if (otherKey !== key && other.path === path) {
        other.reason = '同一路径存在并发 Write/Edit，前后版本顺序不确定'
        item.reason = other.reason
      }
    }
    pending.set(key, item)
    try {
      const snapshot = await port.capture({
        phase: 'before', sessionId: sessionIdOf(input), ...(input.prompt_id && { promptId: input.prompt_id }),
        toolUseId, toolName: input.tool_name, toolInput, path, cwd,
      })
      if (isUsableSnapshot(snapshot, path)) item.before = snapshot
      else item.reason = '工具执行前版本或可恢复备份不可用'
    } catch {
      item.reason = '工具执行前版本采集失败'
    }
    return { continue: true }
  }

  const postToolUse = async (rawInput: unknown, toolUseID?: string): Promise<{ continue: true }> => {
    const input = rawInput as PostToolUseHookInput
    if (!isWriteTool(input.tool_name)) return { continue: true }
    const toolUseId = input.tool_use_id || toolUseID
    const key = toolUseId ? pendingKey(input.prompt_id, toolUseId) : undefined
    const item = key ? pending.get(key) : undefined
    if (key) pending.delete(key)
    if (!item || !toolUseId || item.toolName !== input.tool_name) {
      await record({
        sessionId: sessionIdOf(input), ...(input.prompt_id && { promptId: input.prompt_id }),
        ...(toolUseId && { toolUseId }), toolName: input.tool_name, path: item?.path ?? '',
        ...(item?.before && { before: item.before }), status: 'unsupported',
        reason: '找不到匹配的 PreToolUse 证据，不能认定工具前后版本',
      })
      return { continue: true }
    }

    const cwd = typeof item.input.cwd === 'string' ? item.input.cwd : process.cwd()
    const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input as Record<string, unknown> : {}
    let after: ClaudeRewindFileSnapshot | null = null
    let reason = item.reason
    try {
      after = await port.capture({
        phase: 'after', sessionId: sessionIdOf(input), ...(input.prompt_id && { promptId: input.prompt_id }),
        toolUseId, toolName: item.toolName, toolInput, path: item.path, cwd,
      })
    } catch {
      reason ??= '工具执行后版本采集失败'
    }
    if (!isUsableSnapshot(after, item.path)) reason ??= '工具执行后版本或可恢复备份不可用'
    const complete = !item.reason && !!item.before && isUsableSnapshot(after, item.path)
    await record({
      sessionId: sessionIdOf(input), ...(input.prompt_id && { promptId: input.prompt_id }), toolUseId,
      toolName: item.toolName, path: item.path, ...(item.before && { before: item.before }),
      ...(after && isUsableSnapshot(after, item.path) && { after }), status: complete ? 'complete' : 'unsupported',
      ...(!complete && { reason: reason ?? '前后版本映射不完整' }),
    })
    return { continue: true }
  }

  const postToolUseFailure = async (rawInput: unknown, toolUseID?: string): Promise<{ continue: true }> => {
    const input = rawInput as PostToolUseFailureHookInput
    if (!isWriteTool(input.tool_name)) return { continue: true }
    const toolUseId = input.tool_use_id || toolUseID
    const key = toolUseId ? pendingKey(input.prompt_id, toolUseId) : undefined
    const item = key ? pending.get(key) : undefined
    if (key) pending.delete(key)
    await record({
      sessionId: sessionIdOf(input), ...(input.prompt_id && { promptId: input.prompt_id }),
      ...(toolUseId && { toolUseId }), toolName: input.tool_name, path: item?.path ?? '',
      ...(item?.before && { before: item.before }), status: 'failed',
      reason: 'SDK 报告受控文件工具执行失败，写后状态未知',
    })
    return { continue: true }
  }

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
  }
}
