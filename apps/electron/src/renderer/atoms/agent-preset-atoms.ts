/**
 * Agent Preset Atoms — 按工作区缓存的预设列表与会话绑定映射
 *
 * - agentPresetsAtom：Map<workspaceSlug, AgentPreset[]>，预设为工作区级配置，
 *   按需加载后缓存（技能视图/会话工具栏各自通过 workspacePresetsAtom 读写）。
 * - 无工作区会话使用独立缓存键，仍可选择内置元预设。
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { AgentPreset } from '@profer/shared'
import { DEFAULT_PRESET_ID } from '@profer/shared'
import { coreTargetsAtom } from './core-target-atoms'

/** 按工作区缓存的预设列表（预设为工作区级配置） */
export const agentPresetsAtom = atom<Map<string, AgentPreset[]>>(new Map())

/** 已完成加载的工作区缓存键；空列表只有在加载完成后才代表确实没有可用预设。 */
const agentPresetsLoadedStateAtom = atom<Set<string>>(new Set<string>())
export const agentPresetsLoadedAtom = atom(
  (get) => get(agentPresetsLoadedStateAtom),
  (get, set, update: Set<string> | ((previous: Set<string>) => Set<string>)) => {
    const previous = get(agentPresetsLoadedStateAtom)
    set(agentPresetsLoadedStateAtom, typeof update === 'function' ? update(previous) : update)
  },
)

const NO_WORKSPACE_PRESET_CACHE_KEY = '__no_workspace__'

export function agentPresetCacheKey(workspaceSlug: string | undefined): string {
  return workspaceSlug ?? NO_WORKSPACE_PRESET_CACHE_KEY
}

export function coreScopedPresetCacheKey(workspaceSlug: string | undefined, target: { currentId: string; generation: number }): string {
  return `${target.currentId}:${target.generation}:${agentPresetCacheKey(workspaceSlug)}`
}

/** 某工作区的预设缓存读写原子；无工作区会话也缓存并展示内置元预设。 */
export const workspacePresetsAtom = atomFamily((workspaceSlug: string | undefined) => {
  // Core 身份/代际参与缓存键，切换后不会复用旧 Core 的同名工作区数据。
  return atom<AgentPreset[], [AgentPreset[]], void>(
    (get) => {
      const target = get(coreTargetsAtom)
      const targetKey = coreScopedPresetCacheKey(workspaceSlug, target)
      return get(agentPresetsAtom).get(targetKey) ?? []
    },
    (get, set, presets: AgentPreset[]) => {
      const target = get(coreTargetsAtom)
      const targetKey = coreScopedPresetCacheKey(workspaceSlug, target)
      const next = new Map(get(agentPresetsAtom))
      next.set(targetKey, presets)
      set(agentPresetsAtom, next)
    },
  )
})

/**
 * 在预设列表中解析预设。
 *
 * 注意：不能用 shared 的 normalizePresetId（只认内置），自定义预设 ID 必须直接匹配。
 */
export function presetOf(presets: AgentPreset[], presetId: string | undefined): AgentPreset | undefined {
  if (!presetId) return presets.find((p) => p.id === DEFAULT_PRESET_ID)
  return presets.find((p) => p.id === presetId) ?? presets.find((p) => p.id === DEFAULT_PRESET_ID)
}
