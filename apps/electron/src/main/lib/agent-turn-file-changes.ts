/**
 * 会话「每轮改了哪些文件」的只读查询。
 *
 * 数据来源分两层：
 * - Shadow Git 归属记录：一份真实的树差异，能给出 added/modified/deleted 与前后边界，
 *   只读 diff 也由它生成（`turns.jsonl`，turnId = 触发该轮的用户消息 uuid）；
 * - 消息里的 `proferFileChanges`：旧会话 / 采集失败 / 记录尚未落盘时的兜底，只证明
 *   「某个工具写过这个文件」，没有前后内容，因此不提供 diff。
 *
 * WebUI 只读、只展示，不提供编辑与写回；这里也不暴露采集排除路径或 git 细节。
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { SDKMessage, SDKUserMessage } from '@profer/shared'
import { isUserInputMessage } from '@profer/session-core'
import {
  createGitRunner,
  findShadowTurnAttribution,
  readShadowTurnAttributions,
  shadowTreePath,
  type ShadowTurnAttributionRecord,
  type ShadowTurnChange,
} from '@profer/session-store'
import { getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'
import { findGitPath } from './git-detector'
import { getWorkspaceShadowDir, getWorkspaceShadowRepoDir } from './workspace-shadow-git'

export interface AgentTurnFileChangeView {
  rootId: string
  /** 相对根目录的路径（正斜杠）。 */
  path: string
  /** 给 UI 用的路径：主根显示相对路径，附加目录带上目录名。 */
  displayPath: string
  status: 'added' | 'modified' | 'deleted'
  attribution: 'confirmed' | 'unconfirmed'
  evidenceSource?: 'write' | 'edit' | 'bash' | 'unknown'
  /** 是否有可读取的只读 diff。 */
  diffAvailable: boolean
}

export interface AgentTurnFileChangesView {
  turnId: string
  source: 'shadow-git' | 'messages'
  partial: boolean
  note?: string
  changes: AgentTurnFileChangeView[]
}

export type AgentTurnFileDiffResult =
  | { ok: true; diff: string; truncated: boolean; status: AgentTurnFileChangeView['status']; path: string }
  | { ok: false; error: string }

/** 单次 diff 的展示上限；超出部分直接截断并标记，绝不把主进程内存交给客户端。 */
const MAX_DIFF_CHARS = 120_000
const MAX_DIFF_LINES = 4_000
const DIFF_TIMEOUT_MS = 30_000

/** 与桌面 TurnFileChangesSummary 同一份工具名单（含 Pi 的小写变体）。 */
const MUTATING_TOOL_NAMES = new Set([
  'edit', 'write', 'multiedit', 'multi_edit', 'notebookedit', 'notebook_edit',
])

function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function resolveSessionWorkspace(sessionId: string): { workspaceId: string; shadowDir: string } | undefined {
  const workspaceId = getAgentSessionMeta(sessionId)?.workspaceId
  if (!workspaceId) return undefined
  try {
    return { workspaceId, shadowDir: getWorkspaceShadowDir(workspaceId) }
  } catch {
    return undefined
  }
}

function displayPathFor(rootPath: string, kind: 'managed' | 'project' | 'attached' | undefined, path: string): string {
  if (kind !== 'attached' || !rootPath) return path
  return `${basename(rootPath)}/${path}`
}

function toChangeView(
  record: ShadowTurnAttributionRecord,
  change: ShadowTurnChange,
): AgentTurnFileChangeView {
  const root = record.roots.find((item) => item.rootId === change.rootId)
  return {
    rootId: change.rootId,
    path: change.path,
    displayPath: displayPathFor(root?.rootPath ?? '', root?.kind, change.path),
    status: change.status,
    attribution: change.attribution,
    ...(change.evidenceSource ? { evidenceSource: change.evidenceSource } : {}),
    diffAvailable: Boolean(record.afterCommitId),
  }
}

function recordToView(record: ShadowTurnAttributionRecord): AgentTurnFileChangesView {
  return {
    turnId: record.turnId,
    source: 'shadow-git',
    partial: record.partial,
    ...(record.note ? { note: record.note } : {}),
    changes: record.changes.map((change) => toChangeView(record, change)),
  }
}

interface ToolUseFact {
  toolUseId: string
  toolName: string
  filePath: string
}

function extractToolUseFacts(message: SDKMessage): ToolUseFact[] {
  if (message.type !== 'assistant') return []
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  const facts: ToolUseFact[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
    if (candidate.type !== 'tool_use') continue
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') continue
    if (!MUTATING_TOOL_NAMES.has(normalizeForMatch(candidate.name))) continue
    const input = candidate.input && typeof candidate.input === 'object'
      ? candidate.input as Record<string, unknown>
      : {}
    const filePath = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
    if (typeof filePath !== 'string' || !filePath.trim()) continue
    facts.push({ toolUseId: candidate.id, toolName: candidate.name, filePath })
  }
  return facts
}

interface ToolResultFact {
  toolUseId: string
  failed: boolean
  fileChanges: string[]
}

function extractToolResultFacts(message: SDKMessage): ToolResultFact[] {
  if (message.type !== 'user') return []
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  const facts: ToolResultFact[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const candidate = block as {
      type?: unknown
      tool_use_id?: unknown
      is_error?: unknown
      proferFileChanges?: unknown
    }
    if (candidate.type !== 'tool_result' || typeof candidate.tool_use_id !== 'string') continue
    const fileChanges: string[] = []
    if (Array.isArray(candidate.proferFileChanges)) {
      for (const item of candidate.proferFileChanges) {
        if (!item || typeof item !== 'object') continue
        const path = (item as { path?: unknown }).path
        if (typeof path === 'string' && path.trim()) fileChanges.push(path)
      }
    }
    facts.push({ toolUseId: candidate.tool_use_id, failed: candidate.is_error === true, fileChanges })
  }
  return facts
}

/**
 * 消息兜底：按用户输入切 turn，优先用 `proferFileChanges`，没有时才看写入工具的入参。
 * 与桌面渲染层同一判据；只返回有实际写入事实的 turn。
 */
function buildMessageFallback(sessionId: string): AgentTurnFileChangesView[] {
  let messages: SDKMessage[]
  try {
    messages = getAgentSessionSDKMessages(sessionId)
  } catch {
    return []
  }

  const views: AgentTurnFileChangesView[] = []
  let turnId: string | undefined
  let turnMessages: SDKMessage[] = []

  const flush = (): void => {
    if (!turnId) return
    const toolUses = new Map<string, ToolUseFact>()
    const failed = new Set<string>()
    const authoritative = new Map<string, string>()

    for (const message of turnMessages) {
      for (const fact of extractToolResultFacts(message)) {
        if (fact.failed) failed.add(fact.toolUseId)
        for (const path of fact.fileChanges) authoritative.set(path, path)
      }
      for (const fact of extractToolUseFacts(message)) toolUses.set(fact.toolUseId, fact)
    }

    const paths = new Map<string, string>()
    if (authoritative.size > 0) {
      for (const path of authoritative.values()) paths.set(normalizeForMatch(path), path)
    } else {
      for (const fact of toolUses.values()) {
        if (failed.has(fact.toolUseId)) continue
        paths.set(normalizeForMatch(fact.filePath), fact.filePath)
      }
    }

    if (paths.size > 0) {
      views.push({
        turnId,
        source: 'messages',
        partial: false,
        changes: [...paths.values()].map((path) => ({
          rootId: '',
          path,
          displayPath: path,
          status: 'modified',
          attribution: 'confirmed',
          diffAvailable: false,
        })),
      })
    }
  }

  for (const message of messages) {
    if (message.type === 'user' && isUserInputMessage(message as SDKUserMessage)) {
      flush()
      turnId = typeof message.uuid === 'string' && message.uuid ? message.uuid : undefined
      turnMessages = []
      continue
    }
    if (turnId) turnMessages.push(message)
  }
  flush()

  return views
}

/**
 * 列出某个会话每一轮的改动文件。
 *
 * Shadow 记录按 turnId 覆盖同名的消息兜底；记录中没有 changes（采集失败/超时）时
 * 保留兜底证据，避免「明明看到工具写了文件，列表却是空的」。
 */
export function listAgentSessionTurnFileChanges(sessionId: string): AgentTurnFileChangesView[] {
  const fallback = buildMessageFallback(sessionId)
  const workspace = resolveSessionWorkspace(sessionId)
  const records = workspace
    ? readShadowTurnAttributions(workspace.shadowDir, { sessionId }).slice(-200)
    : []

  const fallbackByTurn = new Map(fallback.map((view) => [view.turnId, view]))
  const merged = new Map<string, AgentTurnFileChangesView>()

  for (const record of records) {
    const view = recordToView(record)
    if (view.changes.length === 0) {
      const evidence = fallbackByTurn.get(record.turnId)
      if (evidence) {
        merged.set(record.turnId, { ...evidence, partial: record.partial, ...(record.note ? { note: record.note } : {}) })
        continue
      }
    }
    merged.set(record.turnId, view)
  }
  for (const view of fallback) {
    if (!merged.has(view.turnId)) merged.set(view.turnId, view)
  }

  return [...merged.values()]
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS && diff.split('\n').length <= MAX_DIFF_LINES) {
    return { diff, truncated: false }
  }
  const byChars = diff.slice(0, MAX_DIFF_CHARS)
  const lines = byChars.split('\n')
  const clipped = (lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines).join('\n')
  return {
    diff: `${clipped}\n…（diff 过长，已截断）`,
    truncated: true,
  }
}

/** 把 `roots/<rootId>/` 前缀从 diff 头行去掉，让用户看到真实的项目相对路径。 */
function stripShadowPrefix(diff: string, rootId: string): string {
  const prefix = `roots/${rootId}/`
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        return line.split(prefix).join('')
      }
      return line
    })
    .join('\n')
}

/**
 * 读取某一轮某个文件的只读 diff。
 *
 * `rootId` + `path` 必须与归属记录里的某一项完全匹配：只接受记录里的文件，
 * 不接受任意路径，避免把只读查询变成任意文件读取。
 */
export async function getAgentSessionTurnFileDiff(input: {
  sessionId: string
  turnId: string
  rootId: string
  path: string
}): Promise<AgentTurnFileDiffResult> {
  const workspace = resolveSessionWorkspace(input.sessionId)
  if (!workspace) return { ok: false, error: '会话没有可用的工作区快照' }

  const record = findShadowTurnAttribution(workspace.shadowDir, input.sessionId, input.turnId)
  if (!record) return { ok: false, error: '这一轮没有可用的 diff 记录' }

  const change = record.changes.find(
    (item) => item.rootId === input.rootId && item.path === input.path,
  )
  if (!change) return { ok: false, error: '这一轮没有这个文件的改动记录' }
  if (!record.afterCommitId) return { ok: false, error: '这一轮没有可用结束边界' }

  const repoDir = getWorkspaceShadowRepoDir(workspace.workspaceId)
  if (!existsSync(repoDir)) return { ok: false, error: '工作区快照仓库不存在' }
  const gitPath = findGitPath()
  if (!gitPath) return { ok: false, error: 'git 不可用' }

  const treePath = shadowTreePath(change.rootId, change.path)
  const args = record.beforeCommitId
    ? [
        'diff', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv',
        record.beforeCommitId, record.afterCommitId, '--', treePath,
      ]
    : [
        'diff-tree', '-p', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv',
        '--root', record.afterCommitId, '--', treePath,
      ]

  try {
    const result = await createGitRunner({ gitPath }).run(args, {
      gitDir: repoDir,
      timeoutMs: DIFF_TIMEOUT_MS,
    })
    if (!result.ok) return { ok: false, error: result.stderr.trim() || '读取 diff 失败' }
    const raw = stripShadowPrefix(result.stdout, change.rootId)
    if (!raw.trim()) return { ok: false, error: '没有可显示的内容差异' }
    const { diff, truncated } = truncateDiff(raw)
    return { ok: true, diff, truncated, status: change.status, path: change.path }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '读取 diff 失败' }
  }
}