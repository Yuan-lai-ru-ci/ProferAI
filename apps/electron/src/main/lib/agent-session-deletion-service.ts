import { AgentSessionDeletionCoordinator } from './agent-session-deletion'
import {
  cleanupResidualSessionFiles,
  clearAgentSessionDeletionTombstone,
  deleteAgentSession,
  getAgentSessionDeletionOrder,
  getAgentSessionMeta,
} from './agent-session-manager'
import { beginAgentSessionDeletion, endAgentSessionDeletion, stopAgentAndWait } from './agent-service'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { browserController } from './browser-controller'
import {
  hasAgentSessionProjectionPublisher,
  publishAgentSessionDeletion,
  publishAgentSessionProjection,
} from './agent-session-ui-projection-publisher'
import {
  completeSessionDeletion,
  enqueueSessionDeletion,
  enqueueSessionDeletions,
  failSessionDeletion,
  isSessionDeletionPending,
  listSessionDeletionRequests,
  type SessionDeletionReason,
} from './agent-session-deletion-queue'

/**
 * 会话删除的唯一入口。
 *
 * 调用方（桌面 IPC / 移动端远程命令 / 工作区级联）只负责「提交删除请求」：
 * 入队后立刻返回，所有窗口通过 `session_projection(delete)` 同步隐藏；
 * 真正的停止、清理、索引移除由这里串行执行，失败自动重试，进程退出后下次启动续跑。
 */

const coordinator = new AgentSessionDeletionCoordinator()
const committedListeners = new Set<(sessionIds: string[]) => void>()
let running: Promise<void> | null = null

/** 删除真正落盘完成后通知宿主（如释放远程回放登记）。 */
export function onSessionDeletionCommitted(listener: (sessionIds: string[]) => void): () => void {
  committedListeners.add(listener)
  return () => committedListeners.delete(listener)
}

/**
 * 删除完成后 30s 再做一次残留清理。
 *
 * 强制删除时 run 可能还没真正退出，之后仍会创建检查点/工具结果目录；
 * 延迟复扫把它们收掉，避免几 GB 的孤儿目录永久留下。
 */
function scheduleResidualCleanup(sessionId: string, workspaceId?: string): void {
  const timer = setTimeout(() => {
    void cleanupResidualSessionFiles(sessionId, workspaceId).catch((error) => {
      console.warn(`[Agent 会话] 删除后残留清理失败 (${sessionId}):`, error)
    })
  }, 30_000)
  timer.unref?.()
}

function publishDeleted(sessionIds: string[]): void {
  if (!hasAgentSessionProjectionPublisher()) return
  for (const sessionId of sessionIds) {
    try {
      publishAgentSessionDeletion(sessionId, Date.now())
    } catch {
      // 未接线（测试 / CLI）时忽略广播。
    }
  }
}

export interface RequestSessionDeletionInput {
  sessionId: string
  /** 已知的级联快照；缺省时按索引现算。 */
  sessionIds?: string[]
  reason?: SessionDeletionReason
}

/**
 * 提交删除请求：立即返回，后台执行。
 *
 * @returns 本次请求实际会删除的会话 id（含委派子会话），调用方可据此同步本地 UI。
 */
export function requestSessionDeletion(input: RequestSessionDeletionInput): {
  requestId: string
  sessionIds: string[]
} {
  const snapshot = input.sessionIds?.length ? input.sessionIds : getAgentSessionDeletionOrder(input.sessionId)
  const request = enqueueSessionDeletion({
    sessionId: input.sessionId,
    sessionIds: snapshot,
    workspaceId: getAgentSessionMeta(input.sessionId)?.workspaceId,
    reason: input.reason ?? 'user',
  })
  const sessionIds = request?.sessionIds ?? snapshot
  // 入队即上删除锁：清理要排队，期间即使有残留标签页也不能再启动新的 run。
  for (const sessionId of sessionIds) beginAgentSessionDeletion(sessionId)
  // 先广播隐藏：即使磁盘清理要几秒，所有窗口的列表和标签页都立即消失。
  publishDeleted(sessionIds)
  void drainSessionDeletionQueue()
  return { requestId: request?.id ?? '', sessionIds }
}

/**
 * 批量提交删除（删除工作区等场景）：一次持久化、一次广播。
 *
 * @returns 本次会删除的全部会话 id
 */
export function requestSessionDeletions(
  sessionIds: string[],
  reason: SessionDeletionReason = 'user',
): string[] {
  if (sessionIds.length === 0) return []
  const requests = enqueueSessionDeletions(sessionIds.map((sessionId) => ({
    sessionId,
    sessionIds: getAgentSessionDeletionOrder(sessionId),
    workspaceId: getAgentSessionMeta(sessionId)?.workspaceId,
    reason,
  })))
  const allIds = [...new Set(requests.flatMap((request) => request.sessionIds))]
  for (const sessionId of allIds) beginAgentSessionDeletion(sessionId)
  publishDeleted(allIds)
  void drainSessionDeletionQueue()
  return allIds
}

/**
 * 等待指定会话真正删除完成（含停止 run 与清理文件）。
 *
 * 删除工作区需要在移除目录前确认会话 run 已停止，否则仍在写的 run 会把文件
 * 写回已删除的目录。超时返回 false，由调用方决定是否继续。
 */
export async function waitForSessionDeletions(sessionIds: string[], timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (sessionIds.some((sessionId) => isSessionDeletionPending(sessionId))) {
    if (Date.now() > deadline) return false
    await drainSessionDeletionQueue().catch(() => {})
    if (!sessionIds.some((sessionId) => isSessionDeletionPending(sessionId))) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return true
}

/** 串行消费删除队列；并发调用会复用同一个执行链。 */
export function drainSessionDeletionQueue(): Promise<void> {
  if (running) return running
  running = (async () => {
    for (;;) {
      const next = listSessionDeletionRequests()[0]
      if (!next) break
      try {
        await coordinator.delete(next.sessionId, {
          getDeletionOrder: () => next.sessionIds,
          beginDeletion: beginAgentSessionDeletion,
          endDeletion: endAgentSessionDeletion,
          stopAndWait: stopAgentAndWait,
          clearState: (sessionId) => {
            permissionService.clearSessionWhitelist(sessionId)
            permissionService.clearSessionPending(sessionId)
            askUserService.clearSessionPending(sessionId)
            exitPlanService.clearSessionPending(sessionId)
            void browserController.close(sessionId)
          },
          // 带上 workspaceId：索引条目已被移除时仍能解析 session 目录继续清理。
          deleteSession: (sessionId) => deleteAgentSession(sessionId, { workspaceId: next.workspaceId }),
          // 用户明确要求：停止失败/超时也把数据删掉，避免「删不动」的体感。
          forceDeleteOnStopFailure: true,
          onStopFailure: (sessionId, error) => {
            console.warn(`[Agent 会话] 停止失败，转为强制删除 (${sessionId}):`, error)
          },
        })
        completeSessionDeletion(next.id)
        for (const sessionId of next.sessionIds) endAgentSessionDeletion(sessionId)
        scheduleResidualCleanup(next.sessionId, next.workspaceId)
        for (const listener of committedListeners) {
          try {
            listener(next.sessionIds)
          } catch (error) {
            console.warn('[Agent 会话] 删除完成回调异常:', error)
          }
        }
      } catch (error) {
        console.error(`[Agent 会话] 后台删除失败 (${next.sessionId}):`, error)
        let abandoned = false
        try {
          abandoned = failSessionDeletion(next.id).abandoned
        } catch (queueError) {
          // 队列写盘失败（磁盘满/权限）：保留请求留给下次启动，本轮停止消费。
          console.error('[Agent 会话] 记录删除失败次数时队列不可写，暂停本轮消费:', queueError)
          break
        }
        if (abandoned) {
          console.error(`[Agent 会话] 删除连续失败，已放弃并恢复显示: ${next.sessionId}`)
          // 放弃后会话仍在索引里：补一条 upsert，让已经隐藏它的窗口重新显示。
          for (const sessionId of next.sessionIds) endAgentSessionDeletion(sessionId)
          // 会话仍在索引里才撤销墓碑；索引已删的会话保留墓碑，避免迟到写入复活文件。
          if (getAgentSessionMeta(next.sessionId)) {
            for (const sessionId of next.sessionIds) clearAgentSessionDeletionTombstone(sessionId)
          }
          const restored = getAgentSessionMeta(next.sessionId)
          if (restored && hasAgentSessionProjectionPublisher()) {
            try { publishAgentSessionProjection(restored) } catch { /* 未接线时忽略 */ }
          }
          continue
        }
        // 协调器失败时会在 finally 释放删除锁；重试前重新上锁，避免窗口期又能发送。
        for (const sessionId of next.sessionIds) beginAgentSessionDeletion(sessionId)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
      }
    }
  })().finally(() => {
    running = null
  })
  return running
}

/** 应用启动时续跑上次未完成的删除（进程退出 / 崩溃场景）。 */
export function resumePendingSessionDeletions(): void {
  const pending = listSessionDeletionRequests()
  if (pending.length === 0) return
  console.log(`[Agent 会话] 恢复 ${pending.length} 个未完成的删除请求`)
  for (const request of pending) {
    for (const sessionId of request.sessionIds) beginAgentSessionDeletion(sessionId)
  }
  publishDeleted(pending.flatMap((request) => request.sessionIds))
  void drainSessionDeletionQueue()
}
