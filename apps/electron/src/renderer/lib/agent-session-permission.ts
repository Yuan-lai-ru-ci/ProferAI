import type { AgentSessionMeta, ProferPermissionMode } from '@profer/shared'
import type { createStore } from 'jotai/vanilla'
import { agentPermissionModeMapAtom, agentPlanModeSessionsAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { updatePlanModeSessionSet } from './agent-plan-mode'
import { upsertAgentSession } from './agent-session-list'

/** 权威元数据优先于旧瞬时缓存；预设仅在会话还没有模式时提供默认值。 */
export function resolveSessionPermissionMode(
  presetDefault: ProferPermissionMode,
  persistedMode?: ProferPermissionMode,
  cachedMode?: ProferPermissionMode,
): ProferPermissionMode {
  return persistedMode ?? cachedMode ?? presetDefault
}

/** 同步后端回执；拒绝旧 revision 对元数据、权限缓存及计划态的部分覆盖。 */
export function applyAuthoritativeSessionPermission(
  store: ReturnType<typeof createStore>,
  session: AgentSessionMeta,
): boolean {
  const current = store.get(agentSessionsAtom).find(item => item.id === session.id)
  if (current && (session.revision ?? 0) < (current.revision ?? 0)) return false
  store.set(agentSessionsAtom, previous => upsertAgentSession(previous, session))
  syncAuthoritativePermissionMode(store, session.id, session.permissionMode)
  return true
}

/** 配置与运行态解耦：不创建流占位，也不修改完成标记或 run 分组。 */
export function syncAuthoritativePermissionMode(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  mode?: ProferPermissionMode,
): void {
  store.set(agentPermissionModeMapAtom, previous => {
    if (previous.get(sessionId) === mode) return previous
    const next = new Map(previous)
    if (mode === undefined) next.delete(sessionId)
    else next.set(sessionId, mode)
    return next
  })
  store.set(agentPlanModeSessionsAtom, previous => updatePlanModeSessionSet(previous, sessionId, mode === 'plan'))
}
