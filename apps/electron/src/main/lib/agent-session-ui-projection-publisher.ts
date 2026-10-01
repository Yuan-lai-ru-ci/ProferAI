import type { AgentSessionMeta, AgentStreamPayload } from '@profer/shared'
import type { AgentEventBus } from './agent-event-bus'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { buildAgentSessionUiProjection } from './agent-session-ui-projection'
import { getAgentUnreadPolicyMode } from './agent-unread-mode'

let projectionEventBus: AgentEventBus | null = null

/** Configure the single EventBus used by all UI projection mutations. */
export function configureAgentSessionProjectionPublisher(eventBus: AgentEventBus): void {
  projectionEventBus = eventBus
}

function emitProjection(sessionId: string, payload: AgentStreamPayload): void {
  if (!projectionEventBus) throw new Error('Agent session projection publisher 尚未初始化')
  projectionEventBus.emit(sessionId, payload)
}

/** Publish the canonical safe snapshot after a successful session metadata mutation. */
export function publishAgentSessionProjection(meta: AgentSessionMeta): void {
  emitProjection(meta.id, {
    kind: 'session_projection',
    operation: 'upsert',
    session: buildAgentSessionUiProjection(meta),
  })
}

/** Mutate session UI metadata and publish it through the unified projection plane. */
export function updateAgentSessionUiMeta(
  id: string,
  updates: Parameters<typeof updateAgentSessionMeta>[1],
): AgentSessionMeta {
  const updated = updateAgentSessionMeta(id, updates)
  publishAgentSessionProjection(updated)
  return updated
}

/**
 * 「未读」状态的唯一主进程写入口。
 *
 * 会话未读的事实源是 `AgentSessionMeta.completedButUnconfirmed`。开启态下所有产生或清除未读的
 * 路径（run 完成 / 用户发送新一轮 / 确认已读 / 归档 / 手动标记未读 / Pocket 远程命令）都必须只
 * 经过这里，三处状态（侧边栏绿标、标签页指示点、任务栏角标）由 `session_projection` 广播
 * 天然同帧一致。关闭态下渲染层的内存集合仍是显示权威，但持久化字段的写入同样走这里。
 *
 * @param extra 必须与未读同事务落盘的配套字段（如旧版 `manualWorking`），避免多次写盘与多个 projection。
 *
 * 幂等：会话已删除（或索引中不存在）时返回 null 并静默跳过，迟到的完成/确认调用不得复活已删除会话。
 *
 * 「归档副效应」按模式分支（关闭态保真优先）：
 * - **关闭态**（`auto`，默认）：不携带 `archived`，让 `updateAgentSessionMeta` 既有的自动解归档
 *   照旧生效——与原实现里「打开/关闭带持久化未读的归档会话 / 菜单切换 / 移动端标记已读」
 *   会把会话拉回活跃列表的行为逐点一致。
 * - **开启态**（`manual`）：显式保持 `archived: true`，未读变更（尤其 run 完成、迟到的确认）
 *   不得顺带把归档会话拉回活跃列表；开启态下「归档＝已读」，回列表只能由用户显式解归档。
 */
export function setAgentSessionUnread(
  sessionId: string,
  unread: boolean,
  extra?: Partial<Pick<AgentSessionMeta, 'manualWorking'>>,
): AgentSessionMeta | null {
  const existing = getAgentSessionMeta(sessionId)
  if (!existing) return null
  const keepArchived = existing.archived === true && getAgentUnreadPolicyMode() === 'manual'
  return updateAgentSessionUiMeta(sessionId, {
    ...extra,
    completedButUnconfirmed: unread,
    ...(keepArchived ? { archived: true } : {}),
  })
}

/** Publish a revision tombstone so delayed upserts cannot resurrect a deleted session. */
export function publishAgentSessionDeletion(sessionId: string, revision: number): void {
  emitProjection(sessionId, {
    kind: 'session_projection',
    operation: 'delete',
    sessionId,
    revision,
  })
}
