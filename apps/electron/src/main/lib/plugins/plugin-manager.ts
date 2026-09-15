import { parsePluginCapabilities } from './plugin-capabilities'
import { app, BrowserWindow, dialog, shell } from 'electron'
import AdmZip from 'adm-zip'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PROFER_PLUGIN_ID_PATTERN,
  PROFER_PLUGIN_MANIFEST_FILE,
  PROFER_PLUGIN_PAGE_ID_PATTERN,
  PROFER_PLUGIN_PERMISSIONS,
  PROFER_PLUGIN_SCHEMA_VERSION,
  type ProferInstalledPlugin,
  type ProferPluginManifest,
  type ProferPluginOperationResult,
  type ProferPluginPageContribution,
  type ProferPluginPermission,
} from '@profer/plugin-api'
import { getPluginDataDir, getPluginsDir, getPluginsIndexPath } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_PACKAGE_BYTES = 30 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_FILE_COUNT = 1_000
const MAX_DEPTH = 16
/** 单个 ZIP 路径段（含文件名）的字符上限。 */
const MAX_PATH_SEGMENT_LENGTH = 240
/** 安装后最长文件路径上限：给 Windows MAX_PATH(260) 留出余量，超限在安装前显式拒绝。 */
const MAX_INSTALL_PATH_LENGTH = 240
/** 安装、更新或卸载中途失败留下的临时目录前缀。 */
const PLUGIN_TEMP_DIR_PREFIXES = ['.install-', '.backup-', '.remove-']
/** 临时目录可能仍被另一实例的安装流程使用，只回收有足够历史的残留。 */
const PLUGIN_TEMP_DIR_MIN_AGE_MS = 60 * 60 * 1000
const PLUGIN_TEMP_DIR_CLEANUP_ATTEMPTS = 3
/** Windows 会静默丢掉文件名末尾的空格与点，必须在落盘前拒绝，避免实际文件树与校验树不一致。 */
const WINDOWS_TRIMMED_SUFFIX_PATTERN = /[ .]$/
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SAFE_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const ALLOWED_PAGE_EXTENSIONS = new Set(['.html', '.htm'])
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/

function canonicalizeScopePrefix(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.startsWith('/')) throw new Error('资源 scope 前缀非法')
  const input = value.trim()
  if (!input || input.split('/').some((part) => part === '..' || part === '.')) throw new Error('资源 scope 前缀必须是相对路径')
  const normalized = input.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('../') || normalized.includes(':')) throw new Error('资源 scope 前缀非法')
  return normalized
}

interface PluginIndexEntry {
  enabled: boolean
  installedAt: number
  updatedAt: number
}

interface PluginIndexFile {
  schemaVersion: 1
  plugins: Record<string, PluginIndexEntry>
}

interface ValidatedPluginPackage {
  root: string
  manifest: ProferPluginManifest
  /** 相对插件根目录的最长文件路径长度，用于安装路径预算。 */
  maxRelativePathLength: number
}

let pluginsChangedListener: (() => void) | null = null
let pluginMutationListener: ((pluginId: string) => void) | null = null

function ok(status: ProferPluginOperationResult['status'], message: string, plugin?: ProferInstalledPlugin): ProferPluginOperationResult {
  return { ok: true, status, message, ...(plugin && { plugin }) }
}

function fail(message: string, status: ProferPluginOperationResult['status'] = 'error'): ProferPluginOperationResult {
  return { ok: false, status, message }
}

export function setPluginsChangedListener(listener: (() => void) | null): void {
  pluginsChangedListener = listener
}

/** 插件代码即将替换或删除时，先让运行中的原生 View 退出，避免加载旧实例。 */
export function setPluginMutationListener(listener: ((pluginId: string) => void) | null): void {
  pluginMutationListener = listener
}

function emitChanged(): void {
  try { pluginsChangedListener?.() } catch (error) { console.warn('[插件] 状态通知失败:', error) }
}

function defaultIndex(): PluginIndexFile {
  return { schemaVersion: 1, plugins: {} }
}

function readIndex(): PluginIndexFile {
  const raw = readJsonFileSafe<Partial<PluginIndexFile>>(getPluginsIndexPath())
  if (!raw || raw.schemaVersion !== 1 || !raw.plugins || typeof raw.plugins !== 'object') return defaultIndex()
  const plugins: Record<string, PluginIndexEntry> = {}
  for (const [id, value] of Object.entries(raw.plugins)) {
    if (!PROFER_PLUGIN_ID_PATTERN.test(id) || !value || typeof value !== 'object') continue
    const entry = value as Partial<PluginIndexEntry>
    plugins[id] = {
      enabled: entry.enabled === true,
      installedAt: typeof entry.installedAt === 'number' ? entry.installedAt : Date.now(),
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
    }
  }
  return { schemaVersion: 1, plugins }
}

function writeIndex(index: PluginIndexFile): void {
  writeJsonFileAtomic(getPluginsIndexPath(), index)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((leftParts[index] ?? 0) !== (rightParts[index] ?? 0)) return (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
  }
  return 0
}

function supportsEngineRange(range: string, currentVersion: string): boolean {
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  if (comparators.length === 0 || comparators.length > 8) throw new Error('engines.profer 范围不能为空或过长')
  return comparators.every((item) => {
    const match = COMPARATOR_PATTERN.exec(item)
    if (!match) throw new Error(`不支持的 Profer 版本范围：${item}`)
    const comparison = compareVersions(currentVersion, `${match[2]}.${match[3]}.${match[4]}`)
    switch (match[1] ?? '=') {
      case '>': return comparison > 0
      case '>=': return comparison >= 0
      case '<': return comparison < 0
      case '<=': return comparison <= 0
      default: return comparison === 0
    }
  })
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('可选文本字段必须是字符串')
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maxLength) throw new Error(`文本字段不能超过 ${maxLength} 个字符`)
  return normalized
}

function assertSafeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  const input = value.replace(/\\/g, '/')
  if (input.split('/').some((segment) => segment === '..')) {
    throw new Error(`${label}必须位于插件目录内`)
  }
  const normalized = normalize(input).replace(/\\/g, '/')
  if (normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized)) {
    throw new Error(`${label}必须位于插件目录内`)
  }
  if (input.length > 240 || !SAFE_RELATIVE_PATH_PATTERN.test(input) || input.startsWith('/') || input.includes('//')) {
    throw new Error(`${label}包含不受支持的路径字符`)
  }
  return normalized.replace(/^\.\//, '')
}

function parsePage(raw: unknown, index: number): ProferPluginPageContribution {
  if (!isRecord(raw)) throw new Error(`contributes.pages[${index}] 必须是对象`)
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!PROFER_PLUGIN_PAGE_ID_PATTERN.test(id)) throw new Error(`页面 id 非法：${id || '(empty)'}`)
  if (!title || title.length > 80) throw new Error(`页面 ${id} 的标题不能为空且不能超过 80 个字符`)
  const entry = assertSafeRelativePath(raw.entry, `页面 ${id} 的 entry`)
  const extension = entry.slice(entry.lastIndexOf('.')).toLowerCase()
  if (!ALLOWED_PAGE_EXTENSIONS.has(extension)) throw new Error(`页面 ${id} 的 entry 必须是 HTML 文件`)
  let placements: ProferPluginPageContribution['placements']
  if (raw.placements !== undefined) {
    if (!Array.isArray(raw.placements)) throw new Error(`页面 ${id} 的 placements 必须是数组`)
    const allowed = new Set(['settings', 'tab', 'sidebar', 'panel'])
    const parsed = raw.placements.filter((item): item is 'settings' | 'tab' | 'sidebar' | 'panel' => typeof item === 'string' && allowed.has(item))
    if (parsed.length !== raw.placements.length) throw new Error(`页面 ${id} 包含未知 placement`)
    placements = [...new Set(parsed)]
  }
  return { id, title, entry, ...(placements && { placements }) }
}

export function parsePluginManifest(raw: unknown): ProferPluginManifest {
  if (!isRecord(raw)) throw new Error(`${PROFER_PLUGIN_MANIFEST_FILE} 必须是 JSON 对象`)
  if (raw.schemaVersion !== PROFER_PLUGIN_SCHEMA_VERSION) {
    throw new Error(`仅支持 schemaVersion ${PROFER_PLUGIN_SCHEMA_VERSION}`)
  }
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (!PROFER_PLUGIN_ID_PATTERN.test(id)) throw new Error('插件 id 必须是小写反向域名形式，例如 com.example.plugin')
  if (!name || name.length > 80) throw new Error('插件 name 不能为空且不能超过 80 个字符')
  if (!VERSION_PATTERN.test(version)) throw new Error('插件 version 必须是 semver，例如 1.0.0')

  let workspaceScopes: ProferPluginManifest['workspaceScopes']
  if (raw.workspaceScopes !== undefined) {
    if (!Array.isArray(raw.workspaceScopes) || raw.workspaceScopes.length > 50) throw new Error('workspaceScopes 必须是有限数组')
    workspaceScopes = raw.workspaceScopes.map((value, index) => {
      if (!isRecord(value) || typeof value.workspaceId !== 'string' || !value.workspaceId.trim() || value.workspaceId.length > 200) {
        throw new Error(`workspaceScopes[${index}] 的 workspaceId 非法`)
      }
      if (value.prefixes !== undefined && (!Array.isArray(value.prefixes) || value.prefixes.length > 100)) throw new Error(`workspaceScopes[${index}] 的 prefixes 非法`)
      const prefixes = value.prefixes === undefined ? undefined : [...new Set(value.prefixes.map((prefix) => canonicalizeScopePrefix(prefix)))]
      return { workspaceId: value.workspaceId.trim(), ...(prefixes && { prefixes }) }
    })
    if (new Set(workspaceScopes.map((scope) => `${scope.workspaceId}\\0${scope.prefixes?.join('\\0') ?? ''}`)).size !== workspaceScopes.length) {
      throw new Error('workspaceScopes 不能重复')
    }
  }
  let providerScopes: ProferPluginManifest['providerScopes']
  if (raw.providerScopes !== undefined) {
    if (!Array.isArray(raw.providerScopes) || raw.providerScopes.length > 50) throw new Error('providerScopes 必须是有限数组')
    providerScopes = raw.providerScopes.map((value, index) => {
      if (!isRecord(value) || typeof value.providerId !== 'string' || !value.providerId.trim() || value.providerId.length > 200) {
        throw new Error(`providerScopes[${index}] 的 providerId 非法`)
      }
      if (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.length > 100 || value.fields.some((field) => typeof field !== 'string' || !field.trim() || field.length > 200))) {
        throw new Error(`providerScopes[${index}] 的 fields 非法`)
      }
      const fields = value.fields === undefined ? undefined : [...new Set(value.fields.map((field) => field.trim()))]
      return { providerId: value.providerId.trim(), ...(fields && { fields }) }
    })
    if (new Set(providerScopes.map((scope) => `${scope.providerId}\\0${scope.fields?.join('\\0') ?? ''}`)).size !== providerScopes.length) {
      throw new Error('providerScopes 不能重复')
    }
  }
  let permissions: ProferPluginPermission[] | undefined
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) throw new Error('permissions 必须是数组')
    const known = new Set<string>(PROFER_PLUGIN_PERMISSIONS)
    const parsed = raw.permissions.filter((item): item is ProferPluginPermission => typeof item === 'string' && known.has(item))
    if (parsed.length !== raw.permissions.length) throw new Error('permissions 包含当前 Profer 不支持的权限')
    permissions = [...new Set(parsed)]
  }

  if (!isRecord(raw.contributes)) throw new Error('contributes 必须是对象')
  const pageRaw = raw.contributes.pages
  const pages = pageRaw === undefined
    ? undefined
    : Array.isArray(pageRaw) ? pageRaw.map(parsePage) : (() => { throw new Error('contributes.pages 必须是数组') })()
  if (pages && pages.length > 20) throw new Error('单个插件最多贡献 20 个页面')
  if (pages && new Set(pages.map((page) => page.id)).size !== pages.length) throw new Error('插件页面 id 不能重复')

  const capabilities = parsePluginCapabilities(raw, pages)
  let modelRoutingPolicies: ProferPluginManifest['contributes']['modelRoutingPolicies']
  if (raw.contributes.modelRoutingPolicies !== undefined) {
    const policies = raw.contributes.modelRoutingPolicies
    if (!Array.isArray(policies)) throw new Error('modelRoutingPolicies 必须是数组')
    modelRoutingPolicies = policies.map((policy, policyIndex) => {
      if (!isRecord(policy)) throw new Error(`modelRoutingPolicies[${policyIndex}] 必须是对象`)
      const policyId = typeof policy.id === 'string' ? policy.id.trim() : ''
      if (!PROFER_PLUGIN_PAGE_ID_PATTERN.test(policyId)) throw new Error(`模型路由策略 id 非法：${policyId || '(empty)'}`)
      if (policy.kind !== 'model-routing.rules.v1') throw new Error(`模型路由策略 ${policyId} 的 kind 不受支持`)
      return { id: policyId, kind: 'model-routing.rules.v1' as const }
    })
  }

  if ((!pages || pages.length === 0) && (!modelRoutingPolicies || modelRoutingPolicies.length === 0)) {
    throw new Error('插件至少需要贡献一个页面或一项宿主能力')
  }

  const homepage = normalizeOptionalText(raw.homepage, 300)
  let engines: ProferPluginManifest['engines']
  if (raw.engines !== undefined) {
    if (!isRecord(raw.engines) || typeof raw.engines.profer !== 'string' || !raw.engines.profer.trim()) {
      throw new Error('engines.profer 必须是版本范围字符串')
    }
    const range = raw.engines.profer.trim()
    if (!supportsEngineRange(range, app.getVersion())) {
      throw new Error(`插件不支持当前 Profer 版本 ${app.getVersion()}（要求 ${range}）`)
    }
    engines = { profer: range }
  }
  if (homepage) {
    let parsed: URL
    try { parsed = new URL(homepage) } catch { throw new Error('homepage 必须是有效的 HTTPS URL') }
    if (parsed.protocol !== 'https:') throw new Error('homepage 必须使用 HTTPS')
  }

  return {
    schemaVersion: 1,
    id,
    name,
    version,
    description: normalizeOptionalText(raw.description, 500),
    publisher: normalizeOptionalText(raw.publisher, 100),
    ...(homepage && { homepage }),
    ...(engines && { engines }),
    ...(capabilities.network && { network: capabilities.network }),
    ...(permissions && { permissions }),
    ...(workspaceScopes && { workspaceScopes }),
    ...(providerScopes && { providerScopes }),
    contributes: {
      ...capabilities.contributions,
      ...(pages && { pages }),
      ...(modelRoutingPolicies && { modelRoutingPolicies }),
    },
  }
}

function resolvePackageRoot(root: string): string | null {
  try {
    if (lstatSync(root).isSymbolicLink()) return null
  } catch {
    return null
  }
  if (existsSync(join(root, PROFER_PLUGIN_MANIFEST_FILE))) return root
  const directories = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
  return directories.length === 1 && existsSync(join(root, directories[0]!.name, PROFER_PLUGIN_MANIFEST_FILE))
    ? join(root, directories[0]!.name)
    : null
}

/** 扫描并校验插件目录，同时记录最长相对路径，供安装路径预算判断。 */
function scanPackage(root: string): { maxRelativePathLength: number } {
  let totalBytes = 0
  let fileCount = 0
  let maxRelativePathLength = 0
  const visit = (directory: string, depth: number, parentRelativeLength: number): void => {
    if (depth > MAX_DEPTH) throw new Error(`插件目录不能超过 ${MAX_DEPTH} 层`)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('插件包不允许包含符号链接')
      const absolute = join(directory, entry.name)
      const relativeLength = parentRelativeLength + (parentRelativeLength > 0 ? 1 : 0) + entry.name.length
      if (entry.isDirectory()) {
        visit(absolute, depth + 1, relativeLength)
      } else if (entry.isFile()) {
        maxRelativePathLength = Math.max(maxRelativePathLength, relativeLength)
        const size = statSync(absolute).size
        if (size > MAX_FILE_BYTES) throw new Error(`插件单个文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`)
        totalBytes += size
        fileCount += 1
        if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`插件包不能超过 ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`)
        if (fileCount > MAX_FILE_COUNT) throw new Error(`插件包最多包含 ${MAX_FILE_COUNT} 个文件`)
      } else {
        throw new Error('插件包只允许普通文件和目录')
      }
    }
  }
  visit(root, 0, 0)
  return { maxRelativePathLength }
}

function validatePackage(sourceRoot: string): ValidatedPluginPackage {
  const root = resolvePackageRoot(sourceRoot)
  if (!root) throw new Error(`插件包根目录必须包含 ${PROFER_PLUGIN_MANIFEST_FILE}`)
  const { maxRelativePathLength } = scanPackage(root)
  const manifestPath = join(root, PROFER_PLUGIN_MANIFEST_FILE)
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('manifest 不允许是符号链接')
  let raw: unknown
  try { raw = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
    throw new Error(`${PROFER_PLUGIN_MANIFEST_FILE} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = parsePluginManifest(raw)
  for (const page of manifest.contributes.pages ?? []) {
    const entry = resolve(root, page.entry)
    const rel = relative(root, entry)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(entry) || !statSync(entry).isFile() || lstatSync(entry).isSymbolicLink()) {
      throw new Error(`页面入口不存在或不安全：${page.entry}`)
    }
  }
  return { root, manifest, maxRelativePathLength }
}

function isZipSymlink(attr: number): boolean {
  const unixMode = (attr >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

/** ZIP 路径段在 Windows 上会被改写（截断、ADS、设备名），这些名字一律不接受。 */
function isUnsafeZipSegment(segment: string): boolean {
  return !segment || segment === '..' || segment.length > MAX_PATH_SEGMENT_LENGTH
    || segment.includes(':') || WINDOWS_TRIMMED_SUFFIX_PATTERN.test(segment) || WINDOWS_RESERVED_NAME_PATTERN.test(segment)
}

function extractZipSecurely(zipPath: string, target: string): void {
  if (statSync(zipPath).size > MAX_ZIP_BYTES) throw new Error(`ZIP 文件不能超过 ${MAX_ZIP_BYTES / 1024 / 1024} MB`)
  const zip = new AdmZip(zipPath)
  let totalBytes = 0
  let fileCount = 0
  const normalizedPaths = new Set<string>()
  const filePaths = new Set<string>()
  const entries = zip.getEntries()
  for (const entry of entries) {
    const slashPath = entry.entryName.replace(/\\/g, '/')
    const normalized = normalize(slashPath)
    const pathParts = slashPath.split('/')
    const hasTrailingSlash = slashPath.endsWith('/')
    const pathSegments = hasTrailingSlash ? pathParts.slice(0, -1) : pathParts
    if (!slashPath || slashPath.startsWith('/') || slashPath.includes('\0') || isAbsolute(normalized) || pathSegments.some(isUnsafeZipSegment)) {
      throw new Error('ZIP 包含非法路径')
    }
    const normalizedKey = pathSegments.join('/').toLowerCase()
    if (!normalizedKey || normalizedPaths.has(normalizedKey)) throw new Error('ZIP 包含重复路径')
    // 文件不能同时充当目录；否则不同解压器可能得到不同的最终文件树。
    const ancestors = pathSegments.slice(0, -1).map((_part, index) => pathSegments.slice(0, index + 1).join('/').toLowerCase())
    if (ancestors.some((ancestor) => filePaths.has(ancestor))) throw new Error('ZIP 包含文件与目录路径冲突')
    normalizedPaths.add(normalizedKey)
    if (isZipSymlink(entry.attr)) throw new Error('ZIP 包含符号链接')
    if (!entry.isDirectory) {
      fileCount += 1
      totalBytes += entry.header.size
      if (entry.header.size > MAX_FILE_BYTES) throw new Error('ZIP 中存在超大文件')
      if (fileCount > MAX_FILE_COUNT || totalBytes > MAX_PACKAGE_BYTES) throw new Error('ZIP 解压后超过插件包限制')
      filePaths.add(normalizedKey)
    }
  }

  // 不调用 extractAllTo：逐条目写入已通过校验的相对路径，避免把最终路径安全性
  // 交给压缩库的跨平台路径实现；随后再扫描落盘结果，继续 fail closed。
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const slashPath = entry.entryName.replace(/\\/g, '/')
    const pathSegments = slashPath.split('/').filter(Boolean)
    const destination = resolve(target, ...pathSegments)
    const rel = relative(target, destination)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ZIP 包含非法目标路径')
    mkdirSync(resolve(target, ...pathSegments.slice(0, -1)), { recursive: true })
    writeFileSync(destination, entry.getData())
  }
  scanPackage(target)
}

export function getInstalledPlugin(pluginId: string): ProferInstalledPlugin | null {
  if (!PROFER_PLUGIN_ID_PATTERN.test(pluginId)) return null
  const root = join(getPluginsDir(), pluginId)
  if (!existsSync(root)) return null
  try {
    if (lstatSync(root).isSymbolicLink()) return null
  } catch {
    return null
  }
  try {
    const validated = validatePackage(root)
    if (validated.manifest.id !== pluginId) return null
    const state = readIndex().plugins[pluginId]
    const timestamp = statSync(root).mtimeMs
    return {
      manifest: validated.manifest,
      enabled: state?.enabled ?? false,
      installedAt: state?.installedAt ?? timestamp,
      updatedAt: state?.updatedAt ?? timestamp,
    }
  } catch (error) {
    console.warn(`[插件] 跳过无效插件 ${pluginId}:`, error)
    return null
  }
}

export function listInstalledPlugins(): ProferInstalledPlugin[] {
  const directory = getPluginsDir()
  adoptDroppedPluginFolders(directory)
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && PROFER_PLUGIN_ID_PATTERN.test(entry.name))
    .map((entry) => getInstalledPlugin(entry.name))
    .filter((plugin): plugin is ProferInstalledPlugin => plugin !== null)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
}

/**
 * 开发版常见用法是把插件文件夹直接拖进 plugins 目录。
 * 这类文件夹通常叫 capability-demo，而运行时目录必须使用 manifest.id；
 * 刷新列表时将合法的顶层插件目录规范化到该名称。
 */
function adoptDroppedPluginFolders(directory: string): void {
  let changed = false
  const index = readIndex()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
    if (PROFER_PLUGIN_ID_PATTERN.test(entry.name)) continue
    const source = join(directory, entry.name)
    try {
      const validated = validatePackage(source)
      const target = join(directory, validated.manifest.id)
      if (existsSync(target)) continue
      renameSync(source, target)
      const now = Date.now()
      index.plugins[validated.manifest.id] ??= { enabled: true, installedAt: now, updatedAt: now }
      changed = true
    } catch {
      // plugins 目录可能包含说明文件或未完成的拖放目录，刷新时静默跳过。
    }
  }
  if (changed) writeIndex(index)
}

/**
 * 回收安装、更新或卸载中途失败留下的临时目录。
 * Windows 上这类目录常被索引器或杀毒软件瞬时占用，删除失败时退避重试，仍失败则留给下次启动。
 */
export async function cleanupStalePluginTempDirs(now = Date.now()): Promise<string[]> {
  const directory = getPluginsDir()
  let names: string[]
  try { names = readdirSync(directory) } catch { return [] }
  const removed: string[] = []
  for (const name of names) {
    if (!PLUGIN_TEMP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const path = join(directory, name)
    let stats: ReturnType<typeof lstatSync>
    try { stats = lstatSync(path) } catch { continue }
    if (!stats.isDirectory() || now - stats.mtimeMs < PLUGIN_TEMP_DIR_MIN_AGE_MS) continue
    for (let attempt = 1; attempt <= PLUGIN_TEMP_DIR_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        rmSync(path, { recursive: true, force: true })
        removed.push(path)
        break
      } catch (error) {
        if (attempt === PLUGIN_TEMP_DIR_CLEANUP_ATTEMPTS) {
          console.warn('[插件] 残留临时目录清理失败，留待下次启动:', path, error)
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
      }
    }
  }
  if (removed.length > 0) console.log(`[插件] 已回收 ${removed.length} 个残留临时目录`)
  return removed
}

function installValidatedPackage(validated: ValidatedPluginPackage, replace = false): ProferPluginOperationResult {
  const target = join(getPluginsDir(), validated.manifest.id)
  const existing = getInstalledPlugin(validated.manifest.id)
  if (existing && !replace) return fail(`插件「${existing.manifest.name}」已存在，请确认替换`, 'conflict')
  // 先按最终安装位置判断路径长度，避免在 Windows 上安装到一半才因 MAX_PATH 报错。
  const installPathLength = target.length + 1 + validated.maxRelativePathLength
  if (installPathLength > MAX_INSTALL_PATH_LENGTH) {
    return fail(`插件安装路径过长（${installPathLength} 字符，上限 ${MAX_INSTALL_PATH_LENGTH}）：请缩短插件目录层级或插件 id`)
  }
  const staging = join(getPluginsDir(), `.install-${randomUUID()}`)
  const backup = join(getPluginsDir(), `.backup-${randomUUID()}`)
  let published = false
  try {
    cpSync(validated.root, staging, { recursive: true })
    validatePackage(staging)
    if (existing) pluginMutationListener?.(validated.manifest.id)
    if (existsSync(target)) renameSync(target, backup)
    renameSync(staging, target)
    published = true
    const now = Date.now()
    const index = readIndex()
    index.plugins[validated.manifest.id] = {
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    }
    writeIndex(index)
    // 索引写入成功后再清理旧版本；清理失败不影响已经完成的更新。
    try { if (existsSync(backup)) rmSync(backup, { recursive: true, force: true }) } catch (error) {
      console.warn('[插件] 安装备份清理失败，将在后续维护中清理:', error)
    }
    const plugin = getInstalledPlugin(validated.manifest.id) ?? undefined
    emitChanged()
    return ok(existing ? 'updated' : 'installed', `${existing ? '已更新' : '已安装'}插件「${validated.manifest.name}」`, plugin)
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
    // 索引写入失败时也回滚已发布目录，不能留下“代码已更新但索引未更新”的半安装状态。
    try {
      if (published && existsSync(target)) rmSync(target, { recursive: true, force: true })
      if (existsSync(backup)) renameSync(backup, target)
    } catch (rollbackError) {
      console.error('[插件] 安装回滚失败:', rollbackError)
    }
    return fail(`安装失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function installPluginPackage(sourcePath: string, replace = false): ProferPluginOperationResult {
  if (!sourcePath || !isAbsolute(sourcePath) || !existsSync(sourcePath)) return fail('插件包路径不存在')
  const temporary = mkdtempSync(join(tmpdir(), 'profer-plugin-'))
  try {
    if (lstatSync(sourcePath).isSymbolicLink()) return fail('插件包路径不能是符号链接')
    const sourceStats = statSync(sourcePath)
    if (sourceStats.isDirectory()) return installValidatedPackage(validatePackage(sourcePath), replace)
    if (!sourceStats.isFile() || !sourcePath.toLowerCase().endsWith('.zip')) return fail('请选择插件目录或 ZIP 文件')
    extractZipSecurely(sourcePath, temporary)
    return installValidatedPackage(validatePackage(temporary), replace)
  } catch (error) {
    return fail(`安装失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function setPluginEnabled(pluginId: string, enabled: boolean): ProferPluginOperationResult {
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin) return fail('插件不存在')
  const index = readIndex()
  const now = Date.now()
  index.plugins[pluginId] = {
    enabled,
    installedAt: index.plugins[pluginId]?.installedAt ?? plugin.installedAt,
    updatedAt: now,
  }
  writeIndex(index)
  const updated = getInstalledPlugin(pluginId) ?? undefined
  emitChanged()
  return ok(enabled ? 'enabled' : 'disabled', `已${enabled ? '启用' : '停用'}插件「${plugin.manifest.name}」`, updated)
}

export function removePlugin(pluginId: string): ProferPluginOperationResult {
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin) return fail('插件不存在')
  const root = join(getPluginsDir(), pluginId)
  const backup = join(getPluginsDir(), `.remove-${randomUUID()}`)
  pluginMutationListener?.(pluginId)
  try {
    // 先改名隐藏运行目录，再提交索引；索引失败时可恢复旧插件，避免出现半卸载状态。
    renameSync(root, backup)
    const index = readIndex()
    delete index.plugins[pluginId]
    writeIndex(index)
    try { rmSync(backup, { recursive: true, force: true }) } catch (error) { console.warn('[插件] 卸载备份清理失败:', error) }
    emitChanged()
    return ok('removed', `已卸载插件「${plugin.manifest.name}」；插件数据已保留`)
  } catch (error) {
    try {
      if (!existsSync(root) && existsSync(backup)) renameSync(backup, root)
    } catch (rollbackError) {
      console.error('[插件] 卸载回滚失败:', rollbackError)
    }
    return fail(`卸载失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function selectPluginPackage(kind: 'zip' | 'folder'): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = kind === 'folder'
    ? { title: '选择 Profer 插件目录', properties: ['openDirectory'] }
    : { title: '选择 Profer 插件 ZIP', properties: ['openFile'], filters: [{ name: 'Profer 插件包', extensions: ['zip'] }] }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export async function openPluginsFolder(): Promise<void> {
  await shell.openPath(getPluginsDir())
}

export function resolvePluginPage(pluginId: string, pageId: string): { plugin: ProferInstalledPlugin; page: ProferPluginPageContribution; root: string } {
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin || !plugin.enabled) throw new Error('插件不存在或未启用')
  const page = plugin.manifest.contributes.pages?.find((candidate) => candidate.id === pageId)
  if (!page) throw new Error('插件页面不存在')
  return { plugin, page, root: realpathSync(join(getPluginsDir(), pluginId)) }
}

/** 供插件协议在每次请求时重新解析根目录，更新插件后不会继续读取旧目录。 */
export function resolveInstalledPluginRoot(pluginId: string): string {
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin || !plugin.enabled) throw new Error('插件不存在或未启用')
  return realpathSync(join(getPluginsDir(), pluginId))
}

export function resolvePluginDataFile(pluginId: string): string {
  if (!PROFER_PLUGIN_ID_PATTERN.test(pluginId)) throw new Error('插件 ID 非法')
  const dir = join(getPluginDataDir(), pluginId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'storage.json')
}
