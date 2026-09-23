import {
  PROFER_DEFAULT_PERMISSION_MODE,
  normalizeAgentRuntime,
  type AgentSessionMeta,
  type AgentSessionUiProjection,
} from '@profer/shared'

/** Convert private session metadata into the safe cross-device UI snapshot. */
export function buildAgentSessionUiProjection(meta: AgentSessionMeta): AgentSessionUiProjection {
  const presetReference = meta.presetReference
    ? {
        presetId: meta.presetReference.presetId,
        presetScope: meta.presetReference.presetScope,
        ...(meta.presetReference.workspaceSlug ? { workspaceSlug: meta.presetReference.workspaceSlug } : {}),
        ...(meta.presetReference.presetVersion ? { presetVersion: meta.presetReference.presetVersion } : {}),
      }
    : null

  return {
    schemaVersion: 1,
    id: meta.id,
    revision: Math.max(0, meta.revision ?? 0),
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    channelId: meta.channelId ?? null,
    modelId: meta.modelId ?? null,
    agentRuntime: normalizeAgentRuntime(meta.agentRuntime),
    permissionMode: meta.permissionMode ?? PROFER_DEFAULT_PERMISSION_MODE,
    presetId: meta.presetId ?? null,
    presetReference,
    openAIThinkingLevel: meta.openAIThinkingLevel ?? null,
    codexFastMode: meta.codexFastMode ?? false,
    autoQueueSendEnabled: meta.autoQueueSendEnabled ?? true,
    workspaceId: meta.workspaceId ?? null,
    pinned: meta.pinned ?? false,
    archived: meta.archived ?? false,
    draft: meta.draft ?? false,
    parentSessionId: meta.parentSessionId ?? null,
    rootSessionId: meta.rootSessionId ?? null,
    sourceDelegationId: meta.sourceDelegationId ?? null,
    explorationParentSessionId: meta.explorationParentSessionId ?? null,
    explorationSourceMessageId: meta.explorationSourceMessageId ?? null,
    explorationSourceLabel: meta.explorationSourceLabel ?? null,
    delegationRole: meta.delegationRole ?? null,
    delegationStatus: meta.delegationStatus ?? null,
    delegationDepth: meta.delegationDepth ?? null,
    sourceAutomationId: meta.sourceAutomationId ?? null,
    automationGraduated: meta.automationGraduated ?? false,
    completedButUnconfirmed: meta.completedButUnconfirmed ?? false,
    stoppedByUser: meta.stoppedByUser ?? false,
    lastInterruptReason: meta.lastInterruptReason ?? null,
    lastInterruptLabel: meta.lastInterruptLabel ?? null,
    lastInterruptAt: meta.lastInterruptAt ?? null,
  }
}
