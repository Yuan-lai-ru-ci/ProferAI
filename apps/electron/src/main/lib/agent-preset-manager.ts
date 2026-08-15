/**
 * Agent Preset 管理服务（工作区级）
 *
 * 管理 Agent 预设配置，存储在每个工作区的 agent-presets.json
 * （~/.profer/agent-workspaces/{slug}/agent-presets.json，与 mcp.json 同构）。
 *
 * 内置预设（standard/code/minimal）以源码为准、不可改删，对所有工作区恒可见；
 * 配置文件存该工作区的 defaultPresetId + 自定义预设数组。
 * 无工作区（workspaceSlug 为空）时仅提供内置三预设，默认 standard，自定义 CRUD 拒绝。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import {
  BUILTIN_AGENT_PRESETS,
  DEFAULT_PRESET_ID,
} from '@profer/shared'
import type { AgentPreset, AgentPresetConfig, AgentPresetCreateInput, AgentPresetUpdateInput } from '@profer/shared'
import { getWorkspaceAgentPresetsPath } from './config-paths'

// ============================================================
// 测试替身：允许测试把真实 ~/.profer 路径替换成临时基础目录
// ============================================================

let testBaseDirOverride: string | null = null

/** 测试用：覆盖预设配置基础目录（真实路径 = baseDir/{slug}/agent-presets.json） */
export function __setAgentPresetsBaseDirForTest(path: string): void {
  testBaseDirOverride = path
}

/** 测试用：恢复真实路径 */
export function __resetAgentPresetsBaseDirForTest(): void {
  testBaseDirOverride = null
}

/** 兼容旧测试替身命名（deprecated，请用 __setAgentPresetsBaseDirForTest） */
export function __setAgentPresetsConfigPathForTest(path: string): void {
  testBaseDirOverride = path
}

export function __resetAgentPresetsConfigPathForTest(): void {
  testBaseDirOverride = null
}

function getConfigFilePath(workspaceSlug: string | undefined): string | null {
  if (!workspaceSlug) return null
  return testBaseDirOverride
    ? join(testBaseDirOverride, workspaceSlug, 'agent-presets.json')
    : getWorkspaceAgentPresetsPath(workspaceSlug)
}

// ============================================================
// 配置读写
// ============================================================

/** 默认配置 */
function getDefaultConfig(): AgentPresetConfig {
  return { presets: [], defaultPresetId: DEFAULT_PRESET_ID }
}

/** 读取工作区配置；无工作区返回默认配置 */
function readConfig(workspaceSlug: string | undefined): AgentPresetConfig {
  const filePath = getConfigFilePath(workspaceSlug)
  if (!filePath || !existsSync(filePath)) {
    return getDefaultConfig()
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AgentPresetConfig>

    const presets = Array.isArray(data.presets) ? data.presets : []
    // 规范化：默认预设必须存在于内置或该工作区自定义表中，否则回退 standard
    const rawDefault = data.defaultPresetId
    const defaultPresetId = (
      rawDefault === undefined ||
      BUILTIN_AGENT_PRESETS.some((b) => b.id === rawDefault) ||
      presets.some((p) => p.id === rawDefault)
    ) ? (rawDefault ?? DEFAULT_PRESET_ID) : DEFAULT_PRESET_ID

    return {
      presets,
      defaultPresetId,
    }
  } catch (error) {
    console.error('[Agent 预设] 读取配置失败:', error)
    return getDefaultConfig()
  }
}

/** 写入工作区配置文件；无工作区拒绝 */
function writeConfig(workspaceSlug: string | undefined, config: AgentPresetConfig): void {
  const filePath = getConfigFilePath(workspaceSlug)
  if (!filePath) throw new Error('预设管理需要工作区')
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(config, null, 2))
}

// ============================================================
// 查询 API
// ============================================================

/**
 * 列出指定工作区的全部可用预设：内置在前，自定义在后。
 * 内置预设始终以源码为准（与 system-prompt-manager 对齐）；无工作区时仅内置。
 */
export function listAgentPresets(workspaceSlug?: string): AgentPreset[] {
  const config = readConfig(workspaceSlug)
  // 内置遮蔽规则：自定义不允许占用内置 ID（过滤残留）
  const customs = config.presets.filter((p) => !BUILTIN_AGENT_PRESETS.some((b) => b.id === p.id))
  return [...BUILTIN_AGENT_PRESETS, ...customs]
}

/** 按 ID 获取工作区预设；未知 ID 返回 standard。 */
export function getAgentPreset(workspaceSlug: string | undefined, presetId: string | undefined): AgentPreset {
  const normalized = presetId ? resolvePresetId(workspaceSlug, presetId) : DEFAULT_PRESET_ID
  return listAgentPresets(workspaceSlug).find((p) => p.id === normalized)
    ?? BUILTIN_AGENT_PRESETS[0]!
}

/** 获取工作区默认预设 ID（新建会话使用）；无工作区返回 standard。 */
export function getDefaultPresetId(workspaceSlug?: string): string {
  return readConfig(workspaceSlug).defaultPresetId
}

/** 设置工作区默认预设 ID；未知 ID 被规范化回退。 */
export function setDefaultPresetId(workspaceSlug: string | undefined, presetId: string): string {
  const config = readConfig(workspaceSlug)
  const resolved = resolvePresetId(workspaceSlug, presetId)
  config.defaultPresetId = resolved
  writeConfig(workspaceSlug, config)
  return resolved
}

// ============================================================
// 自定义预设 CRUD（工作区级）
// ============================================================

/** 内置 ID 守卫：内置预设不可修改/删除。 */
function assertNotBuiltin(presetId: string): void {
  if (BUILTIN_AGENT_PRESETS.some((b) => b.id === presetId)) {
    throw new Error(`内置预设不可修改或删除: ${presetId}`)
  }
}

/** 解析预设 ID：内置 → 工作区自定义 → standard 回退。 */
export function resolvePresetId(workspaceSlug: string | undefined, presetId: string): string {
  if (BUILTIN_AGENT_PRESETS.some((b) => b.id === presetId)) return presetId
  const config = readConfig(workspaceSlug)
  if (config.presets.some((p) => p.id === presetId)) return presetId
  return DEFAULT_PRESET_ID
}

/** 新建工作区自定义预设。 */
export function createAgentPreset(workspaceSlug: string | undefined, input: AgentPresetCreateInput): AgentPreset {
  const name = input.name?.trim()
  if (!name) throw new Error('预设名称不能为空')

  const now = Date.now()
  const preset: AgentPreset = {
    id: randomUUID(),
    name,
    description: input.description?.trim() || '',
    isBuiltin: false,
    ...(input.promptSections?.length && { promptSections: input.promptSections }),
    ...(input.suppressPromptSections?.length && { suppressPromptSections: input.suppressPromptSections }),
    ...(input.disabledToolGroups?.length && { disabledToolGroups: input.disabledToolGroups }),
    ...(input.effort && { effort: input.effort }),
    ...(input.permissionMode && { permissionMode: input.permissionMode }),
    ...(input.skillSlugs?.length && { skillSlugs: input.skillSlugs }),
    ...(input.mcpServerNames?.length && { mcpServerNames: input.mcpServerNames }),
    ...(input.allowSubagents !== undefined && { allowSubagents: input.allowSubagents }),
    createdAt: now,
    updatedAt: now,
  }

  const config = readConfig(workspaceSlug)
  config.presets.push(preset)
  writeConfig(workspaceSlug, config)
  console.log(`[Agent 预设] 已创建预设: ${workspaceSlug ?? '(无工作区)'}/${preset.name} (${preset.id})`)
  return preset
}

/** 复制预设（内置或自定义）为该工作区新的自定义预设。 */
export function copyAgentPreset(workspaceSlug: string | undefined, fromId: string, name?: string): AgentPreset {
  const source = listAgentPresets(workspaceSlug).find((p) => p.id === fromId)
  if (!source) throw new Error(`源预设不存在: ${fromId}`)

  // 完整复制能力字段：suppressPromptSections / disabledToolGroups 若不复制，
  // 「极简」副本会出现提示词说精简但工具未裁剪的矛盾（违反三层一致原则）。
  return createAgentPreset(workspaceSlug, {
    name: name?.trim() || `${source.name} 副本`,
    description: source.description,
    promptSections: source.promptSections,
    suppressPromptSections: source.suppressPromptSections,
    disabledToolGroups: source.disabledToolGroups,
    effort: source.effort,
    permissionMode: source.permissionMode,
    skillSlugs: source.skillSlugs,
    mcpServerNames: source.mcpServerNames,
    allowSubagents: source.allowSubagents,
  })
}

/** 更新工作区自定义预设；内置预设拒绝。字段省略=不修改，null=清除，空数组=清除。 */
export function updateAgentPreset(workspaceSlug: string | undefined, presetId: string, updates: AgentPresetUpdateInput): AgentPreset {
  assertNotBuiltin(presetId)
  const config = readConfig(workspaceSlug)
  const index = config.presets.findIndex((p) => p.id === presetId)
  if (index === -1) throw new Error(`预设不存在: ${presetId}`)

  const existing = config.presets[index]!
  if (updates.name !== undefined) {
    const name = updates.name.trim()
    if (!name) throw new Error('预设名称不能为空')
    existing.name = name
  }
  if (updates.description !== undefined) existing.description = updates.description.trim()
  // 可选能力字段：null 或空数组均清除（回退为跟随默认/不裁剪）
  if (updates.promptSections !== undefined) existing.promptSections = updates.promptSections?.length ? updates.promptSections : undefined
  if (updates.suppressPromptSections !== undefined) existing.suppressPromptSections = updates.suppressPromptSections?.length ? updates.suppressPromptSections : undefined
  if (updates.disabledToolGroups !== undefined) existing.disabledToolGroups = updates.disabledToolGroups?.length ? updates.disabledToolGroups : undefined
  if (updates.effort !== undefined) existing.effort = updates.effort ?? undefined
  if (updates.permissionMode !== undefined) existing.permissionMode = updates.permissionMode ?? undefined
  if (updates.skillSlugs !== undefined) existing.skillSlugs = updates.skillSlugs?.length ? updates.skillSlugs : undefined
  if (updates.mcpServerNames !== undefined) existing.mcpServerNames = updates.mcpServerNames?.length ? updates.mcpServerNames : undefined
  if (updates.allowSubagents !== undefined) existing.allowSubagents = updates.allowSubagents ?? undefined
  existing.updatedAt = Date.now()

  writeConfig(workspaceSlug, config)
  return existing
}

/** 删除工作区自定义预设；内置预设拒绝；默认引用回退 standard。 */
export function deleteAgentPreset(workspaceSlug: string | undefined, presetId: string): void {
  assertNotBuiltin(presetId)
  const config = readConfig(workspaceSlug)
  const index = config.presets.findIndex((p) => p.id === presetId)
  if (index === -1) throw new Error(`预设不存在: ${presetId}`)

  config.presets.splice(index, 1)
  // 被删预设正作为默认：回退 standard，避免新建会话全部失败
  if (config.defaultPresetId === presetId) {
    config.defaultPresetId = DEFAULT_PRESET_ID
  }
  writeConfig(workspaceSlug, config)
}

// ============================================================
// 会话绑定辅助
// ============================================================

/**
 * 规范化会话预设 ID：内置/该工作区自定义存在则保留，缺失/未知 → standard（历史会话兼容）。
 *
 * 注意：不能用 shared 的 normalizePresetId——它只认内置 ID，自定义预设会被误回退。
 */
export function normalizeSessionPresetId(workspaceSlug: string | undefined, presetId: string | undefined): string {
  if (!presetId) return DEFAULT_PRESET_ID
  return resolvePresetId(workspaceSlug, presetId)
}
