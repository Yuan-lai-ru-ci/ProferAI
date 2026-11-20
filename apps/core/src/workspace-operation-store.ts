import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta, Automation, AutomationTriggerRecord, AgentWorkspace } from '@profer/shared'

export interface CoreWorkspaceOperation {
  operationId: string
  workspace: AgentWorkspace
  sessionIds: string[]
  sessionSnapshots: AgentSessionMeta[]
  sessionDeletionRequests: Array<{ rootSessionId: string; requestId: string; sessionIds: string[] }>
  automationIds: string[]
  automationSnapshots: Automation[]
  triggerSnapshots: AutomationTriggerRecord[]
  status: 'pending' | 'completed' | 'failed'
  requestedAt: number
  error?: string
  revision: number
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.endsWith('.') }

/** workspace删除意图与原始级联范围先持久化；失败保留墓碑和索引，禁止静默扩大范围。 */
export class CoreWorkspaceOperationStore {
  private operations: CoreWorkspaceOperation[]
  constructor(private readonly path: string) {
    if (!existsSync(path)) { this.operations = []; return }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('operations' in parsed) || !Array.isArray(parsed.operations)) throw new Error('Core工作区事务账本损坏，拒绝覆盖')
    this.operations = parsed.operations as CoreWorkspaceOperation[]
    const ids = new Set<string>()
    for (const operation of this.operations) {
      if (!operation || !validId(operation.operationId) || ids.has(operation.operationId) || !operation.workspace || !validId(operation.workspace.id)
        || operation.workspace.storageMode !== 'managed' || !validId(operation.workspace.slug) || operation.workspace.slug === 'default'
        || operation.workspace.rootPath !== undefined || !Array.isArray(operation.sessionIds) || operation.sessionIds.some(id => !validId(id))
        || new Set(operation.sessionIds).size !== operation.sessionIds.length || !Array.isArray(operation.sessionSnapshots)
        || operation.sessionSnapshots.some(meta => !meta || !validId(meta.id) || !operation.sessionIds.includes(meta.id) || meta.workspaceId !== operation.workspace.id)
        || new Set(operation.sessionSnapshots.map(meta => meta.id)).size !== operation.sessionIds.length
        || operation.sessionSnapshots.length !== operation.sessionIds.length || !Array.isArray(operation.sessionDeletionRequests)
        || operation.sessionDeletionRequests.some(item => !item || !validId(item.rootSessionId) || !validId(item.requestId) || !Array.isArray(item.sessionIds)
          || !operation.sessionIds.includes(item.rootSessionId) || !item.sessionIds.includes(item.rootSessionId)
          || new Set(item.sessionIds).size !== item.sessionIds.length || item.sessionIds.some(id => !operation.sessionIds.includes(id)))
        || new Set(operation.sessionDeletionRequests.map(item => item.rootSessionId)).size !== operation.sessionDeletionRequests.length
        || new Set(operation.sessionDeletionRequests.map(item => item.requestId)).size !== operation.sessionDeletionRequests.length
        || new Set(operation.sessionDeletionRequests.flatMap(item => item.sessionIds)).size !== operation.sessionDeletionRequests.reduce((count, item) => count + item.sessionIds.length, 0)
        || !Array.isArray(operation.automationIds)
        || operation.automationIds.some(id => !validId(id)) || new Set(operation.automationIds).size !== operation.automationIds.length
        || !Array.isArray(operation.automationSnapshots) || operation.automationSnapshots.some(item => !item || !operation.automationIds.includes(item.id) || item.workspaceId !== operation.workspace.id)
        || operation.automationSnapshots.length !== operation.automationIds.length || new Set(operation.automationSnapshots.map(item => item.id)).size !== operation.automationIds.length
        || !Array.isArray(operation.triggerSnapshots) || operation.triggerSnapshots.some(item => !item || !operation.automationIds.includes(item.automationId))
        || !['pending', 'completed', 'failed'].includes(operation.status) || !Number.isFinite(operation.requestedAt)
        || !Number.isSafeInteger(operation.revision) || operation.revision < 1) throw new Error('Core工作区事务条目无效，拒绝覆盖')
      ids.add(operation.operationId)
    }
  }
  list(): CoreWorkspaceOperation[] { return structuredClone(this.operations) }
  get(operationId: string): CoreWorkspaceOperation | undefined { const item = this.operations.find(operation => operation.operationId === operationId); return item ? structuredClone(item) : undefined }
  active(workspaceId: string): CoreWorkspaceOperation | undefined {
    const item = this.operations.find(operation => operation.workspace.id === workspaceId && operation.status !== 'completed')
    return item ? structuredClone(item) : undefined
  }
  persist(next: CoreWorkspaceOperation[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ version: 1, operations: next }, null, 2)); fsyncSync(fd) }
      finally { closeSync(fd) }
      renameSync(temp, this.path)
    }
    finally { if (existsSync(temp)) unlinkSync(temp) }
    this.operations = structuredClone(next)
  }
  begin(workspace: AgentWorkspace, sessions: AgentSessionMeta[], automationSnapshots: Automation[], triggerSnapshots: AutomationTriggerRecord[], now = Date.now(), operationId: string = randomUUID()): CoreWorkspaceOperation {
    if (workspace.storageMode !== 'managed' || workspace.slug === 'default' || (workspace as AgentWorkspace & { degradedFromProject?: boolean }).degradedFromProject === true) throw new Error('仅允许删除非默认managed工作区')
    if (!validId(operationId) || !validId(workspace.id) || !validId(workspace.slug) || workspace.rootPath !== undefined
      || sessions.some(item => !validId(item.id) || item.workspaceId !== workspace.id) || new Set(sessions.map(item => item.id)).size !== sessions.length
      || automationSnapshots.some(item => !validId(item.id) || item.workspaceId !== workspace.id)
      || triggerSnapshots.some(item => !automationSnapshots.some(automation => automation.id === item.automationId))) throw new Error('工作区删除快照身份或归属无效')
    const automationIds = automationSnapshots.map(item => item.id)
    if (new Set(automationIds).size !== automationIds.length) throw new Error('工作区Automation快照重复')
    const pending = this.operations.find(operation => operation.workspace.id === workspace.id && operation.status !== 'completed')
    if (pending) throw new Error('工作区已有未完成删除事务，必须先显式重试或解决阻塞')
    const record: CoreWorkspaceOperation = { operationId, workspace: structuredClone(workspace), sessionIds: sessions.map(item => item.id),
      sessionSnapshots: structuredClone(sessions), sessionDeletionRequests: [], automationIds, automationSnapshots: structuredClone(automationSnapshots), triggerSnapshots: structuredClone(triggerSnapshots), status: 'pending', requestedAt: now, revision: 1 }
    if (this.operations.some(item => item.operationId === operationId)) throw new Error('工作区删除operationId已存在')
    this.persist([...this.operations, record])
    return structuredClone(record)
  }
  retry(operationId: string): CoreWorkspaceOperation | undefined {
    const target = this.operations.find(item => item.operationId === operationId)
    if (!target || target.status === 'completed') return undefined
    if (target.status === 'pending') return structuredClone(target)
    const retry = { ...target, status: 'pending' as const, error: undefined, revision: target.revision + 1 }
    this.persist(this.operations.map(item => item.operationId === operationId ? retry : item))
    return structuredClone(retry)
  }
  setSessionDeletionRequests(operationId: string, requests: Array<{ rootSessionId: string; requestId: string; sessionIds: string[] }>): void {
    const target = this.operations.find(item => item.operationId === operationId)
    if (!target) throw new Error('Core工作区删除事务不存在')
    if (target.status !== 'pending') throw new Error('工作区删除事务未处于执行状态')
    if (!Array.isArray(requests) || requests.some(item => !item || !validId(item.rootSessionId) || !validId(item.requestId) || !Array.isArray(item.sessionIds)
      || !target.sessionIds.includes(item.rootSessionId) || !item.sessionIds.includes(item.rootSessionId)
      || item.sessionIds.some(id => !target.sessionIds.includes(id)))
      || new Set(requests.map(item => item.rootSessionId)).size !== requests.length
      || new Set(requests.map(item => item.requestId)).size !== requests.length
      || new Set(requests.flatMap(item => item.sessionIds)).size !== requests.reduce((count, item) => count + item.sessionIds.length, 0)) throw new Error('会话删除请求超出事务快照或重复')
    for (const previous of target.sessionDeletionRequests) {
      const nextRequest = requests.find(item => item.rootSessionId === previous.rootSessionId)
      if (!nextRequest || nextRequest.requestId !== previous.requestId || JSON.stringify(nextRequest.sessionIds) !== JSON.stringify(previous.sessionIds)) throw new Error('已持久化的会话删除请求不能替换或缩减')
    }
    const next = this.operations.map(item => item.operationId === operationId ? { ...item, sessionDeletionRequests: structuredClone(requests), revision: item.revision + 1 } : item)
    this.persist(next)
  }
  finish(operationId: string): void { this.patch(operationId, { status: 'completed', error: undefined }) }
  fail(operationId: string, error: unknown): void { this.patch(operationId, { status: 'failed', error: error instanceof Error ? error.message : String(error) }) }
  private patch(operationId: string, patch: Partial<Pick<CoreWorkspaceOperation, 'status' | 'error'>>): void {
    const next = this.operations.map(item => item.operationId === operationId ? { ...item, ...patch, revision: item.revision + 1 } : item)
    if (!next.some(item => item.operationId === operationId)) throw new Error('Core工作区删除事务不存在')
    this.persist(next)
  }
}
