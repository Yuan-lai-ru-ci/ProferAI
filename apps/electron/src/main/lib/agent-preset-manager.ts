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
  AGENT_PRESET_SUPPRESS_KEYS,
  AGENT_PRESET_TOOL_GROUPS,
  AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP,
  AGENT_PRESET_TOOL_NAMES,
  BUILTIN_AGENT_PRESETS,
  DEFAULT_PRESET_ID,
  PROFER_PERMISSION_MODES,
  mergeAgentPreset,
  toAgentPresetExportEntry,
} from '@profer/shared'
import type {
  AgentEffort,
  AgentPreset,
  AgentPresetConfig,
  AgentPresetCreateInput,
  AgentPresetExportEntry,
  AgentPresetExportFile,
  AgentPresetImportResult,
  AgentPresetSuppressKey,
  AgentPresetToolGroup,
  AgentPresetUpdateInput,
  ProferPermissionMode,
} from '@profer/shared'
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
    // 规范化：过滤历史脏数据中的非法 suppress key / 工具组（防御手工编辑 JSON 遗留值）
    for (const preset of presets) {
      if (Array.isArray(preset.suppressPromptSections)) {
        preset.suppressPromptSections = preset.suppressPromptSections.filter((k) =>
          AGENT_PRESET_SUPPRESS_KEYS.includes(k as AgentPresetSuppressKey))
        if (preset.suppressPromptSections.length === 0) delete preset.suppressPromptSections
      }
      if (Array.isArray(preset.disabledToolGroups)) {
        preset.disabledToolGroups = preset.disabledToolGroups.filter((g) =>
          AGENT_PRESET_TOOL_GROUPS.includes(g as AgentPresetToolGroup))
        if (preset.disabledToolGroups.length === 0) delete preset.disabledToolGroups
      }
      // 规范化：单工具禁用必须是已知短名（防御手工编辑 JSON 遗留值；未知短名直接剔除）
      if (Array.isArray(preset.disabledTools)) {
        preset.disabledTools = preset.disabledTools.filter((t) =>
          AGENT_PRESET_TOOL_NAMES.includes(t as (typeof AGENT_PRESET_TOOL_NAMES)[number]))
        if (preset.disabledTools.length === 0) delete preset.disabledTools
      }
      // 规范化：派生基座必须是内置 ID（防御手工编辑 JSON 遗留非法值；非法时按独立预设处理）
      if (preset.basePresetId !== undefined && !BUILTIN_AGENT_PRESETS.some((b) => b.id === preset.basePresetId)) {
        console.warn(`[Agent 预设] 忽略非法派生基座: ${preset.name ?? preset.id} → ${String(preset.basePresetId)}`)
        delete preset.basePresetId
      }
    }
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

/**
 * 按 ID 获取工作区预设；未知 ID 返回 standard。
 * 派生预设（basePresetId）在此处合并基座为生效配置（内置升级自动跟随）。
 * 出口统一兜底「三层一致」：disabledToolGroups 经 AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP
 * 自动补齐对应 suppressPromptSections（UI 表单与模型工具路径一致，模型漏传 suppress 也不会出现工具已裁但提示词段残留）。
 */
export function getAgentPreset(workspaceSlug: string | undefined, presetId: string | undefined): AgentPreset {
  const normalized = presetId ? resolvePresetId(workspaceSlug, presetId) : DEFAULT_PRESET_ID
  const raw = listAgentPresets(workspaceSlug).find((p) => p.id === normalized)
  if (!raw) return BUILTIN_AGENT_PRESETS[0]!
  const merged = raw.basePresetId
    ? mergeAgentPreset(
        BUILTIN_AGENT_PRESETS.find((b) => b.id === raw.basePresetId) ?? raw,
        raw,
      )
    : raw
  return withSuppressMapping(merged)
}

/** 三层一致兜底：disabledToolGroups → 对应 suppressPromptSections 并集（shared 唯一事实表） */
function withSuppressMapping(preset: AgentPreset): AgentPreset {
  const mapped = (preset.disabledToolGroups ?? []).map((g) => AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP[g])
  const suppress = [...new Set([...(preset.suppressPromptSections ?? []), ...mapped])]
  return suppress.length > 0 ? { ...preset, suppressPromptSections: suppress } : preset
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

/**
 * suppressPromptSections 运行时校验：非合法 key 直接拒绝（含具体非法项），
 * 避免 Agent/用户传任意字符串后静默无效。
 */
function assertSuppressKeys(keys: string[] | undefined): void {
  if (!keys?.length) return
  const invalid = keys.filter((k) => !AGENT_PRESET_SUPPRESS_KEYS.includes(k as AgentPresetSuppressKey))
  if (invalid.length > 0) {
    throw new Error(`非法的提示词段 key: ${invalid.join(', ')}（合法值: ${AGENT_PRESET_SUPPRESS_KEYS.join(' / ')}）`)
  }
}

/** disabledToolGroups 运行时校验：非合法工具组直接拒绝。 */
function assertToolGroups(groups: string[] | undefined): void {
  if (!groups?.length) return
  const invalid = groups.filter((g) => !AGENT_PRESET_TOOL_GROUPS.includes(g as AgentPresetToolGroup))
  if (invalid.length > 0) {
    throw new Error(`非法的工具组: ${invalid.join(', ')}（合法值: ${AGENT_PRESET_TOOL_GROUPS.join(' / ')}）`)
  }
}

/** basePresetId 运行时校验：派生基座只能是内置预设（限制为内置避免循环派生，也与「内置不可改删」语义对齐）。 */
function assertBuiltinBaseId(basePresetId: string | undefined): void {
  if (basePresetId === undefined) return
  if (!BUILTIN_AGENT_PRESETS.some((b) => b.id === basePresetId)) {
    throw new Error(`派生基座必须是内置预设: ${basePresetId}（可选: ${BUILTIN_AGENT_PRESETS.map((b) => b.id).join(' / ')}）`)
  }
}

/** disabledTools 运行时校验：非已知单工具短名直接拒绝（含具体非法项）。 */
function assertToolNames(tools: string[] | undefined): void {
  if (!tools?.length) return
  const invalid = tools.filter((t) => !AGENT_PRESET_TOOL_NAMES.includes(t as (typeof AGENT_PRESET_TOOL_NAMES)[number]))
  if (invalid.length > 0) {
    throw new Error(`非法的单工具短名: ${invalid.join(', ')}（可用工具见 AGENT_PRESET_GROUP_TOOL_NAMES）`)
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
  assertSuppressKeys(input.suppressPromptSections)
  assertToolGroups(input.disabledToolGroups)
  assertToolNames(input.disabledTools)
  assertBuiltinBaseId(input.basePresetId)

  const now = Date.now()
  const preset: AgentPreset = {
    id: randomUUID(),
    name,
    description: input.description?.trim() || '',
    isBuiltin: false,
    ...(input.promptSections?.length && { promptSections: input.promptSections }),
    ...(input.suppressPromptSections?.length && { suppressPromptSections: input.suppressPromptSections }),
    ...(input.disabledToolGroups?.length && { disabledToolGroups: input.disabledToolGroups }),
    ...(input.disabledTools?.length && { disabledTools: input.disabledTools }),
    ...(input.effort && { effort: input.effort }),
    ...(input.permissionMode && { permissionMode: input.permissionMode }),
    ...(input.skillSlugs !== undefined && { skillSlugs: input.skillSlugs }),
    // undefined=不裁剪，[]=禁用全部用户 MCP，非空=白名单。
    ...(input.mcpServerNames !== undefined && { mcpServerNames: input.mcpServerNames }),
    ...(input.allowSubagents !== undefined && { allowSubagents: input.allowSubagents }),
    ...(input.basePresetId !== undefined && { basePresetId: input.basePresetId }),
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
  // basePresetId 一并保留：派生预设的副本继续跟随基座升级。
  return createAgentPreset(workspaceSlug, {
    name: name?.trim() || `${source.name} 副本`,
    description: source.description,
    promptSections: source.promptSections,
    suppressPromptSections: source.suppressPromptSections,
    disabledToolGroups: source.disabledToolGroups,
    disabledTools: source.disabledTools,
    effort: source.effort,
    permissionMode: source.permissionMode,
    skillSlugs: source.skillSlugs,
    mcpServerNames: source.mcpServerNames,
    allowSubagents: source.allowSubagents,
    ...(source.basePresetId !== undefined && { basePresetId: source.basePresetId }),
  })
}

/** 更新工作区自定义预设；内置预设拒绝。字段省略=不修改，null=清除，空数组=有效值（skillSlugs 空数组=禁用全部 skill）。 */
export function updateAgentPreset(workspaceSlug: string | undefined, presetId: string, updates: AgentPresetUpdateInput): AgentPreset {
  assertNotBuiltin(presetId)
  // 可选能力字段：null 表示清除（跳过校验）；数组校验后取非空再落盘
  assertSuppressKeys(updates.suppressPromptSections ?? undefined)
  assertToolGroups(updates.disabledToolGroups ?? undefined)
  assertToolNames(updates.disabledTools ?? undefined)
  // 切换/设置基座必须是内置 ID；null 表示脱离基座（无需校验）
  if (updates.basePresetId !== null) assertBuiltinBaseId(updates.basePresetId)
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
  if (updates.disabledTools !== undefined) existing.disabledTools = updates.disabledTools?.length ? updates.disabledTools : undefined
  if (updates.effort !== undefined) existing.effort = updates.effort ?? undefined
  if (updates.permissionMode !== undefined) existing.permissionMode = updates.permissionMode ?? undefined
  // skillSlugs 语义：null=清除（回退全量），[]=禁用全部 skill（保留），非空=白名单
  if (updates.skillSlugs !== undefined) existing.skillSlugs = updates.skillSlugs ?? undefined
  // undefined=不修改，null=清除（不裁剪），[]=禁用全部用户 MCP。
  if (updates.mcpServerNames !== undefined) existing.mcpServerNames = updates.mcpServerNames ?? undefined
  if (updates.allowSubagents !== undefined) existing.allowSubagents = updates.allowSubagents ?? undefined
  // 派生基座：null=脱离（冻结当前生效配置），值=切换（内置 ID，已校验）
  if (updates.basePresetId === null) {
    const base = existing.basePresetId
      ? BUILTIN_AGENT_PRESETS.find((b) => b.id === existing.basePresetId)
      : undefined
    const resolved = base ? mergeAgentPreset(base, existing) : existing
    existing.promptSections = resolved.promptSections
    existing.suppressPromptSections = resolved.suppressPromptSections
    existing.disabledToolGroups = resolved.disabledToolGroups
    existing.disabledTools = resolved.disabledTools
    existing.effort = resolved.effort
    existing.permissionMode = resolved.permissionMode
    existing.skillSlugs = resolved.skillSlugs
    existing.mcpServerNames = resolved.mcpServerNames
    existing.allowSubagents = resolved.allowSubagents
    delete existing.basePresetId
  } else if (updates.basePresetId !== undefined) {
    existing.basePresetId = updates.basePresetId
  }
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
// 预设导出 / 导入（跨机器分享文件）
// ============================================================

const AGENT_EFFORT_VALUES = ['low', 'medium', 'high', 'max'] as const
const EXPORT_FORMAT = 'profer-agent-presets'
const EXPORT_VERSION = 1
/** 重名冲突时追加的后缀 */
const IMPORT_NAME_SUFFIX = '（导入）'

/**
 * 序列化预设为导出文件 JSON 字符串（内置与自定义通用，剥离 id/isBuiltin/时间戳）。
 * 纯函数：文件写盘与保存对话框由 IPC 层负责。
 */
export function serializeAgentPresetsForExport(presets: AgentPreset[], exportedAt = new Date()): string {
  const file: AgentPresetExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    presets: presets.map(toAgentPresetExportEntry),
  }
  return JSON.stringify(file, null, 2)
}

/** 导入校验错误（带条目定位，供整体拒绝时给出可读信息） */
class AgentPresetImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentPresetImportError'
  }
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AgentPresetImportError(`${label} 必须是字符串数组`)
  }
}

/** 校验单个导出条目；非法直接抛错（含条目定位），未知字段静默忽略（前向兼容） */
function assertImportEntry(entry: unknown, index: number): AgentPresetExportEntry {
  const at = `第 ${index + 1} 个预设`
  if (typeof entry !== 'object' || entry === null) throw new AgentPresetImportError(`${at}不是对象`)
  const value = entry as Record<string, unknown>

  if (typeof value.name !== 'string' || !value.name.trim()) throw new AgentPresetImportError(`${at}的 name 缺失或为空`)
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new AgentPresetImportError(`${at}的 description 必须是字符串`)
  }
  if (value.promptSections !== undefined) assertStringArray(value.promptSections, `${at}的 promptSections`)
  if (value.suppressPromptSections !== undefined) {
    assertStringArray(value.suppressPromptSections, `${at}的 suppressPromptSections`)
    const invalid = (value.suppressPromptSections as string[]).filter((k) => !AGENT_PRESET_SUPPRESS_KEYS.includes(k as AgentPresetSuppressKey))
    if (invalid.length > 0) throw new AgentPresetImportError(`${at}的 suppressPromptSections 含非法 key: ${invalid.join(', ')}`)
  }
  if (value.disabledToolGroups !== undefined) {
    assertStringArray(value.disabledToolGroups, `${at}的 disabledToolGroups`)
    const invalid = (value.disabledToolGroups as string[]).filter((g) => !AGENT_PRESET_TOOL_GROUPS.includes(g as AgentPresetToolGroup))
    if (invalid.length > 0) throw new AgentPresetImportError(`${at}的 disabledToolGroups 含非法工具组: ${invalid.join(', ')}`)
  }
  if (value.disabledTools !== undefined) {
    assertStringArray(value.disabledTools, `${at}的 disabledTools`)
    const invalid = (value.disabledTools as string[]).filter((t) => !AGENT_PRESET_TOOL_NAMES.includes(t as (typeof AGENT_PRESET_TOOL_NAMES)[number]))
    if (invalid.length > 0) throw new AgentPresetImportError(`${at}的 disabledTools 含非法单工具短名: ${invalid.join(', ')}`)
  }
  if (value.effort !== undefined && !AGENT_EFFORT_VALUES.includes(value.effort as (typeof AGENT_EFFORT_VALUES)[number])) {
    throw new AgentPresetImportError(`${at}的 effort 非法: ${String(value.effort)}（合法值: ${AGENT_EFFORT_VALUES.join(' / ')}）`)
  }
  if (value.permissionMode !== undefined && !PROFER_PERMISSION_MODES.includes(value.permissionMode as ProferPermissionMode)) {
    throw new AgentPresetImportError(`${at}的 permissionMode 非法: ${String(value.permissionMode)}（合法值: ${PROFER_PERMISSION_MODES.join(' / ')}）`)
  }
  if (value.skillSlugs !== undefined) assertStringArray(value.skillSlugs, `${at}的 skillSlugs`)
  if (value.mcpServerNames !== undefined) assertStringArray(value.mcpServerNames, `${at}的 mcpServerNames`)
  if (value.allowSubagents !== undefined && typeof value.allowSubagents !== 'boolean') {
    throw new AgentPresetImportError(`${at}的 allowSubagents 必须是布尔值`)
  }
  if (value.basePresetId !== undefined) {
    if (typeof value.basePresetId !== 'string' || !BUILTIN_AGENT_PRESETS.some((b) => b.id === value.basePresetId)) {
      throw new AgentPresetImportError(`${at}的 basePresetId 必须是内置预设 ID（${BUILTIN_AGENT_PRESETS.map((b) => b.id).join(' / ')}）`)
    }
  }

  return {
    name: value.name.trim(),
    description: typeof value.description === 'string' ? value.description.trim() : '',
    ...(Array.isArray(value.promptSections) && { promptSections: value.promptSections as string[] }),
    ...(Array.isArray(value.suppressPromptSections) && { suppressPromptSections: value.suppressPromptSections as AgentPresetSuppressKey[] }),
    ...(Array.isArray(value.disabledToolGroups) && { disabledToolGroups: value.disabledToolGroups as AgentPresetToolGroup[] }),
    ...(Array.isArray(value.disabledTools) && { disabledTools: value.disabledTools as string[] }),
    ...(value.effort !== undefined && { effort: value.effort as AgentEffort }),
    ...(value.permissionMode !== undefined && { permissionMode: value.permissionMode as ProferPermissionMode }),
    ...(value.skillSlugs !== undefined && { skillSlugs: value.skillSlugs as string[] }),
    ...(Array.isArray(value.mcpServerNames) && { mcpServerNames: value.mcpServerNames as string[] }),
    ...(value.allowSubagents !== undefined && { allowSubagents: value.allowSubagents as boolean }),
    ...(typeof value.basePresetId === 'string' && { basePresetId: value.basePresetId }),
  }
}

/**
 * 从导出文件 JSON 导入预设到工作区。
 *
 * 语义：整体校验先行（任一非法条目则全部拒绝，保证原子性）；
 * 通过后逐条创建自定义预设（新 UUID，不保留源 ID），重名自动追加「（导入）」后缀。
 */
export function importAgentPresets(workspaceSlug: string | undefined, jsonText: string): AgentPresetImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new AgentPresetImportError('文件不是合法的 JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) throw new AgentPresetImportError('文件内容必须是 JSON 对象')
  const envelope = parsed as Record<string, unknown>
  if (envelope.format !== EXPORT_FORMAT) {
    throw new AgentPresetImportError(`不是 Profer 预设导出文件（format 应为 ${EXPORT_FORMAT}）`)
  }
  if (envelope.version !== EXPORT_VERSION) {
    throw new AgentPresetImportError(`导出文件版本不受支持: ${String(envelope.version)}（当前支持 ${EXPORT_VERSION}）`)
  }
  if (!Array.isArray(envelope.presets)) throw new AgentPresetImportError('导出文件缺少 presets 数组')
  if (envelope.presets.length === 0) throw new AgentPresetImportError('导出文件不包含任何预设')

  const entries = envelope.presets.map((entry, index) => assertImportEntry(entry, index))

  // 重名检测：与内置 + 已有自定义对比，冲突时追加后缀
  const existingNames = new Set(listAgentPresets(workspaceSlug).map((p) => p.name))
  const imported: AgentPreset[] = []
  const renamedNames: string[] = []
  for (const entry of entries) {
    const conflicts = existingNames.has(entry.name)
    const finalName = conflicts ? `${entry.name}${IMPORT_NAME_SUFFIX}` : entry.name
    if (conflicts) renamedNames.push(entry.name)
    imported.push(createAgentPreset(workspaceSlug, { ...entry, name: finalName }))
    existingNames.add(finalName)
  }

  console.log(`[Agent 预设] 已导入 ${imported.length} 个预设: ${imported.map((p) => p.name).join(' / ')}`)
  return { imported, renamedNames }
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
