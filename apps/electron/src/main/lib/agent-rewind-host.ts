import { createHash, randomUUID } from 'node:crypto'
import type { RewindTarget, SDKMessage } from '@profer/shared'
import { createRewindStore, readShadowTurnAttributions } from '@profer/session-store'
import { normalizeAgentRuntime } from '@profer/shared'
import { createAgentRewindService, type RewindResolverResult } from './agent-rewind-service'
import { getAgentSessionMeta, getAgentSessionSDKMessages, truncateSDKMessages, updateAgentSessionMeta, clearSDKMessages, appendSDKMessages } from './agent-session-manager'
import { createElectronSessionStorePaths } from './session-store-host'
import { withAgentSessionExclusive } from './agent-service'
import { getAgentAttachmentBackupsRoot, getAgentSessionCwd, getAgentSessionMessagesPath, getAttachmentsDir, getPiTranscriptDirForSession } from './config-paths'
import { getAgentWorkspace } from './agent-workspace-manager'
import { createRewindFilePort } from './agent-rewind-file-port'
import { resolveClaudeRewind, rewindBoundaryIndex, type ClaudeRewindTurn } from './agent-rewind-claude'
import { loadPiRewindTracker, persistPiRewindTracker, restorePiRewindTracker } from './agent-rewind-pi'
import { applyWorkspaceShadowRewind, resolveWorkspaceShadowRewind } from './workspace-shadow-rewind'
import { getWorkspaceShadowDir } from './workspace-shadow-git'
import type { ClaudeRewindToolEvidence } from '@profer/agent-provider-claude'
import { rewindPiTranscript, type PiFileMutationEvidence } from '@profer/agent-provider-pi'
import { createAgentRewindNotice } from './agent-rewind-notice'
import { repairAgentSessionCachesAfterRewind } from './agent-rewind-cache'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Provider evidence is loaded by sessionId; this port never trusts renderer paths. */
function trackerPath(sessionId: string): string {
  return join(createElectronSessionStorePaths().rewindDir, sessionId, 'pi-tracker.json')
}

function messageUuid(message: SDKMessage): string | undefined {
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : undefined
}

/** 原子还原 Profer JSONL：Pi 侧重建失败时不能留下「历史截了、记录没截」的半截状态。 */
function restoreProferMessagesBytes(sessionId: string, content: Buffer): void {
  const file = getAgentSessionMessagesPath(sessionId)
  const temp = `${file}.restore-${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content)
    renameSync(temp, file)
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* 清理失败不改变结论 */ }
    throw error
  }
}

/**
 * 截断后把 `pi-tracker.json` 里指向已删轮次的记录裁掉（只留保留历史里出现过的 turnId）。
 *
 * 不裁的话，下一次回退可能按旧 turn 定位到一个已不存在的 entry，把回退变成必然失败。
 * tracker 损坏/写失败不阻断本次回退：它只是回退能力，不是会话内容。
 */
async function prunePiTrackerAfterRewind(sessionId: string, kept: readonly SDKMessage[]): Promise<void> {
  const keptTurnIds = new Set(kept.flatMap((message) => {
    const uuid = messageUuid(message)
    return uuid ? [uuid] : []
  }))
  try {
    const snapshot = (await loadPiRewindTracker(trackerPath(sessionId), sessionId)).snapshot()
    const turns = snapshot.turns.filter((turn) => keptTurnIds.has(turn.turnId))
    const keptTurnSet = new Set(turns.map((turn) => turn.turnId))
    const mutations = snapshot.mutations.filter((mutation) => keptTurnSet.has(mutation.turnId))
    if (turns.length === snapshot.turns.length && mutations.length === snapshot.mutations.length) return
    await persistPiRewindTracker(trackerPath(sessionId), restorePiRewindTracker({
      schemaVersion: 1,
      sessionId,
      turns,
      turnMutationSequences: [],
      mutations,
      unsupported: snapshot.unsupported,
    }))
  } catch (error) {
    console.error(`[Agent 回退] 裁掉 Pi rewind tracker 的已删轮次失败，已忽略: session=${sessionId}`, error)
  }
}

function sessionTurnId(sessionId: string, index: number): string {
  return `${sessionId}-T${index + 1}`
}

/**
 * 回退对话要落到 Pi session 文件的哪个 entry。
 *
 * Pi session 是 append-only tree，回退必须截断到「目标轮的终态 entry」的祖先链，
 * 而这个 entry 只能由**目标 uuid 本身**给出（turnId = Profer 用户消息 uuid）。
 *
 * 不能从保留历史末尾向前找「第一个能解析的锚点」：那样目标 uuid 没有绑定时会静默
 * 截到更早的一轮（真机会话里就丢掉了 8 条 assistant + 10 条 toolResult，却报 ok:true）。
 * 找不到就抛错：本次回退取消，由调用方的 try/catch 把 Profer 消息文件原样恢复。
 */
async function resolvePiBranchEntryId(sessionId: string, nativeResume: string): Promise<string | null> {
  // session-start 回退不需要截断 Pi 文件（entryId = null 的交由调用方处理）。
  if (!nativeResume) return null
  const messages = getAgentSessionSDKMessages(sessionId)
  const hasTarget = messages.some((message) => (message as { uuid?: string }).uuid === nativeResume)
  if (!hasTarget) throw new Error('回退目标消息不在当前 Pi 会话中，无法安全回退')
  const tracker = await loadPiRewindTracker(trackerPath(sessionId), sessionId)
  const terminal = tracker.listTurns().find((turn) => turn.turnId === nativeResume)
  if (terminal?.terminal && terminal.terminalEntryId) return terminal.terminalEntryId
  const bindings = getAgentSessionMeta(sessionId)?.piEntryBindings ?? {}
  const bound = bindings[nativeResume]
  if (bound) return bound
  throw new Error(
    '找不到保留历史的精确 Pi entry 锚点，已取消回退（会话历史未改动）。可先重新回退到更早一轮，或在恢复历史后重试',
  )
}

function sdkEntry(message: SDKMessage): { uuid?: string; type?: string; message?: { content?: Array<{ type?: string; name?: string }> }; tool_name?: string } {
  return message as unknown as { uuid?: string; type?: string; message?: { content?: Array<{ type?: string; name?: string }> }; tool_name?: string }
}

function isClaudeWriterEntry(entry: ReturnType<typeof sdkEntry>): boolean {
  return entry.message?.content?.some(block => block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) === true
}

/** 真实用户轮消息：tool_result 也是 `type: 'user'`，但不是用户开的轮。 */
function isUserTurnMessage(message: SDKMessage): boolean {
  const entry = sdkEntry(message)
  if (entry.type !== 'user' || typeof entry.uuid !== 'string') return false
  const content = entry.message?.content
  if (!Array.isArray(content) || content.length === 0) return true
  return !content.every(block => block.type === 'tool_result')
}

/** 该 assistant 消息所属的用户轮 uuid：向前找最近一条真实用户消息。 */
function userTurnUuidFor(messages: SDKMessage[], positions: Map<SDKMessage, number>, message: SDKMessage): string | undefined {
  for (let index = positions.get(message) ?? 0; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate && isUserTurnMessage(candidate)) return sdkEntry(candidate).uuid
  }
  return undefined
}

/**
 * 工作区归属记录里的边界下标（= 到这里为止要保留的记录条数）。
 *
 * 归属记录是「每用户轮一条」，而 Pi 一轮会产生多条 assistant 消息（每次工具调用各自成条）。
 * 拿 assistant 下标当记录下标，第 2 轮以后就会整体错位——把该撤的文件轮整段漏掉，
 * 于是「对话截了、文件没截」看上去却是成功。因此按 turnId（用户消息 uuid）定位。
 */
function shadowTurnBoundaryFrom(sessionId: string, turnUuid: string): number | undefined {
  const meta = getAgentSessionMeta(sessionId)
  const workspaceId = meta?.workspaceId
  if (!workspaceId) return undefined
  try {
    const records = readShadowTurnAttributions(getWorkspaceShadowDir(workspaceId), { sessionId })
    const index = records.findIndex(record => record.turnId === turnUuid)
    return index < 0 ? undefined : index + 1
  } catch {
    return undefined
  }
}

async function readClaudeEvidence(sessionId: string): Promise<ClaudeRewindToolEvidence[]> {
  const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
  const manifests = await store.listManifestsBySession(sessionId)
  return manifests
    .filter(manifest => manifest.metadata?.kind === 'claude-tool-evidence')
    .map(manifest => manifest.metadata?.evidence as ClaudeRewindToolEvidence)
    .filter((item): item is ClaudeRewindToolEvidence => Boolean(item && item.sessionId === sessionId && typeof item.path === 'string'))
}

function relativeWorkspacePath(sessionId: string, path: string): { rootId: string; relativePath: string; coverage: 'managed' | 'project' } | undefined {
  const meta = getAgentSessionMeta(sessionId)
  const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!meta || !workspace) return undefined
  const rootPath = workspace.storageMode === 'project' ? workspace.rootPath : getAgentSessionCwd(workspace.slug, sessionId)
  if (!rootPath) return undefined
  const normalizedRoot = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  if (path !== rootPath && !path.startsWith(normalizedRoot)) return undefined
  const relativePath = path.slice(normalizedRoot.length)
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some(part => part === '..' || part === '.' || part === '')) return undefined
  return { rootId: workspace.id, relativePath, coverage: workspace.storageMode === 'project' ? 'project' : 'managed' }
}


export function createElectronRewindFilePort(sessionId: string) {
  const paths = createElectronSessionStorePaths()
  const store = createRewindStore(paths, sessionId)
  return createRewindFilePort({
    async roots() {
      const meta = getAgentSessionMeta(sessionId)
      const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
      if (!meta || !workspace) return []
      try {
        const rootPath = workspace.storageMode === 'project'
          ? workspace.rootPath
          : getAgentSessionCwd(workspace.slug, sessionId)
        if (!rootPath) return []
        return [{ rootId: workspace.id, rootPath, kind: workspace.storageMode === 'project' ? 'project' as const : 'managed' as const }]
      } catch {
        return []
      }
    },
    protectedPaths: () => {
      const meta = getAgentSessionMeta(sessionId)
      return [getAttachmentsDir(), getAgentAttachmentBackupsRoot(), ...(meta?.attachedFiles ?? []), ...(meta?.attachedDirectories ?? [])]
    },
    async storeVersion(content, mode) {
      return content === undefined ? { kind: 'absent' } : store.putVersion({ kind: 'file', content, mode })
    },
  })
}

/** 主进程回退适配器：Claude / Pi 都支持对话锚点；文件回退统一走工作区历史（Shadow Git）。 */
export function createElectronAgentRewindService() {
  return createAgentRewindService({
    ports: {
      session: {
        async read(sessionId) {
          const meta = getAgentSessionMeta(sessionId)
          if (!meta) return undefined
          const runtime = normalizeAgentRuntime(meta.agentRuntime)
          if (runtime !== 'claude' && runtime !== 'pi') return undefined
          const messages = getAgentSessionSDKMessages(sessionId)
          const revision = Number.parseInt(createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 12), 16)
          return {
            messages: messages.flatMap((message) => typeof (message as { uuid?: unknown }).uuid === 'string' ? [(message as { uuid: string }).uuid] : []),
            nativeResume: meta.resumeAtMessageUuid ?? '',
            revision: { session: revision, files: 0, state: meta.revision ?? 0 },
            runtime,
          }
        },
        async resolveTarget({ sessionId, target }) {
          const meta = getAgentSessionMeta(sessionId)
          if (!meta) return undefined
          const messages = getAgentSessionSDKMessages(sessionId)
          let endIndex: number
          if (target.kind === 'session-start') endIndex = -1
          else if (target.kind === 'message') endIndex = messages.findIndex((message) => (message as { uuid?: string }).uuid === target.messageUuid)
          else return undefined
          if (target.kind !== 'session-start' && endIndex < 0) return undefined
          const kept = endIndex < 0 ? [] : messages.slice(0, endIndex + 1)
          const lastUuid = kept.at(-1) as { uuid?: string } | undefined
          if (kept.length > 0 && !lastUuid?.uuid) return undefined
          return { messages: kept.flatMap((message) => typeof (message as { uuid?: unknown }).uuid === 'string' ? [(message as { uuid: string }).uuid] : []), nativeResume: lastUuid?.uuid ?? '' }
        },
        async writeConversation(sessionId, value) {
          const meta = getAgentSessionMeta(sessionId)
          if (!meta) throw new Error('Agent 会话不存在')
          const runtime = normalizeAgentRuntime(meta.agentRuntime)
          if (runtime === 'pi') {
            // 先解析 Pi 分支点（只读）：解析失败时不能先截 Profer JSONL 留下半截状态。
            const entryId = await resolvePiBranchEntryId(sessionId, value.nativeResume)
            if (!meta.sdkSessionId) throw new Error('Pi 会话缺少 sdkSessionId，无法回退 Pi transcript')
            // Profer JSONL 是唯一事实源：先存原始字节，重建失败要整份还原。
            const messagesPath = getAgentSessionMessagesPath(sessionId)
            let proferBefore: Buffer
            try {
              proferBefore = readFileSync(messagesPath)
            } catch (error) {
              throw new Error(`读取 Profer 会话历史失败: ${error instanceof Error ? error.message : String(error)}`)
            }
            const kept = value.nativeResume ? truncateSDKMessages(sessionId, value.nativeResume) : clearSDKMessages(sessionId)
            // Pi 文件由 Profer 独占写入（`pi/session-file-store`），因此回退就是「按保留历史重建」：
            // 结构异常（header 缺失 / entry 不存在 / 祖先链断裂）在写盘前失败，主文件原样保留；
            // 不再有「条截了但条数对不上 → 整份还原」这条路径，也就不需要备份与派生校验。
            const rebuilt = rewindPiTranscript({
              piSessionDir: getPiTranscriptDirForSession(sessionId),
              sdkSessionId: meta.sdkSessionId,
              entryId,
            })
            if (!rebuilt.ok) {
              let restoreError: string | undefined
              try {
                restoreProferMessagesBytes(sessionId, proferBefore)
              } catch (error) {
                restoreError = error instanceof Error ? error.message : String(error)
              }
              throw new Error([
                rebuilt.reason ?? 'Pi 记录重建失败',
                restoreError ? `会话历史还原失败，需要人工恢复: ${restoreError}` : '会话历史已还原',
              ].join('；'))
            }
            console.log(
              `[Agent 回退] Pi 记录已重建: session=${sessionId} 保留 ${rebuilt.kept} 条（对话 ${rebuilt.keptMessages ?? 0} 条），移除 ${rebuilt.removed} 条`,
            )
            await prunePiTrackerAfterRewind(sessionId, kept)
            // entry 绑定同样只保留保留历史里出现过的消息：指向已删 entry 的绑定会让下次回退必然失败。
            const keptUuids = new Set(kept.flatMap((message) => {
              const uuid = messageUuid(message)
              return uuid ? [uuid] : []
            }))
            const bindings = meta.piEntryBindings
            const prunedBindings = bindings && Object.keys(bindings).some((uuid) => !keptUuids.has(uuid))
              ? Object.fromEntries(Object.entries(bindings).filter(([uuid]) => keptUuids.has(uuid)))
              : bindings
            // Pi 不消费 resumeAtMessageUuid；仍按协议写回，供回退结果与下一次 send 对齐。
            updateAgentSessionMeta(sessionId, {
              resumeAtMessageUuid: value.nativeResume || undefined,
              ...(bindings ? { piEntryBindings: prunedBindings } : {}),
            })
            return
          }
          if (runtime !== 'claude') throw new Error('Claude 会话不存在或 runtime 不匹配')
          if (value.nativeResume) truncateSDKMessages(sessionId, value.nativeResume)
          else {
            const current = getAgentSessionSDKMessages(sessionId)
            if (current.length) {
              const { clearSDKMessages } = await import('./agent-session-manager')
              clearSDKMessages(sessionId)
            }
          }
          updateAgentSessionMeta(sessionId, {
            resumeAtMessageUuid: value.nativeResume || undefined,
            ...(value.nativeResume ? {} : { sdkSessionId: undefined }),
          })
        },
      },
      resolver: {
        async resolve(input): Promise<RewindResolverResult> {
          const meta = getAgentSessionMeta(input.sessionId)
          const runtime = meta ? normalizeAgentRuntime(meta.agentRuntime) : undefined
          if (!meta || runtime !== (meta.agentRuntime ? normalizeAgentRuntime(meta.agentRuntime) : runtime)) {
            return { supported: false, runtime: runtime ?? 'claude', reason: '当前 runtime 没有可用的回退适配器' }
          }
          const messages = getAgentSessionSDKMessages(input.sessionId)
          const positions = new Map<SDKMessage, number>()
          messages.forEach((message, index) => positions.set(message, index))
          const assistantMessages = messages.filter(message => sdkEntry(message).type === 'assistant' && typeof sdkEntry(message).uuid === 'string')
          const turns: ClaudeRewindTurn[] = []
          const turnByAssistant = new Map<string, string>()
          for (let index = 0; index < assistantMessages.length; index += 1) {
            const assistant = sdkEntry(assistantMessages[index]!)
            const assistantUuid = assistant.uuid!
            const userUuid = userTurnUuidFor(messages, positions, assistantMessages[index]!)
            if (!userUuid) continue
            const turnId = sessionTurnId(input.sessionId, index)
            turns.push({ turnId, userMessageUuid: userUuid, assistantMessageUuid: assistantUuid })
            turnByAssistant.set(assistantUuid, turnId)
          }
          // 文件回退一律走工作区历史（与 runtime 无关，Claude/Pi 共用同一份归属记录）。
          // 边界先用会话层的换算函数算一次：对话截断与文件回退必须是同一条线。
          const boundaryIndex = rewindBoundaryIndex(turns, input.target)
          // assistant 下标 ≠ 工作区轮下标（Pi 一轮多条 assistant），按用户轮 uuid 重新定位。
          const boundaryTurnUuid = boundaryIndex !== undefined && boundaryIndex >= 0 ? turns[boundaryIndex]?.userMessageUuid : undefined
          const shadowFromTurnIndex = boundaryTurnUuid ? shadowTurnBoundaryFrom(input.sessionId, boundaryTurnUuid) : undefined
          // 两套编号不能混用：归属记录的切片单位是「记录条数」，assistant 下标的含义是
          // 「消息位置」。有目标轮 uuid 却定位不到归属记录时（真机上常见：老会话、
          // 记录被清、轮次身份换了），用 assistant 下标兜底会实实在在撤错轮。
          // 这种情况一律报文件侧不可用，让 UI 退到显式的「只回退对话」。
          const boundaryUnlocatable = boundaryTurnUuid !== undefined && shadowFromTurnIndex === undefined
          const shadowResolution = input.mode === 'conversation' || boundaryIndex === undefined || boundaryUnlocatable
            ? undefined
            : await resolveWorkspaceShadowRewind({
              sessionId: input.sessionId,
              // boundaryIndex === -1（session-start / 首轮之前）时 shadowFromTurnIndex 必为 undefined，
              // 这里自然落到 0：归属记录全部属于被撤范围。
              fromTurnIndex: shadowFromTurnIndex ?? boundaryIndex + 1,
            })
          const filesAvailable = shadowResolution?.available === true
          const shadowReason = shadowResolution?.reason
            ?? (boundaryIndex === undefined
              ? '回退目标不在已加载的会话轮次中'
              : boundaryUnlocatable
                ? '无法按轮次定位文件变化记录'
                : '当前会话没有可用的文件变化记录')
          const shadowFiles = filesAvailable ? shadowResolution!.items : undefined
          const shadowTurns = filesAvailable ? shadowResolution!.turns : []
          if (input.mode !== 'conversation' && !filesAvailable) {
            return {
              runtime,
              supported: false,
              reason: shadowReason,
              capability: { runtime, supportsConversation: true, supportsFiles: false, supportsBoth: false, supportsUndo: true, supportsRefine: true, supportsSubmission: true, reasons: { files: shadowReason } },
            }
          }
          if (runtime === 'pi') {
            // Pi 的对话边界只由 `session.resolveTarget` 给出（与 Claude 同一套 session-start/message 语义）。
            // 这里不再重复算一份 messages/nativeResume：resolver 自己算一份只会让计划里的
            // removedMessageUuids 与真正写入的边界不一致。
            return {
              runtime: 'pi', supported: true,
              capability: {
                runtime: 'pi',
                supportsConversation: true,
                supportsFiles: filesAvailable,
                supportsBoth: filesAvailable,
                supportsUndo: true, supportsRefine: true, supportsSubmission: true,
                ...(filesAvailable ? {} : { reasons: { files: shadowReason } }),
              },
              ...(shadowFiles ? { files: shadowFiles, shadow: { turns: shadowTurns } } : {}),
            }
          }
          // 文件回退已由工作区历史承担，这里只解对话边界：
          // 旧证据链（tool_use → 内容引用）既判断不了「用户后来改过」，也不做合并，
          // 继续让它参与判定只会用「缺少快照」这类理由把可用的回退挡掉。
          const resolved = resolveClaudeRewind({
            sessionId: input.sessionId, mode: 'conversation', target: input.target, turns,
            currentSdkSessionId: meta.sdkSessionId, currentSdkEntries: messages.map(sdkEntry),
            fileEvidence: [], currentFileSnapshots: {},
          })
          // 文件来源只有工作区历史：旧 D4 证据链（tool_use → 内容引用）不再驱动写盘，
          // 它既不知道「用户后来改过」，也无法做非重合合并。
          const claudeSupported = resolved.supported && (input.mode === 'conversation' || filesAvailable)
          return {
            runtime: 'claude', supported: claudeSupported,
            reason: claudeSupported ? resolved.reason : (resolved.reason ?? shadowReason),
            capability: {
              ...resolved.capability,
              supportsFiles: filesAvailable,
              supportsBoth: resolved.supported && filesAvailable,
              ...(filesAvailable ? {} : { reasons: { ...resolved.capability.reasons, files: shadowReason } }),
            },
            ...(resolved.conversation ? { conversation: { messages: messages.flatMap(message => sdkEntry(message).uuid ? [sdkEntry(message).uuid!] : []), nativeResume: resolved.conversation.resumeAt ?? '' } } : {}),
            ...(shadowFiles ? { files: shadowFiles, shadow: { turns: shadowTurns } } : {}),
          }
        },
      },
      files: {
        async read(path, scope) {
          const sessionId = scope?.sessionId
          if (!sessionId) throw new Error('文件操作缺少 sessionId')
          const port = createElectronRewindFilePort(sessionId)
          if (!scope?.rootId || !scope.relativePath) throw new Error('文件证据缺少 rootId/relativePath')
          const inspected = await port.inspect(scope.rootId, scope.relativePath)
          return inspected.version.kind === 'absent' ? undefined : { revision: `${inspected.version.sha256}:${inspected.version.mode ?? 0}`, value: inspected.content?.toString('utf8') ?? '' }
        },
        async write(path, value, expectedRevision, scope) {
          const sessionId = scope?.sessionId
          if (!sessionId) throw new Error('文件操作缺少 sessionId')
          const port = createElectronRewindFilePort(sessionId)
          if (!scope?.rootId || !scope.relativePath) throw new Error('文件证据缺少 rootId/relativePath')
          const current = await port.inspect(scope.rootId, scope.relativePath)
          const currentRevision = current.version.kind === 'absent' ? 'absent' : `${current.version.sha256}:${current.version.mode ?? 0}`
          if (currentRevision !== expectedRevision) throw Object.assign(new Error('文件在回退前已变化'), { code: 'CONFLICT' })
          await port.write(scope.rootId, scope.relativePath, value === undefined ? undefined : Buffer.from(value), undefined, current.version)
        },
        async readBackup(backupRef, sessionId) {
          if (!sessionId) throw new Error('文件备份读取缺少 sessionId')
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          return (await store.readObject(backupRef)).toString('utf8')
        },
        async authorizePath(path, scope) {
          const sessionId = scope?.sessionId
          if (!sessionId) throw new Error('文件授权缺少 sessionId')
          if (!scope?.rootId || !scope.relativePath) throw new Error('文件证据缺少 rootId/relativePath')
          await createElectronRewindFilePort(sessionId).resolve(scope.rootId, scope.relativePath)
        },
      },
      recovery: {
        async backup({ sessionId, files, fileActions = [], messages, nativeResume, planId, plan, expectedRevision, callerKey }) {
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const sdkMessages = getAgentSessionSDKMessages(sessionId)
          const serializedMessages = JSON.stringify(sdkMessages)
          const version = await store.putVersion({ kind: 'file', content: Buffer.from(serializedMessages) })
          const messageRef = version.kind === 'file' ? version.contentRef : ''
          const durableActions = []
          for (const action of fileActions) {
            const storeVersion = async (state: { revision: string; value?: string } | undefined) => {
              if (!state) return { kind: 'absent' as const }
              const stored = await store.putVersion({ kind: 'file', content: Buffer.from(state.value ?? ''), mode: 0o600 })
              return stored
            }
            const before = await storeVersion(action.before)
            const after = await storeVersion(action.after)
            durableActions.push({
              sessionId, rootId: action.rootId, relativePath: action.relativePath, action: action.action,
              before, after,
              currentRevision: before.kind === 'file' ? `${before.sha256}:${before.mode ?? 0}` : 'absent',
              afterRevision: after.kind === 'file' ? `${after.sha256}:${after.mode ?? 0}` : 'absent',
              ...(callerKey ? { ownerKey: callerKey } : {}),
            })
          }
          const refs = [messageRef, ...durableActions.flatMap(action => [action.before, action.after].filter(version => version.kind === 'file').map(version => version.contentRef))]
          const recoveryId = `rewind-${randomUUID()}`
          await store.writeManifest({
            recoveryId, sessionId, status: 'ready', createdAt: Date.now(), refs,
            metadata: { fileActions: durableActions, nativeResume, sdkSessionId: getAgentSessionMeta(sessionId)?.sdkSessionId, messageVersion: version, planId, plan, expectedRevision, callerKey, status: 'ready' },
          })
          return recoveryId
        },
        async journal({ sessionId, recoveryId, status }) {
          if (!sessionId) throw new Error('恢复记录缺少 sessionId')
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const manifest = await store.readManifest(recoveryId)
          if (!manifest) throw new Error('恢复记录不存在')
          const statusMetadata = status === 'committed'
            ? { appliedRevision: createHash('sha256').update(JSON.stringify(getAgentSessionSDKMessages(sessionId))).digest('hex') }
            : {}
          await store.writeManifest({ ...manifest, status, metadata: { ...manifest.metadata, ...statusMetadata, status } })
          await store.writeJournal({
            operationId: recoveryId, sessionId: sessionId!, status: status === 'committed' ? 'committed' : status === 'recovery-required' ? 'recovery-required' : 'started',
            phase: status, createdAt: manifest.createdAt, updatedAt: Date.now(), refs: manifest.refs, actions: (manifest.metadata?.fileActions as import('@profer/session-store').RewindJournalFileAction[] | undefined) ?? [],
            metadata: { ...manifest.metadata, ...statusMetadata, status, recoveryId, sessionId },
          })
        },
        async bindOwner({ sessionId, recoveryId, callerKey }) {
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const manifest = await store.readManifest(recoveryId)
          if (!manifest) throw new Error('恢复记录不存在')
          const existingOwner = manifest.metadata?.ownerKey
          if (existingOwner && existingOwner !== callerKey) throw new Error('恢复记录已有其他调用方')
          const metadata = { ...manifest.metadata, ownerKey: callerKey }
          await store.writeManifest({ ...manifest, metadata })
          const journal = await store.readJournal(recoveryId)
          if (journal) await store.writeJournal({ ...journal, metadata: { ...journal.metadata, ...metadata, recoveryId, sessionId } })
        },
        async readRecovery(sessionId, recoveryId) {
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const manifest = await store.readManifest(recoveryId)
          const journal = await store.readJournal(recoveryId)
          if (!manifest) return undefined
          const metadata = manifest.metadata ?? {}
          const journalMetadata = journal?.metadata ?? {}
          if (typeof metadata.planId !== 'string' || !metadata.plan || !['conversation', 'files', 'both'].includes((metadata.plan as { mode?: string }).mode ?? '')) return undefined
          const ownerKey = metadata.ownerKey ?? metadata.callerKey ?? journalMetadata.ownerKey ?? journalMetadata.callerKey
          return {
            recoveryId, sessionId, planId: metadata.planId, mode: (metadata.plan as { mode: 'conversation' | 'files' | 'both' }).mode,
            status: manifest.status === 'recovery-required' || journal?.status === 'recovery-required'
              ? 'recovery-required'
              : manifest.status === 'applying' || journal?.status === 'started'
                ? 'recovery-required'
                : 'committed',
            ...(typeof ownerKey === 'string' ? { ownerKey } : {}),
            ...(metadata.result ? { result: metadata.result as import('@profer/shared').RewindResult } : {}),
            ...(metadata.undone ? { undone: metadata.undone as import('@profer/shared').RewindResult } : {}),
          }
        },
        async updateRecovery({ sessionId, recoveryId, patch }) {
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const manifest = await store.readManifest(recoveryId)
          if (!manifest) throw new Error('恢复记录不存在')
          await store.writeManifest({ ...manifest, status: patch.status === 'recovery-required' ? 'recovery-required' : patch.status === 'committed' ? 'committed' : manifest.status, metadata: { ...manifest.metadata, ...patch } })
          const journal = await store.readJournal(recoveryId)
          if (journal) await store.writeJournal({
            ...journal,
            status: patch.undone ? 'committed' : patch.status === 'committed' ? 'committed' : patch.status === 'recovery-required' ? 'recovery-required' : journal.status,
            phase: patch.undone ? 'undone' : patch.status ?? journal.phase,
            updatedAt: Date.now(),
            metadata: { ...journal.metadata, ...manifest.metadata, ...patch, recoveryId, sessionId },
          })
        },
        async persistPlan({ sessionId, plan, targetValues, targetBackupRefs }) {
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const current = await store.readManifest(plan.planId)
          const plans = (current?.metadata?.plans as Record<string, unknown> | undefined) ?? {}
          plans[plan.planId] = { plan, targetValues, targetBackupRefs }
          await store.writeManifest({
            recoveryId: plan.planId, sessionId, status: 'ready', createdAt: current?.createdAt ?? Date.now(), refs: current?.refs ?? [],
            metadata: { ...current?.metadata, plans },
          })
        },
        async readPlan(sessionId, planId) {
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const manifest = await store.readManifest(planId)
          const value = manifest?.metadata?.plans && (manifest.metadata.plans as Record<string, unknown>)[planId]
          return value as { plan: import('@profer/shared').RewindPlan; targetValues: Record<string, string | undefined>; targetBackupRefs: Record<string, string | undefined> } | undefined
        },
        async retain() {},
        async undo(sessionId, recoveryId, expectedRevision) {
          const store = createRewindStore(createElectronSessionStorePaths(), sessionId)
          const manifest = await store.readManifest(recoveryId)
          const journal = await store.readJournal(recoveryId)
          if (!manifest || !['applying', 'recovery-required', 'committed'].includes(manifest.status)) throw new Error('恢复记录不存在或状态不可撤销')
          const metadata = manifest.metadata ?? {}
          const meta = getAgentSessionMeta(sessionId)
          if (!meta || normalizeAgentRuntime(meta.agentRuntime) !== 'claude') throw new Error('Claude 会话不存在或 runtime 不匹配')
          const currentMessages = getAgentSessionSDKMessages(sessionId)
          const currentRevision = Number.parseInt(createHash('sha256').update(JSON.stringify(currentMessages)).digest('hex').slice(0, 12), 16)
          if (expectedRevision && currentRevision !== expectedRevision.session) throw Object.assign(new Error('恢复期间会话已变化'), { code: 'PLAN_STALE' })
          const appliedRevision = metadata.appliedRevision
          const currentRevisionHash = createHash('sha256').update(JSON.stringify(currentMessages)).digest('hex')
          if (typeof appliedRevision !== 'string' || currentRevisionHash !== appliedRevision) {
            throw Object.assign(new Error('回退后会话已变化，不能安全覆盖恢复'), { code: 'PLAN_STALE' })
          }
          const fileActions = (journal?.actions?.length ? journal.actions : (metadata.fileActions as import('@profer/session-store').RewindJournalFileAction[] | undefined) ?? [])
          const filePort = createElectronRewindFilePort(sessionId)
          const resolvedActions = fileActions.map(action => ({ action, scope: { sessionId, rootId: action.rootId, relativePath: action.relativePath } }))
          const currentFiles = [] as Array<{ action: typeof fileActions[number]; version: import('@profer/session-store').StoredFileVersion }>
          for (const entry of resolvedActions) {
            const inspected = await filePort.inspect(entry.action.rootId, entry.action.relativePath)
            const currentRevision = inspected.version.kind === 'absent' ? 'absent' : `${inspected.version.sha256}:${inspected.version.mode ?? 0}`
            if (currentRevision !== entry.action.afterRevision) throw Object.assign(new Error(`文件在恢复前已变化: ${entry.action.relativePath}`), { code: 'CONFLICT' })
            if (entry.action.before.kind === 'file') await store.readVersion(entry.action.before)
            currentFiles.push({ action: entry.action, version: inspected.version })
          }
          for (const entry of currentFiles) {
            const content = await store.readVersion(entry.action.before)
            await filePort.write(entry.action.rootId, entry.action.relativePath, content, entry.action.before.kind === 'file' ? entry.action.before.mode : undefined, entry.version)
          }
          const version = metadata.messageVersion as { kind?: string; contentRef?: string; sha256?: string; size?: number } | undefined
          if (!version || version.kind !== 'file' || !version.contentRef || !version.sha256 || typeof version.size !== 'number') {
            throw new Error('恢复记录缺少消息对象')
          }
          const content = await store.readVersion(version as import('@profer/session-store').StoredFileVersion)
          if (!content) throw new Error('恢复记录消息对象不存在')
          const saved = JSON.parse(content.toString('utf8')) as SDKMessage[]
          clearSDKMessages(sessionId)
          appendSDKMessages(sessionId, saved)
          const nativeResume = metadata.nativeResume
          updateAgentSessionMeta(sessionId, {
            resumeAtMessageUuid: typeof nativeResume === 'string' && nativeResume ? nativeResume : undefined,
            sdkSessionId: typeof metadata.sdkSessionId === 'string' ? metadata.sdkSessionId : undefined,
          })
          await store.writeManifest({ ...manifest, status: 'committed', metadata: { ...metadata, undone: true } })
        },
      },
      shadow: {
        async apply(input) {
          const meta = getAgentSessionMeta(input.sessionId)
          const workspaceId = meta?.workspaceId
          if (!workspaceId) {
            return { ok: false, restoredPaths: [], deletedPaths: [], keptPaths: [], error: '当前会话没有绑定工作区' }
          }
          const applied = await applyWorkspaceShadowRewind({
            sessionId: input.sessionId,
            workspaceId,
            turns: input.turns,
          })
          return {
            ok: applied.ok,
            restoredPaths: applied.restoredPaths,
            deletedPaths: applied.deletedPaths,
            keptPaths: applied.keptPaths,
            ...(applied.error ? { error: applied.error } : {}),
          }
        },
      },
      lock: { withSessionLock: withAgentSessionExclusive },
      // 回退已写盘后：① 为下一轮准备一次性不可见上下文；② 失效本会话派生缓存。
      // 两者都是「派生数据」，失败只影响新鲜度，不能把已完成的回退改成失败。
      afterExecute: async (result) => {
        const notice = createAgentRewindNotice(result)
        if (notice) {
          try {
            updateAgentSessionMeta(result.sessionId, { pendingRewindNotice: notice })
          } catch (error) {
            console.warn('[Agent 回退] 写入回退上下文失败（不影响回退结论）:', error)
          }
        }
        try {
          const repair = repairAgentSessionCachesAfterRewind(result.sessionId)
          if (repair.clampedAnalyzedTurn !== undefined) {
            console.log(`[Agent 回退] 回溯水位已回退: session=${result.sessionId} lastAnalyzedTurn=${repair.clampedAnalyzedTurn}`)
          }
        } catch (error) {
          console.warn('[Agent 回退] 派生缓存重建失败（不影响回退结论）:', error)
        }
      },
      submitAfterRewind: async (input) => ({
        status: 'failed', submissionId: input.submissionId, planId: input.planId,
        error: { code: 'CAPABILITY_UNAVAILABLE', message: 'R0 不支持回退后自动重发', sessionId: input.sessionId, planId: input.planId },
      }),
    },
  })
}

export type ElectronRewindTarget = RewindTarget
