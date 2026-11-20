import type { AgentSessionMeta, SDKMessage } from '@profer/shared'
import type { NativeSessionArtifactAdapter } from '@profer/session-store'
import { forkClaudeNativeSession, validateClaudeNativeAnchor, restoreClaudeNativeFiles } from '@profer/agent-provider-claude'
import { forkPiNativeSession, preparePiNativeRewind, replacePiNativeTranscript, loadPiFileCheckpoint, restorePiFileCheckpoint } from '@profer/agent-provider-pi'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildAgentSessionUiProjection } from '@profer/shared'
import { findNativePiRewindJournal } from './native-session-pi'

export interface NativeSessionState { meta: AgentSessionMeta; messages: SDKMessage[] }
export interface NativeSessionLocation { file: string; cwd: string; sessionDir: string }
export interface NativeSessionPorts {
  projectMode(meta: AgentSessionMeta): boolean
  sdkConfigDir?: string
  read(id: string): NativeSessionState
  /** 必须同时检查运行 owner、Goal、删除锁；true 表示任何一种占用。 */
  busy(id: string): boolean
  /** 与 coordinator 共享每会话准入锁；返回释放函数。 */
  acquireOperation?(id: string): () => void
  locate(meta: AgentSessionMeta): NativeSessionLocation
  /** 宿主已有持久化事务：检查 revision 后更新消息和 metadata。不能先广播。 */
  commit(id: string, expectedRevision: string, messages: SDKMessage[], patch: Partial<AgentSessionMeta>, artifacts?: Partial<Record<'graph' | 'harness' | 'native', string>>): void
  /** 预留目标会话 ID/目录后由宿主完成原生 cwd 重定位、Graph/Harness 截断及文件检查点引用接管；失败必须回滚新记录。 */
  createFork(source: AgentSessionMeta, messages: SDKMessage[], patch: Partial<AgentSessionMeta>): AgentSessionMeta
}
function uuid(message: SDKMessage): string | undefined { return (message as { uuid?: string }).uuid }
export function nativeSessionRevision(state: NativeSessionState): string {
  return createHash('sha256').update(JSON.stringify([state.meta, state.messages])).digest('hex')
}
/** Core 权威消息快照：内容修订号覆盖 metadata 与消息，不能只凭 message count 去重。 */
export function nativeSessionSnapshot(state: NativeSessionState, since?: string) {
  const revision = nativeSessionRevision(state)
  return { sessionId: state.meta.id, revision, metadataRevision: state.meta.revision ?? 0,
    unchanged: revision === since, ...(revision === since ? {} : { meta: buildAgentSessionUiProjection(state.meta), messages: structuredClone(state.messages) }) }
}

/** 每会话串行，运行中禁止 fork/rewind；最终提交仍由宿主 CAS 防止外部写者覆盖。 */
export class CoreNativeSessionService {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(private readonly ports: NativeSessionPorts) {}
  /** 启动时在允许运行前调用；未提交的回退还原原生文件，已提交的回退保留新文件。 */
  recoverPi(id: string, configDir?: string): void {
    if (this.ports.busy(id)) throw new Error('运行中禁止恢复原生事务')
    const state = this.ports.read(id)
    const journalFile = configDir && state.meta.sdkSessionId
      ? findNativePiRewindJournal(configDir, state.meta.sdkSessionId)
      : undefined
    if (!journalFile) return
    const release = this.ports.acquireOperation?.(id)
    try {
      const location = this.ports.locate(state.meta)
      if (journalFile !== `${location.file}.profer-rewind.json`) throw new Error('Pi 原生回退事务路径与会话不匹配')
      const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
        schema?: number; sessionId?: string; expected?: string; original?: string; replacement?: string;
        messages?: SDKMessage[]; patch?: Partial<AgentSessionMeta>
      }
      if (journal.schema !== 1 || journal.sessionId !== id || typeof journal.expected !== 'string'
        || typeof journal.original !== 'string' || typeof journal.replacement !== 'string' || !Array.isArray(journal.messages) || !journal.patch) throw new Error('原生回退事务损坏，禁止继续运行')
      const currentFile = readFileSync(location.file, 'utf8')
      if (currentFile !== journal.original && currentFile !== journal.replacement) throw new Error('原生回退文件被外部修改，禁止自动覆盖')
      if (nativeSessionRevision(state) === journal.expected) replacePiNativeTranscript(location.file, journal.original)
      else {
        const projected = { ...state.meta, ...journal.patch }
        if (JSON.stringify(state.messages) !== JSON.stringify(journal.messages)
          || Object.entries(journal.patch).some(([key, value]) => JSON.stringify(projected[key as keyof AgentSessionMeta]) !== JSON.stringify(state.meta[key as keyof AgentSessionMeta]))) throw new Error('原生回退事务归属冲突，禁止继续运行')
        replacePiNativeTranscript(location.file, journal.replacement)
      }
      unlinkSync(journalFile)
    } finally { release?.() }
  }
  snapshot(id: string, since?: string) { return nativeSessionSnapshot(this.ports.read(id), since) }
  private execute<T>(id: string, revision: string, action: (state: NativeSessionState) => Promise<T>): Promise<T> {
    // 回退前所有写入必须在同一个 Core 命令锁内；pending 仅协调本服务调用，busy/CAS 仍由宿主管理。
    const prior = this.pending.get(id) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(async () => {
      if (this.ports.busy(id)) throw new Error('会话正在执行、续跑或删除，不能修改原生历史')
      const state = this.ports.read(id)
      if (nativeSessionRevision(state) !== revision) throw new Error('REVISION_CONFLICT: 会话历史已变化')
      const release = this.ports.acquireOperation?.(id)
      try {
        if (this.ports.busy(id)) throw new Error('会话正在执行、续跑或删除，不能修改原生历史')
        if (nativeSessionRevision(this.ports.read(id)) !== revision) throw new Error('REVISION_CONFLICT: 会话历史已变化')
        return await action(state)
      } finally { release?.() }
    })
    this.pending.set(id, next)
    void next.finally(() => { if (this.pending.get(id) === next) this.pending.delete(id) }).catch(() => {})
    return next
  }
  private anchor(state: NativeSessionState, target: string) {
    const index = state.messages.findIndex(message => uuid(message) === target)
    if (index < 0) throw new Error('未找到目标消息')
    for (let cursor = index; cursor >= 0; cursor--) {
      const messageId = uuid(state.messages[cursor]!)
      const entryId = messageId && state.meta.piEntryBindings?.[messageId]
      if (entryId) return { entryId, messages: state.messages.slice(0, cursor + 1) }
    }
    throw new Error('Pi 历史消息没有可用的 entry 映射，不能安全修改')
  }
  /** 复用 session-store 已有原生操作契约；宿主操作服务可直接注入。 */
  artifactAdapter(runtime: 'pi' | 'claude'): NativeSessionArtifactAdapter {
    return {
      runtime,
      fork: async input => {
        if (!input.upToMessageUuid) throw new Error('原生分叉必须提供消息锚点')
        const location = this.ports.locate(input.sourceMeta)
        if (runtime === 'pi') {
          const anchor = this.anchor(this.ports.read(input.sessionId), input.upToMessageUuid)
          const destination = this.ports.locate(input.destinationMeta)
          const artifact = await forkPiNativeSession({ ...location, entryId: anchor.entryId, destinationDir: destination.cwd })
          return { nativeSessionId: artifact.sessionId, nativeSessionFile: artifact.file }
        }
        if (!this.ports.sdkConfigDir || !input.sourceMeta.sdkSessionId) throw new Error('Claude 原生会话缺失')
        const artifact = await forkClaudeNativeSession({ sdkConfigDir: this.ports.sdkConfigDir,
          sessionId: input.sourceMeta.sdkSessionId, messageId: input.upToMessageUuid, cwd: location.cwd })
        return { nativeSessionId: artifact.sessionId, nativeSessionFile: artifact.file }
      },
    }
  }
  forkClaude(id: string, target: string, revision: string) {
    return this.execute(id, revision, async state => {
      if ((state.meta.agentRuntime ?? 'claude') !== 'claude' || !state.meta.sdkSessionId || !this.ports.sdkConfigDir) throw new Error('Claude 原生会话或 SDK 根目录缺失')
      const index = state.messages.findIndex(message => uuid(message) === target)
      if (index < 0) throw new Error('未找到分叉目标消息')
      const location = this.ports.locate(state.meta)
      const artifact = await forkClaudeNativeSession({ sdkConfigDir: this.ports.sdkConfigDir, sessionId: state.meta.sdkSessionId, messageId: target, cwd: location.cwd })
      if (this.ports.busy(id) || nativeSessionRevision(this.ports.read(id)) !== revision) throw new Error('REVISION_CONFLICT: 分叉期间源会话已变化')
      return this.ports.createFork(state.meta, state.messages.slice(0, index + 1), {
        sdkSessionId: artifact.sessionId, forkSourceSdkSessionId: state.meta.sdkSessionId,
        resumeAtMessageUuid: undefined, parentSessionId: undefined,
      })
    })
  }
  rewindClaude(id: string, target: string, revision: string) {
    return this.execute(id, revision, async state => {
      if ((state.meta.agentRuntime ?? 'claude') !== 'claude' || !state.meta.sdkSessionId) throw new Error('Claude 原生会话缺失')
      const index = state.messages.findIndex(message => uuid(message) === target)
      if (index < 0) throw new Error('未找到回退目标消息')
      if (!this.ports.sdkConfigDir) throw new Error('Claude SDK 根目录缺失')
      validateClaudeNativeAnchor(this.ports.sdkConfigDir, state.meta.sdkSessionId, target)
      const location = this.ports.locate(state.meta)
      const fileRewind = this.ports.projectMode(state.meta)
        ? { canRewind: false, error: '项目模式下文件回退由 git 负责，本次仅回退对话' }
        : restoreClaudeNativeFiles({ sdkConfigDir: this.ports.sdkConfigDir, sessionId: state.meta.sdkSessionId, messageId: target, cwd: location.cwd })
      // 与桌面 Claude 对话回退一致，由下一轮 SDK resumeSessionAt 消费锚点。
      this.ports.commit(id, revision, state.messages.slice(0, index + 1), { resumeAtMessageUuid: target })
      return { ...this.snapshot(id), fileRewind }
    })
  }
  forkPi(id: string, target: string, revision: string, destinationDir: string) {
    return this.execute(id, revision, async state => {
      if (state.meta.agentRuntime !== 'pi') throw new Error('会话不是 Pi runtime')
      const anchor = this.anchor(state, target), location = this.ports.locate(state.meta)
      const artifact = await forkPiNativeSession({ ...location, destinationDir, entryId: anchor.entryId })
      // 分叉完成后再核对权威历史，失败不能把陈旧前缀发布为新会话。
      if (this.ports.busy(id) || nativeSessionRevision(this.ports.read(id)) !== revision) throw new Error('REVISION_CONFLICT: 分叉期间源会话已变化；原生分叉文件保留待恢复')
      const messageIds = new Set(anchor.messages.map(uuid).filter((value): value is string => Boolean(value)))
      return this.ports.createFork(state.meta, anchor.messages, { sdkSessionId: artifact.sessionId, piSessionFile: artifact.file,
        piEntryBindings: Object.fromEntries(Object.entries(state.meta.piEntryBindings ?? {}).filter(([message]) => messageIds.has(message))),
        resumeAtMessageUuid: undefined, parentSessionId: undefined, forkSourceSdkSessionId: state.meta.sdkSessionId })
    })
  }
  rewindPi(id: string, target: string, revision: string) {
    return this.execute(id, revision, async state => {
      if (state.meta.agentRuntime !== 'pi') throw new Error('会话不是 Pi runtime')
      const anchor = this.anchor(state, target), location = this.ports.locate(state.meta)
      const prepared = await preparePiNativeRewind({ ...location, entryId: anchor.entryId })
      if (this.ports.busy(id) || nativeSessionRevision(this.ports.read(id)) !== revision) throw new Error('REVISION_CONFLICT: 回退期间会话已变化')
      let fileRewind: { canRewind: boolean; error?: string; filesChanged?: string[] } = { canRewind: false, error: '该 turn 没有文件检查点' }
      const checkpoint = state.meta.piFileCheckpoints?.[anchor.entryId]
      if (this.ports.projectMode(state.meta)) fileRewind = { canRewind: false, error: '项目模式下文件回退由 git 负责，本次仅回退对话' }
      else if (checkpoint) {
        const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint), location.cwd)
        if (restored.failed) throw new Error('文件检查点无法安全恢复，已取消对话回退')
        fileRewind = { canRewind: true, filesChanged: restored.changed }
      }
      const retained = new Set(prepared.entryIds)
      const patch: Partial<AgentSessionMeta> = {
        piEntryBindings: Object.fromEntries(Object.entries(state.meta.piEntryBindings ?? {}).filter(([, entry]) => retained.has(entry))),
        piFileCheckpoints: Object.fromEntries(Object.entries(state.meta.piFileCheckpoints ?? {}).filter(([entry]) => retained.has(entry))),
        resumeAtMessageUuid: undefined,
      }
      // 原生 transcript 先原子替换；宿主 commit 必须提供恢复事务，失败不能广播成功。
      const original = readFileSync(location.file, 'utf8')
      const journalFile = `${location.file}.profer-rewind.json`
      if (existsSync(journalFile)) throw new Error('存在未恢复的原生回退事务')
      replacePiNativeTranscript(journalFile, JSON.stringify({ schema: 1, sessionId: id, expected: revision,
        original, replacement: prepared.content, messages: anchor.messages, patch }))
      replacePiNativeTranscript(location.file, prepared.content)
      try { this.ports.commit(id, revision, anchor.messages, patch) }
      catch (error) {
        // 宿主提交与回滚均失败时，保留原生事务，由启动时先 redo 宿主提交、再协调 transcript。
        if (error instanceof Error && error.message.startsWith('NATIVE_COMMIT_RECOVERY_REQUIRED:')) throw error
        replacePiNativeTranscript(location.file, original)
        unlinkSync(journalFile)
        throw error
      }
      unlinkSync(journalFile)
      return { ...this.snapshot(id), fileRewind }
    })
  }
}
