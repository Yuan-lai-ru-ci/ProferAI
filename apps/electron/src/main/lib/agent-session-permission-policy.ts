import { createEffectiveAgentPresetPolicy, resolveEffectivePermissionMode } from '@profer/shared'
import type { AgentSessionMeta, ProferPermissionMode } from '@profer/shared'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentPresetByReference, presetReferenceForId } from './agent-preset-manager'

/** 收集宿主持久化事实；普通发送参数永远不升级为可信用户授权。 */
export function resolveSessionPermissionOptions(
  session: AgentSessionMeta | null | undefined,
  requestedMode?: ProferPermissionMode,
): { userPermissionMode?: ProferPermissionMode; permissionMode?: ProferPermissionMode } {
  const persistedLimit = session?.permissionModeSource === 'user' ? undefined : session?.permissionMode
  let permissionMode = persistedLimit === undefined ? requestedMode
    : requestedMode === undefined ? persistedLimit : resolveEffectivePermissionMode(persistedLimit, requestedMode)
  const cap = resolveSessionDelegationPermissionCap(session)
  if (cap !== undefined) permissionMode = permissionMode === undefined ? cap : resolveEffectivePermissionMode(cap, permissionMode)
  return {
    ...(session?.permissionModeSource === 'user' ? { userPermissionMode: session.permissionMode } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  }
}

/** 委派的父级边界独立于子预设默认；用户模式也不能跨过它。缺失/环形血缘安全收紧。 */
export function resolveSessionDelegationPermissionCap(
  session: AgentSessionMeta | null | undefined,
  visited = new Set<string>(),
): ProferPermissionMode | undefined {
  if (!session?.sourceDelegationId) return undefined
  if (visited.has(session.id)) return 'plan'
  visited.add(session.id)
  const parentId = session.parentSessionId ?? session.sourceSessionId
  const parent = parentId ? getAgentSessionMeta(parentId) : undefined
  if (!parent) return 'plan'
  const workspaceSlug = parent.workspaceId ? getAgentWorkspace(parent.workspaceId)?.slug : undefined
  const reference = parent.presetReference ?? presetReferenceForId(workspaceSlug, parent.presetId)
  const policy = createEffectiveAgentPresetPolicy(getAgentPresetByReference(reference, workspaceSlug), reference, {
    ...(parent.permissionModeSource === 'user' ? { userPermissionMode: parent.permissionMode } : { permissionMode: parent.permissionMode }),
  })
  const inherited = resolveSessionDelegationPermissionCap(parent, visited)
  return inherited === undefined ? policy.permissionMode : resolveEffectivePermissionMode(inherited, policy.permissionMode)
}
