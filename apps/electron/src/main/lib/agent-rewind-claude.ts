import type {
  RewindCapabilityReport,
  RewindFileAction,
  RewindMode,
  RewindTarget,
} from '@profer/shared'
import type { AgentRuntime } from '@profer/shared'
import type {
  ClaudeRewindFileSnapshot,
  ClaudeRewindToolEvidence,
} from '@profer/agent-provider-claude'

export interface ClaudeRewindTurn {
  turnId: string
  userMessageUuid: string
  assistantMessageUuid: string
}

export interface ClaudeSdkTranscriptEntry {
  uuid?: string
  type?: string
  message?: {
    content?: Array<{ type?: string; name?: string }>
  }
  tool_name?: string
}

export interface ClaudeTurnFileEvidence {
  turnId: string
  evidence: ClaudeRewindToolEvidence
}

export interface ClaudeRewindResolveInput {
  sessionId: string
  mode: RewindMode
  target: RewindTarget
  turns: ClaudeRewindTurn[]
  currentSdkSessionId?: string
  currentSdkEntries: ClaudeSdkTranscriptEntry[]
  forkSourceSdkSessionId?: string
  forkSourceSdkEntries?: ClaudeSdkTranscriptEntry[]
  /** 源 transcript UUID -> 当前 fork transcript UUID。 */
  forkMessageUuidMap?: Record<string, string>
  /** 当前文件实际快照，由宿主在 prepare 时读取；不得用历史状态冒充当前状态。 */
  currentFileSnapshots?: Record<string, ClaudeRewindFileSnapshot>
  fileEvidence: ClaudeTurnFileEvidence[]
}

export interface ClaudeFileVersionCandidate {
  path: string
  action: Exclude<RewindFileAction, 'keep' | 'conflict'>
  currentRevision: string
  targetRevision: string
  currentBackupRef?: string
  targetBackupRef?: string
  evidence: 'tracked-write'
  toolUseIds: string[]
}

export interface ClaudeRewindResolution {
  supported: boolean
  capability: RewindCapabilityReport
  reason?: string
  /** 仅在 files 模式下省略；文件回退不能改动对话恢复位置。 */
  conversation?: {
    resumeAt?: string
    sdkSessionId?: string
    forkSourceSdkSessionId?: string
    retainedThroughTurnId?: string
  }
  fileCandidates?: ClaudeFileVersionCandidate[]
}

function findSdkUuid(
  messageUuid: string,
  input: ClaudeRewindResolveInput,
): { uuid: string; sourceSession: boolean } | undefined {
  if (input.currentSdkEntries.some(entry => entry.uuid === messageUuid)) return { uuid: messageUuid, sourceSession: false }
  if (
    input.forkSourceSdkSessionId
    && input.forkSourceSdkEntries?.some(entry => entry.uuid === messageUuid)
  ) {
    const forkUuid = input.forkMessageUuidMap?.[messageUuid]
    if (!forkUuid || !input.currentSdkEntries.some(entry => entry.uuid === forkUuid)) return undefined
    return { uuid: forkUuid, sourceSession: false }
  }
  return undefined
}

function toolNames(entries: ClaudeSdkTranscriptEntry[]): string[] {
  const names: string[] = []
  for (const entry of entries) {
    if (typeof entry.tool_name === 'string') names.push(entry.tool_name)
    for (const block of entry.message?.content ?? []) {
      if (block.type === 'tool_use' && typeof block.name === 'string') names.push(block.name)
    }
  }
  return names
}

function hasUntrackedWriter(entries: ClaudeSdkTranscriptEntry[]): boolean {
  return toolNames(entries).some(name => name === 'Bash' || name === 'PowerShell' || name.startsWith('mcp__'))
}

function targetTurnIndex(input: ClaudeRewindResolveInput): number {
  const target = input.target
  if (target.kind === 'session-start') return -1
  if (target.kind === 'message') return input.turns.findIndex(turn => turn.assistantMessageUuid === target.messageUuid)
  const index = input.turns.findIndex(turn => turn.turnId === target.turnId)
  if (index < 0) return -1
  return target.kind === 'after-turn' ? index : index - 1
}

function targetExists(input: ClaudeRewindResolveInput): boolean {
  const target = input.target
  if (target.kind === 'session-start') return true
  if (target.kind === 'message') return input.turns.some(turn => turn.assistantMessageUuid === target.messageUuid)
  return input.turns.some(turn => turn.turnId === target.turnId)
}

function buildFileCandidates(input: ClaudeRewindResolveInput, boundaryIndex: number): {
  candidates: ClaudeFileVersionCandidate[]
  reason?: string
} {
  const eventsByPath = new Map<string, ClaudeTurnFileEvidence[]>()
  for (const event of input.fileEvidence) {
    const events = eventsByPath.get(event.evidence.path) ?? []
    events.push(event)
    eventsByPath.set(event.evidence.path, events)
  }

  const candidates: ClaudeFileVersionCandidate[] = []
  for (const [path, events] of eventsByPath) {
    const ordered = events
      .map(event => ({ ...event, turnIndex: input.turns.findIndex(turn => turn.turnId === event.turnId) }))
      .sort((left, right) => left.turnIndex - right.turnIndex)
    if (ordered.some(event => event.turnIndex < 0)) return { candidates, reason: `文件证据未映射到本会话轮次: ${path}` }
    if (ordered.some(event => event.evidence.status !== 'complete' || !event.evidence.before || !event.evidence.after)) {
      return { candidates, reason: `受控写入缺少完整的前后版本证据: ${path}` }
    }
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!.evidence.after!
      const next = ordered[index]!.evidence.before!
      if (previous.revision !== next.revision || previous.exists !== next.exists) {
        return { candidates, reason: `连续写入之间版本链不一致，可能存在外部修改: ${path}` }
      }
    }

    const latestEvidence = ordered.at(-1)!.evidence.after!
    const current = input.currentFileSnapshots?.[path]
    if (!current || current.path !== path || !current.revision) {
      return { candidates, reason: `缺少 prepare 时的当前文件版本快照: ${path}` }
    }
    if (current.revision !== latestEvidence.revision || current.exists !== latestEvidence.exists) {
      return { candidates, reason: `当前文件已偏离会话最后一次受控写入，存在外部修改: ${path}` }
    }

    const targetEvent = [...ordered].reverse().find(event => event.turnIndex <= boundaryIndex)
    const nextEvent = ordered.find(event => event.turnIndex > boundaryIndex)
    const target = targetEvent?.evidence.after ?? nextEvent?.evidence.before
    if (!target || !nextEvent) continue
    if (current.exists && !current.backupRef) {
      return { candidates, reason: `缺少当前文件恢复副本: ${path}` }
    }
    if (target.exists && !target.backupRef) return { candidates, reason: `缺少目标文件备份: ${path}` }
    if (target.exists === current.exists && (!target.exists || target.revision === current.revision)) continue

    candidates.push({
      path,
      action: target.exists ? 'restore' : 'delete',
      currentRevision: current.revision,
      targetRevision: target.revision,
      currentBackupRef: current.backupRef,
      ...(target.backupRef && { targetBackupRef: target.backupRef }),
      evidence: 'tracked-write',
      toolUseIds: ordered.filter(event => event.turnIndex > boundaryIndex).map(event => event.evidence.toolUseId).filter((id): id is string => Boolean(id)),
    })
  }
  return { candidates }
}

/** 只解析回退目标和证据，不应用任何文件操作。 */

export function resolveClaudeRewind(input: ClaudeRewindResolveInput): ClaudeRewindResolution {
  const baseCapability: RewindCapabilityReport = {
    runtime: 'claude' as AgentRuntime,
    supportsConversation: false,
    supportsFiles: false,
    supportsBoth: false,
    supportsUndo: false,
    supportsRefine: false,
    supportsSubmission: false,
  }
  if (!targetExists(input)) {
    return {
      supported: false,
      capability: { ...baseCapability, reasons: { conversation: '回退目标不在已加载的会话轮次中', files: '回退目标不在已加载的会话轮次中', both: '回退目标不在已加载的会话轮次中' } },
      reason: '回退目标不在已加载的会话轮次中',
    }
  }

  const boundaryIndex = targetTurnIndex(input)
  const retainedTurn = boundaryIndex >= 0 ? input.turns[boundaryIndex] : undefined
  const retainedSdkMessage = retainedTurn ? findSdkUuid(retainedTurn.assistantMessageUuid, input) : undefined
  const conversationSupported = !retainedTurn || Boolean(input.currentSdkSessionId && retainedSdkMessage)
  const conversation = conversationSupported
    ? {
        ...(retainedSdkMessage && { resumeAt: retainedSdkMessage.uuid }),
        ...(input.currentSdkSessionId && { sdkSessionId: input.currentSdkSessionId }),
        ...(retainedSdkMessage?.sourceSession && input.forkSourceSdkSessionId && { forkSourceSdkSessionId: input.forkSourceSdkSessionId }),
        ...(retainedTurn && { retainedThroughTurnId: retainedTurn.turnId }),
      }
    : undefined

  const allSdkEntries = [
    ...input.currentSdkEntries,
    ...(input.forkSourceSdkEntries ?? []),
  ]
  let fileReason: string | undefined
  let fileCandidates: ClaudeFileVersionCandidate[] = []
  if (hasUntrackedWriter(allSdkEntries)) {
    fileReason = '会话包含 Shell/PowerShell/MCP 写入，无法把文件变更可靠归属到受控 Write/Edit'
  } else if (input.fileEvidence.length === 0) {
    fileReason = '会话没有受控 Write/Edit 的文件版本证据'
  } else {
    const resolvedFiles = buildFileCandidates(input, boundaryIndex)
    fileCandidates = resolvedFiles.candidates
    fileReason = resolvedFiles.reason
  }
  const filesSupported = !fileReason
  const supportsConversation = conversationSupported
  const supportsFiles = filesSupported
  const supportsBoth = conversationSupported && filesSupported
  const capability: RewindCapabilityReport = {
    ...baseCapability,
    supportsConversation,
    supportsFiles,
    supportsBoth,
    reasons: {
      ...(!conversationSupported && { conversation: '缺少 Claude SDK session ID 或无法把保留轮次映射到 SDK 消息 UUID' }),

      ...(!filesSupported && { files: fileReason }),
      ...(input.mode === 'both' && (!conversationSupported || !filesSupported) && { both: fileReason ?? '无法映射 Claude SDK 对话目标' }),
    },
  }
  const supported = input.mode === 'conversation'
    ? supportsConversation
    : input.mode === 'files'
      ? supportsFiles
      : supportsBoth
  return {
    supported,
    capability,
    ...(!supported && { reason: input.mode === 'conversation' ? capability.reasons?.conversation : input.mode === 'files' ? fileReason : capability.reasons?.both }),
    ...(input.mode !== 'files' && supportsConversation && { conversation }),
    ...(input.mode !== 'conversation' && supportsFiles && { fileCandidates }),
  }
}
