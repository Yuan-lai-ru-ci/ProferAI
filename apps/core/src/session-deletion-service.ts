import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync, realpathSync, readdirSync, openSync, readSync, closeSync, fsyncSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta, AgentSessionDeletionStatusPayload } from '@profer/shared'
import { AgentSessionDeletionCoordinator } from '@profer/agent-runtime'
import { createSessionStorePaths, resolveOwnedSessionLayout, createSessionJournalStore } from '@profer/session-store'
import type { CoreConfig } from './config'
import type { CoreAgentRuntime } from './runtime'

export interface CoreDeletionRecord {
  id: string
  sessionId: string
  sessions: AgentSessionMeta[]
  status: 'pending' | 'completed' | 'failed'
  revision: number
  requestedAt: number
  error?: string
  /** 所有运行已停止、清理即将开始；一旦持久化就永久拒绝晚到写入。 */
  cleanupStarted?: boolean
  sourceRequestId?: string
  sourceFingerprint?: string
  sourceRequestedAt?: number
  sourceReason?: 'user' | 'workspace' | 'resume'
}

/** 删除意图和墓碑先落盘；项目旧副本/索引备份不能复活已删除会话。 */
export class CoreSessionDeletionService {
  private runtime?: CoreAgentRuntime
  private readonly records: CoreDeletionRecord[]
  private readonly coordinator = new AgentSessionDeletionCoordinator()
  private running?: Promise<void>
  private closed = false
  private readonly path: string
  constructor(private readonly config: CoreConfig) {
    this.path = join(config.configDir, 'core-session-deletions.json')
    if (!existsSync(this.path)) { this.records = []; return }
    const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('records' in value) || !Array.isArray(value.records)) throw new Error('Core删除记录损坏，拒绝继续以免会话复活')
    this.records = value.records as CoreDeletionRecord[]
    const ids = new Set<string>()
    const sourceIds = new Set<string>()
    for (const record of this.records) {
      if (!record || typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(record.id) || ids.has(record.id)
        || !validId(record.sessionId) || !Array.isArray(record.sessions) || !record.sessions.length
        || record.sessions.some(meta => !meta || !validId(meta.id)) || !record.sessions.some(meta => meta.id === record.sessionId)
        || !['pending', 'completed', 'failed'].includes(record.status) || !Number.isFinite(record.revision) || !Number.isFinite(record.requestedAt)
        || (record.sourceRequestId !== undefined && (typeof record.sourceRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(record.sourceRequestId)))
        || (record.cleanupStarted !== undefined && typeof record.cleanupStarted !== 'boolean')
        || (record.sourceRequestedAt !== undefined && (!Number.isFinite(record.sourceRequestedAt) || record.sourceRequestedAt < 0))
        || (record.sourceReason !== undefined && !['user', 'workspace', 'resume'].includes(record.sourceReason))
        || (record.sourceFingerprint !== undefined && typeof record.sourceFingerprint !== 'string')) throw new Error('Core删除记录条目无效')
      if (record.sourceRequestId) {
        if (sourceIds.has(record.sourceRequestId) || !record.sourceFingerprint) throw new Error('历史删除请求身份重复或缺少参数指纹')
        sourceIds.add(record.sourceRequestId)
      }
      ids.add(record.id)
    }
  }
  excludedIds(workspaceId?: string): Set<string> {
    return new Set(this.records.flatMap(record => record.sessions
      .filter(meta => workspaceId === undefined || meta.workspaceId === workspaceId).map(meta => meta.id)))
  }
  isDeleting(id: string): boolean { return this.records.some(record => record.sessions.some(meta => meta.id === id)) }
  isCompleted(id: string): boolean { return this.records.some(record => record.status === 'completed' && record.sessions.some(meta => meta.id === id)) }
  isWriteBlocked(id: string): boolean {
    return this.records.some(record => (record.cleanupStarted || record.status === 'completed') && record.sessions.some(meta => meta.id === id))
  }
  snapshot(): CoreDeletionRecord[] { return structuredClone(this.records) }
  statusSnapshots(): AgentSessionDeletionStatusPayload[] {
    return this.records.map(record => ({ kind: 'session_deletion', requestId: record.id, sessionId: record.sessionId,
      title: record.sessions.find(meta => meta.id === record.sessionId)?.title ?? '会话', status: record.status,
      revision: record.revision, ...(record.error ? { error: record.error } : {}) }))
  }
  private persist(next: CoreDeletionRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ version: 1, records: next }, null, 2)); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temp, this.path)
    this.records.splice(0, this.records.length, ...next)
  }
  bindRuntime(runtime: CoreAgentRuntime): void {
    this.runtime = runtime
    void this.drain().catch(error => console.error('[Core] 删除恢复失败：', error))
  }
  private commitSnapshot(sessionId: string, order: AgentSessionMeta[], sourceRequestId?: string, sourceFingerprint?: string, source?: { requestedAt?: number; reason?: 'user' | 'workspace' | 'resume' }, requestId: string = randomUUID()): { requestId: string; sessionIds: string[] } {
    const record: CoreDeletionRecord = { id: requestId, sessionId, sessions: order.map(meta => structuredClone(meta)), status: 'pending', requestedAt: Date.now(),
      revision: Math.max(Date.now(), ...order.map(meta => (meta.revision ?? 0) + 1)), ...(sourceRequestId ? { sourceRequestId } : {}), ...(sourceFingerprint ? { sourceFingerprint } : {}),
      ...(source?.requestedAt !== undefined ? { sourceRequestedAt: source.requestedAt } : {}), ...(source?.reason ? { sourceReason: source.reason } : {}) }
    this.persist([...this.records, record])
    this.publish(record)
    void this.drain().catch(error => console.error('[Core] 删除事务失败：', error))
    return { requestId: record.id, sessionIds: record.sessions.map(meta => meta.id) }
  }

  importLegacyRequest(input: { sourceRequestId: string; sessionId: string; sessionIds: string[]; workspaceId?: string; requestedAt?: number; reason?: 'user' | 'workspace' | 'resume' }): { requestId: string; sessionIds: string[] } {
    if (!this.config.desktopWorkspaceIndexPath || !['127.0.0.1', 'localhost', '::1'].includes(this.config.host)) throw new Error('仅桌面自有的本地Core可接管历史删除队列')
    if (!this.runtime || this.closed) throw new Error('Core删除服务未就绪')
    const sourceRequestId = input.sourceRequestId
    if (input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || !input.workspaceId)) throw new Error('历史删除工作区无效')
    if (input.requestedAt !== undefined && (!Number.isFinite(input.requestedAt) || input.requestedAt < 0)) throw new Error('历史删除时间无效')
    if (input.reason !== undefined && !['user', 'workspace', 'resume'].includes(input.reason)) throw new Error('历史删除原因无效')
    if (typeof sourceRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(sourceRequestId)) throw new Error('历史删除请求ID无效')
    const sourceFingerprint = deletionFingerprint(input)
    const existing = this.records.find(record => record.sourceRequestId === sourceRequestId)
    if (existing) {
      if (existing.sourceFingerprint !== sourceFingerprint) throw new Error('历史删除请求ID参数冲突；原队列保持未交接')
      return { requestId: existing.id, sessionIds: existing.sessions.map(meta => meta.id) }
    }
    if (!validId(input.sessionId) || !Array.isArray(input.sessionIds) || !input.sessionIds.length || input.sessionIds.length > 1000
      || input.sessionIds.some(id => !validId(id)) || new Set(input.sessionIds).size !== input.sessionIds.length
      || !input.sessionIds.includes(input.sessionId)) throw new Error('历史删除会话快照无效；原队列保持未交接')
    const current = this.runtime.sessions.list(true)
    const snapshots: AgentSessionMeta[] = []
    for (const id of input.sessionIds) {
      const meta = current.find(item => item.id === id)
      if (!meta) throw new Error(`历史删除会话缺少Core元数据，保留旧请求待人工处理: ${id}`)
      if ((meta.workspaceId ?? undefined) !== input.workspaceId) throw new Error(`历史删除会话工作区冲突，保留旧请求: ${id}`)
      if (this.isDeleting(id)) throw new Error(`会话已有其他Core删除事务，保留旧请求: ${id}`)
      snapshots.push(meta)
    }
    if (snapshots.find(meta => meta.id === input.sessionId)?.workspaceId !== input.workspaceId) throw new Error('历史删除根会话工作区不匹配')
    // 完全使用旧请求提供的有序sessionIds，不调用当前树的getDeletionOrder。
    return this.commitSnapshot(input.sessionId, snapshots, sourceRequestId, sourceFingerprint, input)
  }

  retry(requestId: string): boolean {
    const record = this.records.find(item => item.id === requestId || item.sourceRequestId === requestId)
    if (!record) return false
    if (record.status === 'pending') { void this.drain().catch(error => console.error('[Core] 删除恢复失败：', error)); return true }
    if (record.status !== 'failed') return false
    const next = structuredClone(this.records)
    const selected = next.find(item => item.id === record.id)!
    selected.status = 'pending'
    selected.error = undefined
    selected.revision += 1
    this.persist(next)
    this.publish(selected)
    void this.drain().catch(error => console.error('[Core] 删除重试失败：', error))
    return true
  }

  requestSnapshot(sessionId: string, sessionIds: string[], requestId: string = randomUUID()): { requestId: string; sessionIds: string[] } {
    if (this.closed || !this.runtime) throw new Error('Core删除服务未就绪')
    if (!validId(sessionId) || !/^[a-zA-Z0-9_-]{1,160}$/.test(requestId)
      || !Array.isArray(sessionIds) || !sessionIds.length || sessionIds.some(id => !validId(id))
      || new Set(sessionIds).size !== sessionIds.length || !sessionIds.includes(sessionId)) throw new Error('会话删除快照无效')
    const existing = this.records.find(record => record.id === requestId)
    if (existing) {
      if (existing.sessionId !== sessionId || JSON.stringify(existing.sessions.map(meta => meta.id)) !== JSON.stringify(sessionIds)) throw new Error('会话删除requestId范围冲突')
      return { requestId, sessionIds: existing.sessions.map(meta => meta.id) }
    }
    const metas = this.runtime.sessions.list(true)
    const snapshots = sessionIds.map(id => {
      const meta = metas.find(item => item.id === id)
      if (!meta) throw new Error(`会话删除快照缺少会话: ${id}`)
      if (this.isDeleting(id)) throw new Error(`会话已有其他删除事务: ${id}`)
      return structuredClone(meta)
    })
    const selected = new Set(sessionIds)
    for (const meta of metas) {
      if (meta.parentSessionId && selected.has(meta.parentSessionId) && meta.sourceDelegationId && meta.delegationRelation !== 'independent' && !selected.has(meta.id)) throw new Error(`会话删除快照遗漏从属子会话: ${meta.id}`)
    }
    if (snapshots.some(meta => meta.workspaceId !== snapshots.find(item => item.id === sessionId)?.workspaceId)) throw new Error('会话删除快照跨越工作区')
    return this.commitSnapshot(sessionId, snapshots, undefined, undefined, undefined, requestId)
  }
  request(sessionId: string): { requestId: string; sessionIds: string[] } {
    if (this.closed || !this.runtime) throw new Error('Core删除服务未就绪')
    const prior = this.records.find(record => record.sessions.some(meta => meta.id === sessionId))
    if (prior) {
      if (prior.status === 'failed') this.retry(prior.id)
      return { requestId: prior.id, sessionIds: prior.sessions.map(meta => meta.id) }
    }
    const metas = this.runtime.sessions.list(true)
    const parent = metas.find(meta => meta.id === sessionId)
    if (!parent) throw new Error('Agent 会话不存在')
    const order: AgentSessionMeta[] = [], seen = new Set<string>()
    const visit = (meta: AgentSessionMeta) => {
      if (seen.has(meta.id)) return
      seen.add(meta.id)
      for (const child of metas.filter(item => item.parentSessionId === meta.id && item.sourceDelegationId && item.delegationRelation !== 'independent')) visit(child)
      order.push(structuredClone(meta))
    }
    visit(parent)
    // 有交叉删除事务时先等它完成，不能假装已接受整棵树。
    if (order.some(meta => this.isDeleting(meta.id))) throw new Error('关联子会话已有删除事务，请完成后重试')
    return this.commitSnapshot(sessionId, order)
  }
  private publish(record: CoreDeletionRecord): void {
    const payloads: Array<{ sessionId: string; payload: unknown }> = record.sessions.map(meta => ({ sessionId: meta.id,
      payload: { kind: 'session_projection', operation: 'delete', sessionId: meta.id, revision: record.revision } }))
    payloads.push({ sessionId: record.sessionId, payload: this.statusSnapshots().find(item => item.requestId === record.id)! })
    for (const frame of payloads) {
      try { this.runtime?.publish({ type: 'runtime', ...frame }) }
      catch (error) { console.error('[Core] 删除状态投影失败，已保存的事务仍继续，可重连恢复：', error) }
    }
  }
  drain(): Promise<void> {
    if (this.running) return this.running.then(() => {
      // 新意图可能在上一轮退出循环/清理journal的间隙提交；不能只等旧Promise。
      if (!this.closed && this.records.some(item => item.status === 'pending')) return this.drain()
    })
    const work = Promise.resolve().then(() => this.drainInternal())
    this.running = work
    void work.finally(() => { if (this.running === work) this.running = undefined }).catch(() => {})
    return work
  }
  private async drainInternal(): Promise<void> {
    if (!this.runtime || this.closed) return
    const runtime = this.runtime
    const journal = createSessionJournalStore(join(this.config.configDir, 'core-session-operation-journal'))
    for (;;) {
      const record = this.records.find(item => item.status === 'pending')
      if (!record || this.closed) break
      try {
        // 所有路径和共享资源引用先校验，停止失败时绝不进入清理阶段。
        for (const snapshot of record.sessions) {
          const current = runtime.sessions.getMeta(snapshot.id)
          if (current && current.workspaceId !== snapshot.workspaceId) throw new Error('会话已迁出删除事务的原工作区，拒绝清理')
        }
        let plans = record.sessions.map(meta => this.cleanupPlan(meta))
        for (const meta of runtime.sessions.list(true)) {
          if (record.sessions.some(item => item.id === meta.id)) continue
          if ((meta.sdkSessionId || meta.forkSourceSdkSessionId) && record.sessions.some(item => item.sdkSessionId && (item.sdkSessionId === meta.sdkSessionId || item.sdkSessionId === meta.forkSourceSdkSessionId))) throw new Error('原生会话仍被另一会话使用，拒绝删除')
          const ownedCheckpoints = record.sessions.flatMap(item => Object.values(item.piFileCheckpoints ?? {}))
          if (Object.values(meta.piFileCheckpoints ?? {}).some(path => ownedCheckpoints.includes(path))) throw new Error('检查点仍被其他会话引用，拒绝删除')
        }
        await journal.write({ operationId: record.id, operation: 'delete', sessionId: record.sessionId, sessionIds: record.sessions.map(meta => meta.id), status: 'started', phase: 'stopping', createdAt: record.requestedAt, updatedAt: Date.now() })
        let refreshed = false
        await this.coordinator.delete(record.sessionId, {
          getDeletionOrder: () => record.sessions.map(meta => meta.id), beginDeletion() {}, endDeletion() {},
          stopAndWait: async id => {
            const expected = record.sessions.find(meta => meta.id === id)!
            const current = runtime.sessions.getMeta(id)
            if (current && current.workspaceId !== expected.workspaceId) throw new Error('停止前会话工作区归属变化，拒绝清理')
            for (const goal of runtime.goals.list(id)) { await runtime.goals.stop(goal.id); runtime.goals.clear(goal.id) }
            if (runtime.sessions.getMeta(id) && !this.isWriteBlocked(id)) {
              if (record.sourceRequestId) runtime.sessions.updateMeta(id, { stoppedByUser: true })
              else await runtime.stopDelegationsForParent(id)
            }
            await runtime.coordinator.stopAndWait(id, 'session_deleted')
            if (runtime.coordinator.ownership.getOwner(id)) throw new Error('运行尚未释放执行权，禁止删除')
          },
          clearState: id => { runtime.permissions.clearSession(id); runtime.askUser.clearSessionPending(id); runtime.exitPlan.clearSessionPending(id) },
          deleteSession: async id => {
            if (!refreshed) {
              const next = structuredClone(this.records)
              const target = next.find(item => item.id === record.id)!
              target.sessions = record.sessions.map(meta => {
                const current = runtime.sessions.getMeta(meta.id)
                if (current && current.workspaceId !== meta.workspaceId) throw new Error('停止期间会话工作区归属变化，拒绝清理')
                return structuredClone(current ?? meta)
              })
              plans = target.sessions.map(meta => this.cleanupPlan(meta))
              const activeSnapshots = target.sessions
              for (const meta of runtime.sessions.list(true)) {
                if (activeSnapshots.some(item => item.id === meta.id)) continue
                if (activeSnapshots.some(item => item.sdkSessionId && (meta.sdkSessionId === item.sdkSessionId || meta.forkSourceSdkSessionId === item.sdkSessionId))) throw new Error('停止期间原生会话新增了其他引用，拒绝清理')
                const references = Object.values(meta.piFileCheckpoints ?? {})
                if (references.some(path => plans.flat().some(target => target.directory && within(target.path, path)))) throw new Error('停止期间会话私有资源新增了其他引用，拒绝清理')
              }
              // 与最新原生身份快照同次提交；第一次unlink之前落盘，崩溃恢复也不能重开写入口。
              target.cleanupStarted = true
              this.persist(next)
              refreshed = true
            }
            const plan = plans[record.sessions.findIndex(meta => meta.id === id)]!
            for (const path of plan) {
              // 重新校验，不能只信异步停止前的路径快照。
              this.assertPath(path.root, path.path)
              await rm(path.path, { recursive: path.directory, force: true })
            }
            runtime.sessions.remove(id)
          },
        })
        const next = structuredClone(this.records)
        Object.assign(next.find(item => item.id === record.id)!, { status: 'completed', error: undefined, revision: record.revision + 1 })
        this.persist(next)
        this.publish(next.find(item => item.id === record.id)!)
        try { await journal.remove(record.id) }
        catch (error) { console.error('[Core] 已完成删除的日志清理失败，不撤销完成状态：', error) }
      } catch (error) {
        const current = this.records.find(item => item.id === record.id)
        if (current?.status === 'completed') continue
        const next = structuredClone(this.records)
        Object.assign(next.find(item => item.id === record.id)!, { status: 'failed', error: error instanceof Error ? error.message : String(error), revision: (current?.revision ?? record.revision) + 1 })
        this.persist(next)
        this.publish(next.find(item => item.id === record.id)!)
        console.error(`[Core] 会话删除未完成，保留墓碑与错误，需显式重试: ${record.sessionId}`, error)
      }
    }
  }
  private assertPath(root: string, path: string): void {
    const rel = relative(resolve(root), resolve(path))
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('删除路径越界')
    let cursor = resolve(root)
    // 根本身可重定位，但内部符号链接一律不跟随。
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('删除路径包含符号链接，需人工检查')
    }
    if (existsSync(root) && existsSync(path)) {
      const actual = relative(realpathSync(root), realpathSync(path))
      if (!actual || actual.startsWith(`..${sep}`) || actual === '..' || isAbsolute(actual)) throw new Error('删除真实路径越界')
    }
  }
  private cleanupPlan(meta: AgentSessionMeta): Array<{ root: string; path: string; directory: boolean }> {
    if (!validId(meta.id)) throw new Error('删除会话ID非法')
    const runtime = this.runtime!
    const workspace = meta.workspaceId ? runtime.workspaces.list().find(item => item.id === meta.workspaceId) : undefined
    const layout = resolveOwnedSessionLayout(meta, workspace)
    const configRoot = this.config.configDir
    const paths = createSessionStorePaths(configRoot)
    const plan: Array<{ root: string; path: string; directory: boolean }> = []
    const add = (root: string, path: string, directory = false) => { this.assertPath(root, path); plan.push({ root, path, directory }) }
    // 项目数据目录是会话私有目录，绝不把cwd/项目根当清理目标。
    if (layout.kind === 'project') {
      add(workspace!.rootPath!, layout.dataDir!, true)
      add(workspace!.rootPath!, join(workspace!.rootPath!, '.profer', 'rewind', meta.id), true)
    }
    else {
      add(configRoot, join(paths.sessionsDir, `${meta.id}.jsonl`))
      add(configRoot, join(paths.graphDir, `${meta.id}-graph.jsonl`))
      add(configRoot, join(paths.harnessDir, `${meta.id}-pi-harness.jsonl`))
    }
    for (const name of ['session-workspaces', 'agent-checkpoints', 'pi-checkpoints', 'agent-attachment-backups', 'tool-results', 'agent-rewind']) add(configRoot, join(configRoot, name, meta.id), true)
    if (meta.sdkSessionId) {
      if (!validId(meta.sdkSessionId)) throw new Error('原生会话ID非法')
      // 仅本Core隔离的SDK目录，永不读取环境变量或forkSourceSdkSessionId。
      const sdkRoot = join(configRoot, 'sdk-config')
      add(configRoot, join(sdkRoot, 'file-history', meta.sdkSessionId), true)
      const projects = join(sdkRoot, 'projects')
      this.assertPath(configRoot, projects)
      if (existsSync(projects)) for (const entry of readdirSync(projects, { withFileTypes: true })) {
        if (entry.isDirectory()) add(configRoot, join(projects, entry.name, `${meta.sdkSessionId}.jsonl`))
      }
      if (meta.agentRuntime === 'pi') {
        const matches: string[] = []
        const scan = (root: string, directory: string, depth = 0) => {
          this.assertPath(root, directory)
          if (!existsSync(directory)) return
          if (depth > 24) throw new Error('原生会话目录过深')
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            this.assertPath(root, path)
            if (entry.isDirectory()) scan(root, path, depth + 1)
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
              let fd: number | undefined
              try {
                fd = openSync(path, 'r'); const buffer = Buffer.alloc(16384); const length = readSync(fd, buffer, 0, buffer.length, 0)
                const header = JSON.parse(buffer.toString('utf8', 0, length).split('\n', 1)[0]!.replace(/^\uFEFF/, ''))
                if (header.type === 'session' && header.id === meta.sdkSessionId) matches.push(path)
              } catch { /* 非本会话或损坏文件不删除 */ } finally { if (fd !== undefined) closeSync(fd) }
            }
          }
        }
        for (const directory of [join(configRoot, 'pi-sessions'), join(sdkRoot, 'sessions', 'pi')]) scan(configRoot, directory)
        if (matches.length > 1) throw new Error('多个原生Pi文件身份相同，拒绝猜测删除')
        for (const path of matches) add(configRoot, path)
      }
    }
    return plan
  }
  async shutdown(): Promise<void> { this.closed = true; await this.running }
  dispose(): void { this.closed = true }
}
function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function deletionFingerprint(input: { sessionId: string; sessionIds: string[]; workspaceId?: string; requestedAt?: number; reason?: string }): string {
  return JSON.stringify({ sessionId: input.sessionId, sessionIds: input.sessionIds, workspaceId: input.workspaceId ?? null, requestedAt: input.requestedAt ?? null, reason: input.reason ?? null })
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && !value.endsWith('.') }
