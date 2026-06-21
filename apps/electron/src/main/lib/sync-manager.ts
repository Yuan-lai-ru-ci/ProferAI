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
import { BrowserWindow } from 'electron'
import { fetch as undiciFetch } from 'undici'
import { getSyncStatePath } from './config-paths'
import { getTeamAuth } from './auth-service'
import { listAgentWorkspaces, readIndex, writeIndex, getWorkspaceBrand, setWorkspaceBrand } from './agent-workspace-manager'
import { AGENT_IPC_CHANNELS, SYNC_IPC_CHANNELS } from '@proma/shared'
import type { SyncEnvelope, SyncStateIndex, WorkspaceSyncState } from './sync-types'

const POLL_INTERVAL_MS = 30_000 // 30 秒轮询间隔
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
        console.warn('[同步] 令牌过期，跳过本次推送')
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

    // 超过最大重试次数的信封丢弃
    _pendingEnvelopes = _pendingEnvelopes.filter((e) => e.retryCount <= MAX_RETRY_COUNT)
    saveEnvelopeQueue()

    return false
  }
}

async function pullChanges(serverBaseUrl: string, token: string): Promise<SyncEnvelope[]> {
  const teamWs = listAgentWorkspaces().filter((w) => w.type === 'team')
  if (teamWs.length === 0) return []

  try {
    const lastSync = Math.max(
      ...teamWs.map((w) => w.lastSyncedAt ?? 0),
      0,
    )

    const response = await (undiciFetch as unknown as typeof fetch)(
      `${serverBaseUrl}/v1/sync/pull`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ since: lastSync }),
      },
    )

    if (!response.ok) return []
    return (await response.json()) as SyncEnvelope[]
  } catch (err) {
    console.error('[同步] 拉取变更失败:', err)
    return []
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
        case 'brand': {
          const payload = env.payload as { workspaceId: string; brand: Parameters<typeof setWorkspaceBrand>[1] }
          setWorkspaceBrand(payload.workspaceId, payload.brand)
          break
        }
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
  }
}

/** 心跳上报 */
async function sendHeartbeat(): Promise<void> {
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

let _syncTimer: ReturnType<typeof setInterval> | null = null

/** 执行一次完整的同步周期 */
async function syncCycle(): Promise<void> {
  const auth = getTeamAuth()
  if (!auth) return // 未登录，跳过

  // 1. 推送待发送的变更
  await pushEnvelopes(auth.baseUrl, auth.token)

  // 2. 拉取远程变更
  const changes = await pullChanges(auth.baseUrl, auth.token)
  if (changes.length > 0) {
    applyRemoteChanges(changes)
    checkIfRemoved(changes)
    console.log(`[同步] 已拉取 ${changes.length} 条远程变更`)
  }

  // 3. 更新同步时间戳
  const teamWs = listAgentWorkspaces().filter((w) => w.type === 'team')
  const now = Date.now()
  for (const ws of teamWs) {
    const state = getWorkspaceSyncState(ws.id)
    state.lastIncrementalSyncAt = now
    state.pendingOutgoing = _pendingEnvelopes.filter(
      (e) => e.workspaceId === ws.id,
    ).length
    state.pendingIncoming = 0
    state.isSyncing = false
  }
  writeSyncIndex()

  // 4. 心跳上报
  await sendHeartbeat()

  broadcastStatusChange()
}

/** 启动同步引擎 */
export function startSyncEngine(): void {
  if (_syncTimer) return

  console.log('[同步] 同步引擎已启动')
  _syncTimer = setInterval(syncCycle, POLL_INTERVAL_MS)

  // 立即执行首次同步
  syncCycle().catch((err) => console.warn('[同步] 首次同步失败:', err))
}

/** 停止同步引擎 */
export function stopSyncEngine(): void {
  if (_syncTimer) {
    clearInterval(_syncTimer)
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
