import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigDir } from './config-paths'

/**
 * 会话删除队列（持久化）。
 *
 * 删除的磁盘成本不可控（单个会话的检查点目录可能十几万文件），但用户只关心
 * 「点完立刻消失」。所以删除拆成两步：
 * 1. 入队：写一个几百字节的队列文件，立刻从列表隐藏并返回；
 * 2. 后台串行执行：停止 run → 清理文件 → 移除索引条目 → 出队。
 *
 * 队列持久化保证「删除请求已接受但进程退出」时下次启动继续删完，不会复活。
 * 本模块只做存储与内存集合，不依赖任何运行时服务，避免与 agent-session-manager 成环。
 *
 * 健壮性约定：
 * - 队列文件损坏 / 形状不对时降级为空队列并留证，绝不让列表加载抛错；
 * - 先落盘成功、再提交内存状态：写盘失败不会留下「已隐藏但无人消费」的幽灵请求。
 */

export type SessionDeletionReason = 'user' | 'workspace' | 'resume'

export interface SessionDeletionRequest {
  /** 本次删除请求 id（出队用）。 */
  id: string
  /** 请求删除的根会话。 */
  sessionId: string
  /** 需要一并隐藏/删除的会话（叶子到根的快照），用于崩溃后恢复。 */
  sessionIds: string[]
  /** 会话所属工作区；索引条目已移除时用它解析 session 目录。 */
  workspaceId?: string
  requestedAt: number
  reason: SessionDeletionReason
  /** 已尝试次数；超过上限会放弃并恢复显示，避免会话永久隐身。 */
  attempts: number
}

interface SessionDeletionQueueFile {
  version: 1
  requests: SessionDeletionRequest[]
}

const QUEUE_VERSION = 1
const MAX_ATTEMPTS = 3

let state: SessionDeletionQueueFile | null = null
let pendingIds = new Set<string>()
let overridePath: string | undefined

function queuePath(): string {
  return overridePath ?? join(getConfigDir(), 'agent-session-deletions.json')
}

function isRequest(value: unknown): value is SessionDeletionRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.sessionId === 'string'
    && Array.isArray(candidate.sessionIds)
    && candidate.sessionIds.every((id) => typeof id === 'string')
    && (candidate.workspaceId === undefined || typeof candidate.workspaceId === 'string')
    && typeof candidate.requestedAt === 'number'
    && typeof candidate.reason === 'string'
    && typeof candidate.attempts === 'number'
}

/** 由请求列表推导待删除集合；任何异常都降级为空集合，绝不冒泡到列表读取。 */
function buildPendingIds(requests: SessionDeletionRequest[]): Set<string> {
  const next = new Set<string>()
  for (const request of requests) {
    next.add(request.sessionId)
    for (const id of request.sessionIds) next.add(id)
  }
  return next
}

function persistState(next: SessionDeletionQueueFile): void {
  const filePath = queuePath()
  const directory = dirname(filePath)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const tempPath = `${filePath}.tmp`
  writeFileSync(tempPath, JSON.stringify(next), 'utf8')
  renameSync(tempPath, filePath)
}

function load(): SessionDeletionQueueFile {
  if (state) return state

  const filePath = queuePath()
  // 主文件优先，其次残留的 .tmp（上次写到一半被杀）。
  for (const candidate of [filePath, `${filePath}.tmp`]) {
    if (!existsSync(candidate)) continue
    try {
      const raw = readFileSync(candidate, 'utf8')
      if (!raw.trim()) continue
      const parsed = JSON.parse(raw) as { requests?: unknown }
      if (!Array.isArray(parsed.requests)) throw new Error('requests 不是数组')
      const requests = parsed.requests.filter(isRequest)
      if (requests.length !== parsed.requests.length) {
        console.warn(`[Agent 会话] 删除队列含 ${parsed.requests.length - requests.length} 条非法记录，已忽略`)
      }
      state = { version: QUEUE_VERSION, requests }
      pendingIds = buildPendingIds(requests)
      return state
    } catch (error) {
      console.warn(`[Agent 会话] 删除队列文件不可用，尝试下一候选 (${candidate}):`, error)
      if (candidate === filePath) {
        // 留证后继续按空队列启动，避免坏文件让整个列表加载失败。
        try {
          renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
        } catch { /* 留证失败不影响启动 */ }
      }
    }
  }

  state = { version: QUEUE_VERSION, requests: [] }
  pendingIds = new Set()
  return state
}

/** 会话是否处于「已接受删除但尚未删完」状态；列表与入口守卫都看这个。 */
export function isSessionDeletionPending(sessionId: string): boolean {
  try {
    load()
  } catch {
    return false
  }
  return pendingIds.has(sessionId)
}

export function listSessionDeletionRequests(): SessionDeletionRequest[] {
  load()
  return [...state!.requests]
}

export interface SessionDeletionQueueInput {
  sessionId: string
  sessionIds: string[]
  workspaceId?: string
  reason?: SessionDeletionReason
}

/** 纯函数：把一批输入合入现有请求列表，返回新数组（不改原对象）。 */
function planRequests(
  current: SessionDeletionRequest[],
  inputs: SessionDeletionQueueInput[],
  now: number,
): { requests: SessionDeletionRequest[]; added: SessionDeletionRequest[]; changed: boolean } {
  const requests = current.map((request) => ({ ...request, sessionIds: [...request.sessionIds] }))
  const added: SessionDeletionRequest[] = []
  let changed = false

  for (const input of inputs) {
    const sessionIds = [...new Set([input.sessionId, ...input.sessionIds])]
    const existing = requests.find((request) => request.sessionId === input.sessionId)
    if (existing) {
      const missing = sessionIds.filter((id) => !existing.sessionIds.includes(id))
      if (missing.length > 0) {
        existing.sessionIds.push(...missing)
        changed = true
      }
      if (input.workspaceId && !existing.workspaceId) {
        existing.workspaceId = input.workspaceId
        changed = true
      }
      added.push(existing)
      continue
    }
    const request: SessionDeletionRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      sessionIds,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      requestedAt: now,
      reason: input.reason ?? 'user',
      attempts: 0,
    }
    requests.push(request)
    added.push(request)
    changed = true
  }
  return { requests, added, changed }
}

/** 提交新状态：先落盘，成功后才替换内存与待删除集合。 */
function commit(nextRequests: SessionDeletionRequest[]): void {
  const nextState: SessionDeletionQueueFile = { version: QUEUE_VERSION, requests: nextRequests }
  const nextPending = buildPendingIds(nextRequests)
  persistState(nextState)
  state = nextState
  pendingIds = nextPending
}

/** 入队并持久化；同一批 id 已在队列中时不重复入队。 */
export function enqueueSessionDeletion(input: SessionDeletionQueueInput): SessionDeletionRequest | undefined {
  load()
  const plan = planRequests(state!.requests, [input], Date.now())
  if (plan.changed) commit(plan.requests)
  return plan.added[0]
}

/**
 * 批量入队：只落盘一次。
 *
 * 删除工作区可能有上百个会话，逐个持久化会把小文件写放大成上百次。
 */
export function enqueueSessionDeletions(inputs: SessionDeletionQueueInput[]): SessionDeletionRequest[] {
  load()
  const plan = planRequests(state!.requests, inputs, Date.now())
  if (plan.changed) commit(plan.requests)
  return plan.added
}

/** 删除完成：出队并持久化。 */
export function completeSessionDeletion(requestId: string): void {
  load()
  if (!state!.requests.some((request) => request.id === requestId)) return
  commit(state!.requests.filter((request) => request.id !== requestId))
}

/** 记录一次失败；达到上限时放弃（会话会重新出现在列表里）。 */
export function failSessionDeletion(requestId: string): { abandoned: boolean } {
  load()
  const request = state!.requests.find((item) => item.id === requestId)
  if (!request) return { abandoned: true }
  if (request.attempts + 1 < MAX_ATTEMPTS) {
    const next = state!.requests.map((item) => item.id === requestId ? { ...item, attempts: item.attempts + 1 } : item)
    commit(next)
    return { abandoned: false }
  }
  commit(state!.requests.filter((item) => item.id !== requestId))
  return { abandoned: true }
}

/** 测试用：切换队列文件并清空内存状态。 */
export function __setSessionDeletionQueuePathForTest(path: string | undefined): void {
  overridePath = path
  state = null
  pendingIds = new Set()
}
