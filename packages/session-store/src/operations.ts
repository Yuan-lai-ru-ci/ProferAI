import type { AgentSessionMeta } from '@profer/shared'
import type {
  DeleteSessionInput,
  ForkSessionInput,
  RewindSessionInput,
  SessionOperationHost,
  SessionOperationPhase,
  SessionOperationProgress,
  SessionOperationService,
  SessionStore,
} from './contracts'
import { SessionOperationError } from './contracts'
import { createSessionJournalStore, type SessionOperationJournal } from './journal'
import { copyGraphEventsThroughTimestamp, copyHarnessEventsThroughTimestamp } from './event-store'
import { copySessionWorkspace, removeSessionWorkspace } from './workspace-store'

export interface SessionOperationServiceOptions {
  store: SessionStore
  host: SessionOperationHost
  workspacePath?: (meta: AgentSessionMeta) => string | undefined
  journalDir?: string
}

export function createSessionOperationService(options: SessionOperationServiceOptions): SessionOperationService {
  const journal = options.journalDir ? createSessionJournalStore(options.journalDir) : undefined

  const runDelete = async (input: DeleteSessionInput): Promise<{ deletedSessionIds: string[] }> => {
    const order = input.cascade === false
      ? [input.sessionId]
      : await options.host.getDeletionOrder(input.sessionId)
    const deletedSessionIds = [...new Set(order.length > 0 ? order : [input.sessionId])]
    const emit = progressEmitter(input, 'delete')
    const entry = createJournalEntry(input, 'delete', deletedSessionIds)
    await journal?.write(entry)

    try {
      await updateJournal(journal, entry, 'stopping')
      emit('stopping', 0, deletedSessionIds.length)
      for (let index = 0; index < deletedSessionIds.length; index += 1) {
        await options.host.stopAndWait(deletedSessionIds[index]!)
        emit('stopping', index + 1, deletedSessionIds.length, deletedSessionIds[index])
      }
      await updateJournal(journal, entry, 'cleaning')
      for (let index = 0; index < deletedSessionIds.length; index += 1) {
        const sessionId = deletedSessionIds[index]!
        await options.host.clearRuntimeState?.(sessionId)
        const meta = await options.store.index.get(sessionId)
        if (meta) {
          await options.host.getArtifactAdapter?.(meta)?.removeOwnedArtifact?.(meta)
          const workspace = options.workspacePath?.(meta)
          if (workspace) await removeSessionWorkspace(workspace)
        }
        await options.store.files.remove(sessionId)
        await options.store.metadata.remove(sessionId)
        emit('cleaning', index + 1, deletedSessionIds.length, sessionId)
      }
      await updateJournal(journal, entry, 'completed', 'committed')
      emit('completed', deletedSessionIds.length, deletedSessionIds.length)
      await journal?.remove(input.operationId)
      return { deletedSessionIds }
    } catch (error) {
      await updateJournal(journal, entry, entry.phase, 'failed', error instanceof Error ? error.message : String(error))
      emit('failed', undefined, undefined, error instanceof Error ? error.message : String(error))
      throw toOperationError(error, 'delete', input.sessionId)
    }
  }

  const runFork = async (input: ForkSessionInput): Promise<AgentSessionMeta> => {
    const source = await options.store.index.get(input.sessionId)
    if (!source) throw new SessionOperationError('session_not_found', `Agent 会话不存在: ${input.sessionId}`, { operation: 'fork', sessionId: input.sessionId })
    const emit = progressEmitter(input, 'fork')
    const entry = createJournalEntry(input, 'fork')
    await journal?.write(entry)
    const destination = await options.store.metadata.create({
      title: `${source.title}${input.titleSuffix ?? ' (fork)'}`,
      channelId: source.channelId,
      workspaceId: source.workspaceId,
      modelId: source.modelId,
      agentRuntime: source.agentRuntime,
    })
    entry.destinationSessionId = destination.id
    await journal?.write(entry)
    let artifactCreated = false
    try {
      await updateJournal(journal, entry, 'reading')
      emit('reading', 0)
      const adapter = options.host.getArtifactAdapter?.(source)
      const artifact = adapter
        ? await adapter.fork({
            sessionId: input.sessionId,
            upToMessageUuid: input.upToMessageUuid,
            destinationSessionId: destination.id,
            sourceMeta: source,
            destinationMeta: destination,
          })
        : {}
      artifactCreated = Boolean(artifact.nativeSessionId || artifact.nativeSessionFile)
      const updated = await options.store.metadata.update(destination.id, {
        ...(artifact.nativeSessionId ? { sdkSessionId: artifact.nativeSessionId } : {}),
        ...(artifact.nativeSessionFile ? { piSessionFile: artifact.nativeSessionFile } : {}),
      })
      await updateJournal(journal, entry, 'copying')
      emit('copying', 0)
      await options.store.files.copy(input.sessionId, destination.id, {
        upToMessageUuid: input.upToMessageUuid,
        transformMessage: input.transformMessage,
        onProgress: (completed) => emit('copying', completed),
      })
      const sourceWorkspace = options.workspacePath?.(source)
      const destinationWorkspace = options.workspacePath?.(updated)
      if (sourceWorkspace && destinationWorkspace) {
        const result = await copySessionWorkspace(sourceWorkspace, destinationWorkspace, (completed) => emit('copying', completed))
        if (result.failedCount > 0) throw new Error(`fork 工作区有 ${result.failedCount} 个条目未复制`)
      }
      const messages = await options.store.messages.read(input.sessionId)
      const forkTarget = input.upToMessageUuid
        ? messages.find((message) => (message as { uuid?: string }).uuid === input.upToMessageUuid)
        : undefined
      const forkTimestamp = typeof (forkTarget as { _createdAt?: unknown } | undefined)?._createdAt === 'number'
        ? (forkTarget as unknown as { _createdAt: number })._createdAt
        : Date.now()
      await copyGraphEventsThroughTimestamp(options.store.paths, input.sessionId, updated.id, forkTimestamp)
      await copyHarnessEventsThroughTimestamp(options.store.paths, input.sessionId, updated.id, forkTimestamp)
      await updateJournal(journal, entry, 'completed', 'committed')
      emit('completed', 1, 1)
      await journal?.remove(input.operationId)
      return updated
    } catch (error) {
      await updateJournal(journal, entry, entry.phase, 'failed', error instanceof Error ? error.message : String(error))
      emit('failed', undefined, undefined, error instanceof Error ? error.message : String(error))
      try {
        await options.store.files.remove(destination.id)
        const destinationWorkspace = options.workspacePath?.(destination)
        if (destinationWorkspace) await removeSessionWorkspace(destinationWorkspace)
        if (artifactCreated) await options.host.getArtifactAdapter?.(source)?.removeOwnedArtifact?.(destination)
        await options.store.metadata.remove(destination.id)
      } catch {
        // Preserve the original operation error; the journal records cleanup failure.
      }
      throw toOperationError(error, 'fork', input.sessionId)
    }
  }

  const runRewind = async (input: RewindSessionInput): Promise<{ remainingMessages: number }> => {
    const meta = await options.store.index.get(input.sessionId)
    if (!meta) throw new SessionOperationError('session_not_found', `Agent 会话不存在: ${input.sessionId}`, { operation: 'rewind', sessionId: input.sessionId })
    const emit = progressEmitter(input, 'rewind')
    const entry = createJournalEntry(input, 'rewind')
    await journal?.write(entry)
    try {
      await updateJournal(journal, entry, 'reading')
      emit('reading')
      const messages = await options.store.messages.read(input.sessionId)
      const targetIndex = input.assistantMessageUuid
        ? messages.findIndex((message) => (message as { uuid?: string }).uuid === input.assistantMessageUuid)
        : -1
      if (input.assistantMessageUuid && targetIndex < 0) {
        throw new SessionOperationError('target_not_found', `回退目标不存在: ${input.assistantMessageUuid}`, {
          operation: 'rewind',
          sessionId: input.sessionId,
        })
      }
      const kept = input.assistantMessageUuid ? messages.slice(0, targetIndex + 1) : []
      await options.host.getArtifactAdapter?.(meta)?.rewind?.({
        sessionId: input.sessionId,
        assistantMessageUuid: input.assistantMessageUuid,
        meta,
      })
      await updateJournal(journal, entry, 'persisting')
      await options.store.messages.replace(input.sessionId, kept)
      emit('persisting', kept.length, messages.length)
      await updateJournal(journal, entry, 'completed', 'committed')
      emit('completed', kept.length, messages.length)
      await journal?.remove(input.operationId)
      return { remainingMessages: kept.length }
    } catch (error) {
      await updateJournal(journal, entry, entry.phase, 'failed', error instanceof Error ? error.message : String(error))
      emit('failed', undefined, undefined, error instanceof Error ? error.message : String(error))
      throw toOperationError(error, 'rewind', input.sessionId)
    }
  }

  return { delete: runDelete, fork: runFork, rewind: runRewind }
}

function createJournalEntry(
  input: { operationId: string; sessionId: string },
  operation: SessionOperationJournal['operation'],
  sessionIds?: string[],
): SessionOperationJournal {
  const now = Date.now()
  return {
    operationId: input.operationId,
    operation,
    sessionId: input.sessionId,
    status: 'started',
    phase: 'reading',
    createdAt: now,
    updatedAt: now,
    ...(sessionIds ? { sessionIds } : {}),
  }
}

async function updateJournal(
  journal: ReturnType<typeof createSessionJournalStore> | undefined,
  entry: SessionOperationJournal,
  phase: string,
  status: SessionOperationJournal['status'] = 'started',
  error?: string,
): Promise<void> {
  if (!journal) return
  entry.phase = phase
  entry.status = status
  entry.updatedAt = Date.now()
  if (error) entry.error = error
  await journal.write(entry)
}

function progressEmitter(
  input: { operationId: string; sessionId: string; onProgress?: (progress: SessionOperationProgress) => void },
  operation: SessionOperationProgress['operation'],
): (phase: SessionOperationPhase, completed?: number, total?: number, detail?: string) => void {
  return (phase, completed, total, detail) => input.onProgress?.({
    operationId: input.operationId,
    operation,
    sessionId: input.sessionId,
    phase,
    ...(completed === undefined ? {} : { completed }),
    ...(total === undefined ? {} : { total }),
    ...(detail === undefined ? {} : { detail }),
  })
}

function toOperationError(error: unknown, operation: string, sessionId: string): SessionOperationError {
  if (error instanceof SessionOperationError) return error
  return new SessionOperationError('operation_failed', error instanceof Error ? error.message : String(error), {
    cause: error,
    operation,
    sessionId,
  })
}
