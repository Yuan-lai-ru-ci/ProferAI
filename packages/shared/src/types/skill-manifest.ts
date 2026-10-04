/**
 * Skill 模块清单（SKILL.json）共享类型与纯校验。
 *
 * 设计意图：把「模块是什么、需要什么、从哪来」从正文 frontmatter 里独立出来，变成
 * 有 schema、可校验、可被 UI / 分发 / 插件共同读取的机器清单。正文（SKILL.md）继续
 * 负责方法说明，本文件不读取文件系统，也不做任何磁盘判断。
 *
 * 兼容策略：清单缺失时全部字段可由 frontmatter 与旧路由侧车（profer-routing.json）
 * 回退推导；清单存在时按字段优先，冲突由 skill-doctor 报出，不在解析层偷偷合并。
 */
import { AGENT_PRESET_CAPABILITY_GROUPS, type AgentPresetToolGroup } from './agent-preset'

/** 当前支持的清单版本；遇到更高版本一律不信任字段，退回 frontmatter / 侧车。 */
export const SKILL_MANIFEST_SCHEMA_VERSION = 1

/** 模块清单文件名，与正文 SKILL.md 成对出现。 */
export const SKILL_MANIFEST_FILENAME = 'SKILL.json'

/** 清单可声明的适用表面；未声明表示不限。 */
export const SKILL_MANIFEST_SURFACES = ['desktop', 'cli', 'pocket'] as const
export type SkillManifestSurface = (typeof SKILL_MANIFEST_SURFACES)[number]

export interface SkillManifestInterface {
  /** 展示名；缺省时用 name。 */
  displayName?: string
  /** 短描述：列表、搜索与路由优先使用的文本；缺省回退 description。 */
  shortDescription?: string
  /** 建议的首轮提问；只作引导，不参与触发。 */
  defaultPrompt?: string
  /** 图标相对路径（相对 Skill 目录，不得越界）。 */
  icon?: string
  /** 品牌色 #rgb / #rrggbb。 */
  brandColor?: string
}

export interface SkillManifestPolicy {
  /** 是否允许自动触发；false 时只接受显式引用（等价 Codex allow_implicit_invocation=false）。 */
  implicit?: boolean
  /** 适用表面；未声明表示全部。 */
  surfaces?: readonly SkillManifestSurface[]
}

export interface SkillManifestTriggers {
  /** 作者声明的触发词；用户会怎么说，由作者负责。 */
  keywords?: readonly string[]
  /** 排除词：命中即不自动触发。 */
  excludeKeywords?: readonly string[]
}

export interface SkillManifestDependencies {
  /** 依赖的能力组（工具组），id 必须在 AGENT_PRESET_CAPABILITY_GROUPS 中存在。 */
  toolGroups?: readonly AgentPresetToolGroup[]
  /** 依赖的具体工具名，支持 mcp__server__tool 全名或短名。 */
  tools?: readonly string[]
  /** 依赖的 MCP 服务器名。 */
  mcpServers?: readonly string[]
  /** 依赖的外部命令（CLI）。当前只作声明与诊断，不参与运行时门禁。 */
  commands?: readonly string[]
}

export interface SkillManifestRequires {
  /** 依赖的宿主语义类（例如 .table）；由 doctor 与宿主契约清单核对。 */
  hostClasses?: readonly string[]
}

export interface SkillManifestProvenance {
  kind: 'bundled' | 'user' | 'workspace' | 'plugin' | 'imported'
  /** 来源标识（内置 skillId、插件 id、导入 URL/文件名）。 */
  id?: string
  /** 内容哈希，用于分发与升级判断。 */
  contentHash?: string
}

export interface SkillManifest {
  schemaVersion: number
  slug?: string
  name?: string
  /** 人类可读描述；与 interface.shortDescription 同时存在时以短描述为路由文本。 */
  description?: string
  version?: string
  interface?: SkillManifestInterface
  policy?: SkillManifestPolicy
  triggers?: SkillManifestTriggers
  dependencies?: SkillManifestDependencies
  requires?: SkillManifestRequires
  provenance?: SkillManifestProvenance
}

export type SkillManifestIssueCode =
  | 'not-an-object'
  | 'missing-schema-version'
  | 'unsupported-schema-version'
  | 'invalid-field'
  | 'unknown-field'
  | 'unsafe-path'
  | 'duplicate-description'

export type SkillManifestIssueSeverity = 'error' | 'warning'

export interface SkillManifestIssue {
  code: SkillManifestIssueCode
  severity: SkillManifestIssueSeverity
  message: string
  /** 出问题的字段路径，例如 interface.icon。 */
  field?: string
}

/**
 * 清单写入补丁（UI / 导入器唯一允许的写入口：不暴露「整份覆写」）。
 *
 * 字段语义统一为三态：`undefined` 不动、`null` / 空字符串 / 空数组删除该字段、其他值覆盖。
 */
export interface SkillManifestPatch {
  name?: string | null
  description?: string | null
  version?: string | null
  provenance?: SkillManifestProvenance | null
  interface?: SkillManifestPatchGroup<SkillManifestInterface>
  policy?: SkillManifestPatchGroup<SkillManifestPolicy>
  triggers?: SkillManifestPatchGroup<SkillManifestTriggers>
  dependencies?: SkillManifestPatchGroup<SkillManifestDependencies>
  requires?: SkillManifestPatchGroup<SkillManifestRequires>
}

/** 对象组的补丁形状：每个字段都可单独声明为「删掉」。 */
export type SkillManifestPatchGroup<T> = { [K in keyof T]?: T[K] | null } | null

export interface SkillManifestParseResult {
  /** 仅当清单可用（是对象、版本受支持）时返回；有 warning 时仍返回。 */
  manifest?: SkillManifest
  issues: SkillManifestIssue[]
}

const KNOWN_TOP_LEVEL_FIELDS = new Set(['schemaVersion', 'slug', 'name', 'description', 'version', 'interface', 'policy', 'triggers', 'dependencies', 'requires', 'provenance'])
const KNOWN_INTERFACE_FIELDS = new Set(['displayName', 'shortDescription', 'defaultPrompt', 'icon', 'brandColor'])
const KNOWN_POLICY_FIELDS = new Set(['implicit', 'surfaces'])
const KNOWN_TRIGGER_FIELDS = new Set(['keywords', 'excludeKeywords'])
const KNOWN_DEPENDENCY_FIELDS = new Set(['toolGroups', 'tools', 'mcpServers', 'commands'])
const KNOWN_REQUIRES_FIELDS = new Set(['hostClasses'])
const KNOWN_PROVENANCE_FIELDS = new Set(['kind', 'id', 'contentHash'])
const SURFACE_SET = new Set<string>(SKILL_MANIFEST_SURFACES)
const AGENT_PRESET_CAPABILITY_GROUP_IDS = new Set<string>(AGENT_PRESET_CAPABILITY_GROUPS.map(group => group.id))
const PROVENANCE_KINDS = new Set(['bundled', 'user', 'workspace', 'plugin', 'imported'])
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const BRAND_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const MAX_TEXT_CHARS = 300
const MAX_LONG_TEXT_CHARS = 600
const MAX_ARRAY_ITEMS = 100
const MAX_ITEM_CHARS = 160

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readText(record: Record<string, unknown>, field: string, issues: SkillManifestIssue[], path: string, maxChars = MAX_TEXT_CHARS, required = false): string | undefined {
  const value = record[field]
  if (value === undefined) {
    if (required) issues.push({ code: 'invalid-field', severity: 'error', field: path, message: `${path} 不能为空` })
    return undefined
  }
  if (typeof value !== 'string' || !value.trim() || value.length > maxChars) {
    issues.push({ code: 'invalid-field', severity: 'error', field: path, message: `${path} 应为 1-${maxChars} 字符的非空字符串` })
    return undefined
  }
  return value.trim()
}

function readStringArray(record: Record<string, unknown>, field: string, issues: SkillManifestIssue[], path: string): string[] | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || value.some(item => typeof item !== 'string' || !item.trim() || item.length > MAX_ITEM_CHARS)) {
    issues.push({ code: 'invalid-field', severity: 'error', field: path, message: `${path} 应为不超过 ${MAX_ARRAY_ITEMS} 项的短字符串数组` })
    return undefined
  }
  return [...new Set(value.map(item => (item as string).trim()))]
}

function reportUnknownFields(record: Record<string, unknown>, known: Set<string>, path: string, issues: SkillManifestIssue[]): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) issues.push({ code: 'unknown-field', severity: 'warning', field: path ? `${path}.${key}` : key, message: `未知字段 ${path ? `${path}.` : ''}${key} 不会被使用` })
  }
}

function readSubRecord(record: Record<string, unknown>, field: string, issues: SkillManifestIssue[], path: string): Record<string, unknown> | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    issues.push({ code: 'invalid-field', severity: 'error', field: path, message: `${path} 应为对象` })
    return undefined
  }
  return value
}

function readSubRecordArray<T>(
  record: Record<string, unknown>,
  field: string,
  issues: SkillManifestIssue[],
  path: string,
  known: Set<string>,
  read: (input: Record<string, unknown>, issues: SkillManifestIssue[], path: string) => T,
): T | undefined {
  const input = readSubRecord(record, field, issues, path)
  if (!input) return undefined
  reportUnknownFields(input, known, path, issues)
  return read(input, issues, path)
}

/** 越界或绝对的图标路径视为硬错误：清单不能把宿主指向目录之外。 */
function safeRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(value)) return false
  return !value.split(/[\\/]/).includes('..')
}

/**
 * 纯校验：不读磁盘、不抛异常。版本缺失按 1 处理并提示；版本不受支持时不返回 manifest，
 * 让上层退回 frontmatter / 侧车，而不是用未来字段。
 */
export function parseSkillManifest(value: unknown): SkillManifestParseResult {
  const issues: SkillManifestIssue[] = []
  if (!isPlainObject(value)) {
    issues.push({ code: 'not-an-object', severity: 'error', message: 'SKILL.json 顶层应为对象' })
    return { issues }
  }
  reportUnknownFields(value, KNOWN_TOP_LEVEL_FIELDS, '', issues)

  const rawVersion = value.schemaVersion
  let schemaVersion = SKILL_MANIFEST_SCHEMA_VERSION
  if (rawVersion === undefined) {
    issues.push({ code: 'missing-schema-version', severity: 'warning', field: 'schemaVersion', message: `缺少 schemaVersion，按 ${SKILL_MANIFEST_SCHEMA_VERSION} 处理` })
  } else if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
    issues.push({ code: 'invalid-field', severity: 'error', field: 'schemaVersion', message: 'schemaVersion 应为正整数' })
    return { issues }
  } else if (rawVersion > SKILL_MANIFEST_SCHEMA_VERSION) {
    issues.push({ code: 'unsupported-schema-version', severity: 'error', field: 'schemaVersion', message: `schemaVersion ${rawVersion} 高于当前支持的 ${SKILL_MANIFEST_SCHEMA_VERSION}，已忽略清单` })
    return { issues }
  } else {
    schemaVersion = rawVersion
  }

  const manifest: SkillManifest = { schemaVersion }
  const slug = readText(value, 'slug', issues, 'slug')
  if (slug !== undefined) {
    // slug 会作为目录段使用，非法值不能进入清单，避免上层把它当路径。
    if (!SLUG_PATTERN.test(slug)) issues.push({ code: 'invalid-field', severity: 'error', field: 'slug', message: 'slug 只能是小写字母、数字与连字符' })
    else manifest.slug = slug
  }
  const name = readText(value, 'name', issues, 'name')
  if (name !== undefined) manifest.name = name
  const description = readText(value, 'description', issues, 'description', MAX_LONG_TEXT_CHARS)
  if (description !== undefined) manifest.description = description
  const version = readText(value, 'version', issues, 'version', 64)
  if (version !== undefined) {
    if (!VERSION_PATTERN.test(version)) issues.push({ code: 'invalid-field', severity: 'error', field: 'version', message: 'version 应为 semver（如 1.2.3）' })
    else manifest.version = version
  }

  const iface = readSubRecordArray(value, 'interface', issues, 'interface', KNOWN_INTERFACE_FIELDS, (input, list, path) => {
    const result: SkillManifestInterface = {}
    const displayName = readText(input, 'displayName', list, `${path}.displayName`)
    if (displayName !== undefined) result.displayName = displayName
    const shortDescription = readText(input, 'shortDescription', list, `${path}.shortDescription`, MAX_LONG_TEXT_CHARS)
    if (shortDescription !== undefined) result.shortDescription = shortDescription
    const defaultPrompt = readText(input, 'defaultPrompt', list, `${path}.defaultPrompt`, 500)
    if (defaultPrompt !== undefined) result.defaultPrompt = defaultPrompt
    const icon = readText(input, 'icon', list, `${path}.icon`)
    if (icon !== undefined) {
      if (!safeRelativePath(icon)) list.push({ code: 'unsafe-path', severity: 'error', field: `${path}.icon`, message: 'icon 必须是 Skill 目录内的相对路径' })
      else result.icon = icon
    }
    const brandColor = readText(input, 'brandColor', list, `${path}.brandColor`, 16)
    if (brandColor !== undefined) {
      if (!BRAND_COLOR_PATTERN.test(brandColor)) list.push({ code: 'invalid-field', severity: 'error', field: `${path}.brandColor`, message: 'brandColor 应为 #rgb 或 #rrggbb' })
      else result.brandColor = brandColor
    }
    return result
  })
  if (iface) manifest.interface = iface

  const policy = readSubRecordArray(value, 'policy', issues, 'policy', KNOWN_POLICY_FIELDS, (input, list, path) => {
    const result: SkillManifestPolicy = {}
    if (input.implicit !== undefined) {
      if (typeof input.implicit !== 'boolean') list.push({ code: 'invalid-field', severity: 'error', field: `${path}.implicit`, message: 'implicit 应为布尔值' })
      else result.implicit = input.implicit
    }
    const surfaces = readStringArray(input, 'surfaces', list, `${path}.surfaces`)
    if (surfaces) {
      const unknown = surfaces.filter(surface => !SURFACE_SET.has(surface))
      if (unknown.length) list.push({ code: 'invalid-field', severity: 'error', field: `${path}.surfaces`, message: `未知表面: ${unknown.join('、')}` })
      else result.surfaces = Object.freeze(surfaces as SkillManifestSurface[])
    }
    return result
  })
  if (policy) manifest.policy = policy

  const triggers = readSubRecordArray(value, 'triggers', issues, 'triggers', KNOWN_TRIGGER_FIELDS, (input, list, path) => {
    const result: SkillManifestTriggers = {}
    const keywords = readStringArray(input, 'keywords', list, `${path}.keywords`)
    if (keywords) result.keywords = Object.freeze(keywords)
    const excludeKeywords = readStringArray(input, 'excludeKeywords', list, `${path}.excludeKeywords`)
    if (excludeKeywords) result.excludeKeywords = Object.freeze(excludeKeywords)
    return result
  })
  if (triggers) manifest.triggers = triggers

  const dependencies = readSubRecordArray(value, 'dependencies', issues, 'dependencies', KNOWN_DEPENDENCY_FIELDS, (input, list, path) => {
    const result: SkillManifestDependencies = {}
    const toolGroups = readStringArray(input, 'toolGroups', list, `${path}.toolGroups`)
    if (toolGroups) {
      const unknown = toolGroups.filter(group => !AGENT_PRESET_CAPABILITY_GROUP_IDS.has(group))
      if (unknown.length) list.push({ code: 'invalid-field', severity: 'error', field: `${path}.toolGroups`, message: `未知能力组: ${unknown.join('、')}` })
      else result.toolGroups = Object.freeze(toolGroups as AgentPresetToolGroup[])
    }
    const tools = readStringArray(input, 'tools', list, `${path}.tools`)
    if (tools) result.tools = Object.freeze(tools)
    const mcpServers = readStringArray(input, 'mcpServers', list, `${path}.mcpServers`)
    if (mcpServers) result.mcpServers = Object.freeze(mcpServers)
    const commands = readStringArray(input, 'commands', list, `${path}.commands`)
    if (commands) result.commands = Object.freeze(commands)
    return result
  })
  if (dependencies) manifest.dependencies = dependencies

  const requires = readSubRecordArray(value, 'requires', issues, 'requires', KNOWN_REQUIRES_FIELDS, (input, list, path) => {
    const result: SkillManifestRequires = {}
    const hostClasses = readStringArray(input, 'hostClasses', list, `${path}.hostClasses`)
    if (hostClasses) {
      const invalid = hostClasses.filter(item => /\s/.test(item))
      if (invalid.length) list.push({ code: 'invalid-field', severity: 'error', field: `${path}.hostClasses`, message: '宿主语义类不能包含空白字符' })
      else result.hostClasses = Object.freeze(hostClasses)
    }
    return result
  })
  if (requires) manifest.requires = requires

  const provenance = readSubRecordArray(value, 'provenance', issues, 'provenance', KNOWN_PROVENANCE_FIELDS, (input, list, path) => {
    const result: SkillManifestProvenance = { kind: 'bundled' }
    const kind = readText(input, 'kind', list, `${path}.kind`, 32, true)
    if (kind !== undefined) {
      if (!PROVENANCE_KINDS.has(kind)) list.push({ code: 'invalid-field', severity: 'error', field: `${path}.kind`, message: `未知来源类型: ${kind}` })
      else result.kind = kind as SkillManifestProvenance['kind']
    }
    const id = readText(input, 'id', list, `${path}.id`)
    if (id !== undefined) result.id = id
    const contentHash = readText(input, 'contentHash', list, `${path}.contentHash`, 128)
    if (contentHash !== undefined) result.contentHash = contentHash
    return result
  })
  if (provenance) manifest.provenance = provenance

  // 两个描述字段都能当路由文本，同时存在且不一致就是第二份真相：提示作者只留一个。
  const shortDescription = manifest.interface?.shortDescription
  if (shortDescription && manifest.description && shortDescription !== manifest.description) {
    issues.push({ code: 'duplicate-description', severity: 'warning', field: 'description', message: 'description 与 interface.shortDescription 同时存在且不一致；路由按 shortDescription，建议只保留一处' })
  }
  return { manifest, issues }
}

/** 清单声明的路由字段；能力组已在本文件校验，外部不再重复判断。 */
export interface SkillManifestRoutingFields {
  keywords?: readonly string[]
  excludeKeywords?: readonly string[]
  implicit?: boolean
  requiredTools?: readonly string[]
  requiredMcpServers?: readonly string[]
  requiredToolGroups?: readonly AgentPresetToolGroup[]
}

/** 把清单映射为路由字段；未声明返回空对象，交给侧车与内置依赖补齐。 */
export function skillManifestToRoutingFields(manifest: SkillManifest | undefined): SkillManifestRoutingFields {
  if (!manifest) return {}
  const fields: SkillManifestRoutingFields = {}
  if (manifest.triggers?.keywords) fields.keywords = manifest.triggers.keywords
  if (manifest.triggers?.excludeKeywords) fields.excludeKeywords = manifest.triggers.excludeKeywords
  if (manifest.policy?.implicit !== undefined) fields.implicit = manifest.policy.implicit
  if (manifest.dependencies?.tools) fields.requiredTools = manifest.dependencies.tools
  if (manifest.dependencies?.mcpServers) fields.requiredMcpServers = manifest.dependencies.mcpServers
  if (manifest.dependencies?.toolGroups) fields.requiredToolGroups = manifest.dependencies.toolGroups
  return fields
}

/** 路由与列表优先使用的描述文本：短描述 > 描述。 */
export function skillManifestDescription(manifest: SkillManifest | undefined): string | undefined {
  return manifest?.interface?.shortDescription ?? manifest?.description
}

/** 展示名：interface.displayName > name。 */
export function skillManifestDisplayName(manifest: SkillManifest | undefined): string | undefined {
  return manifest?.interface?.displayName ?? manifest?.name
}

// ===== 医生诊断（类型共享，诊断逻辑仍在主进程）=====

export type SkillDoctorSeverity = 'error' | 'warning' | 'info'

export type SkillDoctorCode =
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'manifest-unknown-field'
  | 'manifest-slug-mismatch'
  | 'manifest-frontmatter-mismatch'
  | 'routing-duplicated'
  | 'description-missing'
  | 'description-too-short'
  | 'description-no-usage-marker'
  | 'keywords-missing'
  | 'keywords-redundant'
  | 'triggers-in-manifest'
  | 'dependency-tool-unavailable'
  | 'dependency-group-disabled'
  | 'host-class-missing'
  | 'body-oversize'

export interface SkillDoctorIssue {
  code: SkillDoctorCode
  severity: SkillDoctorSeverity
  message: string
  field?: string
}
