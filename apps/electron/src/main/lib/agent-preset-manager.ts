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

import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs'
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
  AgentSessionMeta,
  Automation,
} from '@profer/shared'
import { getAgentPresetMigrationPath, getGlobalAgentPresetsPath, getWorkspaceAgentPresetsPath, getAgentWorkspacesIndexPath, getAgentSessionsIndexPath, getAutomationsPath } from './config-paths'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { AgentPresetError } from '@profer/shared'
import type { AgentPresetScope, PresetReference, PresetReferenceReport, PresetWorkspaceReference, GlobalAgentPresetConfig } from '@profer/shared'

// ============================================================
// 测试替身：允许测试把真实 ~/.profer 路径替换成临时基础目录
// ============================================================

let testBaseDirOverride: string | null = null
let testWorkspaceSlugs: string[] | null = null

/** 测试用：覆盖预设配置基础目录（真实路径 = baseDir/{slug}/agent-presets.json） */
export function __setAgentPresetsBaseDirForTest(path: string): void {
  testBaseDirOverride = path
}

/** 测试用：恢复真实路径 */
export function __resetAgentPresetsBaseDirForTest(): void {
  testBaseDirOverride = null
  testWorkspaceSlugs = null
}

/** 测试用：让迁移覆盖临时目录中的指定工作区；生产代码从工作区索引读取。 */
export function __setAgentPresetMigrationWorkspacesForTest(slugs: string[]): void {
  testWorkspaceSlugs = [...new Set(slugs)]
}

/** 兼容旧测试替身命名（deprecated，请用 __setAgentPresetsBaseDirForTest） */
export function __setAgentPresetsConfigPathForTest(path: string): void {
  testBaseDirOverride = path
}

export function __resetAgentPresetsConfigPathForTest(): void {
  testBaseDirOverride = null
  testWorkspaceSlugs = null
}

function getConfigFilePath(workspaceSlug: string | undefined): string | null {
  if (!workspaceSlug) return null
  return testBaseDirOverride
    ? join(testBaseDirOverride, workspaceSlug, 'agent-presets.json')
    : getWorkspaceAgentPresetsPath(workspaceSlug)
}

function getGlobalConfigFilePath(): string {
  return testBaseDirOverride ? join(testBaseDirOverride, 'agent-presets.json') : getGlobalAgentPresetsPath()
}

function getMigrationIndexPath(getPath: () => string, filename: string): string {
  return testBaseDirOverride ? join(testBaseDirOverride, filename) : getPath()
}

function getMigrationWorkspaces(): Array<{ id: string; slug: string; name: string }> {
  if (testWorkspaceSlugs) return testWorkspaceSlugs.map((slug) => ({ id: slug, slug, name: slug }))
  return (require('./agent-workspace-manager') as typeof import('./agent-workspace-manager'))
    .listAgentWorkspaces()
    .filter((workspace) => !workspace.isDeleted)
    .map((workspace) => ({ id: workspace.id, slug: workspace.slug, name: workspace.name }))
}

function backupPresetMigrationFile(filePath: string, workspaceSlug: string, startedAt: string): void {
  const backupDir = join(dirname(filePath), '.migration-backup')
  const backupPath = join(backupDir, `preset-system-${startedAt.replace(/[:.]/g, '-')}.json`)
  if (!existsSync(backupPath)) {
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(filePath, backupPath)
  }
  void workspaceSlug
}

function presetScopeOf(preset: AgentPreset, fallback: AgentPresetScope): AgentPresetScope {
  return preset.scope ?? fallback
}

function withScope(preset: AgentPreset, scope: AgentPresetScope, workspaceSlug?: string): AgentPreset {
  return {
    ...preset,
    scope,
    ...(scope === 'workspace' && workspaceSlug ? { workspaceSlug } : {}),
    ...(scope !== 'workspace' ? { workspaceSlug: undefined } : {}),
    version: preset.version ?? '1.0.0',
  }
}

// ============================================================
// 配置读写
// ============================================================

/** 默认配置；兼容旧版本与新工作区均使用 standard，用户可主动清除。 */
function getDefaultConfig(_workspaceSlug?: string): AgentPresetConfig {
  return { presets: [], defaultPresetId: DEFAULT_PRESET_ID, defaultPresetReference: { presetId: DEFAULT_PRESET_ID, presetScope: 'builtin-meta' }, disabledGlobalPresetIds: [], disabledWorkspacePresetIds: [] }
}

function getDefaultGlobalConfig(): GlobalAgentPresetConfig {
  return { version: 1, presets: [], workspaceScopes: {} }
}

function readGlobalConfig(): GlobalAgentPresetConfig {
  const data = readJsonFileSafe<Partial<GlobalAgentPresetConfig>>(getGlobalConfigFilePath())
  if (!data || !Array.isArray(data.presets)) return getDefaultGlobalConfig()
  const workspaceScopes = data.workspaceScopes && typeof data.workspaceScopes === 'object'
    ? Object.fromEntries(Object.entries(data.workspaceScopes).map(([presetId, slugs]) => [presetId, Array.isArray(slugs) ? slugs.filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0) : []]))
    : {}
  return { version: 1, presets: data.presets.map((preset) => withScope(preset, 'user-global')), workspaceScopes }
}

function writeGlobalConfig(config: GlobalAgentPresetConfig): void {
  mkdirSync(dirname(getGlobalConfigFilePath()), { recursive: true })
  try {
    writeJsonFileAtomic(getGlobalConfigFilePath(), config)
  } catch (error) {
    throw new AgentPresetError('PRESET_WRITE_FAILED', `全局预设写入失败: ${error instanceof Error ? error.message : String(error)}`)
  }
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

    const presets = Array.isArray(data.presets)
      ? data.presets.map((preset) => withScope(preset, 'workspace', workspaceSlug))
      : []
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
      // C6：非法、缺失或循环基座必须保留原始字段并记录诊断，不能静默变成独立预设。
      if (preset.basePresetId !== undefined && !BUILTIN_AGENT_PRESETS.some((b) => b.id === preset.basePresetId)) {
        console.warn(`[Agent 预设] 保留非法派生基座待诊断: ${preset.name ?? preset.id} → ${String(preset.basePresetId)}`)
        preset.migrationStatus = 'invalid-base'
        preset.migrationReason = `非法派生基座: ${String(preset.basePresetId)}`
      }
    }
    // 规范化：允许空默认值；非空值必须仍指向当前可用预设，否则清空而不是回退 standard。
    const rawDefault = typeof data.defaultPresetId === 'string' ? data.defaultPresetId : (data.defaultPresetExplicitlyCleared ? '' : DEFAULT_PRESET_ID)
    const globalScopes = rawDefault ? readGlobalConfig().workspaceScopes?.[rawDefault] : undefined
    const globalDefaultAvailable = readGlobalConfig().presets.some((p) => p.id === rawDefault) && (globalScopes === undefined || Boolean(workspaceSlug && globalScopes.includes(workspaceSlug)))
    const defaultPresetId = rawDefault && (
      BUILTIN_AGENT_PRESETS.some((b) => b.id === rawDefault) ||
      globalDefaultAvailable ||
      presets.some((p) => p.id === rawDefault)
    ) ? rawDefault : ''
    const defaultPresetReference = defaultPresetId
      ? (data.defaultPresetReference ?? {
          presetId: defaultPresetId,
          presetScope: BUILTIN_AGENT_PRESETS.some((preset) => preset.id === defaultPresetId)
            ? 'builtin-meta'
            : readGlobalConfig().presets.some((preset) => preset.id === defaultPresetId) ? 'user-global' : 'workspace',
          ...(BUILTIN_AGENT_PRESETS.some((preset) => preset.id === defaultPresetId) || readGlobalConfig().presets.some((preset) => preset.id === defaultPresetId) ? {} : { workspaceSlug }),
        })
      : undefined

    const disabledGlobalPresetIds = Array.isArray(data.disabledGlobalPresetIds)
      ? data.disabledGlobalPresetIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
    const disabledWorkspacePresetIds = Array.isArray(data.disabledWorkspacePresetIds)
      ? data.disabledWorkspacePresetIds.filter((id): id is string => typeof id === 'string' && presets.some((preset) => preset.id === id))
      : []
    return { presets, defaultPresetId, ...(defaultPresetReference ? { defaultPresetReference } : {}), ...(data.defaultPresetExplicitlyCleared ? { defaultPresetExplicitlyCleared: true } : {}), disabledGlobalPresetIds, disabledWorkspacePresetIds }
  } catch (error) {
    console.error('[Agent 预设] 读取配置失败:', error)
    return getDefaultConfig()
  }
}

/** 写入工作区配置文件；无工作区拒绝 */
function writeConfig(workspaceSlug: string | undefined, config: AgentPresetConfig): void {
  const filePath = getConfigFilePath(workspaceSlug)
  if (!filePath) throw new AgentPresetError('PRESET_WORKSPACE_REQUIRED', '预设管理需要工作区')
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeJsonFileAtomic(filePath, config)
  } catch (error) {
    throw new AgentPresetError('PRESET_WRITE_FAILED', `工作区预设写入失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ============================================================
// 查询 API
// ============================================================

/**
 * 列出指定工作区的全部可用预设：内置在前，自定义在后。
 * 内置预设始终以源码为准（与 system-prompt-manager 对齐）；无工作区时仅内置。
 */
export function listAgentPresets(workspaceSlug?: string, includeInactiveGlobal = false): AgentPreset[] {
  const workspaceConfig = readConfig(workspaceSlug)
  const globalPresets = readGlobalConfig().presets
  // 内置遮蔽规则：用户数据不允许占用内置 ID（过滤残留，但不覆盖用户数据）。
  const globals = globalPresets.filter((p) => !BUILTIN_AGENT_PRESETS.some((b) => b.id === p.id))
  const workspacePresets = workspaceConfig.presets.filter((p) => !BUILTIN_AGENT_PRESETS.some((b) => b.id === p.id)).map((preset) => ({
    ...preset,
    enabledInWorkspace: !workspaceConfig.disabledWorkspacePresetIds?.includes(preset.id),
  }))
  const visibleGlobals = workspaceSlug
    ? globals
      .filter((preset) => {
        const scopes = readGlobalConfig().workspaceScopes?.[preset.id]
        const explicitlyDisabled = workspaceConfig.disabledGlobalPresetIds?.includes(preset.id)
        return includeInactiveGlobal || (!explicitlyDisabled && (scopes === undefined || scopes.includes(workspaceSlug)))
      })
      .map((preset) => ({
        ...preset,
        enabledInWorkspace: !workspaceConfig.disabledGlobalPresetIds?.includes(preset.id) && (readGlobalConfig().workspaceScopes?.[preset.id] === undefined || readGlobalConfig().workspaceScopes?.[preset.id]?.includes(workspaceSlug)),
      }))
    : globals
  return [
    ...BUILTIN_AGENT_PRESETS.map((preset) => {
      const scopes = readGlobalConfig().workspaceScopes?.[preset.id]
      const explicitlyDisabled = workspaceConfig.disabledGlobalPresetIds?.includes(preset.id) ?? false
      return { ...preset, ...(workspaceSlug ? { enabledInWorkspace: !explicitlyDisabled && (scopes === undefined || scopes.includes(workspaceSlug)) } : {}) }
    }),
    ...visibleGlobals,
    ...workspacePresets,
  ]
}

/** 只列出全局预设（内置元预设 + 用户全局预设）。 */
export function listGlobalAgentPresets(workspaceSlug?: string): AgentPreset[] {
  const config = readGlobalConfig()
  return [
    ...BUILTIN_AGENT_PRESETS.map((preset) => {
      const scopes = config.workspaceScopes?.[preset.id]
      const disabled = workspaceSlug ? readConfig(workspaceSlug).disabledGlobalPresetIds?.includes(preset.id) ?? false : false
      return { ...preset, ...(workspaceSlug ? { enabledInWorkspace: !disabled && (scopes === undefined || scopes.includes(workspaceSlug)) } : {}) }
    }),
    ...config.presets.map((preset) => {
      const scopes = config.workspaceScopes?.[preset.id]
      const enabledInWorkspace = workspaceSlug ? scopes === undefined || scopes.includes(workspaceSlug) : undefined
      return { ...preset, ...(workspaceSlug ? { enabledInWorkspace } : {}) }
    }),
  ]
}

/** 将 reference 校验为严格、可审计的形式；不会为未知 ID 静默回退。 */
export function normalizePresetReference(reference: PresetReference, contextWorkspaceSlug?: string): PresetReference {
  if (!reference || typeof reference.presetId !== 'string' || !reference.presetId.trim()) {
    throw new AgentPresetError('PRESET_UNKNOWN_REFERENCE', '预设引用缺少有效 presetId')
  }
  if (!['builtin-meta', 'user-global', 'workspace'].includes(reference.presetScope)) {
    throw new AgentPresetError('PRESET_UNKNOWN_REFERENCE', `未知预设作用域: ${String(reference.presetScope)}`)
  }
  if (reference.presetScope === 'workspace') {
    const workspaceSlug = reference.workspaceSlug || contextWorkspaceSlug
    if (!workspaceSlug) throw new AgentPresetError('PRESET_WORKSPACE_REQUIRED', '工作区预设引用必须提供 workspaceSlug')
    return { ...reference, presetId: reference.presetId.trim(), workspaceSlug }
  }
  if (reference.workspaceSlug !== undefined) {
    throw new AgentPresetError('PRESET_SCOPE_MISMATCH', '全局预设引用不得携带 workspaceSlug')
  }
  return { ...reference, presetId: reference.presetId.trim() }
}

/** 严格解析同一引用；Claude 与 Pi runtime 均应调用此入口。 */
export function resolvePresetReference(reference: PresetReference, contextWorkspaceSlug?: string): AgentPreset {
  return resolvePresetReferenceInternal(reference, contextWorkspaceSlug, new Set<string>())
}

function resolvePresetReferenceInternal(reference: PresetReference, contextWorkspaceSlug: string | undefined, visiting: Set<string>): AgentPreset {
  const normalized = normalizePresetReference(reference, contextWorkspaceSlug)
  const identity = `${normalized.presetScope}:${normalized.workspaceSlug ?? ''}:${normalized.presetId}`
  if (visiting.has(identity)) {
    throw new AgentPresetError('PRESET_INVALID_BASE', `检测到预设继承循环: ${identity}`, { identity })
  }
  const nextVisiting = new Set(visiting)
  nextVisiting.add(identity)
  if ((normalized.presetScope === 'user-global' || normalized.presetScope === 'builtin-meta') && contextWorkspaceSlug) {
    const globalConfig = readGlobalConfig()
    const scopes = globalConfig.workspaceScopes?.[normalized.presetId]
    if (scopes && !scopes.includes(contextWorkspaceSlug)) {
      throw new AgentPresetError('PRESET_UNKNOWN_REFERENCE', `全局预设已解除当前工作区生效范围: ${normalized.presetId}`)
    }
    if (readConfig(contextWorkspaceSlug).disabledGlobalPresetIds?.includes(normalized.presetId)) {
      throw new AgentPresetError('PRESET_NOT_FOUND', `预设已在当前工作区禁用: ${normalized.presetId}`)
    }
  }
  const candidates = normalized.presetScope === 'builtin-meta'
    ? BUILTIN_AGENT_PRESETS
    : normalized.presetScope === 'user-global'
      ? readGlobalConfig().presets
      : readConfig(normalized.workspaceSlug).presets
  const raw = candidates.find((preset) => preset.id === normalized.presetId)
  if (!raw) throw new AgentPresetError('PRESET_NOT_FOUND', `预设不存在: ${normalized.presetScope}/${normalized.presetId}`)
  if (raw.migrationStatus === 'invalid-base') {
    throw new AgentPresetError('PRESET_INVALID_BASE', raw.migrationReason ?? `预设基座无效: ${normalized.presetId}`, { presetId: normalized.presetId })
  }
  if (normalized.presetVersion && raw.version && normalized.presetVersion !== raw.version) {
    throw new AgentPresetError('PRESET_CONCURRENT_UPDATE', `预设版本已变化: ${normalized.presetId}`)
  }
  const baseReference = raw.basePresetReference ?? (raw.basePresetId
    ? { presetId: raw.basePresetId, presetScope: 'builtin-meta' as const }
    : undefined)
  if (!baseReference) return withSuppressMapping(raw)
  const base = resolvePresetReferenceInternal(baseReference, normalized.workspaceSlug, nextVisiting)
  return withSuppressMapping(mergeAgentPreset(base, raw))
}

function referenceForPreset(preset: AgentPreset, workspaceSlug?: string): PresetReference {
  const scope = presetScopeOf(preset, workspaceSlug ? 'workspace' : 'builtin-meta')
  return {
    presetId: preset.id,
    presetScope: scope,
    ...(scope === 'workspace' ? { workspaceSlug: preset.workspaceSlug ?? workspaceSlug } : {}),
    ...(preset.version ? { presetVersion: preset.version } : {}),
  }
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
  return resolvePresetReference(referenceForPreset(raw, workspaceSlug), workspaceSlug)
}

/** Runtime 唯一引用入口；Claude/Pi 不应自行按名称或裸 ID 推断作用域。 */
export function getAgentPresetByReference(reference: PresetReference, contextWorkspaceSlug?: string): AgentPreset {
  return resolvePresetReference(reference, contextWorkspaceSlug)
}

/** 三层一致兜底：disabledToolGroups → 对应 suppressPromptSections 并集（shared 唯一事实表） */
function withSuppressMapping(preset: AgentPreset): AgentPreset {
  const mapped = (preset.disabledToolGroups ?? []).map((g) => AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP[g])
  const suppress = [...new Set([...(preset.suppressPromptSections ?? []), ...mapped])]
  return suppress.length > 0 ? { ...preset, suppressPromptSections: suppress } : preset
}

/** 获取工作区默认预设 ID；空字符串表示用户未设置默认预设。 */
export function getDefaultPresetId(workspaceSlug?: string): string {
  return readConfig(workspaceSlug).defaultPresetId
}

/** 设置或清除工作区默认预设；传空字符串清除默认值，不回退 standard。 */
export function setDefaultPresetId(workspaceSlug: string | undefined, presetId: string): string {
  const config = readConfig(workspaceSlug)
  if (!presetId.trim()) {
    config.defaultPresetId = ''
    config.defaultPresetExplicitlyCleared = true
    delete config.defaultPresetReference
    writeConfig(workspaceSlug, config)
    return ''
  }
  const preset = listAgentPresets(workspaceSlug).find((candidate) => candidate.id === presetId && candidate.enabledInWorkspace !== false)
  if (!preset) throw new AgentPresetError('PRESET_NOT_FOUND', `预设不存在或未在当前工作区生效: ${presetId}`)
  config.defaultPresetId = preset.id
  delete config.defaultPresetExplicitlyCleared
  config.defaultPresetReference = referenceForPreset(preset, workspaceSlug)
  writeConfig(workspaceSlug, config)
  return preset.id
}

/** 将旧裸 ID 转为带作用域引用；未知值必须显式失败，禁止静默回退 standard。 */
export function presetReferenceForId(workspaceSlug: string | undefined, presetId: string | undefined): PresetReference {
  if (!presetId?.trim()) return { presetId: '', presetScope: 'builtin-meta' }
  const id = presetId.trim()
  const builtin = BUILTIN_AGENT_PRESETS.find((preset) => preset.id === id)
  if (builtin) return referenceForPreset(builtin)
  const global = readGlobalConfig().presets.find((preset) => preset.id === id)
  if (global) return referenceForPreset(global)
  const workspace = workspaceSlug ? readConfig(workspaceSlug).presets.find((preset) => preset.id === id) : undefined
  if (workspace) return referenceForPreset(workspace, workspaceSlug)
  throw new AgentPresetError('PRESET_UNKNOWN_REFERENCE', `无法将旧预设 ID 转换为稳定引用: ${id}`)
}

/** 全局用户预设 CRUD；builtin-meta 永远不进入此存储。 */
export function createGlobalAgentPreset(input: AgentPresetCreateInput): AgentPreset {
  const name = input.name?.trim()
  if (!name) throw new AgentPresetError('PRESET_WRITE_FAILED', '预设名称不能为空')
  assertSuppressKeys(input.suppressPromptSections)
  assertToolGroups(input.disabledToolGroups)
  assertToolNames(input.disabledTools)
  assertBuiltinBaseId(input.basePresetId)
  const now = Date.now()
  const preset: AgentPreset = withScope({
    id: randomUUID(), name, description: input.description?.trim() || '', isBuiltin: false,
    ...(input.promptSections?.length && { promptSections: input.promptSections }),
    ...(input.suppressPromptSections?.length && { suppressPromptSections: input.suppressPromptSections }),
    ...(input.disabledToolGroups?.length && { disabledToolGroups: input.disabledToolGroups }),
    ...(input.disabledTools?.length && { disabledTools: input.disabledTools }),
    ...(input.effort && { effort: input.effort }), ...(input.permissionMode && { permissionMode: input.permissionMode }),
    ...(input.skillSlugs !== undefined && { skillSlugs: input.skillSlugs }),
    ...(input.mcpServerNames !== undefined && { mcpServerNames: input.mcpServerNames }),
    ...(input.allowSubagents !== undefined && { allowSubagents: input.allowSubagents }),
    ...(input.basePresetId !== undefined && { basePresetId: input.basePresetId }),
    createdAt: now, updatedAt: now,
  }, 'user-global')
  const config = readGlobalConfig()
  // 新建全局预设默认对所有工作区可见；只有发生移除范围时才物化 workspaceScopes。
  writeGlobalConfig({ ...config, presets: [...config.presets, preset] })
  return preset
}

/** 将工作区预设提升为用户全局预设；原工作区预设是否保留由调用方明确传入。 */
export function promoteWorkspacePresetToGlobal(workspaceSlug: string, presetId: string, targetWorkspaceSlugs: string[], keepWorkspaceCopy = true): AgentPreset {
  const source = readConfig(workspaceSlug).presets.find((preset) => preset.id === presetId)
  if (!source) throw new AgentPresetError('PRESET_NOT_FOUND', `工作区预设不存在: ${presetId}`)
  const created = createGlobalAgentPreset({
    name: source.name,
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
    basePresetId: source.basePresetId,
  })
  const config = readGlobalConfig()
  const scopes = [...new Set(targetWorkspaceSlugs)]
  config.workspaceScopes = { ...(config.workspaceScopes ?? {}), [created.id]: scopes }
  writeGlobalConfig(config)
  if (!keepWorkspaceCopy) {
    deleteAgentPreset(workspaceSlug, presetId)
  } else {
    setWorkspacePresetEnabled(workspaceSlug, presetId, false)
  }
  return created
}

export function updateGlobalAgentPreset(presetId: string, updates: AgentPresetUpdateInput): AgentPreset {
  assertNotBuiltin(presetId)
  const config = readGlobalConfig()
  const index = config.presets.findIndex((preset) => preset.id === presetId)
  if (index < 0) throw new AgentPresetError('PRESET_NOT_FOUND', `全局预设不存在: ${presetId}`)
  // 复用工作区更新逻辑的校验与字段语义，但不把全局配置映射为 workspace。
  const existing = config.presets[index]!
  assertSuppressKeys(updates.suppressPromptSections ?? undefined)
  assertToolGroups(updates.disabledToolGroups ?? undefined)
  assertToolNames(updates.disabledTools ?? undefined)
  if (updates.basePresetId !== null) assertBuiltinBaseId(updates.basePresetId)
  const updated = applyPresetUpdates(existing, updates)
  config.presets[index] = withScope(updated, 'user-global')
  writeGlobalConfig(config)
  return config.presets[index]!
}

function applyPresetUpdates(existing: AgentPreset, updates: AgentPresetUpdateInput): AgentPreset {
  const next = { ...existing }
  if (updates.name !== undefined) { const name = updates.name.trim(); if (!name) throw new AgentPresetError('PRESET_WRITE_FAILED', '预设名称不能为空'); next.name = name }
  if (updates.description !== undefined) next.description = updates.description.trim()
  if (updates.promptSections !== undefined) next.promptSections = updates.promptSections?.length ? updates.promptSections : undefined
  if (updates.suppressPromptSections !== undefined) next.suppressPromptSections = updates.suppressPromptSections?.length ? updates.suppressPromptSections : undefined
  if (updates.disabledToolGroups !== undefined) next.disabledToolGroups = updates.disabledToolGroups?.length ? updates.disabledToolGroups : undefined
  if (updates.disabledTools !== undefined) next.disabledTools = updates.disabledTools?.length ? updates.disabledTools : undefined
  if (updates.effort !== undefined) next.effort = updates.effort ?? undefined
  if (updates.permissionMode !== undefined) next.permissionMode = updates.permissionMode ?? undefined
  if (updates.skillSlugs !== undefined) next.skillSlugs = updates.skillSlugs ?? undefined
  if (updates.mcpServerNames !== undefined) next.mcpServerNames = updates.mcpServerNames ?? undefined
  if (updates.allowSubagents !== undefined) next.allowSubagents = updates.allowSubagents ?? undefined
  if (updates.basePresetId === null) {
    const base = next.basePresetId ? BUILTIN_AGENT_PRESETS.find((preset) => preset.id === next.basePresetId) : undefined
    const resolved = base ? mergeAgentPreset(base, next) : next
    Object.assign(next, { promptSections: resolved.promptSections, suppressPromptSections: resolved.suppressPromptSections, disabledToolGroups: resolved.disabledToolGroups, disabledTools: resolved.disabledTools, effort: resolved.effort, permissionMode: resolved.permissionMode, skillSlugs: resolved.skillSlugs, mcpServerNames: resolved.mcpServerNames, allowSubagents: resolved.allowSubagents })
    delete next.basePresetId
  } else if (updates.basePresetId !== undefined) next.basePresetId = updates.basePresetId
  next.updatedAt = Date.now()
  return next
}

export function copyPresetToWorkspace(source: PresetReference, workspaceSlug: string, name?: string): AgentPreset {
  const sourcePreset = resolvePresetReference(source, workspaceSlug)
  const copied = createAgentPreset(workspaceSlug, {
    name: name?.trim() || `${sourcePreset.name} 副本`, description: sourcePreset.description,
    promptSections: sourcePreset.promptSections, suppressPromptSections: sourcePreset.suppressPromptSections,
    disabledToolGroups: sourcePreset.disabledToolGroups, disabledTools: sourcePreset.disabledTools,
    effort: sourcePreset.effort, permissionMode: sourcePreset.permissionMode, skillSlugs: sourcePreset.skillSlugs,
    mcpServerNames: sourcePreset.mcpServerNames, allowSubagents: sourcePreset.allowSubagents,
  })
  const config = readConfig(workspaceSlug)
  const stored = config.presets.find((preset) => preset.id === copied.id)
  if (stored) {
    stored.sourcePresetId = sourcePreset.id
    stored.sourcePresetScope = sourcePreset.scope ?? source.presetScope
    stored.sourceVersion = sourcePreset.version
    stored.copiedAt = Date.now()
    writeConfig(workspaceSlug, config)
    return stored
  }
  return copied
}

interface PresetMigrationState {
  version: 2 | 3
  status: 'completed' | 'failed'
  result: 'migrated' | 'no-history'
  startedAt: string
  completedAt?: string
  completedWorkspaces: string[]
  remappedIds: Array<{ workspaceSlug: string; oldId: string; newId: string; reason: 'builtin-conflict' | 'duplicate-id' }>
  diagnostics: Array<{ workspaceSlug?: string; presetId?: string; status: string; reason: string }>
  failures: string[]
}

function presetJsonFingerprint(preset: AgentPreset): string {
  const { id: _id, isBuiltin: _isBuiltin, scope: _scope, version: _version, workspaceSlug: _workspaceSlug, enabledInWorkspace: _enabled, updatedAt: _updatedAt, createdAt: _createdAt, migrationStatus: _migrationStatus, migrationReason: _migrationReason, ...content } = preset
  return JSON.stringify(content)
}

function isValidLegacyPreset(value: unknown): value is AgentPreset {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AgentPreset>
  return typeof candidate.id === 'string' && candidate.id.trim().length > 0
    && typeof candidate.name === 'string' && candidate.name.trim().length > 0
    && typeof candidate.description === 'string'
    && typeof candidate.createdAt === 'number' && typeof candidate.updatedAt === 'number'
}

function baseReferenceForLegacyPreset(preset: AgentPreset, workspaceSlug: string, presetsById: Map<string, AgentPreset>): PresetReference | undefined {
  if (preset.basePresetReference) return normalizePresetReference(preset.basePresetReference, workspaceSlug)
  if (!preset.basePresetId) return undefined
  if (BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === preset.basePresetId)) {
    return { presetId: preset.basePresetId, presetScope: 'builtin-meta', presetVersion: BUILTIN_AGENT_PRESETS.find((builtin) => builtin.id === preset.basePresetId)?.version }
  }
  if (presetsById.has(preset.basePresetId)) return { presetId: preset.basePresetId, presetScope: 'workspace', workspaceSlug }
  return undefined
}

function hasPresetBaseCycle(preset: AgentPreset, presetsById: Map<string, AgentPreset>, workspaceSlug: string, trail = new Set<string>()): boolean {
  if (!preset.basePresetId && !preset.basePresetReference) return false
  if (trail.has(preset.id)) return true
  const next = preset.basePresetId ?? preset.basePresetReference?.presetId
  if (!next || BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === next)) return false
  const parent = presetsById.get(next)
  return parent ? hasPresetBaseCycle(parent, presetsById, workspaceSlug, new Set([...trail, preset.id])) : true
}

/** 启动前幂等迁移；C/D 分类、备份、稳定引用和失败重试均在 Manager 内完成。 */
export function ensurePresetSystemReady(): PresetMigrationState {
  const migrationPath = testBaseDirOverride ? join(testBaseDirOverride, 'agent-preset-migration.json') : getAgentPresetMigrationPath()
  const previous = readJsonFileSafe<PresetMigrationState>(migrationPath)
  // version 3 重新盘点旧迁移结果：version 2 可能已把 D1/D2 当作
  // workspace 副本或漏掉部分裸引用，不能再以 completed 短路。
  if (previous?.version === 3 && previous.status === 'completed') return previous
  const startedAt = previous?.startedAt ?? new Date().toISOString()
  const remappedIds: PresetMigrationState['remappedIds'] = []
  const diagnostics: PresetMigrationState['diagnostics'] = []
  const failures: string[] = []
  const completedWorkspaces: string[] = []
  let changedAny = false

  try {
    const workspaces = getMigrationWorkspaces()
    const workspaceIdToSlug = new Map(workspaces.map((workspace) => [workspace.id, workspace.slug]))
    const remaps = new Map<string, string>()
    for (const workspace of workspaces) {
      const filePath = getConfigFilePath(workspace.slug)
      if (!filePath || !existsSync(filePath)) continue
      try {
        // 无论后续 JSON/条目校验是否成功，先保存原文，保证 D4 失败路径仍可恢复。
        backupPresetMigrationFile(filePath, workspace.slug, startedAt)
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<AgentPresetConfig>
        if (!Array.isArray(raw.presets)) {
          if (raw.presets !== undefined) throw new Error('presets 不是数组')
          continue
        }
        const malformed = raw.presets.filter((preset) => !isValidLegacyPreset(preset))
        const malformedUnknown = malformed.find((preset) => {
          const id = typeof preset === 'object' && preset !== null ? (preset as { id?: unknown }).id : undefined
          return typeof id !== 'string' || !BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === id)
        })
        if (malformedUnknown) throw new Error('存在无法识别且缺少必要字段的损坏预设')
        const legacyPresets = raw.presets.filter((preset): preset is AgentPreset => isValidLegacyPreset(preset))
        const malformedBuiltins = malformed.map((preset) => (preset as { id: string }).id)
        const duplicateIds = [...new Set(legacyPresets.map((preset) => preset.id).filter((id, index, ids) => ids.indexOf(id) !== index))]
        if (duplicateIds.length > 0) {
          diagnostics.push({ workspaceSlug: workspace.slug, status: 'id-conflict', reason: `旧配置包含重复预设 ID（${duplicateIds.join(', ')}），旧裸引用无法精确消歧；已保留源文件，需人工处理后重试` })
          throw new Error(`存在无法精确消歧的重复预设 ID: ${duplicateIds.join(', ')}`)
        }
        const originalById = new Map(legacyPresets.map((preset) => [preset.id, preset]))
        const used = new Set<string>()
        const migrated: AgentPreset[] = []
        for (const malformedBuiltinId of malformedBuiltins) {
          diagnostics.push({ workspaceSlug: workspace.slug, presetId: malformedBuiltinId, status: 'builtin-corrupt', reason: '内置预设字段损坏，已备份原配置并恢复为 builtin-meta 引用' })
        }
        for (const legacy of legacyPresets) {
          const builtin = BUILTIN_AGENT_PRESETS.find((candidate) => candidate.id === legacy.id)
          const looksLikeBuiltin = Boolean(builtin)
          const isNormalBuiltinCopy = Boolean(builtin && presetJsonFingerprint(legacy) === presetJsonFingerprint(builtin))
          if (isNormalBuiltinCopy) {
            // D1/D2：旧物理副本不再作为 workspace 定义，只保留稳定 builtin-meta 引用。
            // 若旧文件明确记录了关闭状态，迁移到工作区 override，禁止默认重新开启。
            if (legacy.enabledInWorkspace === false) {
              const disabled = new Set(raw.disabledGlobalPresetIds ?? [])
              disabled.add(legacy.id)
              raw.disabledGlobalPresetIds = [...disabled]
            }
            continue
          }
          let id = legacy.id
          let status: AgentPreset['migrationStatus']
          let reason: string | undefined
          if (looksLikeBuiltin) {
            id = randomUUID()
            status = 'builtin-corrupt'
            reason = '内置 ID 内容与官方基线不一致，按 D3/D5 保护为 workspace 预设'
            remappedIds.push({ workspaceSlug: workspace.slug, oldId: legacy.id, newId: id, reason: 'builtin-conflict' })
          } else if (used.has(id)) {
            // 理论上 duplicateIds 已在上方拦截；此守卫防止未来新增输入路径绕过消歧检查。
            throw new Error(`存在无法精确消歧的重复预设 ID: ${id}`)
          }
          used.add(id)
          const migratedPreset = withScope({ ...legacy, id, isBuiltin: false }, 'workspace', workspace.slug)
          if (status) { migratedPreset.migrationStatus = status; migratedPreset.migrationReason = reason }
          const base = baseReferenceForLegacyPreset(legacy, workspace.slug, originalById)
          if (base) migratedPreset.basePresetReference = base
          if (legacy.basePresetId && !base) {
            migratedPreset.migrationStatus = 'invalid-base'
            migratedPreset.migrationReason = `无法解析旧基座: ${legacy.basePresetId}`
            diagnostics.push({ workspaceSlug: workspace.slug, presetId: id, status: 'invalid-base', reason: migratedPreset.migrationReason })
          } else if (hasPresetBaseCycle(legacy, originalById, workspace.slug)) {
            migratedPreset.migrationStatus = 'invalid-base'
            migratedPreset.migrationReason = '检测到预设继承循环，保留原基座字段并禁止静默修复'
            diagnostics.push({ workspaceSlug: workspace.slug, presetId: id, status: 'invalid-base', reason: migratedPreset.migrationReason })
          }
          if (status) diagnostics.push({ workspaceSlug: workspace.slug, presetId: id, status, reason: reason! })
          migrated.push(migratedPreset)
          if (id !== legacy.id) remaps.set(`${workspace.slug}:${legacy.id}`, id)
        }
        const oldDefault = typeof raw.defaultPresetId === 'string' ? raw.defaultPresetId : DEFAULT_PRESET_ID
        const defaultId = remaps.get(`${workspace.slug}:${oldDefault}`) ?? oldDefault
        const defaultReference: PresetReference = BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === defaultId)
          ? { presetId: defaultId, presetScope: 'builtin-meta', presetVersion: BUILTIN_AGENT_PRESETS.find((builtin) => builtin.id === defaultId)?.version }
          : { presetId: defaultId, presetScope: 'workspace', workspaceSlug: workspace.slug }
        const next: AgentPresetConfig = { ...raw, presets: migrated, defaultPresetId: defaultId, defaultPresetReference: defaultReference, migrationDiagnostics: diagnostics.filter((item) => item.workspaceSlug === workspace.slug).map(({ presetId, status, reason }) => ({ presetId, status, reason })) }
        if (JSON.stringify(next) !== JSON.stringify(raw)) {
          writeJsonFileAtomic(filePath, next)
          changedAny = true
        }
        completedWorkspaces.push(workspace.slug)
      } catch (error) {
        failures.push(`${workspace.slug}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    migratePresetReferencesInFile(getMigrationIndexPath(getAgentSessionsIndexPath, 'agent-sessions.json'), (value) => {
      const workspaceSlug = typeof value.workspaceId === 'string' ? workspaceIdToSlug.get(value.workspaceId) : undefined
      return migrateLegacyReference(value, workspaceSlug, remaps, failures)
    }, startedAt)
    migratePresetReferencesInFile(getMigrationIndexPath(getAutomationsPath, 'automations.json'), (value) => {
      const workspaceSlug = typeof value.workspaceId === 'string' ? workspaceIdToSlug.get(value.workspaceId) : undefined
      return migrateLegacyReference(value, workspaceSlug, remaps, failures)
    }, startedAt)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  const state: PresetMigrationState = {
    version: 3,
    status: failures.length ? 'failed' : 'completed',
    result: changedAny ? 'migrated' : 'no-history',
    startedAt,
    ...(failures.length === 0 ? { completedAt: new Date().toISOString() } : {}),
    completedWorkspaces: [...new Set(completedWorkspaces)],
    remappedIds,
    diagnostics,
    failures,
  }
  mkdirSync(dirname(migrationPath), { recursive: true })
  writeJsonFileAtomic(migrationPath, state)
  return state
}

function migrateLegacyReference<T extends Record<string, unknown>>(value: T, workspaceSlug: string | undefined, remaps: Map<string, string>, failures: string[]): T {
  if (typeof value.presetId !== 'string' || value.presetReference) return value
  if (!workspaceSlug) {
    failures.push(`引用 ${value.presetId} 缺少可确认的 workspaceSlug，保留裸引用待处理`)
    return value
  }
  const oldId = value.presetId
  const remappedId = remaps.get(`${workspaceSlug}:${oldId}`) ?? oldId
  const presetScope: AgentPresetScope = BUILTIN_AGENT_PRESETS.some((preset) => preset.id === remappedId) ? 'builtin-meta' : 'workspace'
  return { ...value, presetId: remappedId, presetReference: { presetId: remappedId, presetScope, ...(presetScope === 'workspace' ? { workspaceSlug } : {}) } }
}

function migratePresetReferencesInFile(filePath: string, transform: (value: Record<string, unknown>) => Record<string, unknown>, startedAt: string): void {
  const data = readJsonFileSafe<Record<string, unknown>>(filePath)
  if (!data) return
  const collectionKey = Array.isArray(data.sessions) ? 'sessions' : Array.isArray(data.automations) ? 'automations' : undefined
  if (!collectionKey) return
  const collection = data[collectionKey] as unknown[]
  const migrated = collection.map((item) => typeof item === 'object' && item !== null ? transform(item as Record<string, unknown>) : item)
  if (JSON.stringify(migrated) === JSON.stringify(collection)) return
  backupPresetMigrationFile(filePath, collectionKey, startedAt)
  writeJsonFileAtomic(filePath, { ...data, [collectionKey]: migrated })
}

/** 查询 user-global 的有效工作区引用；副本 source 元数据不算 blocker。 */
export function getPresetReferenceReport(reference: PresetReference): PresetReferenceReport {
  const normalized = normalizePresetReference(reference)
  const preset = resolvePresetReference(normalized)
  const blockers: PresetWorkspaceReference[] = []
  const { listAgentWorkspaces } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const { listAgentSessions } = require('./agent-session-manager') as typeof import('./agent-session-manager')
  const { listAutomations } = require('./automation-manager') as typeof import('./automation-manager')
  const workspaces = listAgentWorkspaces().filter((workspace) => !workspace.isDeleted)
  const workspaceScopes = (normalized.presetScope === 'user-global' || normalized.presetScope === 'builtin-meta')
    ? workspaces.filter((workspace) => {
        const scopes = readGlobalConfig().workspaceScopes?.[normalized.presetId]
        return scopes === undefined || scopes.includes(workspace.slug)
      }).map((workspace) => ({ workspaceSlug: workspace.slug, workspaceName: workspace.name }))
    : []
  for (const workspace of workspaces) {
    const objects: Array<{ reason: PresetWorkspaceReference['reason']; id: string }> = []
    const workspaceConfig = readConfig(workspace.slug)
    const configuredScopes = readGlobalConfig().workspaceScopes?.[normalized.presetId]
    const globalScopeActive = normalized.presetScope !== 'user-global' || configuredScopes === undefined || configuredScopes.includes(workspace.slug)
    if (!globalScopeActive) continue
    const defaultReference = workspaceConfig.defaultPresetReference ?? presetReferenceForId(workspace.slug, workspaceConfig.defaultPresetId)
    if (defaultReference.presetScope === normalized.presetScope && defaultReference.presetId === preset.id) objects.push({ reason: 'workspace-default', id: workspace.slug })
    for (const session of listAgentSessions(true)) {
      if (session.workspaceId !== workspace.id || session.archived) continue
      const sessionReference = (session as AgentSessionMetaWithReference).presetReference
        ?? presetReferenceForId(workspace.slug, session.presetId)
      if (sessionReference.presetScope === normalized.presetScope && sessionReference.presetId === preset.id) objects.push({ reason: 'session', id: session.id })
    }
    for (const automation of listAutomations()) {
      if (automation.workspaceId !== workspace.id || !automation.active) continue
      const automationReference = (automation as AutomationWithReference).presetReference
        ?? presetReferenceForId(workspace.slug, automation.presetId)
      if (automationReference.presetScope === normalized.presetScope && automationReference.presetId === preset.id) objects.push({ reason: 'automation', id: automation.id })
    }
    if (objects.length) {
      for (const group of ['workspace-default', 'session', 'automation'] as const) {
        const ids = objects.filter((item) => item.reason === group).map((item) => item.id)
        if (!ids.length) continue
        blockers.push({ workspaceSlug: workspace.slug, workspaceName: workspace.name, status: 'active', reason: group, objectIds: ids, objectCount: ids.length, actions: ['rebind', 'disable', 'inspect'] })
      }
    }
  }
  return { preset: normalized, blockers, workspaceScopes, totalCount: blockers.reduce((sum, item) => sum + item.objectCount, 0), canDelete: blockers.length === 0 }
}

interface AgentSessionMetaWithReference { presetReference?: PresetReference }
interface AutomationWithReference { presetReference?: PresetReference }

/** 工作区默认预设改绑：显式 scope 校验并返回更新后的引用。 */
export function setDefaultPresetReference(workspaceSlug: string, reference: PresetReference): PresetReference {
  const normalized = normalizePresetReference(reference, workspaceSlug)
  if (normalized.presetScope === 'user-global' || normalized.presetScope === 'builtin-meta') {
    const workspaceConfig = readConfig(workspaceSlug)
    if (workspaceConfig.disabledGlobalPresetIds?.includes(normalized.presetId)) {
      throw new AgentPresetError('PRESET_NOT_FOUND', `预设已在当前工作区禁用: ${normalized.presetId}`)
    }
    // 先在无工作区上下文中确认实体存在且继承关系有效，再扩展作用域；否则
    // “设为默认”会因为当前工作区尚未在 scope 中而永远无法完成。
    const preset = resolvePresetReference(normalized)
    const globalConfig = readGlobalConfig()
    globalConfig.workspaceScopes = { ...(globalConfig.workspaceScopes ?? {}), [normalized.presetId]: [...new Set([...(globalConfig.workspaceScopes?.[normalized.presetId] ?? []), workspaceSlug])] }
    writeGlobalConfig(globalConfig)
    const config = readConfig(workspaceSlug)
    config.defaultPresetId = preset.id
    config.defaultPresetReference = normalized
    writeConfig(workspaceSlug, config)
    return normalized
  }
  const preset = resolvePresetReference(normalized, workspaceSlug)
  const config = readConfig(workspaceSlug)
  config.defaultPresetId = preset.id
  config.defaultPresetReference = normalized
  writeConfig(workspaceSlug, config)
  return normalized
}

/** 直接解除用户全局预设在工作区的生效范围；保留已有引用，发送时由解析器报告失效。 */
function listKnownWorkspaceSlugs(): string[] {
  const { listAgentWorkspaces } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  return listAgentWorkspaces().filter((workspace) => !workspace.isDeleted).map((workspace) => workspace.slug)
}

export function enableGlobalPresetInWorkspace(workspaceSlug: string, reference: PresetReference): void {
  const normalized = normalizePresetReference(reference)
  if (normalized.presetScope !== 'user-global' && normalized.presetScope !== 'builtin-meta') throw new AgentPresetError('PRESET_READ_ONLY', '只有全局或元预设可以添加工作区范围')
  resolvePresetReference(normalized)
  const config = readGlobalConfig()
  const scopes = config.workspaceScopes?.[normalized.presetId]
  const nextScopes = [...new Set([...(scopes ?? listKnownWorkspaceSlugs()), workspaceSlug])]
  writeGlobalConfig({ ...config, workspaceScopes: { ...(config.workspaceScopes ?? {}), [normalized.presetId]: nextScopes } })
}

export function disableGlobalPresetInWorkspace(workspaceSlug: string, reference: PresetReference): void {
  const normalized = normalizePresetReference(reference)
  if (normalized.presetScope !== 'user-global' && normalized.presetScope !== 'builtin-meta') throw new AgentPresetError('PRESET_READ_ONLY', '只有全局或元预设可以解除工作区范围')
  resolvePresetReference(normalized)
  const globalConfig = readGlobalConfig()
  const scopes = globalConfig.workspaceScopes?.[normalized.presetId]
  const activeScopes = scopes ?? listKnownWorkspaceSlugs()
  globalConfig.workspaceScopes = { ...(globalConfig.workspaceScopes ?? {}), [normalized.presetId]: activeScopes.filter((slug) => slug !== workspaceSlug) }
  writeGlobalConfig(globalConfig)
  const config = readConfig(workspaceSlug)
  const defaultReference = config.defaultPresetReference
  const defaultMatches = defaultReference
    ? (defaultReference.presetScope === normalized.presetScope && defaultReference.presetId === normalized.presetId)
    : config.defaultPresetId === normalized.presetId
  if (defaultMatches) {
    config.defaultPresetId = ''
    config.defaultPresetExplicitlyCleared = true
    delete config.defaultPresetReference
    writeConfig(workspaceSlug, config)
  }
}

/** 会话预设改绑；同时写入兼容 presetId 和唯一 reference。 */
export function rebindAgentSessionPreset(sessionId: string, reference: PresetReference): AgentSessionMeta {
  const { getAgentSessionMeta, updateAgentSessionMeta } = require('./agent-session-manager') as typeof import('./agent-session-manager')
  const session = getAgentSessionMeta(sessionId)
  if (!session) throw new AgentPresetError('PRESET_NOT_FOUND', `会话不存在: ${sessionId}`)
  const workspaceSlug = session.workspaceId
    ? (require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')).getAgentWorkspace(session.workspaceId)?.slug
    : undefined
  const normalized = normalizePresetReference(reference, workspaceSlug)
  const preset = resolvePresetReference(normalized, workspaceSlug)
  return updateAgentSessionMeta(sessionId, { presetId: preset.id, presetReference: normalized })
}

/** 自动任务预设改绑；undefined/空引用表示跟随工作区默认。 */
export function rebindAutomationPreset(automationId: string, reference: PresetReference | null): Automation {
  const { getAutomation, updateAutomation } = require('./automation-manager') as typeof import('./automation-manager')
  const automation = getAutomation(automationId)
  if (!automation) throw new AgentPresetError('PRESET_NOT_FOUND', `自动任务不存在: ${automationId}`)
  if (reference === null) {
    const updated = updateAutomation({ id: automationId, presetId: '' })
    if (!updated) throw new AgentPresetError('PRESET_NOT_FOUND', `自动任务不存在: ${automationId}`)
    return updated
  }
  const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const workspaceSlug = automation.workspaceId ? getAgentWorkspace(automation.workspaceId)?.slug : undefined
  const normalized = normalizePresetReference(reference, workspaceSlug)
  const preset = resolvePresetReference(normalized, workspaceSlug)
  const updated = updateAutomation({ id: automationId, presetId: preset.id, presetReference: normalized })
  if (!updated) throw new AgentPresetError('PRESET_NOT_FOUND', `自动任务不存在: ${automationId}`)
  return updated
}

export function deleteGlobalAgentPreset(reference: PresetReference): void {
  const normalized = normalizePresetReference(reference)
  if (normalized.presetScope !== 'user-global') throw new AgentPresetError('PRESET_READ_ONLY', '只有 user-global 预设可以删除')
  const report = getPresetReferenceReport(normalized)
  if (!report.canDelete) throw new AgentPresetError('PRESET_DELETE_BLOCKED', '预设仍被工作区有效引用，请先解除或改绑', report)
  const config = readGlobalConfig()
  const next = config.presets.filter((preset) => preset.id !== normalized.presetId)
  if (next.length === config.presets.length) throw new AgentPresetError('PRESET_NOT_FOUND', `全局预设不存在: ${normalized.presetId}`)
  const workspaceScopes = { ...(config.workspaceScopes ?? {}) }
  delete workspaceScopes[normalized.presetId]
  writeGlobalConfig({ ...config, presets: next, workspaceScopes })
}

// ============================================================
// 自定义预设 CRUD（工作区级）
// ============================================================

/** 内置 ID 守卫：内置预设不可修改/删除。 */
function assertNotBuiltin(presetId: string): void {
  if (BUILTIN_AGENT_PRESETS.some((b) => b.id === presetId)) {
    throw new AgentPresetError('PRESET_READ_ONLY', `内置预设不可修改或删除: ${presetId}`)
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
  if (readGlobalConfig().presets.some((p) => p.id === presetId)) return presetId
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
    scope: 'workspace',
    version: '1.0.0',
    workspaceSlug,
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
  // enabledInWorkspace 只用于本地显示/启停，不写入预设内容字段。
  existing.updatedAt = Date.now()

  writeConfig(workspaceSlug, config)
  return existing
}

/** 切换工作区级预设的显示/生效状态；排序和内容保持不变。 */
export function setWorkspacePresetEnabled(workspaceSlug: string, presetId: string, enabled: boolean): void {
  const config = readConfig(workspaceSlug)
  if (!config.presets.some((preset) => preset.id === presetId)) throw new AgentPresetError('PRESET_NOT_FOUND', `预设不存在: ${presetId}`)
  const disabled = new Set(config.disabledWorkspacePresetIds ?? [])
  if (enabled) disabled.delete(presetId)
  else disabled.add(presetId)
  config.disabledWorkspacePresetIds = [...disabled]
  if (config.defaultPresetId === presetId && !enabled) {
    config.defaultPresetId = ''
    config.defaultPresetExplicitlyCleared = true
    delete config.defaultPresetReference
  }
  writeConfig(workspaceSlug, config)
}

/** 删除工作区自定义预设；内置预设拒绝；若删除默认预设则清空默认值。 */
export function deleteAgentPreset(workspaceSlug: string | undefined, presetId: string): void {
  assertNotBuiltin(presetId)
  const config = readConfig(workspaceSlug)
  const index = config.presets.findIndex((p) => p.id === presetId)
  if (index === -1) throw new Error(`预设不存在: ${presetId}`)

  config.presets.splice(index, 1)
  // 被删预设正作为默认：清空默认值，由新会话/发送前选择器要求用户主动选择。
  if (config.defaultPresetId === presetId) {
    config.defaultPresetId = ''
    config.defaultPresetExplicitlyCleared = true
    delete config.defaultPresetReference
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
  if (presetId === undefined) return DEFAULT_PRESET_ID
  if (!presetId.trim()) return ''
  return resolvePresetId(workspaceSlug, presetId)
}
