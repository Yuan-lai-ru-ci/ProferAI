import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta, SDKMessage } from '@profer/shared'
import { createSessionStorePaths, createSyncSessionIndexStore, registerOwnedSessionLayout, resolveOwnedSessionLayout, sessionMessagesPath, sessionGraphPath, sessionHarnessPath, mirrorProjectSessionIndexes } from '@profer/session-store'
import { locateClaudeNativeSession, relocateClaudeNativeSession } from '@profer/agent-provider-claude'
import { replacePiNativeTranscript } from '@profer/agent-provider-pi'
import type { CoreSessionStore } from './runtime'
import type { CoreWorkspaceStore } from './workspaces'
import type { CoreConfig } from './config'
import { resolveNativePiSessionFile } from './native-session-pi'
import { nativeSessionRevision, type NativeSessionPorts, type NativeSessionState } from './native-session-service'

export interface CoreNativeSessionStoreOptions {
  config: CoreConfig
  sessions: CoreSessionStore
  workspaces: CoreWorkspaceStore
  /** 必须覆盖运行 owner、Goal 续跑/调度、委派续跑与删除锁。 */
  busy(sessionId: string): boolean
  onChanged?(meta: AgentSessionMeta): void
}
interface CommitJournal {
  schema: 1
  before: NativeSessionState
  after: NativeSessionState
  artifacts?: Array<{ kind: 'graph' | 'harness' | 'native'; before: string; after: string; nativeSessionId?: string; runtime?: 'pi' | 'claude' }>
}

/** 与 CoreSessionStore 共用磁盘索引；同步提交期间不让出事件循环，启动恢复必须先于运行入口。 */
export function createCoreNativeSessionPorts(options: CoreNativeSessionStoreOptions): NativeSessionPorts & { recover(): void } {
  const { config, sessions, workspaces } = options
  const paths = createSessionStorePaths(config.configDir)
  const index = createSyncSessionIndexStore(() => paths.sessionsIndex)
  const journalDir = join(config.configDir, 'native-session-transactions')
  const sdkConfigDir = join(config.configDir, 'sdk-config')
  const workspace = (meta: AgentSessionMeta) => workspaces.list().find(item => item.id === meta.workspaceId)
  const register = (meta: AgentSessionMeta) => registerOwnedSessionLayout(meta, workspace(meta))
  const read = (id: string): NativeSessionState => {
    const meta = sessions.getMeta(id)
    if (!meta) throw new Error(`会话不存在: ${id}`)
    register(meta)
    return { meta: structuredClone(meta), messages: structuredClone([...sessions.readMessages(id)]) }
  }
  const cwd = (meta: AgentSessionMeta): string => {
    const owner = workspace(meta)
    resolveOwnedSessionLayout(meta, owner)
    if (owner?.storageMode === 'project') return resolve(owner.rootPath!)
    return join(config.workspaceRoot, owner?.slug ?? 'default')
  }
  const persist = (state: NativeSessionState): void => {
    register(state.meta)
    const file = sessionMessagesPath(paths, state.meta.id)
    mkdirSync(dirname(file), { recursive: true })
    replacePiNativeTranscript(file, state.messages.length ? state.messages.map(message => JSON.stringify(message)).join('\n') + '\n' : '')
    const current = index.read()
    index.write({ ...current, sessions: [...current.sessions.filter(item => item.id !== state.meta.id), state.meta] })
    // 镜像不是事务权威；失败后可由已有项目索引协调器重建。
    try { mirrorProjectSessionIndexes(index.read(), workspaces.list()) }
    catch (error) { console.error('[Core] 原生会话项目镜像保存失败：', error) }
  }
  const artifactPath = (id: string, kind: 'graph' | 'harness' | 'native', identity?: { nativeSessionId?: string; runtime?: 'pi' | 'claude' }) => {
    if (kind === 'graph') return sessionGraphPath(paths, id)
    if (kind === 'harness') return sessionHarnessPath(paths, id)
    const state = read(id)
    return (identity?.runtime ?? state.meta.agentRuntime) === 'pi' ? resolveNativePiSessionFile(config.configDir, identity?.nativeSessionId ?? state.meta.sdkSessionId ?? '') : locateClaudeNativeSession(sdkConfigDir, identity?.nativeSessionId ?? state.meta.sdkSessionId ?? '')
  }
  const persistArtifacts = (id: string, artifacts: CommitJournal['artifacts'], side: 'before' | 'after') => {
    for (const artifact of artifacts ?? []) {
      if ((artifact.kind !== 'graph' && artifact.kind !== 'harness' && artifact.kind !== 'native') || typeof artifact.before !== 'string' || typeof artifact.after !== 'string') throw new Error('原生历史附属日志损坏')
      replacePiNativeTranscript(artifactPath(id, artifact.kind, artifact), artifact[side])
    }
  }
  const recover = (): void => {
    if (!existsSync(journalDir)) return
    for (const entry of readdirSync(journalDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = join(journalDir, entry.name)
      const journal = JSON.parse(readFileSync(file, 'utf8')) as CommitJournal
      if (journal.schema !== 1 || !journal.before?.meta?.id || journal.before.meta.id !== journal.after?.meta?.id
        || entry.name !== `${journal.before.meta.id}.json` || !Array.isArray(journal.before.messages) || !Array.isArray(journal.after.messages)) throw new Error('原生会话提交日志损坏')
      const id = journal.before.meta.id
      if (options.busy(id)) throw new Error('会话占用中，禁止恢复原生提交')
        try {
          const current = read(id)
          // 崩溃可发生在消息替换与索引替换之间，只允许四种已记录的组合。
          if (![journal.before.meta, journal.after.meta].some(meta => JSON.stringify(meta) === JSON.stringify(current.meta))
            || ![journal.before.messages, journal.after.messages].some(messages => JSON.stringify(messages) === JSON.stringify(current.messages))) throw new Error('原生会话恢复冲突，拒绝覆盖外部写入')
          for (const artifact of journal.artifacts ?? []) {
            const currentArtifact = readFileSync(artifactPath(id, artifact.kind, artifact), 'utf8')
            if (currentArtifact !== artifact.before && currentArtifact !== artifact.after) throw new Error('Graph/Harness 恢复冲突，拒绝覆盖外部写入')
          }
          persist(journal.after)
          persistArtifacts(id, journal.artifacts, 'after')
        } catch (error) {
          if (!sessions.getMeta(id)) {
            registerOwnedSessionLayout(journal.after.meta, workspace(journal.after.meta))
            persist(journal.after)
            persistArtifacts(id, journal.artifacts, 'after')
          } else throw error
        }
      unlinkSync(file)
    }
  }
  const commit: NativeSessionPorts['commit'] = (id, expectedRevision, messages, patch, replacements) => {
    if (options.busy(id)) throw new Error('会话占用中，禁止提交原生历史')
    const before = read(id)
    if (nativeSessionRevision(before) !== expectedRevision) throw new Error('REVISION_CONFLICT: 会话历史已变化')
    const after: NativeSessionState = { messages: structuredClone(messages), meta: { ...before.meta, ...patch, id,
      revision: (before.meta.revision ?? 0) + 1, updatedAt: Date.now() } }
    const artifacts: NonNullable<CommitJournal['artifacts']> = []
    for (const kind of ['graph', 'harness', 'native'] as const) {
      const replacement = replacements?.[kind]
      if (replacement === undefined) continue
      const identity = kind === 'native' ? { nativeSessionId: after.meta.sdkSessionId ?? before.meta.sdkSessionId, runtime: after.meta.agentRuntime } : {}
      const path = artifactPath(id, kind, identity)
      if (!existsSync(path)) throw new Error('恢复目标附属文件不存在')
      artifacts.push({ kind, before: readFileSync(path, 'utf8'), after: replacement, ...identity })
    }
    if (messages.length < before.messages.length) {
      const timestamp = (messages.at(-1) as { _createdAt?: number } | undefined)?._createdAt
      for (const kind of ['graph', 'harness'] as const) {
        if (replacements?.[kind] !== undefined) continue
        const artifactFile = artifactPath(id, kind)
        if (!existsSync(artifactFile)) continue
        if (messages.length > 0 && (typeof timestamp !== 'number' || !Number.isFinite(timestamp))) throw new Error('回退锚点没有有效时间戳，无法安全截断 Graph/Harness')
        const original = readFileSync(artifactFile, 'utf8')
        const events = original.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { timestamp?: number })
        if (events.some(event => typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp))) throw new Error('Graph/Harness 事件缺少有效时间戳，无法安全回退')
        const retained = messages.length === 0 ? [] : events.filter(event => event.timestamp! <= timestamp!)
        artifacts.push({ kind, before: original, after: retained.map(event => JSON.stringify(event)).join('\n') + (retained.length ? '\n' : '') })
      }
    }
    mkdirSync(journalDir, { recursive: true })
    const file = join(journalDir, `${id}.json`)
    if (existsSync(file)) throw new Error('存在未恢复的原生提交事务')
    replacePiNativeTranscript(file, JSON.stringify({ schema: 1, before, after, artifacts } satisfies CommitJournal))
    try { persist(after); persistArtifacts(id, artifacts, 'after') }
    catch (error) {
      // 同步失败回滚两份权威文件；进程崩溃则由日志 redo。回滚失败保留日志并阻止后续写入。
      try { persist(before); persistArtifacts(id, artifacts, 'before'); unlinkSync(file) }
      catch { throw new Error('NATIVE_COMMIT_RECOVERY_REQUIRED: 提交与回滚失败，必须先恢复事务', { cause: error }) }
      throw error
    }
    unlinkSync(file)
    options.onChanged?.(after.meta)
  }
  const createFork: NativeSessionPorts['createFork'] = (source, messages, patch) => {
    if (options.busy(source.id)) throw new Error('源会话占用中，禁止分叉')
    const current = read(source.id)
    if (nativeSessionRevision(current) !== nativeSessionRevision({ meta: source, messages: current.messages })) throw new Error('REVISION_CONFLICT: 分叉源已变化')
    const now = Date.now()
    // 白名单继承配置，不继承 Goal/委派/自动化/运行态归属。
    const meta: AgentSessionMeta = {
      id: randomUUID(), title: `${source.title} (fork)`, createdAt: now, updatedAt: now, revision: 1,
      workspaceId: source.workspaceId, storageLayout: source.storageLayout,
      agentRuntime: source.agentRuntime, agentRuntimeLocked: true,
      channelId: source.channelId, modelId: source.modelId, presetId: source.presetId, presetReference: source.presetReference,
      permissionMode: source.permissionMode, agentCwdMode: source.agentCwdMode, sessionWorkbenchLayout: source.sessionWorkbenchLayout,
      attachedDirectories: source.attachedDirectories, attachedFiles: source.attachedFiles,
      agentEffort: source.agentEffort, openAIThinkingLevel: source.openAIThinkingLevel, codexFastMode: source.codexFastMode,
      sdkSessionId: patch.sdkSessionId, piSessionFile: patch.piSessionFile, piEntryBindings: patch.piEntryBindings,
      forkSourceSdkSessionId: source.sdkSessionId,
    }
    register(meta)
    const generated: string[] = []
    try {
      const destinationCwd = cwd(meta)
  const nativeFile = meta.agentRuntime === 'pi' && meta.sdkSessionId
        ? resolveNativePiSessionFile(config.configDir, meta.sdkSessionId)
        : undefined
      if (meta.agentRuntime === 'pi' && nativeFile) {
        // SDK 已创建独立 artifact；只更新该副本 header 的 cwd，不修改历史工具参数。
        const lines = readFileSync(nativeFile, 'utf8').split('\n')
        const header = JSON.parse(lines[0]!) as Record<string, unknown>
        lines[0] = JSON.stringify({ ...header, cwd: destinationCwd })
        replacePiNativeTranscript(nativeFile, lines.join('\n'))
      meta.piSessionFile = nativeFile
      } else if (meta.sdkSessionId) {
        relocateClaudeNativeSession({ sdkConfigDir, sessionId: meta.sdkSessionId, sourceCwd: cwd(source), destinationCwd })
      }
      // 检查点归新会话所有；只接管已保留 entry 的引用，不保留源会话路径。
      if (source.piFileCheckpoints && meta.piEntryBindings) {
        const kept = new Set(Object.values(meta.piEntryBindings))
        meta.piFileCheckpoints = {}
        for (const [entry, file] of Object.entries(source.piFileCheckpoints)) {
          if (!kept.has(entry)) continue
          const target = join(paths.checkpointsDir, meta.id, `${entry}-${basename(file)}`)
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(file, target)
          generated.push(target)
          meta.piFileCheckpoints[entry] = target
        }
      }
      const anchor = messages.at(-1) as { _createdAt?: number } | undefined
      const timestamp = anchor?._createdAt
      for (const path of [sessionGraphPath, sessionHarnessPath]) {
        register(source)
        const original = path(paths, source.id)
        register(meta)
        const target = path(paths, meta.id)
        if (!existsSync(original)) continue
        if (typeof timestamp !== 'number') throw new Error('分叉锚点没有时间戳，无法安全截断 Graph/Harness')
        const events = readFileSync(original, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { timestamp?: number })
          .filter(event => typeof event.timestamp === 'number' && event.timestamp <= timestamp)
        mkdirSync(dirname(target), { recursive: true })
        replacePiNativeTranscript(target, events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''))
        generated.push(target)
      }
      persist({ meta, messages: structuredClone(messages) })
    } catch (error) {
      // 仅清理本次新建记录与文件；原生 SDK artifact 保留，避免误删已有上下文。
      index.write({ ...index.read(), sessions: index.read().sessions.filter(item => item.id !== meta.id) })
      generated.push(sessionMessagesPath(paths, meta.id))
      for (const file of generated) if (existsSync(file)) unlinkSync(file)
      throw error
    }
    options.onChanged?.(meta)
    return meta
  }
  return { read, busy: options.busy, commit, createFork, recover, sdkConfigDir,
    projectMode: meta => workspace(meta)?.storageMode === 'project',
    locate: meta => { register(meta); return { cwd: cwd(meta), sessionDir: join(config.configDir, 'pi-sessions'),
      file: meta.agentRuntime === 'pi' ? resolveNativePiSessionFile(config.configDir, meta.sdkSessionId ?? '')
        : locateClaudeNativeSession(sdkConfigDir, meta.sdkSessionId ?? '') } },
  }
}
