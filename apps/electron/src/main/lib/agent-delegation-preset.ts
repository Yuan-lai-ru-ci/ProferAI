import type { AgentPreset, AgentSessionMeta, PresetReference } from '@profer/shared'
import {
  getAgentPresetByReference,
  normalizePresetReference,
  newDelegationPresetReference,
  presetReferenceForId,
} from './agent-preset-manager'

export interface DelegationPresetResolution {
  reference: PresetReference
  preset: AgentPreset
}

export interface ResolveDelegationPresetInput {
  parent?: Pick<AgentSessionMeta, 'presetId' | 'presetReference'>
  target?: PresetReference
  workspaceSlug?: string
}

/**
 * 委派入参归一化：全局作用域（builtin-meta / user-global）不属于任何工作区。
 *
 * 模型经常把 `preset_list` 返回的引用再补一个 workspaceSlug；该字段对全局预设
 * 解析没有任何意义，却会被严格校验直接拒绝，而错误信息只说「不得携带」，
 * 模型往往原样重试，于是一个可忽略的多余字段变成不可恢复的委派失败循环。
 * 因此在工具边界静默丢弃它；持久化/审计路径仍走 `normalizePresetReference`
 * 的严格校验，不放松对落盘数据的要求。
 */
function sanitizeDelegationReference(reference: PresetReference): PresetReference {
  if (reference.presetScope === 'workspace' || reference.workspaceSlug === undefined) {
    return reference
  }
  return {
    presetId: reference.presetId,
    presetScope: reference.presetScope,
    ...(reference.presetVersion !== undefined ? { presetVersion: reference.presetVersion } : {}),
  }
}

/**
 * Resolve the preset that a delegated child session will persist and run with.
 *
 * The parent session's persisted workspace is supplied by the caller. A target
 * workspace reference is never allowed to escape that workspace; global and
 * builtin references are still resolved with the same workspace context so the
 * manager can enforce disabled/scope/version checks in one place.
 */
export function resolveDelegationPreset(
  input: ResolveDelegationPresetInput,
): DelegationPresetResolution | undefined {
  const rawCandidate = input.target
    ?? input.parent?.presetReference
    ?? (input.parent?.presetId ? presetReferenceForId(input.workspaceSlug, input.parent.presetId) : undefined)

  if (!rawCandidate) return undefined
  const candidate = sanitizeDelegationReference(rawCandidate)

  if (input.target?.presetScope === 'workspace' && !input.target.workspaceSlug) {
    throw new Error('目标工作区预设必须提供 workspaceSlug')
  }
  if (candidate.presetScope === 'workspace'
    && input.workspaceSlug
    && candidate.workspaceSlug !== undefined
    && candidate.workspaceSlug !== input.workspaceSlug) {
    throw new Error(`目标工作区预设不属于父会话工作区: ${candidate.workspaceSlug}`)
  }

  const reference = normalizePresetReference(candidate, input.workspaceSlug)
  if (reference.presetScope === 'workspace'
    && reference.workspaceSlug !== input.workspaceSlug) {
    throw new Error(`目标工作区预设不属于父会话工作区: ${reference.workspaceSlug}`)
  }

  const preset = getAgentPresetByReference(reference, input.workspaceSlug)
  return { reference, preset }
}

export function resolveNewDelegationPreset(target: PresetReference | undefined, workspaceSlug?: string): DelegationPresetResolution {
  const reference = newDelegationPresetReference(target && sanitizeDelegationReference(target), workspaceSlug)
  return { reference, preset: getAgentPresetByReference(reference, workspaceSlug) }
}
