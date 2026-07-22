/**
 * 同步引擎
 *
 * 负责团队工作区的双向同步：
 * - 追踪本地变更并异步推送到远程
 * - 定时轮询远程变更并应用到本地
 * - 冲突检测（最后写入者胜出 + 旧版本备份）
 * - 被移除检测
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { BrowserWindow, powerMonitor } from 'electron'
import { fetch as undiciFetch } from 'undici'
import { getSyncStatePath } from './config-paths'
import { getTeamAuth, refreshAuthToken } from './auth-service'
import { listAgentWorkspaces, readIndex, writeIndex } from './agent-workspace-manager'
import { AGENT_IPC_CHANNELS, SYNC_IPC_CHANNELS } from '@profer/shared'
import type { SyncEnvelope, SyncStateIndex, WorkspaceSyncState, SyncPullResponse } from './sync-types'

const POLL_INTERVAL_MS = 60_000 // 基础轮询间隔（活跃时）
const POLL_JITTER_MS = 15_000   // ±15s 随机抖动，避免所有客户端同时请求
const IDLE_POLL_INTERVAL_MS = 600_000 // 空闲/不可见时的轮询间隔（10min）
const SYSTEM_IDLE_THRESHOLD_S = 300   // 系统空闲判定阈值（5min，秒）
const HEARTBEAT_INTERVAL_MS = 300_000 // 心跳最小间隔（5min），不必每个同步周期都发
const CATCHUP_POLL_INTERVAL_MS = 2_000 // 追赶模式：本轮拉满一页时快速跟进
const MAX_RETRY_COUNT = 5

// ===== 本地同步状态管理 =====

let _syncIndex: SyncStateIndex | null = null

function readSyncIndex(): SyncStateIndex {
  if (_syncIndex) return _syncIndex

  const path = getSyncStatePath()
  if (existsSync(path)) {
    try {
      _syncIndex = JSON.parse(readFileSync(path, 'utf-8'))
      return _syncIndex!
    } catch { /* ignore */ }
  }

  _syncIndex = { version: 1, workspaces: [] }
  return _syncIndex
}

function writeSyncIndex(): void {
  if (!_syncIndex) return
  writeFileSync(getSyncStatePath(), JSON.stringify(_syncIndex, null, 2), 'utf-8')
}

function getWorkspaceSyncState(workspaceId: string): WorkspaceSyncState {
  const index = readSyncIndex()
  let state = index.workspaces.find((ws) => ws.workspaceId === workspaceId)
  if (!state) {
    state = {
      workspaceId,
      lastFullSyncAt: null,
      lastIncrementalSyncAt: null,
      lastSeq: 0,
      pendingOutgoing: 0,
      pendingIncoming: 0,
      isSyncing: false,
      conflictCount: 0,
    }
    index.workspaces.push(state)
  }
  return state
}

// ===== 变更信封队列 =====

let _pendingEnvelopes: SyncEnvelope[] = []
let _envelopeLoaded = false

function getEnvelopeQueuePath(): string {
  const { join } = require('node:path')
  const { getConfigDir } = require('./config-paths')
  return join(getConfigDir(), 'sync-queue.json')
}

function loadEnvelopeQueue(): void {
  if (_envelopeLoaded) return
  const path = getEnvelopeQueuePath()
  if (existsSync(path)) {
    try {
      _pendingEnvelopes = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* ignore */ }
  }
  _envelopeLoaded = true
}

function saveEnvelopeQueue(): void {
  writeFileSync(getEnvelopeQueuePath(), JSON.stringify(_pendingEnvelopes, null, 2), 'utf-8')
}

/** 将变更加入待发送队列 */
export function enqueueChange(
  workspaceId: string,
  entityType: SyncEnvelope['entityType'],
  entityId: string,
  operation: SyncEnvelope['operation'],
  payload: unknown,
): void {
  loadEnvelopeQueue()

  const envelope: SyncEnvelope = {
    id: randomUUID(),
    workspaceId,
    entityType,
    entityId,
    operation,
    payload,
    occurredAt: Date.now(),
    retryCount: 0,
  }

  _pendingEnvelopes.push(envelope)
  saveEnvelopeQueue()

  // 更新同步状态
  const state = getWorkspaceSyncState(entityId)
  state.pendingOutgoing = _pendingEnvelopes.filter(
    (e) => e.entityType === entityType && e.entityId === entityId,
  ).length
  writeSyncIndex()
}

// ===== 与服务端通信 =====

async function pushEnvelopes(serverBaseUrl: string, token: string): Promise<boolean> {
  loadEnvelopeQueue()

  if (_pendingEnvelopes.length === 0) return true

  const toSend = [..._pendingEnvelopes]

  try {
    const response = await (undiciFetch as unknown as typeof fetch)(`${serverBaseUrl}/v1/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ envelopes: toSend }),
    })

    if (!response.ok) {
      if (response.status === 401) {
        console.warn('[同步] 令牌过期，尝试刷新...')
        const ok = await refreshAuthToken().catch(() => false)
        if (ok) {
          const newAuth = getTeamAuth()
          if (newAuth) {
            const retryRes = await (undiciFetch as unknown as typeof fetch)(`${newAuth.baseUrl}/v1/sync/push`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newAuth.token}` },
              body: JSON.stringify({ envelopes: toSend }),
            })
            if (retryRes.ok) {
              const sentIds = new Set(toSend.map((e) => e.id))
              _pendingEnvelopes = _pendingEnvelopes.filter((e) => !sentIds.has(e.id))
              saveEnvelopeQueue()
              return true
            }
          }
        }
        console.warn('[同步] 令牌刷新失败，跳过本次推送')
        return false
      }
      throw new Error(`HTTP ${response.status}`)
    }

    // 成功：从队列移除已发送的信封
    const sentIds = new Set(toSend.map((e) => e.id))
    _pendingEnvelopes = _pendingEnvelopes.filter((e) => !sentIds.has(e.id))
    saveEnvelopeQueue()

    console.log(`[同步] 已推送 ${toSend.length} 条变更`)
    return true
  } catch (err) {
    console.error('[同步] 推送失败:', err)

    // 标记重试
    for (const env of toSend) {
      env.retryCount++
      env.lastError = String(err)
    }
    saveEnvelopeQueue()

    // 超过最大重试次数的信封写入死信队列（不再静默丢弃）
    const deadEnvelopes = _pendingEnvelopes.filter((e) => e.retryCount > MAX_RETRY_COUNT)
    if (deadEnvelopes.length > 0) {
      const { writeDeadLetterEnvelopes } = await import('./sync-dead-letter')
      writeDeadLetterEnvelopes(deadEnvelopes).catch((err) => {
        console.error('[同步] 死信持久化失败:', err)
      })
    }
    _pendingEnvelopes = _pendingEnvelopes.filter((e) => e.retryCount <= MAX_RETRY_COUNT)
    saveEnvelopeQueue()

    return false
  }
}

/** 拉取结果，包含 envelopes 和精确游标 */
interface PullResult {
  envelopes: SyncEnvelope[]
  lastOccurredAt: number
  lastSeq: number
  hasMore: boolean
}

async function pullChanges(serverBaseUrl: string, token: string): Promise<PullResult> {
  const emptyResult: PullResult = { envelopes: [], lastOccurredAt: 0, lastSeq: 0, hasMore: false }
  const teamWs = listAgentWorkspaces().filter((w) => w.type === 'team')
  if (teamWs.length === 0) return emptyResult

  try {
    // 取所有团队工作区中最大的游标（保守策略：宁可多拉不丢）
    let maxSince = 0
    let maxSeq = 0
    for (const w of teamWs) {
      const s = getWorkspaceSyncState(w.id)
      if ((s.lastIncrementalSyncAt ?? 0) > maxSince) {
        maxSince = s.lastIncrementalSyncAt!
        maxSeq = s.lastSeq ?? 0
      } else if ((s.lastIncrementalSyncAt ?? 0) === maxSince && (s.lastSeq ?? 0) > maxSeq) {
        maxSeq = s.lastSeq ?? 0
      }
    }

    const response = await (undiciFetch as unknown as typeof fetch)(
      `${serverBaseUrl}/v1/sync/pull`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ since: maxSince, afterSeq: maxSeq }),
      },
    )

    if (!response.ok) return emptyResult
    const data = (await response.json()) as SyncPullResponse

    // 兼容旧服务端（无 seq 字段的裸数组响应）
    if (Array.isArray(data)) {
      return { envelopes: data, lastOccurredAt: Date.now(), lastSeq: 0, hasMore: false }
    }

    return {
      envelopes: data.envelopes || [],
      lastOccurredAt: data.lastOccurredAt || Date.now(),
      lastSeq: data.lastSeq || 0,
      hasMore: Boolean(data.hasMore),
    }
  } catch (err) {
    console.error('[同步] 拉取变更失败:', err)
    return emptyResult
  }
}

// ===== 变更应用 =====

/** 检测当前用户是否被移除出团队（成员列表中不含自己的 id） */
function checkIfRemoved(envelopes: SyncEnvelope[]): string[] {
  const removedWorkspaceIds: string[] = []

  for (const env of envelopes) {
    if (env.entityType === 'workspace' && env.operation === 'update') {
      const payload = env.payload as Record<string, unknown> | undefined
      if (payload?.memberSummary) {
        const members = payload.memberSummary as Array<{ userId: string }>
        const myUserId = require('./auth-service').getAuthStatus().teamAccountId
        if (myUserId && !members.some((m) => m.userId === myUserId)) {
          removedWorkspaceIds.push(env.entityId)
          console.log(`[同步] 检测到已被移出工作区: ${env.entityId}`)
        }
      }
    }
  }

  return removedWorkspaceIds
}

/** 应用远程变更到本地 */
function applyRemoteChanges(envelopes: SyncEnvelope[]): void {
  let hasFileChanges = false

  for (const env of envelopes) {
    try {
      switch (env.entityType) {
        case 'workspace': {
          // 工作区成员变更：同步 memberSummary 到本地索引
          const payload = env.payload as Record<string, unknown> | undefined
          if (payload?.memberSummary) {
            const index = readIndex()
            const ws = index.workspaces.find((w) => w.id === env.workspaceId)
            if (ws) {
              ws.memberSummary = payload.memberSummary as any
              writeIndex(index)
            }
          }
          break
        }
        case 'file': {
          hasFileChanges = true
          break
        }
        // skill 类型由对应服务处理
      }
    } catch (err) {
      console.warn(`[同步] 应用变更失败 (${env.id}):`, err)
    }
  }

  if (hasFileChanges) {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED)
    })

    // SSE 降级：通过轮询检测到文件变更时也发送通知
    try {
      const { teamNotificationService } = require('./team-notification-service')
      for (const env of envelopes) {
        if (env.entityType === 'file') {
          teamNotificationService.notifyFromSync(
            env.workspaceId,
            env.operation === 'delete' ? 'file_deleted' : 'file_updated',
            { userId: '', ...(env.payload as Record<string, unknown>) },
          )
        }
      }
    } catch { /* 通知服务未加载时忽略 */ }
  }
}

/** 心跳上报（限频：最多每 HEARTBEAT_INTERVAL_MS 一次） */
let _lastHeartbeatAt = 0

async function sendHeartbeat(): Promise<void> {
  if (Date.now() - _lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return

  const auth = getTeamAuth()
  if (!auth) return

  const workspaceIds = listAgentWorkspaces()
    .filter((w) => w.type === 'team')
    .map((w) => w.id)

  if (workspaceIds.length === 0) return

  try {
    await (undiciFetch as unknown as typeof fetch)(`${auth.baseUrl}/v1/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ workspaceIds }),
    })
    _lastHeartbeatAt = Date.now()
  } catch {
    // 心跳失败不关键，静默
  }
}

/** 广播同步状态到渲染进程 */
function broadcastStatusChange(): void {
  const status = getSyncStatus()
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(SYNC_IPC_CHANNELS.STATUS_CHANGED, status)
  })
}

// ===== 同步周期 =====

let _syncTimer: ReturnType<typeof setTimeout> | null = null
let _isRunning = false // 防重入锁：定时轮询与手动 triggerSync 不并发

/**
 * 执行一次完整的同步周期
 * @returns 是否需要快速跟进（本轮拉取到满页，说明还有积压变更未拉完）
 */
async function syncCycle(): Promise<boolean> {
  // 防重入：已有同步周期在执行时直接跳过，避免并发 push/pull 风暴
  if (_isRunning) return false
  _isRunning = true
  try {
    let auth = getTeamAuth()
    // token 过期时主动尝试刷新
    if (!auth) {
      const ok = await refreshAuthToken().catch(() => false)
      if (ok) auth = getTeamAuth()
      if (!auth) return false
    }

    // 1. 推送待发送的变更
    await pushEnvelopes(auth.baseUrl, auth.token)

    // 2. 拉取远程变更
    const pullResult = await pullChanges(auth.baseUrl, auth.token)
    const changes = pullResult.envelopes
    if (changes.length > 0) {
      applyRemoteChanges(changes)
      checkIfRemoved(changes)
      console.log(`[同步] 已拉取 ${changes.length} 条远程变更${pullResult.hasMore ? '（还有积压，将快速跟进）' : ''}`)
    }

    // 3. 更新同步游标（用服务端返回的精确值，避免 Date.now() 跳过同毫秒事件）
    const teamWs = listAgentWorkspaces().filter((w) => w.type === 'team')
    for (const ws of teamWs) {
      const state = getWorkspaceSyncState(ws.id)
      // 仅当服务端返回了有效游标时才更新（避免网络错误后游标倒退）
      if (pullResult.lastOccurredAt > 0) {
        state.lastIncrementalSyncAt = pullResult.lastOccurredAt
        state.lastSeq = pullResult.lastSeq
      }
      state.pendingOutgoing = _pendingEnvelopes.filter(
        (e) => e.workspaceId === ws.id,
      ).length
      state.pendingIncoming = 0
      state.isSyncing = false
    }
    writeSyncIndex()

    // 4. 心跳上报（内部限频）
    await sendHeartbeat()

    broadcastStatusChange()

    return pullResult.hasMore
  } finally {
    _isRunning = false
  }
}

/** 判断当前是否处于空闲/不可见状态（用于降低轮询频率） */
function isIdleOrHidden(): boolean {
  // 系统空闲超过阈值
  try {
    if (powerMonitor.getSystemIdleTime() >= SYSTEM_IDLE_THRESHOLD_S) return true
  } catch { /* 某些平台不支持时忽略 */ }
  // 没有任何可见（且未最小化）的窗口
  const anyVisible = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized(),
  )
  return !anyVisible
}

/** 启动同步引擎 */
export function startSyncEngine(): void {
  if (_syncTimer) return

  console.log('[同步] 同步引擎已启动')

  // 带随机抖动的自调度轮询；空闲/窗口不可见时降频，追赶积压时快速跟进
  const scheduleNext = (base: number) => {
    const jitter = Math.floor(Math.random() * POLL_JITTER_MS * 2) - POLL_JITTER_MS
    const delay = Math.max(2000, base + jitter)
    _syncTimer = setTimeout(() => {
      syncCycle()
        .then((needsFastFollow) => {
          // 还有积压未拉完 → 短间隔快速跟进；否则按活跃度选择间隔
          if (needsFastFollow) scheduleNext(CATCHUP_POLL_INTERVAL_MS)
          else scheduleNext(isIdleOrHidden() ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS)
        })
        .catch((err) => {
          console.warn('[同步] 同步周期失败:', err)
          scheduleNext(isIdleOrHidden() ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS)
        })
    }, delay)
  }

  // 立即执行首次同步，然后进入自调度
  syncCycle()
    .then((needsFastFollow) => scheduleNext(needsFastFollow ? CATCHUP_POLL_INTERVAL_MS : POLL_INTERVAL_MS))
    .catch((err) => {
      console.warn('[同步] 首次同步失败:', err)
      scheduleNext(POLL_INTERVAL_MS)
    })
}

/** 停止同步引擎 */
export function stopSyncEngine(): void {
  if (_syncTimer) {
    clearTimeout(_syncTimer)
    _syncTimer = null
    console.log('[同步] 同步引擎已停止')
  }
}

/** 手动触发同步（用于退出前强制同步等场景） */
export async function triggerSync(_workspaceId?: string): Promise<void> {
  await syncCycle()
}

/** 获取同步状态快照 */
export function getSyncStatus(): { workspaces: WorkspaceSyncState[] } {
  return { workspaces: readSyncIndex().workspaces }
}

/** 获取待发送的变更列表 */
export function getPendingChanges(workspaceId: string): SyncEnvelope[] {
  loadEnvelopeQueue()
  return _pendingEnvelopes.filter(
    (e) => e.entityType === 'workspace' && e.entityId === workspaceId,
  )
}

/** 丢弃待发送的变更 */
export function discardPendingChanges(workspaceId: string): void {
  loadEnvelopeQueue()
  _pendingEnvelopes = _pendingEnvelopes.filter(
    (e) => !(e.entityType === 'workspace' && e.entityId === workspaceId),
  )
  saveEnvelopeQueue()

  const state = getWorkspaceSyncState(workspaceId)
  state.pendingOutgoing = 0
  writeSyncIndex()
}
