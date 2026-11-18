import { createAgentRunContext } from '@profer/agent-runtime'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentSessionMeta, SDKMessage, PrepareRewindPlanInput, RefineRewindPlanInput, ExecuteRewindPlanInput, UndoRewindInput, SubmitAfterRewindInput } from '@profer/shared'
import { createSessionStorePaths, registerOwnedSessionLayout, sessionMessagesPath, sessionGraphPath, sessionHarnessPath, WorkspaceShadowRepository, deriveAttachedRootId, normalizeShadowRoots } from '@profer/session-store'
import { buildGraphFromEvents, parseEventsFromJsonl, generateSummary, serializeEvent, type GraphEvent } from '../../../packages/project-core/src/index'
import { replacePiNativeTranscript, preparePiNativeRewind } from '@profer/agent-provider-pi'
import type { CoreConfig } from './config'
import type { CoreAgentRuntime } from './runtime'
import { createCoreNativeSessionPorts } from './native-session-store'
import { nativeSessionRevision } from './native-session-service'
import { createCoreRewindService } from './native-rewind-host'
import { resolveWorkspaceShadowRewind, applyWorkspaceShadowRewind } from './native-shadow-rewind'
import type { CoreShadowPorts } from './native-shadow-restore'
import { replayPiHarnessEvents } from './native-harness-reducer'
import { toPiHarnessSnapshotView } from './native-harness-view'
import type { PiHarnessEvent } from './native-harness-types'

export function createCoreNativeOperations(config: CoreConfig, runtime: CoreAgentRuntime) {
  const paths = createSessionStorePaths(config.configDir)
  const tokens = new Map<string, symbol>()
  const nativePorts = createCoreNativeSessionPorts({ config, sessions: runtime.sessions, workspaces: runtime.workspaces,
    busy: id => { const owner = runtime.coordinator.ownership.getOwner(id); return (!!owner && owner.token !== tokens.get(id)) || runtime.deletions.isWriteBlocked(id) || runtime.goals.list(id).some(goal => goal.status === "active" || goal.status === "stopping") },
    onChanged: meta => runtime.publish({ type: 'message', sessionId: meta.id, payload: { kind: 'session_meta', meta } }) })
  const meta = (id: string) => {
    const value = runtime.sessions.getMeta(id)
    if (!value) throw new Error('会话不存在')
    registerOwnedSessionLayout(value, runtime.workspaces.list().find(w => w.id === value.workspaceId))
    return value
  }
  const exclusive = async <T,>(id: string, action: () => Promise<T>): Promise<T> => {
    meta(id)
    const token = Symbol('native-operation')
    if (nativePorts.busy(id) || runtime.delegations.snapshot().some(record => record.parentSessionId === id && record.status === 'running')) throw new Error('会话被占用，不能修改历史')
    if (!runtime.coordinator.ownership.claim({ sessionId: id, runtime: meta(id).agentRuntime ?? 'claude', token }).ok) throw new Error('会话已被占用')
    tokens.set(id, token)
    try { return await action() } finally { runtime.coordinator.ownership.release(id, token); tokens.delete(id) }
  }
  const update = (id: string, patch: Partial<AgentSessionMeta>) => {
    const state = nativePorts.read(id)
    nativePorts.commit(id, nativeSessionRevision(state), state.messages, patch)
  }
  const shadowDir = (id: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('工作区标识无效')
    return join(config.configDir, 'workspace-shadow', id)
  }
  const shadow: CoreShadowPorts = {
    getMeta: id => runtime.sessions.getMeta(id), workspace: id => runtime.workspaces.list().find(w => w.id === id), shadowDir, gitPath: 'git',
    roots: (workspace, sessionId) => {
      const primary = realpathSync(workspace.storageMode === 'project' ? workspace.rootPath! : join(config.workspaceRoot, workspace.slug))
      const attached = runtime.sessions.list().filter(session => session.workspaceId === workspace.id && session.id === sessionId).flatMap(session => session.attachedDirectories ?? [])
      const configuration = join(workspace.storageMode === 'project' ? join(primary, '.profer') : join(config.configDir, 'workspaces', workspace.slug), 'config.json')
      if (existsSync(configuration)) {
        const settings = JSON.parse(readFileSync(configuration, 'utf8')) as { attachedDirectories?: unknown }
        if (Array.isArray(settings.attachedDirectories)) attached.push(...settings.attachedDirectories.filter((value): value is string => typeof value === 'string'))
      }
      return normalizeShadowRoots([{ rootId: workspace.id, rootPath: primary, kind: workspace.storageMode === 'project' ? 'project' : 'managed' }, ...attached.filter(path => existsSync(path)).map(path => { const canonical = realpathSync(path); return { rootId: deriveAttachedRootId(canonical), rootPath: canonical, kind: 'attached' as const } })])
    },
    open: workspace => WorkspaceShadowRepository.open({ workspaceId: workspace.id, repoDir: join(shadowDir(workspace.id), 'repo.git'), journalPath: join(shadowDir(workspace.id), 'journal.json'), gitPath: 'git', excludeAbsolutePaths: () => [config.configDir, ...(workspace.rootPath ? [join(workspace.rootPath, '.profer')] : [])] }),
  }
  const backupFile = (id: string) => join(paths.rewindDir, id, 'native-full-backup.json')
  const writeConversation = async (id: string, value: { messages: string[]; nativeResume: string }) => {
    const state = nativePorts.read(id), location = state.meta.sdkSessionId ? nativePorts.locate(state.meta) : undefined
    const keep = new Set(value.messages)
    const messages = state.messages.filter(message => keep.has((message as { uuid?: string }).uuid ?? ''))
    if (state.meta.agentRuntime === 'pi' && location) {
      const entryId = value.nativeResume ? state.meta.piEntryBindings?.[value.nativeResume] : undefined
      if (value.nativeResume && !entryId) throw new Error('Pi 回退缺少精确 entry 绑定')
      const original = readFileSync(location.file, 'utf8')
      const content = entryId ? (await preparePiNativeRewind({ ...location, entryId })).content : original.split('\n')[0] + '\n'
      const patch = { resumeAtMessageUuid: value.nativeResume || undefined, piEntryBindings: Object.fromEntries(Object.entries(state.meta.piEntryBindings ?? {}).filter(([uuid]) => keep.has(uuid))) }
      const journalFile = `${location.file}.profer-rewind.json`
      if (existsSync(journalFile)) throw new Error('存在未恢复的 Pi 原生事务')
      replacePiNativeTranscript(journalFile, JSON.stringify({ schema: 1, sessionId: id, expected: nativeSessionRevision(state), original, replacement: content, messages, patch }))
      replacePiNativeTranscript(location.file, content)
      try { nativePorts.commit(id, nativeSessionRevision(state), messages, patch) }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('NATIVE_COMMIT_RECOVERY_REQUIRED:')) throw error
        replacePiNativeTranscript(location.file, original); unlinkSync(journalFile); throw error
      }
      unlinkSync(journalFile)
    } else nativePorts.commit(id, nativeSessionRevision(state), messages, { resumeAtMessageUuid: value.nativeResume || undefined, ...(value.nativeResume ? {} : { sdkSessionId: undefined }) })
  }
  const rewind = createCoreRewindService({ configDir: config.configDir, paths, getMeta: id => runtime.sessions.getMeta(id), messages: id => [...runtime.sessions.readMessages(id)], workspace: id => runtime.workspaces.list().find(w => w.id === id), cwd: id => nativePorts.locate(meta(id)).cwd, messagesPath: id => sessionMessagesPath(paths, id), shadowDir, exclusive, updateMeta: update, writeConversation,
    backupNative: (id, recoveryId) => {
      const state = nativePorts.read(id), location = state.meta.sdkSessionId ? nativePorts.locate(state.meta) : undefined
      const file = join(paths.rewindDir, id, recoveryId, 'native-full-backup.json')
      mkdirSync(dirname(file), { recursive: true })
      replacePiNativeTranscript(file, JSON.stringify({ state, native: location && existsSync(location.file) ? readFileSync(location.file, 'utf8') : undefined, graph: existsSync(sessionGraphPath(paths, id)) ? readFileSync(sessionGraphPath(paths, id), 'utf8') : undefined, harness: existsSync(sessionHarnessPath(paths, id)) ? readFileSync(sessionHarnessPath(paths, id), 'utf8') : undefined }))
    },
    restoreConversation: async (id, messages, _resume, recoveryId) => {
      if (!recoveryId) throw new Error('缺少原生恢复记录标识')
      const backup = JSON.parse(readFileSync(join(paths.rewindDir, id, recoveryId, 'native-full-backup.json'), 'utf8')) as { state: { meta: AgentSessionMeta }; native?: string; graph?: string; harness?: string }
      const state = nativePorts.read(id)
      if (backup.state.meta.id !== id) throw new Error('原生恢复备份归属无效')
      nativePorts.commit(id, nativeSessionRevision(state), messages, backup.state.meta, { ...(backup.native !== undefined ? { native: backup.native } : {}), ...(backup.graph !== undefined ? { graph: backup.graph } : {}), ...(backup.harness !== undefined ? { harness: backup.harness } : {}) })
    }, repairCaches: id => { const m = meta(id); if ((m.lastAnalyzedTurn ?? 0) > runtime.sessions.readMessages(id).length) update(id, { lastAnalyzedTurn: 0 }) },
    resolveShadow: input => resolveWorkspaceShadowRewind(shadow, input), applyShadow: input => applyWorkspaceShadowRewind(shadow, input),
    submit: async input => {
      if (![input.planId, input.requestId, input.submissionId, input.draftId].every(value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value))) throw new Error('回退提交标识无效')
      let draft: SDKMessage | undefined
      const root = join(paths.rewindDir, input.sessionId)
      if (!draft && existsSync(root)) for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const file = join(root, entry.name, 'native-full-backup.json')
        if (!existsSync(file)) continue
        const store = (await import('@profer/session-store')).createRewindStore(paths, input.sessionId)
        const manifest = await store.readManifest(entry.name)
        if (manifest?.metadata?.planId !== input.planId || manifest.status !== 'committed') continue
        const backup = JSON.parse(readFileSync(file, 'utf8')) as { state: { messages: SDKMessage[] } }
        draft = backup.state.messages.find(message => (message as { uuid?: string }).uuid === input.draftId)
        if (draft) break
      }
      const content = (draft as { message?: { content?: string | Array<{ type: string; text?: string }> } } | undefined)?.message?.content
      const prompt = typeof content === 'string' ? content : content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
      if (!draft || draft.type !== 'user' || !prompt) throw new Error('已提交回退计划中不存在该用户原文引用')
      const submissionFile = join(paths.rewindDir, input.sessionId, `submission-${createHash('sha256').update(input.submissionId).digest('hex')}.json`)
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      if (existsSync(submissionFile)) {
        const previous = JSON.parse(readFileSync(submissionFile, 'utf8')) as { fingerprint: string; result: import('@profer/shared').SubmitAfterRewindResult }
        if (previous.fingerprint !== fingerprint) throw new Error('submissionId 已绑定不同内容')
        return previous.result
      }
      const pending = { status: 'dispatch-unknown' as const, submissionId: input.submissionId, planId: input.planId }
      mkdirSync(dirname(submissionFile), { recursive: true })
      replacePiNativeTranscript(submissionFile, JSON.stringify({ fingerprint, result: pending }))
      await runtime.goals.prepareUserTurn(input.sessionId)
      const context = createAgentRunContext({ sessionId: input.sessionId, uuid: input.submissionId, initiator: 'user' }, randomUUID)
      const handle = runtime.coordinator.run(runtime.createQuery(meta(input.sessionId), prompt, { uuid: input.submissionId, context }))
      void handle.promise.catch(error => console.error('[Core] 回退后提交失败', error))
      const accepted = { status: 'accepted' as const, submissionId: input.submissionId, planId: input.planId }
      replacePiNativeTranscript(submissionFile, JSON.stringify({ fingerprint, result: accepted }))
      return accepted
    } })
  return {
    snapshot: (id: string, since?: string) => runtime.nativeSessions.snapshot(id, since),
    async operation(id: string, operation: string, input: Record<string, unknown> = {}): Promise<unknown> {
      const m = meta(id)
      const args = { ...input, sessionId: id }
      if (operation === 'has_pi_fork') return Boolean(m.piEntryBindings?.[String(input.messageId)])
      if (operation === 'rewind_prepare') return rewind.prepare(args as unknown as PrepareRewindPlanInput)
      if (operation === 'rewind_refine') return rewind.refine(args as unknown as RefineRewindPlanInput)
      if (operation === 'rewind_execute') return rewind.execute(args as unknown as ExecuteRewindPlanInput, String(input.callerKey ?? 'core-native'))
      if (operation === 'rewind_undo') return rewind.undo(args as unknown as UndoRewindInput, String(input.callerKey ?? 'core-native'))
      if (operation === 'rewind_submit') return rewind.submitAfterRewind(args as unknown as SubmitAfterRewindInput)
      if (operation === 'fork') {
        const target = typeof input.upToMessageUuid === 'string' ? input.upToMessageUuid : (runtime.sessions.readMessages(id).at(-1) as { uuid?: string } | undefined)?.uuid
        if (!target) throw new Error('会话没有可分叉的原生锚点')
        return m.agentRuntime === 'pi' ? runtime.nativeSessions.forkPi(id, target, String(input.revision), nativePorts.locate(m).sessionDir) : runtime.nativeSessions.forkClaude(id, target, String(input.revision))
      }
      if (operation === 'rewind') {
        const result = await rewind.prepare({ sessionId: id, mode: 'conversation', target: typeof input.assistantMessageUuid === 'string' ? { kind: 'message', messageUuid: input.assistantMessageUuid } : { kind: 'session-start' } })
        const executed = await rewind.execute({ sessionId: id, planId: result.plan.planId, expectedRevision: result.plan.revision })
        return { remainingMessages: executed.conversation?.remainingMessages ?? runtime.sessions.readMessages(id).length }
      }
      if (operation === 'graph' || operation === 'graph_summary') {
        const file = sessionGraphPath(paths, id), graph = buildGraphFromEvents(existsSync(file) ? parseEventsFromJsonl(readFileSync(file, 'utf8')) : [])
        return operation === 'graph' ? graph : generateSummary(graph)
      }
      if (operation === 'graph_append') return exclusive(id, async () => {
        if (runtime.nativeSessions.snapshot(id).revision !== input.revision) throw new Error('REVISION_CONFLICT')
        const event = input.event as GraphEvent
        if (!event || typeof event.type !== 'string' || !Number.isFinite(event.timestamp)) throw new Error('Graph 事件无效')
        const file = sessionGraphPath(paths, id); mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, serializeEvent(event) + '\n')
        return undefined
      })
      if (operation === 'harness') { const file = sessionHarnessPath(paths, id); const events = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as PiHarnessEvent) : []; return toPiHarnessSnapshotView(replayPiHarnessEvents(id, events)) }
      throw new Error(`未知原生操作: ${operation}`)
    },
  }
}
export type CoreNativeOperations = ReturnType<typeof createCoreNativeOperations>
