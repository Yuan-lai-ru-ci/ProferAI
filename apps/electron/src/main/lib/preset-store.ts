/**
 * 预设存储（PresetStore）——工作区预设的唯一读写入口
 *
 * 两种后端，语义对外一致（错误码、默认引用回退链、规范化规则都不变）：
 *
 * - `managed`：`<configDir>/agent-presets.json` 单文件，与改造前逐字节一致（I1 零回归）。
 * - `project`：`<configDir>/presets/` 目录
 *   - `_config.json`（`schema: "profer.presets/1"`）：工作区级配置，不含 `presets` 数组
 *   - `<presetId>.json`（`schema: "profer.preset/1"`）：单个岗位，剥离 `scope` /
 *     `workspaceSlug` / `enabledInWorkspace` 等机器派生字段，可提交、可 review。
 *
 * 兼容（审计 §8 / P1-4）：`presets/_config.json` 存在才算目录权威（忽略遗留 `agent-presets.json`，仅产出诊断）；
 * 目录不存在时读旧单文件，行为等同 managed；目录存在但没有 `_config.json`（首次拆分为未提交 / 目录被手工
 * 创建）时回退旧单文件并记 `legacy-fallback`；首次写入自动拆分（先写预设文件、最后写 `_config.json`），
 * 旧文件保留不动。中途失败不会留下权威目录，因此不会遮蔽旧岗位。
 *
 * 只读诊断（审计 §7）：引用一致性（`skillSlugs` / `mcpServerNames` 缺失、MCP 不可用）、
 * 非法文件、未知 schema、遗留单文件。诊断**不修改**任何预设数据，也不改变运行时裁剪语义。
 *
 * 写锁（P2-B）：project 后端的单次写事务持有 `presets/.lock`（`openSync(…, 'wx')` 原子创建），
 * 让同一项目的两个 Profer 实例不会交错写 `_config.json` / `<presetId>.json`。
 * 锁只序列化写：读路径不加锁、不阻塞；managed 后端逐字不变（无锁）。
 * 它不解决「跨实例 read-modify-write 丢更新」（manager 的读在锁外），见下面「写锁」小节的遗留风险注释。
 *
 * 刻意不做的事：
 * - 不在读取路径做任何写操作（项目可能只读、可能被 git 占用）；写操作只发生在 write* 上。
 * - 不 import `agent-preset-manager`（manager 反向 import 本模块，会成环），也不 import
 *   `config-paths`（路径全部由 locator 的 `configDir` 派生，避免 mkdir 副作用）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  AGENT_PRESET_SUPPRESS_KEYS,
  AGENT_PRESET_TOOL_GROUPS,
  AGENT_PRESET_TOOL_NAMES,
  AgentPresetError,
  BUILTIN_AGENT_PRESETS,
  DEFAULT_PRESET_ID,
} from '@profer/shared'
import type {
  AgentPreset,
  AgentPresetConfig,
  AgentPresetMigrationDiagnostic,
  AgentPresetScope,
  AgentPresetSuppressKey,
  AgentPresetToolGroup,
  WorkspaceStorageMode,
} from '@profer/shared'
import { writeJsonFileAtomic } from './safe-file'
import { resolveWorkspaceLocation, WorkspaceRootMissingError } from './workspace-locator'

/** `_config.json` schema（主版本不认识 → 只读，禁止保存）。 */
export const PRESET_CONFIG_SCHEMA = 'profer.presets/1'
/** 单预设文件 schema；与 `preset.version`（实体版本）无关。 */
export const PRESET_FILE_SCHEMA = 'profer.preset/1'

const PRESET_CONFIG_SCHEMA_PREFIX = 'profer.presets/'
const PRESET_FILE_SCHEMA_PREFIX = 'profer.preset/'
const PRESETS_DIR_NAME = 'presets'
const PRESET_CONFIG_FILENAME = '_config.json'
const LEGACY_PRESET_FILENAME = 'agent-presets.json'
/** 预设文件名白名单：防路径穿越（`../`、分隔符、控制字符一律拒绝写入）。 */
const PRESET_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/**
 * 预设目录里被 Profer 自己占用的文件名（不含扩展名）。
 * 这些名字必须从预设 id 白名单里排除，否则用户仓库里一个 `id: "_config"` 的预设会在
 * 重命名/写入时落到 `presets/_config.json`，把目录配置整个覆盖掉（配置字段静默丢失）。
 */
const RESERVED_PRESET_FILE_STEMS = new Set([PRESET_CONFIG_FILENAME.slice(0, -'.json'.length)])

function isReservedPresetId(presetId: string): boolean {
  return RESERVED_PRESET_FILE_STEMS.has(presetId)
}
/** 运行时派生字段：不写入项目资产（读取时由 manager 按当前工作区补齐）。 */
const RUNTIME_PRESET_FIELDS = new Set(['scope', 'workspaceSlug', 'enabledInWorkspace'])

// ============================================================
// 诊断
// ============================================================

export type PresetStoreDiagnosticKind =
  /** 单个文件非法（JSON 损坏 / 缺 id / id 非法 / 文件名与 id 不符 / 重复 id / 遮蔽内置 id） */
  | 'invalid-file'
  /** schema 主版本不认识：可读不可写 */
  | 'unknown-schema'
  /** 目录存在但缺少 `_config.json`（目录尚未提交，不是权威） */
  | 'missing-preset-config'
  /**
   * 目录存在但没有 `_config.json`（首次拆分未提交 / 目录被手工创建），
   * 已回退读取旧单文件 `agent-presets.json`（P1-4）
   */
  | 'legacy-fallback'
  /** 目录已生效，遗留 `agent-presets.json` 被忽略 */
  | 'legacy-preset-file-ignored'
  /** 默认引用指向不存在的预设（读取时已静默回退，这里显式暴露） */
  | 'default-missing'
  /** `skillSlugs` 命中不到任何生效技能 */
  | 'missing-skill'
  /** `mcpServerNames` 在合并后的 MCP 配置里不存在 */
  | 'missing-mcp'
  /** MCP 服务器存在但 `enabled === false` */
  | 'unavailable-mcp'

export interface PresetStoreDiagnostic {
  kind: PresetStoreDiagnosticKind
  /** 出问题的对象：文件名、预设 id、技能 slug 或 MCP 名 */
  ref: string
  /** 归属预设（引用类诊断才有） */
  presetId?: string
  detail?: string
}

// ============================================================
// 对外接口
// ============================================================

/**
 * 预设存储接口（规格 §2.4）。
 *
 * 方法签名带 `workspaceSlug`：内部按 `storageMode` 选后端，调用方只认这一层，
 * 不关心项目是目录还是单文件。
 */
export interface PresetStore {
  readConfig(workspaceSlug: string): AgentPresetConfig
  writeConfig(workspaceSlug: string, config: AgentPresetConfig): void
  readPreset(workspaceSlug: string, presetId: string): AgentPreset | null
  writePreset(workspaceSlug: string, preset: AgentPreset): void
  deletePreset(workspaceSlug: string, presetId: string): void
  listDiagnostics(workspaceSlug: string): PresetStoreDiagnostic[]
}

// ============================================================
// 测试替身
// ============================================================

/**
 * 测试用基础目录覆盖：设置后所有工作区强制按 managed 单文件解析到
 * `<baseDir>/<slug>/agent-presets.json`，与改造前的 `__setAgentPresetsBaseDirForTest` 语义一致。
 *
 * 生产路径不受影响；project 模式用例请用 `PROFER_CONFIG_DIR` + 索引文件走真实 locator。
 */
let testBaseDirOverride: string | null = null

export function __setPresetStoreBaseDirForTest(baseDir: string): void {
  testBaseDirOverride = baseDir
  invalidatePresetStoreCache()
}

export function __resetPresetStoreBaseDirForTest(): void {
  testBaseDirOverride = null
  invalidatePresetStoreCache()
}

interface PresetStorageTarget {
  mode: WorkspaceStorageMode
  configDir: string
  /** project 模式的项目根（managed 与 configDir 相同）：写路径必须先校验它存在（I4）。 */
  rootPath: string
}

function resolveTarget(workspaceSlug: string): PresetStorageTarget {
  if (testBaseDirOverride) {
    const configDir = join(testBaseDirOverride, workspaceSlug)
    return { mode: 'managed', configDir, rootPath: configDir }
  }
  const location = resolveWorkspaceLocation(workspaceSlug)
  return { mode: location.mode, configDir: location.configDir, rootPath: location.rootPath }
}

/**
 * 写路径的 I4 断言（P0-2）：project 的 rootPath 不在时**绝不**创建任何目录。
 *
 * `presets/` 目录是 rootPath 的子目录，一旦在 rootPath 缺失时 `mkdir -p`，就会把
 * 被移走的项目（或未挂载的外接卷挂载点）整条父链重建出来，遮蔽挂载点并让「项目凭空变空」。
 * 抛 `WorkspaceRootMissingError`（与 `config-paths` 的写路径同一错误类型），由上层提示
 * 「项目路径不可用，请先重新定位」。
 */
function assertProjectRootExists(target: PresetStorageTarget): void {
  if (target.mode !== 'project') return
  let isDirectory = false
  try {
    isDirectory = statSync(target.rootPath).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) throw new WorkspaceRootMissingError(target.rootPath)
}

/** 当前工作区的存储模式（manager 用于门禁：project 不走单文件迁移）。 */
export function getPresetStorageMode(workspaceSlug: string): WorkspaceStorageMode {
  return resolveTarget(workspaceSlug).mode
}

/** 项目模式预设目录（managed 返回 null）。纯路径，不创建目录。 */
export function getPresetStoreDir(workspaceSlug: string): string | null {
  const target = resolveTarget(workspaceSlug)
  return target.mode === 'project' ? join(target.configDir, PRESETS_DIR_NAME) : null
}

// ============================================================
// 作用域 / 规范化（与 managed 单文件共用同一套规则）
// ============================================================

/** 强制重写预设作用域字段（读取时补齐，写入前剥离）。 */
export function withPresetScope(preset: AgentPreset, scope: AgentPresetScope, workspaceSlug?: string): AgentPreset {
  return {
    ...preset,
    scope,
    ...(scope === 'workspace' && workspaceSlug ? { workspaceSlug } : {}),
    ...(scope !== 'workspace' ? { workspaceSlug: undefined } : {}),
    version: preset.version ?? '1.0.0',
  }
}

/**
 * 工作区预设规范化：补齐作用域 + 过滤历史脏数据（非法 suppress key / 工具组 / 单工具）。
 *
 * 必须与 managed 单文件完全一致——目录格式不允许出现第二套清洗规则（审计 §6.5）。
 */
export function normalizeWorkspacePresets(rawPresets: unknown[], workspaceSlug: string): AgentPreset[] {
  const presets = rawPresets
    .filter((preset): preset is AgentPreset => Boolean(preset) && typeof preset === 'object')
    .map((preset) => withPresetScope(preset, 'workspace', workspaceSlug))

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
    // 单工具禁用必须是已知短名（防御手工编辑 JSON 遗留值；未知短名直接剔除）
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

  return presets
}

/** 空配置：与 manager 的 `getDefaultConfig()` 对齐（不含默认引用，由 manager 解析后补齐）。 */
function getEmptyConfig(): AgentPresetConfig {
  return { presets: [], defaultPresetId: DEFAULT_PRESET_ID, disabledGlobalPresetIds: [], disabledWorkspacePresetIds: [] }
}

/**
 * 配置级字段过滤（两种后端共用）。
 *
 * - `disabledGlobalPresetIds`：只去掉空串（全局预设可能暂时不在本机，不做存在性裁剪）。
 * - `disabledWorkspacePresetIds`：只保留目录/文件里仍存在的 id（与 managed 现有逻辑一致）。
 */
function toWorkspaceConfig(raw: Partial<AgentPresetConfig>, presets: AgentPreset[]): AgentPresetConfig {
  const disabledGlobalPresetIds = Array.isArray(raw.disabledGlobalPresetIds)
    ? raw.disabledGlobalPresetIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  const disabledWorkspacePresetIds = Array.isArray(raw.disabledWorkspacePresetIds)
    ? raw.disabledWorkspacePresetIds.filter((id): id is string =>
      typeof id === 'string' && presets.some((preset) => preset.id === id))
    : []
  const defaultPresetId = typeof raw.defaultPresetId === 'string'
    ? raw.defaultPresetId.trim()
    : (raw.defaultPresetExplicitlyCleared ? '' : DEFAULT_PRESET_ID)
  return {
    presets,
    defaultPresetId,
    // 骨架文件会写 `defaultPresetReference: null`：视为「未设置」，不保留空值。
    ...(raw.defaultPresetReference ? { defaultPresetReference: raw.defaultPresetReference } : {}),
    ...(raw.defaultPresetExplicitlyCleared ? { defaultPresetExplicitlyCleared: true } : {}),
    disabledGlobalPresetIds,
    disabledWorkspacePresetIds,
    ...(Array.isArray(raw.migrationDiagnostics)
      ? { migrationDiagnostics: raw.migrationDiagnostics as AgentPresetMigrationDiagnostic[] }
      : {}),
  }
}

// ============================================================
// 序列化（稳定键序 + 未知字段 round-trip）
// ============================================================

/** 单预设文件键序：固定顺序输出，保证 git diff 可读。 */
const PRESET_FILE_KEY_ORDER: Array<keyof AgentPreset> = [
  'id', 'name', 'description', 'version', 'isBuiltin', 'createdAt', 'updatedAt',
  'promptSections', 'suppressPromptSections', 'disabledToolGroups', 'disabledTools',
  'effort', 'permissionMode', 'skillSlugs', 'mcpServerNames', 'allowSubagents',
  'basePresetId', 'basePresetReference', 'sourcePresetId', 'sourcePresetScope',
  'sourceVersion', 'copiedAt', 'migrationStatus', 'migrationReason',
]

/** 未知字段 round-trip：已知字段与运行时派生字段之外的键原样带回。 */
function pickUnknownPresetFields(raw: Record<string, unknown>): Record<string, unknown> {
  const known = new Set<string>(PRESET_FILE_KEY_ORDER)
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'schema' || known.has(key) || RUNTIME_PRESET_FIELDS.has(key)) continue
    extras[key] = value
  }
  return extras
}

function serializePresetFile(preset: AgentPreset, extras: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { schema: PRESET_FILE_SCHEMA }
  for (const key of PRESET_FILE_KEY_ORDER) {
    const value = preset[key]
    if (value === undefined) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(extras)) {
    if (key === 'schema' || key in out) continue
    out[key] = value
  }
  return out
}

interface PresetLegacySource {
  /** 旧单文件相对 `.profer` 的路径 */
  file: string
  importedAt: string
}

/**
 * 默认引用落盘形式：workspace 作用域**省略 workspaceSlug**。
 *
 * 项目可以被 clone 到另一台机器，slug 是本机索引分配的（且可能重命名）；
 * 写进文件会变成跨机器残留。读时由 manager 注入当前工作区（设计 §5.4 规则 3）。
 */
function serializeDefaultReference(reference: AgentPresetConfig['defaultPresetReference']): AgentPresetConfig['defaultPresetReference'] {
  if (!reference || reference.presetScope !== 'workspace') return reference
  const { workspaceSlug: _omitted, ...rest } = reference
  return rest
}

/** `_config.json` 键序：schema 在最前，与审计 §6.2 示例一致。 */
function serializeConfigFile(
  config: AgentPresetConfig,
  extras: Record<string, unknown> = {},
  legacySource?: PresetLegacySource,
): Record<string, unknown> {
  const out: Record<string, unknown> = { schema: PRESET_CONFIG_SCHEMA }
  if (config.defaultPresetId) out.defaultPresetId = config.defaultPresetId
  const defaultReference = serializeDefaultReference(config.defaultPresetReference)
  if (defaultReference) out.defaultPresetReference = defaultReference
  if (config.defaultPresetExplicitlyCleared) out.defaultPresetExplicitlyCleared = true
  out.disabledGlobalPresetIds = config.disabledGlobalPresetIds ?? []
  out.disabledWorkspacePresetIds = config.disabledWorkspacePresetIds ?? []
  if (config.migrationDiagnostics?.length) out.migrationDiagnostics = config.migrationDiagnostics
  if (legacySource) out.legacySource = legacySource
  for (const [key, value] of Object.entries(extras)) {
    if (key === 'schema' || key in out) continue
    out[key] = value
  }
  return out
}

/** 解析 schema 字符串：主版本 1 = 可读写；缺失 = 旧格式（可读，写入升级）；其他 = 只读。 */
function parseSchemaMajor(value: unknown, prefix: string): number | null {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith(prefix)) return null
  const major = Number(trimmed.slice(prefix.length))
  return Number.isInteger(major) && major >= 0 ? major : null
}

// ============================================================
// managed 后端：单文件 `agent-presets.json`（零回归）
// ============================================================

function readManagedConfig(workspaceSlug: string, configDir: string): AgentPresetConfig {
  const filePath = join(configDir, LEGACY_PRESET_FILENAME)
  if (!existsSync(filePath)) return getEmptyConfig()

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<AgentPresetConfig>
    const presets = normalizeWorkspacePresets(Array.isArray(data.presets) ? data.presets : [], workspaceSlug)
    return toWorkspaceConfig(data, presets)
  } catch (error) {
    console.error('[Agent 预设] 读取配置失败:', error)
    return getEmptyConfig()
  }
}

function writeManagedConfig(configDir: string, config: AgentPresetConfig): void {
  const filePath = join(configDir, LEGACY_PRESET_FILENAME)
  mkdirSync(configDir, { recursive: true })
  try {
    writeJsonFileAtomic(filePath, config)
  } catch (error) {
    throw new AgentPresetError('PRESET_WRITE_FAILED', `工作区预设写入失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ============================================================
// project 后端：`presets/` 目录
// ============================================================

interface DirectoryState {
  config: AgentPresetConfig
  diagnostics: PresetStoreDiagnostic[]
  /** `_config.json`（或整个目录）只能读：未知 schema 主版本 / 配置损坏 */
  readOnly: boolean
  readOnlyReason?: string
  /** `_config.json` 未知字段（round-trip 保留） */
  configExtras: Record<string, unknown>
  /** 单预设文件未知字段（round-trip 保留） */
  presetExtras: Map<string, Record<string, unknown>>
  /**
   * 预设 id → 目录里的真实文件名（P0-1 删除侧的唯一真相）。
   *
   * 文件名与内容 id 允许不一致（审计 §7 只记诊断、不静默丢数据），因此删除绝不能
   * 用 id 拼路径，必须回到这里查真实文件名。
   */
  presetFileNames: Map<string, string>
  /** 单预设文件 schema 未知：可读，写时保持原文件不动 */
  readOnlyPresetIds: Set<string>
  /** 旧单文件拆分来源（写回时保留） */
  legacySource?: PresetLegacySource
  /**
   * 本次读取回退到了旧单文件（目录存在但无 `_config.json`，P1-4）。
   *
   * 写回时据此补记 `legacySource`：目录不是首次创建，但数据确实来自旧单文件。
   */
  legacyFallback?: boolean
}

function fileSignature(filePath: string): string {
  try {
    const stat = statSync(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/** 目录签名：文件名 + mtime + size（只 stat 不读内容），用于缓存失效判定。 */
function storageSignature(configDir: string): string {
  const dir = join(configDir, PRESETS_DIR_NAME)
  const legacySignature = fileSignature(join(configDir, LEGACY_PRESET_FILENAME))
  if (!existsSync(dir)) return `legacy:${legacySignature}`
  let dirSignature: string
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    const parts = names.map((name) => `${name}@${fileSignature(join(dir, name))}`)
    dirSignature = `dir:${parts.join('|')}`
  } catch {
    dirSignature = 'dir:unreadable'
  }
  // 目录没有 `_config.json` 时读取会回退旧单文件：签名必须带上旧文件，否则旧文件被改/删后缓存不失效
  return existsSync(join(dir, PRESET_CONFIG_FILENAME)) ? dirSignature : `${dirSignature}+legacy:${legacySignature}`
}

function readConfigFileExtras(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const known = new Set([
    'schema', 'presets', 'defaultPresetId', 'defaultPresetReference',
    'defaultPresetExplicitlyCleared', 'disabledGlobalPresetIds',
    'disabledWorkspacePresetIds', 'migrationDiagnostics', 'legacySource',
  ])
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawConfig)) {
    if (known.has(key)) continue
    extras[key] = value
  }
  return extras
}

function parseLegacySource(value: unknown): PresetLegacySource | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { file?: unknown; importedAt?: unknown }
  if (typeof candidate.file !== 'string' || typeof candidate.importedAt !== 'string') return undefined
  return { file: candidate.file, importedAt: candidate.importedAt }
}

function buildDirectoryState(workspaceSlug: string, configDir: string): DirectoryState {
  const dir = join(configDir, PRESETS_DIR_NAME)
  const configPath = join(dir, PRESET_CONFIG_FILENAME)
  const legacyPath = join(configDir, LEGACY_PRESET_FILENAME)
  const diagnostics: PresetStoreDiagnostic[] = []
  const presetExtras = new Map<string, Record<string, unknown>>()
  const presetFileNames = new Map<string, string>()
  const readOnlyPresetIds = new Set<string>()

  // ---- 1. `_config.json`（配置级字段；`presets` 的唯一真相是目录里的文件） ----
  let rawConfig: Record<string, unknown> = {}
  let readOnly = false
  let readOnlyReason: string | undefined
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        readOnly = true
        readOnlyReason = `${PRESET_CONFIG_FILENAME} 不是 JSON 对象`
        diagnostics.push({ kind: 'invalid-file', ref: PRESET_CONFIG_FILENAME, detail: 'not-an-object' })
      } else {
        rawConfig = parsed as Record<string, unknown>
      }
    } catch {
      readOnly = true
      readOnlyReason = `${PRESET_CONFIG_FILENAME} 无法解析`
      diagnostics.push({ kind: 'invalid-file', ref: PRESET_CONFIG_FILENAME, detail: 'invalid-json' })
    }
    const major = parseSchemaMajor(rawConfig.schema, PRESET_CONFIG_SCHEMA_PREFIX)
    // 缺失 schema = 旧/手写配置（可读，首次写入升级）；未知主版本 = 只读。
    if (major === null || major > 1) {
      readOnly = true
      readOnlyReason = `未知 schema: ${String(rawConfig.schema)}`
      diagnostics.push({ kind: 'unknown-schema', ref: PRESET_CONFIG_FILENAME, detail: String(rawConfig.schema) })
    }
  } else {
    diagnostics.push({ kind: 'missing-preset-config', ref: PRESET_CONFIG_FILENAME })
  }

  // ---- 2. 单个预设文件（文件名 = presetId，按文件名序读取，重复 id 取首个） ----
  const presets: AgentPreset[] = []
  const seenIds = new Set<string>()
  let fileNames: string[] = []
  try {
    fileNames = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== PRESET_CONFIG_FILENAME).sort()
  } catch {
    fileNames = []
  }
  for (const fileName of fileNames) {
    const presetFileId = fileName.slice(0, -'.json'.length)
    if (!PRESET_FILE_ID_PATTERN.test(presetFileId)) {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, detail: 'invalid-filename' })
      continue
    }
    let raw: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, fileName), 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-an-object')
      raw = parsed as Record<string, unknown>
    } catch {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, detail: 'invalid-json' })
      continue
    }
    const presetId = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!presetId) {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, detail: 'missing-id' })
      continue
    }
    // P0-1：内容 id 必须同时是合法文件名。删除侧按真实文件名删，但 id 仍是 UI / 提示词 /
    // 默认引用的主键；放行 `../../package` 这类 id 等于把穿越入口带进配置（历史上删除分支
    // 会拿它拼路径）。不合法就整个文件不采纳，绝不「只记诊断然后继续用」。
    if (!PRESET_FILE_ID_PATTERN.test(presetId)) {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, presetId, detail: 'invalid-id' })
      continue
    }
    // 保留文件名（`_config`）不能当预设 id：写入按 id 归位会覆盖目录配置。
    if (isReservedPresetId(presetId)) {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, presetId, detail: 'reserved-id' })
      continue
    }
    if (BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === presetId)) {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, presetId, detail: 'builtin-shadowed' })
      continue
    }
    if (seenIds.has(presetId)) {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, presetId, detail: 'duplicate-id' })
      continue
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      diagnostics.push({ kind: 'invalid-file', ref: fileName, presetId, detail: 'missing-name' })
      continue
    }
    if (presetFileId !== presetId) {
      // 以内容 id 为准，写入时按 id 归位（不静默丢数据，也不静默改文件名）
      diagnostics.push({ kind: 'invalid-file', ref: fileName, presetId, detail: 'filename-mismatch' })
    }
    const major = parseSchemaMajor(raw.schema, PRESET_FILE_SCHEMA_PREFIX)
    if (major === null || major > 1) {
      diagnostics.push({ kind: 'unknown-schema', ref: fileName, presetId, detail: String(raw.schema) })
      readOnlyPresetIds.add(presetId)
    }
    seenIds.add(presetId)
    presetFileNames.set(presetId, fileName)
    presetExtras.set(presetId, pickUnknownPresetFields(raw))
    presets.push(...normalizeWorkspacePresets([raw], workspaceSlug))
  }

  // ---- 3. 遗留单文件：目录权威，只诊断不读取 ----
  if (existsSync(legacyPath)) {
    diagnostics.push({ kind: 'legacy-preset-file-ignored', ref: LEGACY_PRESET_FILENAME })
  }

  const config = toWorkspaceConfig(rawConfig as Partial<AgentPresetConfig>, presets)
  return {
    config,
    diagnostics,
    readOnly,
    ...(readOnlyReason ? { readOnlyReason } : {}),
    configExtras: readConfigFileExtras(rawConfig),
    presetExtras,
    presetFileNames,
    readOnlyPresetIds,
    ...(parseLegacySource(rawConfig.legacySource) ? { legacySource: parseLegacySource(rawConfig.legacySource)! } : {}),
  }
}

const directoryStateCache = new Map<string, { signature: string; state: DirectoryState }>()

/** 缓存键带上 configDir：同一个 slug 在模式切换后不会命中上一个目录的缓存。 */
function presetCacheKey(workspaceSlug: string, configDir: string): string {
  return `${workspaceSlug}::${configDir}`
}

function readDirectoryState(workspaceSlug: string, configDir: string): DirectoryState {
  const cacheKey = presetCacheKey(workspaceSlug, configDir)
  const signature = storageSignature(configDir)
  const cached = directoryStateCache.get(cacheKey)
  if (cached && cached.signature === signature) return cached.state

  const state = buildStateForConfigDir(workspaceSlug, configDir)
  directoryStateCache.set(cacheKey, { signature, state })
  return state
}

/**
 * 选择读取后端：`_config.json` 是「目录已生效」的唯一提交标记（P1-4）。
 *
 * 历史实现把「`presets/` 目录存在」当作权威，只要目录在（哪怕是空的 / 首次拆分失败
 * 回滚后残留的）旧单文件 `agent-presets.json` 就被忽略，用户视角等于岗位全丢。
 * 现在只有 `presets/_config.json` 存在才算目录权威：
 *
 * - 目录不存在 → 旧布局（与 managed 行为一致）；
 * - `_config.json` 存在 → 目录权威；
 * - 目录存在但无 `_config.json`，且旧单文件存在 → 回退旧单文件 + `legacy-fallback`；
 * - 目录存在、无 `_config.json`、也无旧单文件 → 读目录里的散装文件（没有旧数据可遮蔽）。
 */
function buildStateForConfigDir(workspaceSlug: string, configDir: string): DirectoryState {
  const dir = join(configDir, PRESETS_DIR_NAME)
  const configPath = join(dir, PRESET_CONFIG_FILENAME)
  const legacyPath = join(configDir, LEGACY_PRESET_FILENAME)

  if (!existsSync(dir)) return buildLegacyState(workspaceSlug, configDir)
  if (existsSync(configPath)) return buildDirectoryState(workspaceSlug, configDir)
  if (existsSync(legacyPath)) {
    const state = buildLegacyState(workspaceSlug, configDir)
    state.diagnostics.push({ kind: 'legacy-fallback', ref: PRESETS_DIR_NAME, detail: 'missing-preset-config' })
    state.legacyFallback = true
    return state
  }
  return buildDirectoryState(workspaceSlug, configDir)
}

function buildLegacyState(workspaceSlug: string, configDir: string): DirectoryState {
  const legacyPath = join(configDir, LEGACY_PRESET_FILENAME)
  const diagnostics: PresetStoreDiagnostic[] = []
  let config = getEmptyConfig()
  if (existsSync(legacyPath)) {
    try {
      const data = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Partial<AgentPresetConfig>
      config = toWorkspaceConfig(data, normalizeWorkspacePresets(Array.isArray(data.presets) ? data.presets : [], workspaceSlug))
    } catch {
      // 旧文件损坏：保持默认配置 + 诊断；绝不因此创建空目录覆盖（审计 §8.1）
      diagnostics.push({ kind: 'invalid-file', ref: LEGACY_PRESET_FILENAME, detail: 'invalid-json' })
    }
  }
  return {
    config,
    diagnostics,
    readOnly: false,
    configExtras: {},
    presetExtras: new Map(),
    presetFileNames: new Map(),
    readOnlyPresetIds: new Set(),
  }
}

// ============================================================
// 写锁（P2-B：同一项目的多实例互斥）
// ============================================================

/** 锁文件名：住在 `presets/` 里，跟着预设资产一起被项目 `.profer/.gitignore` 的 `.lock` 规则忽略。 */
const PRESET_LOCK_FILENAME = '.lock'
/** 首次尝试之外的追加重试次数。 */
const PRESET_LOCK_MAX_RETRIES = 3
/** 重试间隔（ms）：写路径全同步，因此用同步休眠而不是 setTimeout。 */
const PRESET_LOCK_RETRY_DELAY_MS = 50
/** 陈旧锁阈值（ms）：超过且持有进程已不存在才允许清理。 */
const PRESET_LOCK_STALE_MS = 30_000

/** 锁文件内容 `{ pid, createdAt, operation }`。 */
export interface PresetStoreLockHolder {
  /** 持有者进程 pid */
  pid: number
  /** 拿锁时间（epoch ms） */
  createdAt: number
  /** 该次写事务的入口（`writeConfig` / `writePreset` / `deletePreset`） */
  operation: string
}

/**
 * 预设目录被另一个 Profer 实例占用（`PRESET_CONCURRENT_UPDATE`）。
 *
 * 带 `lockPath` 与 `holder`：错误信息直接回答「谁在写、锁在哪」，不必翻日志。
 * 这是实例间互斥失败，不是版本冲突：什么时候重试由调用方/用户决定。
 */
export class PresetStoreLockedError extends AgentPresetError {
  readonly lockPath: string
  readonly holder: PresetStoreLockHolder | null
  readonly attempts: number

  constructor(lockPath: string, holder: PresetStoreLockHolder | null, attempts: number) {
    const holderText = holder
      ? `pid ${holder.pid} 正在执行 ${holder.operation}`
      : '持有者信息不可读'
    super(
      'PRESET_CONCURRENT_UPDATE',
      `预设目录被另一个 Profer 实例占用（${holderText}），请稍后重试: ${lockPath}`,
      { lockPath, holder, attempts },
    )
    this.name = 'PresetStoreLockedError'
    this.lockPath = lockPath
    this.holder = holder
    this.attempts = attempts
  }
}

/**
 * 测试钩子：持锁后、真正写盘前回调一次（参数为锁路径）。
 * 生产不设置；仅用于单测观察「锁在事务内存在且内容正确」。
 */
let writeLockObserverForTest: ((lockPath: string) => void) | null = null

export function __setPresetWriteLockObserverForTest(observer: ((lockPath: string) => void) | null): void {
  writeLockObserverForTest = observer
}

/**
 * 同步休眠：写路径是同步 API（不改签名），只能用 `Atomics.wait` 阻塞当前线程。
 * Node / Electron 主进程 / Bun 均可用；总计最长 150ms，不引入异步泄漏。
 */
const PRESET_LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(PRESET_LOCK_SLEEP_BUFFER, 0, 0, ms)
}

/** 读锁文件内容；读不到/格式不对返回 null（「持有者未知」，绝不据此抢锁）。 */
function readLockHolder(lockPath: string): PresetStoreLockHolder | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const raw = parsed as Record<string, unknown>
    const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null
    if (pid === null) return null
    // createdAt 正常是 epoch ms；容忍手工写的 ISO 字符串（便于用户排查）
    const createdAt = typeof raw.createdAt === 'number'
      ? raw.createdAt
      : (typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : Number.NaN)
    if (!Number.isFinite(createdAt)) return null
    return {
      pid,
      createdAt,
      operation: typeof raw.operation === 'string' && raw.operation.trim() ? raw.operation : 'unknown',
    }
  } catch {
    // 文件刚创建还没写完 / 已被别的实例清理：持有者未知
    return null
  }
}

/** 进程是否存活：`ESRCH` 才代表不存在；`EPERM` 说明存在但无权限，按存活处理。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 陈旧判定：超过阈值 **且** 持有进程已不存在。pid 存活一律不抢（哪怕已经写了很久）。 */
function isStaleLock(holder: PresetStoreLockHolder): boolean {
  const ageMs = Date.now() - holder.createdAt
  if (ageMs <= PRESET_LOCK_STALE_MS) return false
  return !isProcessAlive(holder.pid)
}

/** 原子抢锁：`wx` → 成功即持有；`EEXIST` → 有人先到。 */
function tryCreateLockFile(lockPath: string, operation: string): boolean {
  let fd: number
  try {
    fd = openSync(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw new AgentPresetError(
      'PRESET_WRITE_FAILED',
      `预设写锁创建失败: ${error instanceof Error ? error.message : String(error)}`,
      { lockPath },
    )
  }

  try {
    const holder: PresetStoreLockHolder = { pid: process.pid, createdAt: Date.now(), operation }
    writeSync(fd, JSON.stringify(holder))
  } catch (error) {
    // 半写的锁文件不可留：内容不可读会让其它实例只能干等
    try { unlinkSync(lockPath) } catch { /* 尽力清理 */ }
    throw new AgentPresetError(
      'PRESET_WRITE_FAILED',
      `预设写锁内容写入失败: ${error instanceof Error ? error.message : String(error)}`,
      { lockPath },
    )
  } finally {
    try { closeSync(fd) } catch { /* fd 已被回收 */ }
  }
  return true
}

/** 释放：只删自己写的锁（pid 不符说明锁已被清理后重建，不能替别人解锁）。 */
function releasePresetWriteLock(lockPath: string): void {
  const holder = readLockHolder(lockPath)
  if (holder && holder.pid !== process.pid) {
    console.warn(`[Agent 预设] 写锁归属已变更，跳过释放: ${lockPath}`)
    return
  }
  try {
    unlinkSync(lockPath)
  } catch (error) {
    // ENOENT：已被当作陈旧锁清理，不算失败
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[Agent 预设] 写锁释放失败:', lockPath, error)
    }
  }
}

/**
 * 获取写锁，返回释放函数（调用方必须放在 `finally` 里）。
 *
 * 语义：
 * - 首次尝试 + 最多 3 次重试（间隔 50ms），全失败抛 `PresetStoreLockedError`；
 * - 只有「超过 30 秒 **且** pid 已不存在」的陈旧锁会被清理后重试；
 * - pid 存活、或锁内容不可读时一律不抢。
 *
 * 遗留风险（已知、未在本项解决）：
 * - manager 的 read（`readConfig`）发生在拿锁前：两个实例各自基于旧快照回写时，后写者仍会覆盖前者的**配置级字段**。
 *   本锁保证「单次写事务不交错」，不提供跨实例的乐观并发控制（需版本号 / CAS）。
 * - 「读内容 → 判定陈旧 → unlink」之间没有原子性；竞争窗口内两个实例可能都判定陈旧，但随后 `wx` 只允许一个创建。
 * - 锁不可重入：同一进程内的嵌套写会把自己当「另一个实例」而失败（当前写路径无嵌套调用）。
 * - pid 复用：崩溃残留的锁若 pid 恰好被本进程复用，会判为「存活」而永久阻塞，需用户手工删 `.lock`。
 */
/** 抢到锁后统一收尾：先报给测试观察者，观察者抛错也要把锁放掉，不留泄漏。 */
function afterAcquirePresetLock(lockPath: string): () => void {
  const release = (): void => releasePresetWriteLock(lockPath)
  try {
    writeLockObserverForTest?.(lockPath)
  } catch (error) {
    release()
    throw error
  }
  return release
}

function acquirePresetWriteLock(presetsDir: string, operation: string): () => void {
  // 锁文件住在 presets/ 里，但**本函数不创建任何目录**：`presets/` 只能由
  // `writeDirectoryConfig` 在 rootPath 已验证存在后用 `mkdirSync` 建出来（P0-2）。
  if (!existsSync(presetsDir)) {
    throw new AgentPresetError('PRESET_WRITE_FAILED', `预设目录不存在，拒绝自动创建: ${presetsDir}`, { presetsDir })
  }
  const lockPath = join(presetsDir, PRESET_LOCK_FILENAME)
  const maxAttempts = PRESET_LOCK_MAX_RETRIES + 1
  let lastHolder: PresetStoreLockHolder | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) sleepSync(PRESET_LOCK_RETRY_DELAY_MS)
    if (tryCreateLockFile(lockPath, operation)) return afterAcquirePresetLock(lockPath)

    const current = readLockHolder(lockPath)
    if (current) {
      lastHolder = current
      if (isStaleLock(current)) {
        try { unlinkSync(lockPath) } catch { /* 别的实例先清了 */ }
        // 清理后立刻抢一次：抢到就走，抢不到说明有第三个实例，继续按重试节奏等
        if (tryCreateLockFile(lockPath, operation)) return afterAcquirePresetLock(lockPath)
      }
    }
  }

  throw new PresetStoreLockedError(lockPath, lastHolder, maxAttempts)
}

/**
 * 把预设 id（+ 真实文件名）解析成 `presets/` 内的绝对路径，越界一律返回 null。
 *
 * P0-1 双保险：`id` 与文件名都得过 `PRESET_FILE_ID_PATTERN`，且 `resolve(filePath)` 必须
 * 落在 `resolve(presetsDir) + sep` 里。两道都不通过就跳过（不删、不写），不把穿越变成
 * 一次删除事故。
 */
function resolvePresetFilePath(
  presetsDir: string,
  presetId: string,
  fileName?: string,
): string | null {
  if (!PRESET_FILE_ID_PATTERN.test(presetId)) return null
  if (isReservedPresetId(presetId)) return null
  const targetName = fileName ?? `${presetId}.json`
  if (!targetName.endsWith('.json')) return null
  const targetStem = targetName.slice(0, -'.json'.length)
  if (!PRESET_FILE_ID_PATTERN.test(targetStem)) return null
  if (isReservedPresetId(targetStem)) return null
  const filePath = join(presetsDir, targetName)
  if (!resolve(filePath).startsWith(resolve(presetsDir) + sep)) return null
  return filePath
}

/**
 * project 后端写入：锁只包住这一次「读状态 → 逐文件原子写 → 删除」事务。
 *
 * `dirExistedBefore` 必须在拿锁前采样：拿锁之前 `writeDirectoryConfig` 会先建 `presets/`（锁文件住在
 * 里面），否则首次拆分时 `legacySource` 会漏记。注意「目录存在」已不等于「目录权威」（P1-4 权威标记是
 * `_config.json`），所以这里只用来决定是否记 `legacySource`。
 */
function writeDirectoryConfig(
  workspaceSlug: string,
  target: PresetStorageTarget,
  next: AgentPresetConfig,
  operation = 'writeConfig',
): void {
  // P0-2：rootPath 校验必须在任何 mkdir 之前（包括锁目录）。
  assertProjectRootExists(target)

  const dir = join(target.configDir, PRESETS_DIR_NAME)
  const dirExistedBefore = existsSync(dir)
  // 仅在 rootPath 已验证存在后才创建 presets/；`recursive` 只会落在已存在的 root 内。
  mkdirSync(dir, { recursive: true })
  const releaseLock = acquirePresetWriteLock(dir, operation)
  try {
    writeDirectoryConfigUnlocked(workspaceSlug, target.configDir, next, dirExistedBefore)
  } finally {
    releaseLock()
  }
}

function writeDirectoryConfigUnlocked(
  workspaceSlug: string,
  configDir: string,
  next: AgentPresetConfig,
  dirExistedBefore: boolean,
): void {
  const dir = join(configDir, PRESETS_DIR_NAME)
  const configPath = join(dir, PRESET_CONFIG_FILENAME)
  const legacyPath = join(configDir, LEGACY_PRESET_FILENAME)
  const state = readDirectoryState(workspaceSlug, configDir)
  if (state.readOnly) {
    throw new AgentPresetError(
      'PRESET_WRITE_FAILED',
      `预设目录为只读（${state.readOnlyReason ?? '未知原因'}），请升级 Profer 或手工修复 ${configPath}`,
      { reason: state.readOnlyReason, configPath },
    )
  }

  // 首次拆分（或目录存在但从未提交 `_config.json`、读取回退过旧单文件）：记录旧单文件来源，
  // 便于人工核对；旧文件本身保留不动（P1-4）。
  const legacySource = state.legacySource
    ?? ((!dirExistedBefore || state.legacyFallback === true) && existsSync(legacyPath)
      ? { file: LEGACY_PRESET_FILENAME, importedAt: new Date().toISOString() }
      : undefined)

  // 目录已由 `writeDirectoryConfig` 在 rootPath 存在的前提下创建；这里不再 mkdir，
  // 避免未来把「递归重建父链」加回写路径（P0-2）。
  if (!existsSync(dir)) {
    throw new AgentPresetError('PRESET_WRITE_FAILED', `预设目录不存在: ${dir}`, { dir })
  }

  // 写入前按读取同一规则清洗（不存在的禁用 id、缺省默认 id），避免脏值落盘
  const normalized = toWorkspaceConfig(next, next.presets)
  const previousById = new Map(state.config.presets.map((preset) => [preset.id, preset]))
  const nextIds = new Set(normalized.presets.map((preset) => preset.id))
  const createdFiles: string[] = []

  try {
    // 0) 预检：schema 未知的单文件只读。任何修改尝试都要在动手前报错，绝不静默丢弃用户编辑。
    for (const preset of normalized.presets) {
      if (!state.readOnlyPresetIds.has(preset.id)) continue
      const previous = previousById.get(preset.id)
      const unchanged = previous !== undefined
        && JSON.stringify(serializePresetFile(previous)) === JSON.stringify(serializePresetFile(preset))
      if (!unchanged) {
        throw new AgentPresetError(
          'PRESET_WRITE_FAILED',
          `预设文件 schema 版本未知，已按只读处理，拒绝改写: ${preset.id}.json`,
          { presetId: preset.id, reason: 'read-only-schema' },
        )
      }
    }

    // 1) 新增 / 变更的预设文件（逐文件原子写，skipBackup：项目内不留 .bak 噪音）
    for (const preset of normalized.presets) {
      if (BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === preset.id)) continue
      if (!PRESET_FILE_ID_PATTERN.test(preset.id)) {
        throw new AgentPresetError('PRESET_WRITE_FAILED', `预设 ID 不是合法文件名（仅允许 [A-Za-z0-9_-]）: ${preset.id}`)
      }
      if (state.readOnlyPresetIds.has(preset.id)) continue
      // 写入侧同样走「白名单 + 目录内解析」双保险，不直接拼字符串
      const filePath = resolvePresetFilePath(dir, preset.id)
      if (!filePath) {
        throw new AgentPresetError('PRESET_WRITE_FAILED', `预设文件路径越界，拒绝写入: ${preset.id}`, { presetId: preset.id })
      }
      // 目录里还没有这个文件时一律写：旧单文件拆分/缓存命中都不能当做「已是目标内容」
      if (existsSync(filePath)) {
        const extras = state.presetExtras.get(preset.id)
        const previous = previousById.get(preset.id)
        if (previous && JSON.stringify(serializePresetFile(previous, extras)) === JSON.stringify(serializePresetFile(preset, extras))) continue
      }
      const existed = existsSync(filePath)
      writeJsonFileAtomic(filePath, serializePresetFile(preset, state.presetExtras.get(preset.id)), true)
      if (!existed) createdFiles.push(filePath)
    }

    // 2) `_config.json`：仅在实际变化时写（它同时是「目录已生效」的提交标记）
    const nextConfigFile = serializeConfigFile(normalized, state.configExtras, legacySource)
    const previousConfigFile = serializeConfigFile(state.config, state.configExtras, legacySource)
    if (!existsSync(configPath) || JSON.stringify(previousConfigFile) !== JSON.stringify(nextConfigFile)) {
      const existed = existsSync(configPath)
      writeJsonFileAtomic(configPath, nextConfigFile, true)
      if (!existed) createdFiles.push(configPath)
    }

    // 3) 删除多余预设文件（最后做：崩溃最坏是多一个可诊断文件，而不是引用悬空）
    //    P0-1：按「读状态时记录的真实文件名」删，绝不用 id 拼路径；
    //    没有映射（旧单文件拆分场景）或路径越界时跳过，留给下一轮诊断。
    for (const previous of state.config.presets) {
      if (nextIds.has(previous.id)) continue
      if (state.readOnlyPresetIds.has(previous.id)) continue
      const filePath = resolvePresetFilePath(dir, previous.id, state.presetFileNames.get(previous.id))
      if (!filePath) {
        console.warn(`[Agent 预设] 跳过不安全的预设文件删除: id=${previous.id} file=${state.presetFileNames.get(previous.id) ?? '<unknown>'}`)
        continue
      }
      if (!existsSync(filePath)) continue
      unlinkSync(filePath)
    }
  } catch (error) {
    // 只回滚本次新建的文件；已覆盖的既有文件不回滚（规格 §2.4 约束）
    for (const filePath of createdFiles) {
      try { unlinkSync(filePath) } catch { /* 回滚尽力而为 */ }
    }
    invalidatePresetStoreCache(workspaceSlug)
    if (error instanceof AgentPresetError) throw error
    throw new AgentPresetError(
      'PRESET_WRITE_FAILED',
      `工作区预设写入失败: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  invalidatePresetStoreCache(workspaceSlug)
}

// ============================================================
// 引用一致性诊断（只读，不改变运行时语义）
// ============================================================

/**
 * 可命中的技能 slug 集合；返回 null 表示无法判定（跳过 missing-skill，避免假阳性）。
 *
 * 走运行时同一投影（项目 `skills/` → 全局 `builtin/user`），不为诊断另写一套解析。
 */
function collectAvailableSkillSlugs(workspaceSlug: string): Set<string> | null {
  try {
    const skillManager = require('./global-skill-manager') as typeof import('./global-skill-manager')
    const skills = skillManager.resolveEffectiveSkills(workspaceSlug)
    return new Set(skills.map((skill) => skill.slug.toLowerCase()))
  } catch (error) {
    console.warn('[Agent 预设] 技能清单解析失败，跳过 missing-skill 诊断:', error)
    return null
  }
}

/** 合并 `mcp.json` ← `mcp.local.json` 的服务器名（只读；local 覆盖 base）。 */
function readMcpServers(configDir: string): Record<string, { enabled?: boolean }> {
  const merged: Record<string, { enabled?: boolean }> = {}
  for (const fileName of ['mcp.json', 'mcp.local.json']) {
    const filePath = join(configDir, fileName)
    if (!existsSync(filePath)) continue
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
      const servers = parsed.servers ?? parsed.mcpServers
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue
      for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
        const value = entry && typeof entry === 'object' ? entry as { enabled?: unknown } : {}
        merged[name] = typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}
      }
    } catch {
      // 损坏的 MCP 配置不参与诊断（运行时另有降级链路）
    }
  }
  return merged
}

function listReferenceDiagnostics(workspaceSlug: string, config: AgentPresetConfig, configDir: string): PresetStoreDiagnostic[] {
  const diagnostics: PresetStoreDiagnostic[] = []
  const availableSkills = collectAvailableSkillSlugs(workspaceSlug)
  const mcpServers = readMcpServers(configDir)

  for (const preset of config.presets) {
    for (const skillSlug of preset.skillSlugs ?? []) {
      if (!availableSkills) break
      if (!availableSkills.has(skillSlug.toLowerCase())) {
        diagnostics.push({ kind: 'missing-skill', ref: skillSlug, presetId: preset.id })
      }
    }
    for (const serverName of preset.mcpServerNames ?? []) {
      if (!(serverName in mcpServers)) {
        diagnostics.push({ kind: 'missing-mcp', ref: serverName, presetId: preset.id })
      } else if (mcpServers[serverName]?.enabled === false) {
        diagnostics.push({ kind: 'unavailable-mcp', ref: serverName, presetId: preset.id })
      }
    }
  }
  return diagnostics
}

// ============================================================
// 分派
// ============================================================

function readConfigFor(workspaceSlug: string): AgentPresetConfig {
  const target = resolveTarget(workspaceSlug)
  const config = target.mode === 'project'
    ? readDirectoryState(workspaceSlug, target.configDir).config
    : readManagedConfig(workspaceSlug, target.configDir)
  // 缓存里的 state 不能被调用方改到（manager 会直接 push/改配置后回写），统一返回副本
  return structuredClone(config)
}

function writeConfigFor(workspaceSlug: string, config: AgentPresetConfig, operation = 'writeConfig'): void {
  if (!workspaceSlug.trim()) throw new AgentPresetError('PRESET_WORKSPACE_REQUIRED', '预设管理需要工作区')
  const target = resolveTarget(workspaceSlug)
  // managed 单文件后端不加锁：行为与改造前逐字一致（P2-B 只覆盖 project 目录后端）
  if (target.mode === 'project') writeDirectoryConfig(workspaceSlug, target, config, operation)
  else writeManagedConfig(target.configDir, config)
}

function readPresetFor(workspaceSlug: string, presetId: string): AgentPreset | null {
  return readConfigFor(workspaceSlug).presets.find((preset) => preset.id === presetId) ?? null
}

function writePresetFor(workspaceSlug: string, preset: AgentPreset): void {
  if (BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === preset.id)) {
    throw new AgentPresetError('PRESET_READ_ONLY', `内置预设不可修改或删除: ${preset.id}`)
  }
  const config = readConfigFor(workspaceSlug)
  const exists = config.presets.some((item) => item.id === preset.id)
  const presets = exists
    ? config.presets.map((item) => (item.id === preset.id ? preset : item))
    : [...config.presets, preset]
  writeConfigFor(workspaceSlug, { ...config, presets }, 'writePreset')
}

function deletePresetFor(workspaceSlug: string, presetId: string): void {
  if (BUILTIN_AGENT_PRESETS.some((builtin) => builtin.id === presetId)) {
    throw new AgentPresetError('PRESET_READ_ONLY', `内置预设不可修改或删除: ${presetId}`)
  }
  const config = readConfigFor(workspaceSlug)
  const remaining = config.presets.filter((preset) => preset.id !== presetId)
  if (remaining.length === config.presets.length) throw new AgentPresetError('PRESET_NOT_FOUND', `预设不存在: ${presetId}`)

  const reference = config.defaultPresetReference
  const defaultMatches = reference
    ? reference.presetScope === 'workspace' && reference.presetId === presetId
    : config.defaultPresetId === presetId
  const diagnostics = [...(config.migrationDiagnostics ?? [])]

  const next: AgentPresetConfig = {
    presets: remaining,
    defaultPresetId: config.defaultPresetId,
    ...(config.defaultPresetReference ? { defaultPresetReference: config.defaultPresetReference } : {}),
    ...(config.defaultPresetExplicitlyCleared ? { defaultPresetExplicitlyCleared: true } : {}),
    disabledGlobalPresetIds: config.disabledGlobalPresetIds ?? [],
    disabledWorkspacePresetIds: (config.disabledWorkspacePresetIds ?? []).filter((id) => id !== presetId),
  }

  if (defaultMatches) {
    // 默认引用指向被删预设：回退 standard 并留诊断，不静默（规格 §2.4）
    next.defaultPresetId = DEFAULT_PRESET_ID
    next.defaultPresetReference = { presetId: DEFAULT_PRESET_ID, presetScope: 'builtin-meta' }
    delete next.defaultPresetExplicitlyCleared
    diagnostics.push({ presetId, status: 'default-missing', reason: '默认引用指向已删除的预设，已回退 standard' })
  }
  // 诊断数组在默认引用处理之后才确定，避免空数组快照丢掉后续推送
  if (diagnostics.length) next.migrationDiagnostics = diagnostics

  writeConfigFor(workspaceSlug, next, 'deletePreset')
}

function listDiagnosticsFor(workspaceSlug: string): PresetStoreDiagnostic[] {
  const target = resolveTarget(workspaceSlug)
  const storageDiagnostics = target.mode === 'project'
    ? [...readDirectoryState(workspaceSlug, target.configDir).diagnostics]
    : []

  const config = readConfigFor(workspaceSlug)
  const reference = config.defaultPresetReference
  if (reference && reference.presetScope === 'workspace' && !config.presets.some((preset) => preset.id === reference.presetId)) {
    storageDiagnostics.push({ kind: 'default-missing', ref: reference.presetId })
  }

  return [...storageDiagnostics, ...listReferenceDiagnostics(workspaceSlug, config, target.configDir)]
}

/** 预设存储单例（按 `storageMode` 分派）。 */
export const presetStore: PresetStore = {
  readConfig: readConfigFor,
  writeConfig: writeConfigFor,
  readPreset: readPresetFor,
  writePreset: writePresetFor,
  deletePreset: deletePresetFor,
  listDiagnostics: listDiagnosticsFor,
}

/** 让某个（或全部）工作区的目录缓存失效；写入后自动调用，外部改动也可显式触发。 */
export function invalidatePresetStoreCache(workspaceSlug?: string): void {
  if (workspaceSlug === undefined) {
    directoryStateCache.clear()
    return
  }
  const prefix = `${workspaceSlug}::`
  for (const key of [...directoryStateCache.keys()]) {
    if (key.startsWith(prefix)) directoryStateCache.delete(key)
  }
}
