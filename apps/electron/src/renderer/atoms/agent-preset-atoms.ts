/**
 * Agent Preset Atoms — 按工作区缓存的预设列表与会话绑定映射
 *
 * - agentPresetsAtom：Map<workspaceSlug, AgentPreset[]>，预设为工作区级配置，
 *   按需加载后缓存（技能视图/会话工具栏各自通过 workspacePresetsAtom 读写）。
 * - agentSessionPresetMapAtom：会话 ID → 预设 ID 的内存映射（乐观更新，重启后
 *   以 session meta.presetId 为准回读）。
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { AgentPreset } from '@profer/shared'
import { DEFAULT_PRESET_ID } from '@profer/shared'

/** 按工作区缓存的预设列表（预设为工作区级配置） */
export const agentPresetsAtom = atom<Map<string, AgentPreset[]>>(new Map())

/** 会话 ID → 预设 ID 的内存映射（乐观更新） */
export const agentSessionPresetMapAtom = atom<Map<string, string>>(new Map())

/** 某工作区的预设缓存读写原子；无工作区时返回内置兜底空列表（由 UI 兑底） */
export const workspacePresetsAtom = atomFamily((workspaceSlug: string | undefined) =>
  atom<AgentPreset[], [AgentPreset[]], void>(
    (get) => (workspaceSlug ? get(agentPresetsAtom).get(workspaceSlug) ?? [] : []),
    (get, set, presets: AgentPreset[]) => {
      if (!workspaceSlug) return
      const next = new Map(get(agentPresetsAtom))
      next.set(workspaceSlug, presets)
      set(agentPresetsAtom, next)
    },
  ),
)

/**
 * 在预设列表中解析预设。
 *
 * 注意：不能用 shared 的 normalizePresetId（只认内置），自定义预设 ID 必须直接匹配。
 */
export function presetOf(presets: AgentPreset[], presetId: string | undefined): AgentPreset | undefined {
  if (!presetId) return presets.find((p) => p.id === DEFAULT_PRESET_ID)
  return presets.find((p) => p.id === presetId) ?? presets.find((p) => p.id === DEFAULT_PRESET_ID)
}

export const sessionPresetIdAtom = atomFamily((sessionId: string) =>
  atom<string | undefined, [string], void>(
    (get) => get(agentSessionPresetMapAtom).get(sessionId),
    (get, set, presetId: string) => {
      const map = get(agentSessionPresetMapAtom)
      const next = new Map(map)
      next.set(sessionId, presetId)
      set(agentSessionPresetMapAtom, next)
    },
  ),
)
