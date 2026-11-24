import { AGENT_IPC_CHANNELS } from '@profer/shared'
import type { WebContents } from 'electron'

/** 运行流只有一个绑定；Core 主动推送也必须遵守同一个绑定。 */
export const sessionWebContents = new Map<string, WebContents>()

/** 只在生命周期边界提示重读，不为每个 token、审批或工具事件制造额外查询。 */
export function invalidatesAgentActivity(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || !('kind' in payload)) return false
  if (payload.kind === 'run_complete' || payload.kind === 'run_error') return true
  if (payload.kind !== 'profer_event' || !('event' in payload)) return false
  const event = payload.event
  return !!event && typeof event === 'object' && 'type' in event && (
    event.type === 'runtime_started' || event.type === 'external_run_started'
    || event.type === 'run_completed' || event.type === 'run_idle' || event.type === 'runtime_idle'
  )
}

export function isAgentCatalogPayload(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && 'kind' in payload && (
    payload.kind === 'session_projection' || payload.kind === 'catalog_invalidation' || payload.kind === 'session_deletion'
  )
}

type Receiver = Pick<WebContents, 'id' | 'send' | 'isDestroyed'>
/** 旁观窗口只收到 sessionId；完成、权限和 token 均不在这里扇出。 */
export function invalidateAgentActivity(windows: readonly Receiver[], sessionId: string): void {
  for (const wc of windows) {
    if (wc.isDestroyed()) continue
    try { wc.send(AGENT_IPC_CHANNELS.SESSION_ACTIVITY_INVALIDATED, { sessionId }) } catch { /* 窗口正在关闭；不影响运行流或其他窗口。 */ }
  }
}
