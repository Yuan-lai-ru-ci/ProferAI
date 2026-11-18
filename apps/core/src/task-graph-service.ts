import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { buildGraphFromEvents, getReadyTasks, isSafeSessionId, parseDependsOn, parseForkFrom, type GraphEvent, type TaskGraph } from '../../../packages/project-core/src/index'
import { createSessionStorePaths, resolveOwnedSessionLayout, sessionGraphPathForLayout } from '@profer/session-store'
import { getEffectiveDisabledToolNames } from '@profer/shared'
import { taskGraphToolDisabled, type TaskGraphToolName } from '@profer/agent-provider-pi/task-graph-tools'
import type { CoreConfig } from './config'
import type { CoreAgentRuntime } from './runtime'
import { resolveCorePreset } from './preset-resources'

export interface CoreTaskGraphContext {
  sessionId: string
  runId: string
  signal: AbortSignal
  disabledTools?: readonly string[]
}
export interface CoreTaskGraphSnapshot {
  sessionId: string
  revision: string
  graph: TaskGraph
  tasks: TaskGraph['nodes'][string][]
  readyTaskIds: string[]
}
interface Command { key: string; fingerprint: string; taskId: string }
type StoredEvent = GraphEvent & { coreCommand?: Command }
const statuses = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled'])
const eventTypes = new Set(['task_created', 'task_updated', 'task_status_changed', 'task_dependency_added', 'task_artifact_added', 'task_session_linked', 'task_abandon_annotated', 'task_deleted'])
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`任务图 ${field} 无效`)
  return value
}
function description(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 50000) throw new Error('任务说明无效')
  return value
}
function dependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('任务依赖无效')
  return [...new Set(value.map(id => text(id, 'dependsOn')))]
}
function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
/** 只替换依赖标记，保留其他元标记与现有说明。 */
function enrich(raw: string, dependsOn: string[]): string {
  const clean = raw.replace(/^[ \t]*@?dependsOn:[ \t]*[^\r\n]*(?:\r?\n|$)/gim, '')
  return dependsOn.length ? `dependsOn: ${dependsOn.join(', ')}\n${clean}` : clean
}

/** 单Core单写者。同步校验、落盘、发布之间不让出事件循环，避免与回退/删除交叉提交。 */
export function createCoreTaskGraphService(config: CoreConfig, runtime: CoreAgentRuntime) {
  const paths = createSessionStorePaths(config.configDir)
  function pathFor(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) throw new Error('无效会话标识')
    const meta = runtime.sessions.getMeta(sessionId)
    if (!meta || runtime.deletions.isDeleting(sessionId) || runtime.deletions.isWriteBlocked(sessionId)) throw new Error('会话不属于当前Core或正在删除')
    const workspace = runtime.workspaces.list().find(item => item.id === meta.workspaceId)
    const layout = resolveOwnedSessionLayout(meta, workspace)
    const path = resolve(sessionGraphPathForLayout(paths, sessionId, layout))
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('任务图文件不允许符号链接')
    // 向上解析已有祖先，拒绝中央会话目录经符号链接逃逸。
    let ancestor = dirname(path)
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
    const real = resolve(realpathSync(ancestor), resolve(dirname(path)).slice(ancestor.length).replace(/^[/\\]+/, ''), basename(path))
    const root = layout.kind === 'project' ? resolve(workspace!.rootPath!) : resolve(paths.graphDir)
    let rootAncestor = root
    while (!existsSync(rootAncestor) && dirname(rootAncestor) !== rootAncestor) rootAncestor = dirname(rootAncestor)
    const realRoot = resolve(realpathSync(rootAncestor), root.slice(rootAncestor.length).replace(/^[/\\]+/, ''))
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('任务图路径越界')
    return path
  }
  function load(sessionId: string) {
    const path = pathFor(sessionId)
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const events: StoredEvent[] = raw.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const event: unknown = JSON.parse(line)
      if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string' || !eventTypes.has(event.type)
        || !('timestamp' in event) || typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)
        || !('taskId' in event) || typeof event.taskId !== 'string' || !('payload' in event) || !event.payload || typeof event.payload !== 'object') throw new Error('任务图日志损坏，拒绝覆盖')
      return event as StoredEvent
    })
    const graph = buildGraphFromEvents(events)
    if (!events.length) graph.updatedAt = 0
    const snapshot: CoreTaskGraphSnapshot = { sessionId, revision: createHash('sha256').update(raw).digest('hex'), graph, tasks: Object.values(graph.nodes), readyTaskIds: getReadyTasks(graph).map(task => task.id) }
    return { path, events, snapshot }
  }
  function check(ctx: CoreTaskGraphContext, name: TaskGraphToolName): void {
    ctx.signal.throwIfAborted()
    const meta = runtime.sessions.getMeta(ctx.sessionId)
    if (!meta || runtime.deletions.isDeleting(ctx.sessionId) || runtime.deletions.isWriteBlocked(ctx.sessionId)) throw new Error('任务图会话不存在或正在删除')
    const run = runtime.listRuns().find(item => item.id === ctx.runId)
    if (!run || run.sessionRef !== ctx.sessionId || !['running', 'waiting'].includes(run.status)) throw new Error('任务图工具已不属于当前活跃运行')
    const workspace = runtime.workspaces.list().find(item => item.id === meta.workspaceId)
    const policy = resolveCorePreset(config, meta, workspace).policy
    if (policy.disabledToolGroups.includes('task-graph') || taskGraphToolDisabled(ctx.disabledTools, name) || taskGraphToolDisabled(getEffectiveDisabledToolNames(policy), name)) throw new Error('当前预设禁用此任务图工具')
  }
  function validateEdges(graph: TaskGraph, taskId: string, deps: string[], forkFrom?: string): void {
    for (const id of [...deps, ...(forkFrom ? [forkFrom] : [])]) {
      if (id === taskId || !Object.hasOwn(graph.nodes, id)) throw new Error('任务依赖/分叉来源不存在或指向自身')
    }
    const ancestors = new Set<string>()
    for (let id = forkFrom; id; id = graph.nodes[id]?.forkFrom) {
      if (id === taskId || ancestors.has(id)) throw new Error('任务分叉形成循环')
      ancestors.add(id)
    }
    const visited = new Set<string>()
    const walk = (id: string): void => {
      if (id === taskId) throw new Error('任务依赖形成循环')
      if (visited.has(id)) return
      visited.add(id)
      for (const parent of graph.nodes[id]?.dependsOn ?? []) walk(parent)
    }
    deps.forEach(walk)
  }
  function commit(ctx: CoreTaskGraphContext, state: ReturnType<typeof load>, events: StoredEvent[], command?: Command): CoreTaskGraphSnapshot {
    ctx.signal.throwIfAborted()
    if (command) events[events.length - 1] = { ...events[events.length - 1]!, coreCommand: command }
    const all = [...state.events, ...events]
    mkdirSync(dirname(state.path), { recursive: true })
    const temp = `${state.path}.tmp-${randomUUID()}`
    writeFileSync(temp, all.map(event => JSON.stringify(event)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temp, state.path)
    const snapshot = load(ctx.sessionId).snapshot
    // 发布失败不能将已持久化提交误报为未执行；重连通过 revision 快照恢复。
    try { runtime.publish({ type: 'runtime', sessionId: ctx.sessionId, payload: { kind: 'task_graph_changed', coreId: config.coreId, sessionId: ctx.sessionId, runId: ctx.runId, revision: snapshot.revision, events } }) }
    catch (error) { console.error('[Core TaskGraph] 已保存但发布失败：', error) }
    return snapshot
  }
  return {
    /** 给已鉴权的宿主读入口；不接受外部 prepared/providerInput。 */
    snapshot(sessionId: string): CoreTaskGraphSnapshot { return load(sessionId).snapshot },
    async execute(ctx: CoreTaskGraphContext, name: TaskGraphToolName, input: Record<string, unknown>, operationId?: string): Promise<Record<string, unknown>> {
      check(ctx, name)
      const state = load(ctx.sessionId), graph = state.snapshot.graph
      if (name === 'profer_task_list') return { ...state.snapshot }
      if (name === 'profer_task_get') {
        const taskId = text(input.taskId, 'taskId'), task = Object.hasOwn(graph.nodes, taskId) ? graph.nodes[taskId] : undefined
        if (!task) throw new Error('任务不存在或不属于当前会话')
        return { sessionId: ctx.sessionId, revision: state.snapshot.revision, task }
      }
      const suppliedId = input.operationId ?? operationId
      const key = suppliedId === undefined ? undefined : `${ctx.runId}:${name}:${text(suppliedId, 'operationId')}`
      const { operationId: _operation, expectedRevision: _revision, ...fields } = input
      const digest = fingerprint(fields)
      const prior = key && state.events.find(event => event.coreCommand?.key === key)?.coreCommand
      if (prior) {
        if (prior.fingerprint !== digest) throw new Error('任务图 operationId 不可复用于不同参数')
        return { taskId: prior.taskId, task: graph.nodes[prior.taskId], enrichedDescription: graph.nodes[prior.taskId]?.description, updated: true, revision: state.snapshot.revision, replayed: true }
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== state.snapshot.revision) throw new Error('TASK_GRAPH_REVISION_CONFLICT')
      const taskId = name === 'profer_task_create' ? randomUUID() : text(input.taskId, 'taskId')
      const ts = Math.max(Date.now(), graph.updatedAt + 1), events: StoredEvent[] = []
      if (name === 'profer_task_create') {
        const subject = text(input.subject, 'subject', 500), raw = description(input.description)
        const deps = dependencies(input.dependsOn ?? parseDependsOn(raw))
        const fork = input.forkFrom === undefined ? parseForkFrom(raw) ?? parseForkFrom(subject) ?? undefined : text(input.forkFrom, 'forkFrom')
        validateEdges(graph, taskId, deps, fork)
        events.push({ type: 'task_created', taskId, timestamp: ts, payload: { subject, description: enrich(raw, deps), dependsOn: deps, ...(fork ? { forkFrom: fork } : {}) } },
          { type: 'task_session_linked', taskId, timestamp: ts, payload: { sessionId: ctx.sessionId } })
      } else if (name === 'profer_task_update') {
        const task = Object.hasOwn(graph.nodes, taskId) ? graph.nodes[taskId] : undefined
        if (!task) throw new Error('任务不存在或不属于当前会话')
        if (input.status !== undefined && !statuses.has(String(input.status))) throw new Error('任务状态无效')
        const deps = input.dependsOn === undefined ? task.dependsOn : dependencies(input.dependsOn)
        const raw = input.description === undefined ? task.description ?? '' : description(input.description)
        const fork = parseForkFrom(raw) ?? (input.subject === undefined ? undefined : parseForkFrom(text(input.subject, 'subject', 500))) ?? undefined
        validateEdges(graph, taskId, deps, fork)
        if (input.status === 'completed' && runtime.delegations.snapshot(ctx.sessionId).some(record => record.status === 'running' && record.relation === 'subtask')) {
          return { taskId, updated: false, completionBlocked: true, error: 'RUNNING_DELEGATIONS', revision: state.snapshot.revision }
        }
        if (input.subject !== undefined || input.description !== undefined || input.dependsOn !== undefined) events.push({ type: 'task_updated', taskId, timestamp: ts, payload: {
          ...(input.subject === undefined ? {} : { subject: text(input.subject, 'subject', 500) }), description: enrich(raw, deps), dependsOn: deps,
        } })
        if (input.status !== undefined) events.push({ type: 'task_status_changed', taskId, timestamp: ts, payload: { oldStatus: task.status, newStatus: input.status as typeof task.status } })
        if (input.abandonReason !== undefined) events.push({ type: 'task_abandon_annotated', taskId, timestamp: ts, payload: { reason: text(input.abandonReason, 'abandonReason', 5000), confidence: 1, evidenceTurns: [], source: 'agent' } })
        if (!events.length) throw new Error('任务更新没有可修改字段')
      } else throw new Error('不支持的任务图工具')
      const snapshot = commit(ctx, state, events, key ? { key, fingerprint: digest, taskId } : undefined)
      return { taskId, task: snapshot.graph.nodes[taskId], enrichedDescription: snapshot.graph.nodes[taskId]?.description, updated: true, revision: snapshot.revision }
    },
  }
}
export type CoreTaskGraphService = ReturnType<typeof createCoreTaskGraphService>
