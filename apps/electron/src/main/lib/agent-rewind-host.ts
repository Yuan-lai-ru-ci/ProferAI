import { createHash, randomUUID } from 'node:crypto'
import type { RewindTarget, SDKMessage } from '@profer/shared'
import { createRewindStore } from '@profer/session-store'
import { normalizeAgentRuntime } from '@profer/shared'
import { createAgentRewindService, type RewindResolverResult } from './agent-rewind-service'
import { getAgentSessionMeta, getAgentSessionSDKMessages, truncateSDKMessages, updateAgentSessionMeta, clearSDKMessages, appendSDKMessages } from './agent-session-manager'
import { createElectronSessionStorePaths } from './session-store-host'
import { withAgentSessionExclusive } from './agent-service'
import { getAgentAttachmentBackupsRoot, getAgentSessionCwd, getAttachmentsDir } from './config-paths'
import { getAgentWorkspace } from './agent-workspace-manager'
import { createRewindFilePort } from './agent-rewind-file-port'
import { resolveClaudeRewind, type ClaudeRewindTurn } from './agent-rewind-claude'
import { loadPiRewindTracker, persistPiRewindTracker } from './agent-rewind-pi'
import type { ClaudeRewindToolEvidence } from '@profer/agent-provider-claude'
import type { PiFileMutationEvidence } from '@profer/agent-provider-pi'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Provider evidence is loaded by sessionId; this port never trusts renderer paths. */
function trackerPath(sessionId: string): string {
  return join(createElectronSessionStorePaths().rewindDir, sessionId, 'pi-tracker.json')
}

function sessionTurnId(sessionId: string, index: number): string {
  return `${sessionId}-T${index + 1}`
}

function sdkEntry(message: SDKMessage): { uuid?: string; type?: string; message?: { content?: Array<{ type?: string; name?: string }> }; tool_name?: string } {
  return message as unknown as { uuid?: string; type?: string; message?: { content?: Array<{ type?: string; name?: string }> }; tool_name?: string }
}

function isClaudeWriterEntry(entry: ReturnType<typeof sdkEntry>): boolean {
  return entry.message?.content?.some(block => block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) === true
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

/** 主进程 R0 适配器：支持 Claude 对话锚点；文件恢复与 Pi native transcript 明确关闭。 */
export function createElectronAgentRewindService() {
  return createAgentRewindService({
    ports: {
      session: {
        async read(sessionId) {
          const meta = getAgentSessionMeta(sessionId)
          if (!meta || normalizeAgentRuntime(meta.agentRuntime) !== 'claude') return undefined
          const messages = getAgentSessionSDKMessages(sessionId)
          const revision = Number.parseInt(createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 12), 16)
          return {
            messages: messages.flatMap((message) => typeof (message as { uuid?: unknown }).uuid === 'string' ? [(message as { uuid: string }).uuid] : []),
            nativeResume: meta.resumeAtMessageUuid ?? '',
            revision: { session: revision, files: 0, state: meta.revision ?? 0 },
            runtime: 'claude',
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
          if (!meta || normalizeAgentRuntime(meta.agentRuntime) !== 'claude') throw new Error('Claude 会话不存在或 runtime 不匹配')
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
          if (input.mode !== 'conversation') {
            return {
              runtime,
              supported: false,
              reason: '文件恢复暂不可用：Electron recovery undo 尚未覆盖文件对象与跨 runtime 恢复',
              capability: { runtime, supportsConversation: true, supportsFiles: false, supportsBoth: false, supportsUndo: true, supportsRefine: true, supportsSubmission: true },
            }
          }
          const messages = getAgentSessionSDKMessages(input.sessionId)
          const assistantMessages = messages.filter(message => sdkEntry(message).type === 'assistant' && typeof sdkEntry(message).uuid === 'string')
          const turns: ClaudeRewindTurn[] = []
          const turnByAssistant = new Map<string, string>()
          for (let index = 0; index < assistantMessages.length; index += 1) {
            const assistant = sdkEntry(assistantMessages[index]!)
            const assistantUuid = assistant.uuid!
            const previous = index > 0 ? sdkEntry(assistantMessages[index - 1]!) : undefined
            const user = messages.find(message => sdkEntry(message).type === 'user' && sdkEntry(message).uuid && (!previous || messages.indexOf(message) < messages.indexOf(assistantMessages[index]!)))
            const userUuid = user ? sdkEntry(user).uuid : undefined
            if (!userUuid) continue
            const turnId = sessionTurnId(input.sessionId, index)
            turns.push({ turnId, userMessageUuid: userUuid, assistantMessageUuid: assistantUuid })
            turnByAssistant.set(assistantUuid, turnId)
          }
          if (runtime === 'pi') {
            return {
              runtime: 'pi', supported: true,
              capability: { runtime: 'pi', supportsConversation: true, supportsFiles: false, supportsBoth: false, supportsUndo: true, supportsRefine: true, supportsSubmission: true },
              conversation: { messages: messages.flatMap(message => sdkEntry(message).uuid ? [sdkEntry(message).uuid!] : []), nativeResume: meta.resumeAtMessageUuid ?? '' },
            }
          }
          const evidence = await readClaudeEvidence(input.sessionId)
          const fileEvidence = evidence.map(item => ({ turnId: turnByAssistant.get(item.toolUseId ?? '') ?? sessionTurnId(input.sessionId, Math.max(0, turns.length - 1)), evidence: item }))
          const currentFileSnapshots: Record<string, { path: string; revision: string; exists: boolean; contentRef?: string; backupRef?: string }> = {}
          const filePort = createElectronRewindFilePort(input.sessionId)
          for (const path of new Set(evidence.map(item => item.path))) {
            const scope = relativeWorkspacePath(input.sessionId, path)
            if (!scope) continue
            const inspected = await filePort.inspect(scope.rootId, scope.relativePath)
            currentFileSnapshots[path] = {
              path, revision: inspected.version.kind === 'absent' ? `absent:${path}` : `${inspected.version.sha256}:${inspected.version.mode ?? 0}`,
              exists: inspected.version.kind !== 'absent',
              ...(inspected.version.kind === 'file' ? { contentRef: inspected.version.contentRef, backupRef: inspected.version.contentRef } : {}),
            }
          }
          const resolved = resolveClaudeRewind({
            sessionId: input.sessionId, mode: input.mode, target: input.target, turns,
            currentSdkSessionId: meta.sdkSessionId, currentSdkEntries: messages.map(sdkEntry),
            fileEvidence, currentFileSnapshots,
          })
          const files = resolved.fileCandidates?.map(item => {
            const scope = relativeWorkspacePath(input.sessionId, item.path)
            return { ...item, ...(scope ?? {}), path: scope?.relativePath ?? item.path, evidence: 'tracked-write' as const }
          })
          return {
            runtime: 'claude', supported: resolved.supported, reason: resolved.reason, capability: resolved.capability,
            ...(resolved.conversation ? { conversation: { messages: messages.flatMap(message => sdkEntry(message).uuid ? [sdkEntry(message).uuid!] : []), nativeResume: resolved.conversation.resumeAt ?? '' } } : {}),
            ...(files ? { files } : {}),
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
      lock: { withSessionLock: withAgentSessionExclusive },
      submitAfterRewind: async (input) => ({
        status: 'failed', submissionId: input.submissionId, planId: input.planId,
        error: { code: 'CAPABILITY_UNAVAILABLE', message: 'R0 不支持回退后自动重发', sessionId: input.sessionId, planId: input.planId },
      }),
    },
  })
}

export type ElectronRewindTarget = RewindTarget
