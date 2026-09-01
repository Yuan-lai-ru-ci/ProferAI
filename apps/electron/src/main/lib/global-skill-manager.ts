/**
 * 全局 Skill 管理器：全局定义、工作区覆盖和运行时有效投影的唯一入口。
 *
 * 全局定义与工作区副本永远分开存储；运行时只消费 resolve/prepare 产出的有效投影，
 * 不直接把全局目录和工作区目录同时交给 Claude/Pi，避免重复发现。
 */
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, renameSync, writeFileSync, unlinkSync, copyFileSync, statSync, cpSync } from 'node:fs'
import { join, dirname, relative, resolve, basename } from 'node:path'
import { assertSafeSkillSegment, safeSkillPath, assertSafeSkillRootChild } from './skill-path-security'
import {
  getBuiltinGlobalSkillsDir,
  getDefaultSkillsDir,
  getGlobalSkillsIndexPath,
  getUserGlobalSkillsDir,
  getWorkspaceRuntimeSkillsDir,
  getWorkspaceSkillOverridesPath,
  getSkillSystemMigrationPath,
  getWorkspaceSkillsDir,
  getInactiveSkillsDir,
  getAgentWorkspacePath,
  getAgentWorkspacesDir,
  getAgentWorkspacesIndexPath,
  parseSkillVersion,
} from './config-paths'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { normalizeDefaultSkillSlug } from './default-skill-slugs'
import type {
  GlobalSkillManifest,
  GlobalSkillMeta,
  GlobalSkillDeleteBlockers,
  GlobalSkillWorkspaceReference,
  GlobalSkillSource,
  GlobalSkillType,
  ResolvedSkillMeta,
  RuntimeSkillsProjection,
  WorkspaceGlobalSkillOverride,
  WorkspaceSkillCopyResult,
  WorkspaceSkillOverridesFile,
  WorkspaceSkillSource,
} from '@profer/shared'

interface GlobalSkillIndex {
  schemaVersion: 1
  skills: Record<string, Pick<GlobalSkillManifest, 'skillId' | 'slug' | 'type' | 'version'>>
}

interface SkillRootsOverride {
  globalRoot: string
  workspacesRoot: string
}

interface LegacyMasterSource {
  sourceKind?: 'master' | 'workspace'
  masterSlug?: string
  sourceVersion?: string
  baselineVersion?: string
  sourceWorkspaceSlug?: string
  sourceWorkspaceName?: string
  importedAt?: string
}

interface SkillSystemMigrationState {
  schemaVersion: 1 | 2 | 3
  status: 'in-progress' | 'failed' | 'completed'
  startedAt: string
  completedAt?: string
  completedWorkspaces: string[]
  migratedLegacyMasters: string[]
  failedEntries: string[]
}

let rootsOverride: SkillRootsOverride | null = null
let bundledSkillsRoot: string | null = null
let globalSkillSystemInitialized = false

/** 运行时资源路径由主进程在注册 IPC 前注入；测试可注入临时 bundle。 */
export function configureGlobalSkillSystem(bundleRoot: string): void {
  bundledSkillsRoot = resolve(bundleRoot)
  globalSkillSystemInitialized = false
}

/**
 * 在 Agent 可启动之前初始化全局 Skill；可安全重复调用。
 * seed 与迁移都具备重入能力，因此首次 Agent run 也会在此兜底。
 */
export function ensureGlobalSkillSystemReady(): void {
  if (globalSkillSystemInitialized) return
  if (!bundledSkillsRoot) return
  seedBuiltinGlobalSkills(bundledSkillsRoot)
  const migration = migrateLegacyWorkspaceSkills(bundledSkillsRoot)
  // 有失败项时下一个 Agent run 仍会重试；成功后才缓存本进程就绪状态。
  globalSkillSystemInitialized = migration.failed.length === 0
}

/** 测试用目录替身；生产代码不调用。 */
export function __setGlobalSkillRoots(globalRoot: string, workspacesRoot: string): void {
  rootsOverride = { globalRoot, workspacesRoot }
  mkdirSync(globalRoot, { recursive: true })
  mkdirSync(workspacesRoot, { recursive: true })
}

export function __resetGlobalSkillRoots(): void {
  rootsOverride = null
  bundledSkillsRoot = null
  globalSkillSystemInitialized = false
}

function globalRoot(): string {
  return rootsOverride?.globalRoot ?? getBuiltinGlobalSkillsDir().replace(/[\\/]builtin$/, '')
}
function builtinRoot(): string {
  return rootsOverride ? join(globalRoot(), 'builtin') : getBuiltinGlobalSkillsDir()
}
function userRoot(): string {
  if (rootsOverride) return join(globalRoot(), 'user')
  return getUserGlobalSkillsDir()
}
function workspaceRoot(slug: string): string {
  assertSafeSkillSegment(slug, 'workspaceSlug')
  return rootsOverride ? safeSkillPath(rootsOverride.workspacesRoot, slug, 'workspaceSlug') : getAgentWorkspacePath(slug)
}
function workspaceSkillsRoot(slug: string): string {
  assertSafeSkillSegment(slug, 'workspaceSlug')
  return rootsOverride ? safeSkillPath(workspaceRoot(slug), 'skills', 'workspace skills root') : getWorkspaceSkillsDir(slug)
}
function workspaceInactiveRoot(slug: string): string {
  assertSafeSkillSegment(slug, 'workspaceSlug')
  return rootsOverride ? safeSkillPath(workspaceRoot(slug), 'skills-inactive', 'workspace inactive skills root') : getInactiveSkillsDir(slug)
}
function overridesPath(slug: string): string {
  assertSafeSkillSegment(slug, 'workspaceSlug')
  return rootsOverride ? safeSkillPath(workspaceRoot(slug), 'skill-overrides.json', 'workspace overrides path') : getWorkspaceSkillOverridesPath(slug)
}
function runtimeRoot(slug: string): string {
  assertSafeSkillSegment(slug, 'workspaceSlug')
  const root = rootsOverride ? join(workspaceRoot(slug), '.runtime', 'skills') : getWorkspaceRuntimeSkillsDir(slug)
  return assertSafeSkillRootChild(workspaceRoot(slug), root, 'runtime root')
}
function migrationPath(): string {
  return rootsOverride ? join(globalRoot(), 'skill-system-migration.json') : getSkillSystemMigrationPath()
}
function legacyDefaultSkillsRoot(): string {
  // 测试根将旧 master 放在独立目录，生产环境沿用历史 default-skills 位置作为只读迁移来源。
  return rootsOverride ? join(globalRoot(), 'legacy-default-skills') : getDefaultSkillsDir()
}
function readMigrationState(): SkillSystemMigrationState {
  const stored = readJsonFileSafe<Partial<SkillSystemMigrationState>>(migrationPath())
  const status = stored?.status === 'completed' || stored?.status === 'failed' ? stored.status : 'in-progress'
  return {
    // schema 3 重新盘点 schema 1/2 已完成的工作区：旧实现曾把正常元 Skill
    // 副本提前标为 unknown-legacy 或直接跳过，必须允许本次规则升级重入修正。
    schemaVersion: stored?.schemaVersion === 3 ? 3 : 1,
    status,
    startedAt: stored?.startedAt ?? new Date().toISOString(),
    ...(stored?.completedAt ? { completedAt: stored.completedAt } : {}),
    completedWorkspaces: stored?.schemaVersion === 3 && Array.isArray(stored?.completedWorkspaces) ? stored.completedWorkspaces : [],
    migratedLegacyMasters: Array.isArray(stored?.migratedLegacyMasters) ? stored.migratedLegacyMasters : [],
    failedEntries: Array.isArray(stored?.failedEntries) ? stored.failedEntries : [],
  }
}
function writeMigrationState(state: SkillSystemMigrationState): void {
  mkdirSync(dirname(migrationPath()), { recursive: true })
  writeJsonFileAtomic(migrationPath(), state)
}

function globalIndex(): GlobalSkillIndex {
  const stored = readJsonFileSafe<GlobalSkillIndex>(getGlobalSkillsIndexPathForRoot())
  const skills: GlobalSkillIndex['skills'] = {}
  // manifest 是定义本身，索引只是加速/展示数据；每次读取都从 manifest
  // 重建有效条目，避免索引缺失、损坏或残留条目导致全局 Skill 丢失。
  for (const manifest of allGlobalManifests()) {
    skills[manifest.skillId] = {
      skillId: manifest.skillId,
      slug: manifest.slug,
      type: manifest.type,
      version: manifest.version,
    }
  }
  if (stored?.schemaVersion === 1 && stored.skills) {
    // 保留尚未被本次目录扫描发现的条目只会掩盖损坏，因此不合并 stale index。
    // 读取 stored 仅用于兼容旧文件格式和后续迁移诊断。
    void stored
  }
  return { schemaVersion: 1, skills }
}
function getGlobalSkillsIndexPathForRoot(): string {
  return rootsOverride ? join(globalRoot(), 'index.json') : getGlobalSkillsIndexPath()
}
function saveGlobalIndex(index: GlobalSkillIndex): void {
  mkdirSync(dirname(getGlobalSkillsIndexPathForRoot()), { recursive: true })
  writeJsonFileAtomic(getGlobalSkillsIndexPathForRoot(), index)
}

function manifestPath(skillId: string, type: GlobalSkillType): string {
  const root = type === 'builtin-meta' ? builtinRoot() : userRoot()
  return join(safeSkillPath(root, skillId, 'global skillId'), 'skill.manifest.json')
}
function skillPath(skillId: string, type: GlobalSkillType): string {
  return dirname(manifestPath(skillId, type))
}
function sourcePath(skill: GlobalSkillManifest): string {
  return skillPath(skill.skillId, skill.type)
}
function readManifest(skillId: string, type: GlobalSkillType): GlobalSkillManifest | null {
  const path = manifestPath(skillId, type)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as GlobalSkillManifest
    if (value.schemaVersion !== 1 || value.skillId !== skillId || value.type !== type) return null
    assertSafeSkillSegment(value.skillId, 'global skillId')
    assertSafeSkillSegment(value.slug, 'global Skill slug')
    return value
  } catch {
    return null
  }
}

interface ParsedSkillMeta {
  slug: string
  name: string
  description?: string
}

function parseMeta(content: string, fallbackSlug: string): ParsedSkillMeta {
  const fields: Record<string, string> = {}
  const match = content.replace(/^\uFEFF/, '').match(/^---\s*\n([\s\S]*?)\n---/)
  for (const line of match?.[1]?.split('\n') ?? []) {
    const index = line.indexOf(':')
    if (index < 0 || /^\s/.test(line)) continue
    const key = line.slice(0, index).trim()
    if (!['name', 'description'].includes(key)) continue
    fields[key] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return { slug: fallbackSlug, name: fields.name || fallbackSlug, ...(fields.description ? { description: fields.description } : {}) }
}

function readSkillManifestFromDir(dir: string, skillId: string, type: GlobalSkillType, source?: GlobalSkillSource): GlobalSkillManifest {
  const content = readFileSync(join(dir, 'SKILL.md'), 'utf-8')
  const meta = parseMeta(content, basename(dir))
  const now = new Date().toISOString()
  assertSafeSkillSegment(meta.slug, 'global Skill slug')
  return {
    schemaVersion: 1,
    skillId,
    slug: meta.slug,
    type,
    version: parseSkillVersion(dir),
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    createdAt: now,
    updatedAt: now,
    ...(source ? { source } : {}),
  }
}

interface DirectoryReplaceOperations {
  rename: typeof renameSync
  remove: typeof rmSync
}

const directoryReplaceOperations: DirectoryReplaceOperations = {
  rename: renameSync,
  remove: rmSync,
}

/**
 * 将已准备好的目录切换到 target。
 * target 已存在时先改名为 backup，绝不先删除；新目录切换失败则恢复 backup。
 */
function replaceStagedDirectory(staged: string, target: string, ops = directoryReplaceOperations, afterReplace?: () => void): void {
  const backup = `${target}.${randomUUID()}.backup`
  let backedUp = false
  try {
    if (existsSync(target)) {
      ops.rename(target, backup)
      backedUp = true
    }
    try {
      ops.rename(staged, target)
      afterReplace?.()
    } catch (error) {
      if (existsSync(target)) {
        try { ops.remove(target, { recursive: true, force: true }) } catch { /* 保留原始错误 */ }
      }
      if (backedUp && existsSync(backup) && !existsSync(target)) {
        ops.rename(backup, target)
        backedUp = false
      }
      throw error
    }
    if (backedUp && existsSync(backup)) {
      try { ops.remove(backup, { recursive: true, force: true }) } catch (error) {
        // 新目录已经可读；保留 backup 供后续人工恢复，不能反向破坏新源。
        console.warn(`[全局 Skill] 清理旧目录备份失败，已保留: ${backup}`, error)
      }
    }
  } catch (error) {
    if (existsSync(staged)) {
      try { ops.remove(staged, { recursive: true, force: true }) } catch { /* 保留原始错误 */ }
    }
    if (backedUp && existsSync(backup) && !existsSync(target)) {
      try { ops.rename(backup, target) } catch { /* 保留原始错误 */ }
    }
    throw error
  }
}

/** 不应进入用户 Skill 副本或 Agent runtime 的工程/缓存目录。 */
const SKILL_COPY_BLOCKLIST = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__'])
const RUNTIME_PROJECTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function shouldCopySkillEntry(name: string): boolean {
  return !SKILL_COPY_BLOCKLIST.has(name)
}

/**
 * 只复制普通目录与普通文件：不跟随 symlink，且统一忽略工程产物。
 * 这避免全局/工作区复制与 runtime projection 因符号链接或 node_modules 越过 Skill 根。
 */
export function copySkillDirectorySafely(source: string, target: string): void {
  const sourceStat = statSync(source)
  if (!sourceStat.isDirectory()) throw new Error(`Skill 来源不是目录: ${source}`)
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!shouldCopySkillEntry(entry.name) || entry.isSymbolicLink()) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copySkillDirectorySafely(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

function copyDirectoryAtomic(source: string, target: string, prepare?: (staged: string) => void, afterReplace?: () => void): void {
  const temporary = `${target}.${randomUUID()}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  try {
    copySkillDirectorySafely(source, temporary)
    prepare?.(temporary)
    replaceStagedDirectory(temporary, target, directoryReplaceOperations, afterReplace)
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

/** 仅供 BDD 验证目录切换失败恢复；生产路径使用 copyDirectoryAtomic。 */
export function __replaceStagedDirectoryForTest(staged: string, target: string, failAfterBackup = false): void {
  replaceStagedDirectory(staged, target, {
    rename: ((source: string, destination: string) => {
      if (failAfterBackup && source === staged) throw new Error('模拟新目录切换失败')
      renameSync(source, destination)
    }) as typeof renameSync,
    remove: rmSync,
  })
}

function writeManifest(manifest: GlobalSkillManifest): void {
  writeJsonFileAtomic(manifestPath(manifest.skillId, manifest.type), manifest)
}

function allGlobalManifests(): GlobalSkillManifest[] {
  const result: GlobalSkillManifest[] = []
  for (const [type, root] of [['builtin-meta', builtinRoot()], ['user-global', userRoot()]] as const) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = readManifest(entry.name, type)
      if (manifest) result.push(manifest)
    }
  }
  return result
}

export function listGlobalSkills(workspaceSlug?: string): GlobalSkillMeta[] {
  if (workspaceSlug !== undefined) assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const overrides = workspaceSlug !== undefined ? readWorkspaceSkillOverrides(workspaceSlug) : { schemaVersion: 1 as const, globalSkills: {} }
  const workspaceSkills = workspaceSlug === undefined ? [] : scanWorkspaceSkills(workspaceSlug)
  const result: GlobalSkillMeta[] = allGlobalManifests().map((manifest) => {
    const override = overrides.globalSkills[manifest.skillId]
    const replaced = Boolean(override?.replacementWorkspaceSkillId ?? override?.replacementWorkspaceSkillSlug)
    const replacementSkill = override?.replacementWorkspaceSkillId
      ? workspaceSkills.find((skill) => skill.workspaceSkillId === override.replacementWorkspaceSkillId)
      : undefined
    const replacementPath = workspaceSlug && override?.replacementWorkspaceSkillSlug
      ? safeSkillPath(workspaceSkillsRoot(workspaceSlug), override.replacementWorkspaceSkillSlug, 'replacement workspace Skill slug')
      : undefined
    const replacementSource = replacementSkill
      ? readSource(replacementSkill.path)
      : replacementPath && existsSync(join(replacementPath, 'SKILL.md')) ? readSource(replacementPath) : undefined
    const replacementActive = Boolean(override?.replacementWorkspaceSkillId
      ? replacementSkill?.workspaceSkillId === override.replacementWorkspaceSkillId
      : replacementSource?.sourceSkillId === manifest.skillId)
    const workspaceConflict = Boolean(workspaceSkills.some((skill) => skill.slug === manifest.slug))
    return {
      ...manifest,
      enabledInWorkspace: override?.enabled ?? true,
      replacedInWorkspace: replaced,
      sourceStatus: (replacementSkill?.sourceStatus ?? replacementSource?.sourceStatus ?? 'available') as GlobalSkillMeta['sourceStatus'],
      actualSource: replacementActive || workspaceConflict ? 'workspace' as const : (override?.enabled === false ? 'none' as const : 'global' as const),
      ...(replacementSkill?.workspaceSkillId ? { workspaceSkillId: replacementSkill.workspaceSkillId } : {}),
      ...(manifest.source ? {
        sourceSkillId: manifest.source.sourceSkillId,
        sourceSkillType: manifest.source.sourceSkillType,
        sourceVersion: manifest.source.sourceVersion,
        copiedAt: manifest.source.copiedAt,
      } : {}),
      ...(override?.replacementWorkspaceSkillSlug ? { replacementForSkillId: manifest.skillId } : {}),
    }
  })

  return result
}

export function getGlobalSkill(skillId: string): GlobalSkillManifest {
  assertSafeSkillSegment(skillId, 'global skillId')
  const found = allGlobalManifests().find((skill) => skill.skillId === skillId)
  if (!found) throw new Error(`全局 Skill 不存在: ${skillId}`)
  return found
}

/** 以全局 skillId 读取指定工作区的全局定义状态。 */
export function getGlobalSkillForWorkspace(skillId: string, workspaceSlug: string): GlobalSkillMeta {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const skill = listGlobalSkills(workspaceSlug).find((item) => item.skillId === skillId)
  if (!skill) throw new Error(`全局 Skill 不存在: ${skillId}`)
  return skill
}

/** 复制全局定义为用户全局 Skill；builtin 与 user-global 均可作为源。 */
export function copyGlobalSkillToUserGlobalWithSource(skillId: string, slug?: string): GlobalSkillManifest {
  return copyGlobalSkillToUserGlobal(skillId, slug)
}

/** 创建用户全局 Skill；创建本身不自动绑定任何工作区，范围由详情页单独管理。 */
export function createUserGlobalSkill(slug: string, name: string, description: string, content: string): GlobalSkillManifest {
  const normalizedSlug = slug.trim()
  const normalizedName = name.trim()
  assertSafeSkillSegment(normalizedSlug, 'global Skill slug')
  if (!normalizedSlug) throw new Error('全局 Skill slug 不能为空')
  if (!normalizedName) throw new Error('全局 Skill 名称不能为空')
  if (allGlobalManifests().some((skill) => skill.slug === normalizedSlug)) throw new Error(`全局 Skill slug 已存在: ${normalizedSlug}`)
  const skillId = randomUUID()
  const now = new Date().toISOString()
  const manifest: GlobalSkillManifest = {
    schemaVersion: 1,
    skillId,
    slug: normalizedSlug,
    type: 'user-global',
    version: '1.0.0',
    name: normalizedName,
    ...(description.trim() ? { description: description.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  }
  const source = content.trim() || `# ${normalizedName}\n\n`
  const withFrontmatter = updateFrontmatterField(updateFrontmatterField(source, 'name', normalizedName), 'description', description.trim())
  const target = skillPath(skillId, 'user-global')
  const index = globalIndex()
  index.skills[skillId] = { skillId, slug: normalizedSlug, type: 'user-global', version: manifest.version }
  const temporarySource = `${target}.${randomUUID()}.source`
  mkdirSync(temporarySource, { recursive: true })
  copyDirectoryAtomic(temporarySource, target, (staged) => {
    writeFileSync(join(staged, 'SKILL.md'), updateFrontmatterVersion(withFrontmatter, manifest.version), 'utf-8')
    writeJsonFileAtomic(join(staged, 'skill.manifest.json'), manifest)
  }, () => saveGlobalIndex(index))
  rmSync(temporarySource, { recursive: true, force: true })
  return manifest
}

/** 编辑用户全局 Skill 的显式入口；scope 未明确时由调用方无法绕过作用域提示。 */
export function editGlobalSkill(
  skillId: string,
  workspaceSlug: string | undefined,
  scope: 'global' | 'workspace',
  content: string,
): GlobalSkillManifest | WorkspaceSkillCopyResult {
  const skill = getGlobalSkill(skillId)
  if (scope === 'global') return saveGlobalSkillContent(skillId, content)

  // 先创建临时副本并写入最终内容，再一次性提交目录和 override，避免留下半成品。
  const targetSlug = skill.slug
  if (!workspaceSlug) throw new Error('workspaceSlug 不能为空')
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(targetSlug, 'workspace Skill slug')
  const target = safeSkillPath(workspaceSkillsRoot(workspaceSlug), targetSlug, 'workspace Skill slug')
  const inactive = safeSkillPath(workspaceInactiveRoot(workspaceSlug), targetSlug, 'workspace Skill slug')
  const existingSource = existsSync(target) ? readSource(target)
    : existsSync(inactive) ? readSource(inactive)
      : undefined
  const overrides = readWorkspaceSkillOverrides(workspaceSlug)
  const previousOverride = overrides.globalSkills[skillId]
  const copiedAt = new Date().toISOString()

  // “复制到工作区”完成后，详情编辑器会再次提交同一 scope；允许只更新刚创建的同源 active 副本。
  if (existsSync(target) && existingSource?.sourceSkillId === skillId) {
    const temporaryFile = join(target, `SKILL.md.${randomUUID()}.tmp`)
    const originalFile = join(target, 'SKILL.md')
    const backupFile = join(target, `SKILL.md.${randomUUID()}.old`)
    try {
      writeFileSync(temporaryFile, content, 'utf-8')
      renameSync(originalFile, backupFile)
      try { renameSync(temporaryFile, originalFile) } catch (error) { renameSync(backupFile, originalFile); throw error }
      const workspaceSkillId = ensureWorkspaceSkillId(target, existingSource)
      const override = overrides.globalSkills[skillId] ?? {
        enabled: false,
        replacementWorkspaceSkillSlug: targetSlug,
        replacementWorkspaceSkillId: workspaceSkillId,
        disabledReason: 'replaced-by-workspace-copy' as const,
        updatedAt: copiedAt,
      }
      overrides.globalSkills[skillId] = { ...override, enabled: false, replacementWorkspaceSkillSlug: targetSlug, replacementWorkspaceSkillId: workspaceSkillId }
      try {
        writeWorkspaceSkillOverrides(workspaceSlug, overrides)
      } catch (error) {
        rmSync(originalFile, { force: true })
        renameSync(backupFile, originalFile)
        throw error
      }
      rmSync(backupFile, { force: true })
      return {
        skill: { ...skill, enabledInWorkspace: false, replacedInWorkspace: true, sourceStatus: 'available', actualSource: 'workspace' },
        workspaceSlug,
        workspaceSkillSlug: targetSlug,
        workspaceSkillId,
        override: overrides.globalSkills[skillId]!,
      }
    } catch (error) {
      if (existsSync(temporaryFile)) rmSync(temporaryFile, { force: true })
      if (existsSync(backupFile) && !existsSync(originalFile)) renameSync(backupFile, originalFile)
      throw error
    }
  }
  if (existsSync(target) || existsSync(inactive)) throw new Error(`当前工作区已存在同名 Skill: ${targetSlug}`)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(temporary), { recursive: true })
    copySkillDirectorySafely(sourcePath(skill), temporary)
    writeFileSync(join(temporary, 'SKILL.md'), content, 'utf-8')
    const workspaceSkillId = randomUUID()
    writeSource(temporary, {
      workspaceSkillId,
      sourceSkillId: skill.skillId,
      sourceSkillType: skill.type,
      sourceVersion: skill.version,
      copiedAt,
      scope: 'workspace',
      replacementForSkillId: skill.skillId,
      overrideReason: 'replaced-by-workspace-copy',
    })
    renameSync(temporary, target)
    overrides.globalSkills[skillId] = {
      enabled: false,
      replacementWorkspaceSkillSlug: targetSlug,
      replacementWorkspaceSkillId: workspaceSkillId,
      disabledReason: 'replaced-by-workspace-copy',
      updatedAt: copiedAt,
    }
    writeWorkspaceSkillOverrides(workspaceSlug, overrides)
    return {
      skill: { ...skill, enabledInWorkspace: false, replacedInWorkspace: true, sourceStatus: 'available', actualSource: 'workspace' },
      workspaceSlug,
      workspaceSkillSlug: targetSlug,
      workspaceSkillId,
      override: overrides.globalSkills[skillId]!,
    }
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    if (previousOverride) overrides.globalSkills[skillId] = previousOverride
    else delete overrides.globalSkills[skillId]
    try { writeWorkspaceSkillOverrides(workspaceSlug, overrides) } catch { /* 保留原始错误 */ }
    throw error
  }
}

function bumpPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return version
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function updateFrontmatterField(content: string, field: string, value: string): string {
  const match = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/)
  if (!match) return `---\n${field}: ${value}\n---\n\n${content}`
  const body = match[2]!
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const replacement = `${field}: "${escapedValue}"`
  const updated = new RegExp(`^${field}\\s*:.*$`, 'm').test(body)
    ? body.replace(new RegExp(`^${field}\\s*:.*$`, 'm'), replacement)
    : `${body}\n${replacement}`
  return `${match[1]}${updated}${match[3]}${content.slice(match[0].length)}`
}

function updateFrontmatterVersion(content: string, version: string): string {
  const match = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/)
  if (!match) return `---\nversion: ${version}\n---\n\n${content}`
  const body = match[2]!
  const updated = /^version\s*:/m.test(body)
    ? body.replace(/^version\s*:.*/m, `version: ${version}`)
    : `${body}\nversion: ${version}`
  return `${match[1]}${updated}${match[3]}${content.slice(match[0].length)}`
}

interface WorkspaceSkillDirectory {
  path: string
  slug: string
  active: boolean
  source: WorkspaceSkillSource
}

/** 按不可变 workspaceSkillId 定位副本；绝不以 slug 猜测目标。 */
function findWorkspaceSkillDirectory(workspaceSlug: string, workspaceSkillId: string): WorkspaceSkillDirectory {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(workspaceSkillId, 'workspaceSkillId')
  for (const [root, active] of [[workspaceSkillsRoot(workspaceSlug), true], [workspaceInactiveRoot(workspaceSlug), false]] as const) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      assertSafeSkillSegment(entry.name, 'workspace Skill slug')
      const path = safeSkillPath(root, entry.name, 'workspace Skill slug')
      const source = readSource(path)
      if (source?.workspaceSkillId === workspaceSkillId && existsSync(join(path, 'SKILL.md'))) {
        return { path, slug: entry.name, active, source }
      }
    }
  }
  throw new Error(`工作区 Skill 副本不存在: ${workspaceSkillId}`)
}

/** 给详情 UI 读取工作区副本正文；目标仅由稳定 ID 决定。 */
export function readWorkspaceSkillCopyContent(workspaceSlug: string, workspaceSkillId: string): string {
  const copy = findWorkspaceSkillDirectory(workspaceSlug, workspaceSkillId)
  return readFileSync(join(copy.path, 'SKILL.md'), 'utf-8')
}

/**
 * 原子更新已存在的工作区副本正文，不会回写或重建全局来源。
 * 副本目录改名后仍由 workspaceSkillId 精确命中。
 */
export function saveWorkspaceSkillCopyContent(workspaceSlug: string, workspaceSkillId: string, content: string): void {
  const copy = findWorkspaceSkillDirectory(workspaceSlug, workspaceSkillId)
  const target = join(copy.path, 'SKILL.md')
  const temporary = `${target}.${randomUUID()}.tmp`
  writeFileSync(temporary, content, 'utf-8')
  renameSync(temporary, target)
}

/** 当前工作区的全局 Skill 覆盖清单，仅返回可序列化的快照。 */
export function getWorkspaceGlobalSkillOverrides(workspaceSlug: string): WorkspaceSkillOverridesFile {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  return readWorkspaceSkillOverrides(workspaceSlug)
}

export function readGlobalSkillContent(skillId: string): string {
  const skill = getGlobalSkill(skillId)
  return readFileSync(join(sourcePath(skill), 'SKILL.md'), 'utf-8')
}

function assertEditable(skill: GlobalSkillManifest): void {
  if (skill.type === 'builtin-meta') throw new Error('内置元 Skill 只读，不允许修改或删除')
}

export function saveGlobalSkillContent(skillId: string, content: string): GlobalSkillManifest {
  const skill = getGlobalSkill(skillId)
  assertEditable(skill)
  const dir = sourcePath(skill)
  const nextVersion = bumpPatchVersion(skill.version)
  const parsed = parseMeta(content, skill.slug)
  const duplicate = allGlobalManifests().find((candidate) => candidate.skillId !== skillId && candidate.slug === parsed.slug)
  if (duplicate) throw new Error(`全局 Skill slug 已存在: ${parsed.slug}`)
  const updated: GlobalSkillManifest = {
    ...skill,
    ...parsed,
    version: nextVersion,
    updatedAt: new Date().toISOString(),
  }
  const nextIndex = globalIndex()
  nextIndex.skills[skillId] = { skillId, slug: updated.slug, type: updated.type, version: updated.version }
  copyDirectoryAtomic(dir, dir, (staged) => {
    writeFileSync(join(staged, 'SKILL.md'), updateFrontmatterVersion(content, nextVersion), 'utf-8')
    writeJsonFileAtomic(join(staged, 'skill.manifest.json'), updated)
  }, () => {
    // 索引提交失败时 replaceStagedDirectory 会把旧目录恢复回来。
    saveGlobalIndex(nextIndex)
  })
  return updated
}

/**
 * 返回每个工作区对指定全局 Skill 的实际影响。副本是独立实体：只要全局源并未参与
 * 当前运行时投影，就会作为非阻塞的 replaced-by-workspace-copy 展示，而不是删除墓碑。
 */
export function getGlobalSkillDeleteBlockers(skillId: string): GlobalSkillDeleteBlockers {
  const skill = getGlobalSkill(skillId)
  const references: GlobalSkillWorkspaceReference[] = []
  for (const workspace of listKnownWorkspaces()) {
    const overrides = readWorkspaceSkillOverrides(workspace.slug)
    const override = overrides.globalSkills[skillId]
    const local = scanWorkspaceSkills(workspace.slug)
    const replacement = override?.replacementWorkspaceSkillId
      ? local.find((item) => item.workspaceSkillId === override.replacementWorkspaceSkillId)
      : override?.replacementWorkspaceSkillSlug
        ? local.find((item) => item.sourceSkillId === skillId)
        : undefined
    const localConflict = local.find((item) => item.slug === skill.slug)
    if (replacement) {
      references.push({
        workspaceSlug: workspace.slug, workspaceName: workspace.name,
        status: 'replaced-by-workspace-copy', actualSource: 'workspace',
        reason: 'workspace-copy-replacement', blocksDeletion: false,
        ...(replacement.workspaceSkillId ? { workspaceSkillId: replacement.workspaceSkillId } : {}),
      })
    } else if (override?.enabled === false) {
      references.push({ workspaceSlug: workspace.slug, workspaceName: workspace.name, status: 'disabled', actualSource: 'none', reason: 'disabled-in-workspace', blocksDeletion: false })
    } else if (localConflict) {
      references.push({
        workspaceSlug: workspace.slug, workspaceName: workspace.name,
        status: 'workspace-only', actualSource: 'workspace', reason: 'workspace-local-skill', blocksDeletion: false,
        ...(localConflict.workspaceSkillId ? { workspaceSkillId: localConflict.workspaceSkillId } : {}),
      })
    } else {
      references.push({ workspaceSlug: workspace.slug, workspaceName: workspace.name, status: 'enabled', actualSource: 'global', reason: 'active-global-skill', blocksDeletion: true })
    }
  }
  return { skillId, skillType: skill.type, references }
}

/**
 * 删除前在 Manager 内重新计算引用，不能依赖 UI 曾经展示过的检查结果。
 * 删除只移除用户全局定义及索引；独立工作区副本和 override 均不写入“来源已删除”墓碑。
 */
export function deleteUserGlobalSkill(skillId: string, confirmationToken?: string): void {
  const skill = getGlobalSkill(skillId)
  assertEditable(skill)
  const blockers = getGlobalSkillDeleteBlockers(skillId).references.filter((reference) => reference.blocksDeletion)
  if (blockers.length > 0) {
    throw new Error(`仍有 ${blockers.length} 个工作区正在使用该全局 Skill：${blockers.map((item) => item.workspaceName).join('、')}。请先逐工作区停用或切换为副本。`)
  }
  if (confirmationToken !== `delete:${skillId}`) throw new Error('删除全局 Skill 需要二次确认；删除全局定义不可撤销。')

  const source = sourcePath(skill)
  const backup = `${source}.${randomUUID()}.deleting`
  const indexBefore = globalIndex()
  const indexAfter = { ...indexBefore, skills: { ...indexBefore.skills } }
  const workspaces = listKnownWorkspaces()
  const workspaceBefore = new Map<string, string | null>()
  for (const workspace of workspaces) {
    const path = overridesPath(workspace.slug)
    workspaceBefore.set(workspace.slug, existsSync(path) ? readFileSync(path, 'utf-8') : null)
  }
  delete indexAfter.skills[skillId]
  renameSync(source, backup)
  try {
    saveGlobalIndex(indexAfter)
    // 副本本身保留，但已不存在全局源时任何 override 都是失效管理记录；删除它而不是写墓碑。
    for (const workspace of workspaces) {
      const overrides = readWorkspaceSkillOverrides(workspace.slug)
      if (!(skillId in overrides.globalSkills)) continue
      delete overrides.globalSkills[skillId]
      writeWorkspaceSkillOverrides(workspace.slug, overrides)
    }
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(source) && existsSync(backup)) renameSync(backup, source)
    try { saveGlobalIndex(indexBefore) } catch { /* 保留原始错误 */ }
    for (const [workspaceSlug, raw] of workspaceBefore) {
      const path = overridesPath(workspaceSlug)
      try {
        if (raw === null) { if (existsSync(path)) unlinkSync(path) }
        else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw, 'utf-8') }
      } catch { /* 保留原始错误 */ }
    }
    throw error
  }
}

export function seedBuiltinGlobalSkills(sourceRoot: string): void {
  if (!existsSync(sourceRoot)) return
  const index = globalIndex()
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    assertSafeSkillSegment(entry.name, 'builtin Skill slug')
    if (!existsSync(join(sourceRoot, entry.name, 'SKILL.md'))) continue
    const skillId = `builtin-${entry.name}`
    const source = join(sourceRoot, entry.name)
    const target = skillPath(skillId, 'builtin-meta')
    const existing = readManifest(skillId, 'builtin-meta')
    if (!existing || parseSkillVersion(source) !== existing.version) {
      const manifest = { ...readSkillManifestFromDir(source, skillId, 'builtin-meta'), slug: entry.name }
      copyDirectoryAtomic(source, target, (staged) => writeJsonFileAtomic(join(staged, 'skill.manifest.json'), manifest), () => {
        index.skills[skillId] = { skillId, slug: manifest.slug, type: manifest.type, version: manifest.version }
        saveGlobalIndex(index)
      })
    } else {
      // 即使 index.json 被删除或损坏，重新 seed 也必须恢复稳定 builtin 索引条目。
      index.skills[skillId] = { skillId, slug: existing.slug, type: existing.type, version: existing.version }
      saveGlobalIndex(index)
    }
  }
}

export function copyGlobalSkillToUserGlobal(skillId: string, slug = `${getGlobalSkill(skillId).slug}-copy`): GlobalSkillManifest {
  const source = getGlobalSkill(skillId)
  const normalizedSlug = slug.trim()
  assertSafeSkillSegment(normalizedSlug, 'global Skill slug')
  if (!normalizedSlug) throw new Error('全局 Skill slug 不能为空')
  if (allGlobalManifests().some((skill) => skill.slug === normalizedSlug)) throw new Error(`全局 Skill slug 已存在: ${normalizedSlug}`)
  const newId = randomUUID()
  const target = skillPath(newId, 'user-global')
  try {
    const copiedAt = new Date().toISOString()
    // manifest 的 slug 是运行时和 UI 的统一标识；复制目录中的旧 frontmatter
    // 可能仍然使用源 Skill 名称，必须同步为新用户全局 slug。
    const sourceContent = readFileSync(join(sourcePath(source), 'SKILL.md'), 'utf-8')
    const normalizedContent = updateFrontmatterField(sourceContent, 'name', normalizedSlug)
    const copiedMeta = parseMeta(normalizedContent, normalizedSlug)
    const manifest: GlobalSkillManifest = {
      ...readSkillManifestFromDir(sourcePath(source), newId, 'user-global'),
      ...copiedMeta,
      slug: normalizedSlug,
      createdAt: copiedAt,
      updatedAt: copiedAt,
      source: { sourceSkillId: source.skillId, sourceSkillType: source.type, sourceVersion: source.version, copiedAt },
    }
    const index = globalIndex()
    index.skills[newId] = { skillId: newId, slug: normalizedSlug, type: 'user-global', version: manifest.version }
    copyDirectoryAtomic(sourcePath(source), target, (staged) => {
      writeFileSync(join(staged, 'SKILL.md'), normalizedContent, 'utf-8')
      writeJsonFileAtomic(join(staged, 'skill.manifest.json'), manifest)
    }, () => saveGlobalIndex(index))
    return manifest
  } catch (error) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    throw error
  }
}

function readSource(dir: string): WorkspaceSkillSource | undefined {
  const path = join(dir, '.source.json')
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf-8')) as WorkspaceSkillSource } catch { return undefined }
}
function writeSource(dir: string, source: WorkspaceSkillSource): void {
  writeJsonFileAtomic(join(dir, '.source.json'), source)
}

function ensureWorkspaceSkillId(dir: string, source?: WorkspaceSkillSource): string {
  const existing = source?.workspaceSkillId
  if (existing) return existing
  const workspaceSkillId = randomUUID()
  writeSource(dir, { ...(source ?? { scope: 'workspace' as const }), workspaceSkillId })
  return workspaceSkillId
}
function readWorkspaceSkillOverrides(workspaceSlug: string): WorkspaceSkillOverridesFile {
  const value = readJsonFileSafe<WorkspaceSkillOverridesFile>(overridesPath(workspaceSlug)) ?? { schemaVersion: 1, globalSkills: {} }
  let changed = false
  // 兼容验收前仅保存 slug 的 override：仅当副本 .source.json 明确声明同一来源时回填，绝不按同名猜测。
  for (const [sourceSkillId, override] of Object.entries(value.globalSkills)) {
    if (override.replacementWorkspaceSkillId || !override.replacementWorkspaceSkillSlug) continue
    for (const root of [workspaceSkillsRoot(workspaceSlug), workspaceInactiveRoot(workspaceSlug)]) {
      const dir = safeSkillPath(root, override.replacementWorkspaceSkillSlug, 'replacement workspace Skill slug')
      let source = existsSync(dir) ? readSource(dir) : undefined
      if (source?.sourceSkillId === sourceSkillId) {
        const workspaceSkillId = source.workspaceSkillId ?? ensureWorkspaceSkillId(dir, source)
        if (override.replacementWorkspaceSkillId !== workspaceSkillId) {
          value.globalSkills[sourceSkillId] = { ...override, replacementWorkspaceSkillId: workspaceSkillId }
          changed = true
        }
        break
      }
    }
  }
  if (changed) writeWorkspaceSkillOverrides(workspaceSlug, value)
  return value
}
function writeWorkspaceSkillOverrides(workspaceSlug: string, value: WorkspaceSkillOverridesFile): void {
  mkdirSync(dirname(overridesPath(workspaceSlug)), { recursive: true })
  writeJsonFileAtomic(overridesPath(workspaceSlug), value)
}
function listWorkspaceSlugs(): string[] {
  const root = rootsOverride?.workspacesRoot ?? getAgentWorkspacesDir()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

/** 既包含已有目录，也包含尚未落盘但已登记的工作区，避免漏掉默认启用的全局引用。 */
function listKnownWorkspaces(): Array<{ slug: string; name: string }> {
  const workspaces = new Map(listWorkspaceSlugs().map((slug) => [slug, { slug, name: slug }]))
  if (!rootsOverride) {
    const index = readJsonFileSafe<{ workspaces?: Array<{ slug?: string; name?: string; isDeleted?: boolean }> }>(getAgentWorkspacesIndexPath())
    for (const workspace of index?.workspaces ?? []) {
      if (!workspace.slug || workspace.isDeleted) continue
      try {
        assertSafeSkillSegment(workspace.slug, 'workspaceSlug')
        workspaces.set(workspace.slug, { slug: workspace.slug, name: workspace.name?.trim() || workspace.slug })
      } catch { /* 忽略损坏索引项，不能让删除检查扫描到不安全路径 */ }
    }
  }
  return [...workspaces.values()].sort((left, right) => left.slug.localeCompare(right.slug))
}

export function copyGlobalSkillToWorkspace(skillId: string, workspaceSlug: string): WorkspaceSkillCopyResult {
  const source = getGlobalSkill(skillId)
  const targetSlug = source.slug
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(targetSlug, 'workspace Skill slug')
  const active = safeSkillPath(workspaceSkillsRoot(workspaceSlug), targetSlug, 'workspace Skill slug')
  const inactive = safeSkillPath(workspaceInactiveRoot(workspaceSlug), targetSlug, 'workspace Skill slug')
  if (existsSync(active) || existsSync(inactive)) throw new Error(`当前工作区已存在同名 Skill: ${targetSlug}`)
  const target = active
  const copiedAt = new Date().toISOString()
  const workspaceSkillId = randomUUID()
  const override: WorkspaceGlobalSkillOverride = {
    enabled: true,
    replacementWorkspaceSkillSlug: targetSlug,
    replacementWorkspaceSkillId: workspaceSkillId,
    disabledReason: 'replaced-by-workspace-copy',
    updatedAt: copiedAt,
  }
  const overrides = readWorkspaceSkillOverrides(workspaceSlug)
  const previousOverride = overrides.globalSkills[source.skillId]
  try {
    copyDirectoryAtomic(sourcePath(source), target)
    writeSource(target, { workspaceSkillId, sourceSkillId: source.skillId, sourceSkillType: source.type, sourceVersion: source.version, copiedAt, scope: 'workspace', replacementForSkillId: source.skillId, overrideReason: 'replaced-by-workspace-copy' })
    // 源在本工作区被替换而禁用；副本本身位于 active skills/，会被解析器唯一加载。
    overrides.globalSkills[source.skillId] = { ...override, enabled: false }
    writeWorkspaceSkillOverrides(workspaceSlug, overrides)
  } catch (error) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    if (previousOverride) overrides.globalSkills[source.skillId] = previousOverride
    else delete overrides.globalSkills[source.skillId]
    try { writeWorkspaceSkillOverrides(workspaceSlug, overrides) } catch { /* 保留原始错误 */ }
    throw error
  }
  return { skill: { ...source, enabledInWorkspace: false, replacedInWorkspace: true, sourceStatus: 'available', actualSource: 'workspace' }, workspaceSlug, workspaceSkillSlug: targetSlug, workspaceSkillId, override: overrides.globalSkills[source.skillId]! }
}

export function setGlobalSkillEnabled(workspaceSlug: string, skillId: string, enabled: boolean): void {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const skill = getGlobalSkill(skillId)
  const overrides = readWorkspaceSkillOverrides(workspaceSlug)
  const current = overrides.globalSkills[skillId]
  if (enabled && current?.replacementWorkspaceSkillSlug) {
    throw new Error('当前全局 Skill 已被工作区副本替换，请使用“恢复原全局 Skill”完成显式恢复')
  }
  overrides.globalSkills[skillId] = enabled
    ? { enabled: true, updatedAt: new Date().toISOString() }
    : {
        ...(current ?? {}),
        enabled: false,
        disabledReason: 'user-disabled',
        sourceStatus: 'available',
        updatedAt: new Date().toISOString(),
      }
  writeWorkspaceSkillOverrides(workspaceSlug, overrides)
  void skill
}

export function restoreGlobalSkill(workspaceSlug: string, skillId: string): void {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const overrides = readWorkspaceSkillOverrides(workspaceSlug)
  const current = overrides.globalSkills[skillId]
  if (!current) return
  getGlobalSkill(skillId)
  overrides.globalSkills[skillId] = {
    enabled: true,
    updatedAt: new Date().toISOString(),
  }
  writeWorkspaceSkillOverrides(workspaceSlug, overrides)
}

/**
 * 迁移前备份完整工作区 Skill 目录、来源元数据和 override；正文即使未来修复失败也可恢复。
 * 状态文件中的 completedWorkspaces 使启动中断后可从失败的工作区继续。
 */
function backupWorkspaceMigrationMetadata(workspaceSlug: string, migrationStartedAt: string): void {
  const backupDir = join(workspaceRoot(workspaceSlug), '.migration-backup')
  const backupPath = join(backupDir, `skill-system-${migrationStartedAt.replace(/[:.]/g, '-')}.json`)
  if (existsSync(backupPath)) return
  const sources: Record<string, unknown> = {}
  for (const root of [workspaceSkillsRoot(workspaceSlug), workspaceInactiveRoot(workspaceSlug)]) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillDir = join(root, entry.name)
      if (!existsSync(join(skillDir, 'SKILL.md'))) continue
      const sourceFile = join(skillDir, '.source.json')
      if (existsSync(sourceFile)) {
        try { sources[relative(workspaceRoot(workspaceSlug), sourceFile)] = JSON.parse(readFileSync(sourceFile, 'utf-8')) } catch { sources[relative(workspaceRoot(workspaceSlug), sourceFile)] = 'unreadable' }
      }
      // 旧版本 Skill 通常没有 .source.json，备份必须仍然包含完整正文和资源。
      const contentBackup = join(backupDir, 'skills', relative(workspaceRoot(workspaceSlug), skillDir))
      mkdirSync(dirname(contentBackup), { recursive: true })
      cpSync(skillDir, contentBackup, { recursive: true, dereference: false, errorOnExist: false })
    }
  }
  mkdirSync(backupDir, { recursive: true })
  writeJsonFileAtomic(backupPath, {
    schemaVersion: 2,
    migrationStartedAt,
    skillOverrides: readJsonFileSafe<unknown>(overridesPath(workspaceSlug)) ?? null,
    sources,
  })
}

/** B1/B2 的干净旧副本已验证并备份后退出运行时目录；备份目录保留可人工恢复。 */
function retireCleanLegacySkillCopy(workspaceSlug: string, dir: string, slug: string, active: boolean): void {
  const target = join(workspaceRoot(workspaceSlug), '.migration-backup', 'retired-skills', active ? 'active' : 'inactive', slug)
  if (existsSync(target)) return
  mkdirSync(dirname(target), { recursive: true })
  renameSync(dir, target)
}

function uniqueLegacyUserGlobalSlug(base: string): string {
  const used = new Set(allGlobalManifests().map((skill) => skill.slug))
  let slug = `${base}-legacy`
  let suffix = 2
  while (used.has(slug)) slug = `${base}-legacy-${suffix++}`
  return slug
}

/** 判断旧 master 是否已经作为未修改副本同步到任一工作区。 */
function hasMatchingLegacyWorkspaceCopy(slug: string, legacyDir: string): boolean {
  const normalizedSlug = normalizeDefaultSkillSlug(slug)
  for (const workspaceSlug of listWorkspaceSlugs()) {
    for (const root of [workspaceSkillsRoot(workspaceSlug), workspaceInactiveRoot(workspaceSlug)]) {
      const candidates = [...new Set([slug, normalizedSlug])]
        .map((candidateSlug) => join(root, candidateSlug))
        .filter((candidatePath) => existsSync(join(candidatePath, 'SKILL.md')))
      if (candidates.some((candidatePath) => skillDirectoryHashIgnoringVersion(candidatePath) === skillDirectoryHashIgnoringVersion(legacyDir))) return true
    }
  }
  return false
}

/** 将旧 default-skills 中被手动修改且没有对应干净工作区副本的 master 保存为独立 user-global，绝不覆盖 builtin。 */
function migrateModifiedLegacyMasters(state: SkillSystemMigrationState): { migrated: number; failed: string[] } {
  const legacyRoot = legacyDefaultSkillsRoot()
  if (!existsSync(legacyRoot)) return { migrated: 0, failed: [] }
  let migrated = 0
  const failed: string[] = []
  for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || state.migratedLegacyMasters.includes(entry.name)) continue
    const legacyDir = join(legacyRoot, entry.name)
    if (!existsSync(join(legacyDir, 'SKILL.md'))) continue
    // 工作区中存在与旧 master 完全一致的副本时，它是 B1/B2 证据，不能被误提升为 user-global。
    if (hasMatchingLegacyWorkspaceCopy(entry.name, legacyDir)) {
      state.migratedLegacyMasters.push(entry.name)
      writeMigrationState(state)
      continue
    }
    const builtin = allGlobalManifests().find((skill) => skill.type === 'builtin-meta' && skill.slug === entry.name)
    if (builtin && skillDirectoryHashIgnoringVersion(legacyDir) === skillDirectoryHashIgnoringVersion(sourcePath(builtin))) {
      state.migratedLegacyMasters.push(entry.name)
      writeMigrationState(state)
      continue
    }
    const skillId = randomUUID()
    const target = skillPath(skillId, 'user-global')
    try {
      copyDirectoryAtomic(legacyDir, target)
      const now = new Date().toISOString()
      const manifest: GlobalSkillManifest = {
        ...readSkillManifestFromDir(target, skillId, 'user-global'),
        slug: uniqueLegacyUserGlobalSlug(entry.name),
        createdAt: now,
        updatedAt: now,
        ...(builtin ? { source: { sourceSkillId: builtin.skillId, sourceSkillType: 'builtin-meta' as const, sourceVersion: builtin.version, copiedAt: now } } : {}),
      }
      writeManifest(manifest)
      const index = globalIndex()
      index.skills[skillId] = { skillId, slug: manifest.slug, type: manifest.type, version: manifest.version }
      saveGlobalIndex(index)
      state.migratedLegacyMasters.push(entry.name)
      writeMigrationState(state)
      migrated++
    } catch (error) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      const message = `legacy-master/${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      failed.push(message)
      state.failedEntries = [...state.failedEntries.filter((item) => item !== message), message]
      writeMigrationState(state)
    }
  }
  return { migrated, failed }
}

/**
 * 一次性、可重入地迁移旧 master 工作区副本。
 * 迁移只补充来源元数据和 override，不覆盖正文、不删除目录；无法确认来源时显式标记 unknown-legacy。
 */
export function migrateLegacyWorkspaceSkills(bundleRoot: string): { migrated: number; unknown: number; legacyMasters: number; failed: string[] } {
  const state = readMigrationState()
  // 旧版本曾把“仅同名/带 master 标记”的副本标为 completed；schemaVersion=2
  // 必须重新盘点一次，避免旧结论阻止 B1～B6 规则生效。
  if (state.schemaVersion >= 3 && state.status === 'completed') return { migrated: 0, unknown: 0, legacyMasters: 0, failed: [] }
  const builtinBySlug = new Map<string, { skillId: string; version: string; hash: string }>()
  for (const manifest of allGlobalManifests().filter((item) => item.type === 'builtin-meta')) {
    builtinBySlug.set(manifest.slug, { skillId: manifest.skillId, version: manifest.version, hash: skillDirectoryHashIgnoringVersion(sourcePath(manifest)) })
  }
  // 旧版工作区没有来源元数据时，以旧 default-skills 中的 master 内容作为 B1/B2 的可靠证据。
  // 这里比较“工作区副本 ↔ 旧 master”，而不是“旧 master ↔ 当前 builtin”：新版本
  // 可能已经更新了 builtin 的正文，但旧版用户未修改的同步副本仍应升级为引用。
  const findLegacyBuiltinCandidate = (slug: string, workspaceDir: string): { skillId: string; version: string; hash: string } | undefined => {
    const normalizedSlug = normalizeDefaultSkillSlug(slug)
    const builtin = builtinBySlug.get(normalizedSlug)
    if (!builtin) return undefined
    const legacyRoot = legacyDefaultSkillsRoot()
    const legacyCandidates = [...new Set([slug, normalizedSlug])]
      .map((candidateSlug) => join(legacyRoot, candidateSlug))
      .filter((candidatePath) => existsSync(join(candidatePath, 'SKILL.md')))
    const legacyPath = legacyCandidates[0]
    if (!legacyPath) return undefined
    const workspaceHash = skillDirectoryHashIgnoringVersion(workspaceDir)
    const legacyHash = skillDirectoryHashIgnoringVersion(legacyPath)
    return workspaceHash === legacyHash ? builtin : undefined
  }

  // 兼容上一轮迁移已经写入的稳定旧诊断；新鲜旧备份不依赖该中文字符串。
  const findPreviouslyMisclassifiedBuiltin = (slug: string, source: WorkspaceSkillSource | undefined): { skillId: string; version: string; hash: string } | undefined => {
    if (source?.sourceStatus !== 'unknown-legacy' || !source.migrationReason) return undefined
    const normalizedSlug = normalizeDefaultSkillSlug(slug)
    const builtin = builtinBySlug.get(normalizedSlug)
    return source.migrationReason.includes('疑似元 Skill') && builtin ? builtin : undefined
  }
  // bundleRoot 仅用于保持 API 兼容；builtin 必须先由 seedBuiltinGlobalSkills() 建立稳定 manifest，
  // 不能在迁移阶段凭目录名伪造一个可能不存在的全局 skillId。
  void bundleRoot

  let migrated = 0
  let unknown = 0
  const failed: string[] = []
  const legacyMasterResult = migrateModifiedLegacyMasters(state)
  const legacyMasters = legacyMasterResult.migrated
  failed.push(...legacyMasterResult.failed)
  state.failedEntries = [...state.failedEntries.filter((item) => !item.startsWith('legacy-master/')), ...legacyMasterResult.failed]
  writeMigrationState(state)
  for (const workspaceSlug of listWorkspaceSlugs()) {
    if (state.completedWorkspaces.includes(workspaceSlug)) continue
    try {
      backupWorkspaceMigrationMetadata(workspaceSlug, state.startedAt)
      const overrides = readWorkspaceSkillOverrides(workspaceSlug)
      let changed = false
      for (const [root, enabled] of [[workspaceSkillsRoot(workspaceSlug), true], [workspaceInactiveRoot(workspaceSlug), false]] as const) {
        if (!existsSync(root)) continue
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          assertSafeSkillSegment(entry.name, 'workspace Skill slug')
          if (!existsSync(join(root, entry.name, 'SKILL.md'))) continue
          const dir = safeSkillPath(root, entry.name, 'workspace Skill slug')
          const current = readSource(dir) as (WorkspaceSkillSource & LegacyMasterSource) | undefined
          // 旧版错误迁移会把“官方正文 + 无 sourceKind”的副本写成 unknown-legacy。
          // 仅对该迁移生成的精确诊断重新核验官方指纹；真正来源不明的 B6 仍保持保护态。
          const normalizedLegacySlug = normalizeDefaultSkillSlug(entry.name)
          const sourceCandidate = current?.sourceKind === 'master' && current.masterSlug
            ? builtinBySlug.get(normalizeDefaultSkillSlug(current.masterSlug))
            : undefined
          const previousCandidate = findPreviouslyMisclassifiedBuiltin(entry.name, current)
          const legacyCandidate = !current?.sourceStatus
            ? findLegacyBuiltinCandidate(entry.name, dir)
            : previousCandidate && skillDirectoryHashIgnoringVersion(dir) === previousCandidate.hash
              ? previousCandidate
              : undefined
          // legacyCandidate 已在 findLegacyBuiltinCandidate 内部完成“工作区副本 ↔ 旧 master”比对，
          // 不能再次拿旧副本去和当前 builtin hash 比较：新版本 builtin 可能已经升级正文。
          const cleanCandidate = sourceCandidate && skillDirectoryHashIgnoringVersion(dir) === sourceCandidate.hash
            ? sourceCandidate
            : legacyCandidate
          if (cleanCandidate) {
            // B1/B2：旧副本内容等于未修改的 master，升级为全局引用而不是 workspace 副本。
            overrides.globalSkills[cleanCandidate.skillId] = enabled
              ? { enabled: true, updatedAt: new Date().toISOString() }
              : { enabled: false, disabledReason: 'legacy-meta-copy', updatedAt: new Date().toISOString() }
            retireCleanLegacySkillCopy(workspaceSlug, dir, entry.name, enabled)
            migrated++
            changed = true
            continue
          }
          if (current?.sourceStatus === 'unknown-legacy' || current?.sourceStatus === 'uncertain-legacy-copy' || current?.sourceStatus === 'modified-legacy-copy' || current?.sourceStatus === 'preserved-legacy-disabled-copy') {
            // 已分类的 B3/B4/B5/B6 必须是稳定终态；重试不能因为新增官方基线而改判为 B1/B2。
            if (!current.workspaceSkillId) { ensureWorkspaceSkillId(dir, current); changed = true }
            continue
          }
          if (current?.sourceSkillId) {
            const workspaceSkillId = ensureWorkspaceSkillId(dir, current)
            // 上一次进程可能已写来源元数据、但尚未写 override；重入时补齐
            // 事务的后一半，不改变原正文和 active/inactive 物理状态。
            if (!overrides.globalSkills[current.sourceSkillId]) {
              overrides.globalSkills[current.sourceSkillId] = enabled
                ? {
                    enabled: false,
                    replacementWorkspaceSkillSlug: entry.name,
                    replacementWorkspaceSkillId: workspaceSkillId,
                    disabledReason: 'replaced-by-workspace-copy',
                    updatedAt: new Date().toISOString(),
                  }
                : {
                    enabled: false,
                    disabledReason: 'legacy-meta-copy',
                    updatedAt: new Date().toISOString(),
                  }
              changed = true
            }
            continue
          }
          const candidate = sourceCandidate
          const suspectedBuiltin = current === undefined ? builtinBySlug.get(normalizedLegacySlug) : undefined          // B1/B2 只允许“来源可靠 + 内容等于官方基线”的唯一匹配。
          // 仅同名、版本相同或 sourceKind=master 不能证明正文未被修改。
          const knownModifiedCandidate = candidate && skillDirectoryHashIgnoringVersion(dir) !== candidate.hash ? candidate : undefined

          if (knownModifiedCandidate) {
            // B3/B4：保留正文为独立 workspace Skill，明确禁用全局源。
            const workspaceSkillId = current?.workspaceSkillId ?? randomUUID()
            writeSource(dir, {
              ...current,
              workspaceSkillId,
              sourceSkillId: knownModifiedCandidate.skillId,
              sourceSkillType: 'builtin-meta',
              sourceVersion: current?.sourceVersion ?? knownModifiedCandidate.version,
              copiedAt: current?.importedAt ?? new Date().toISOString(),
              scope: 'workspace',
              replacementForSkillId: knownModifiedCandidate.skillId,
              overrideReason: enabled ? 'modified-legacy-copy' : 'preserved-legacy-disabled-copy',
              sourceStatus: enabled ? 'modified-legacy-copy' : 'preserved-legacy-disabled-copy',
              migrationReason: '来源可靠但内容指纹与官方基线不一致，按独立工作区副本保留',
            })
            overrides.globalSkills[knownModifiedCandidate.skillId] = enabled
              ? { enabled: false, replacementWorkspaceSkillSlug: entry.name, replacementWorkspaceSkillId: workspaceSkillId, disabledReason: 'modified-legacy-copy', updatedAt: new Date().toISOString() }
              : { enabled: false, disabledReason: 'preserved-legacy-disabled-copy', updatedAt: new Date().toISOString() }
            migrated++
            changed = true
          } else if (current?.sourceKind === 'master') {
            // B5：有元 Skill 来源标记但来源/基线无法确认，保留为独立 workspace 副本。
            writeSource(dir, {
              ...current,
              workspaceSkillId: current.workspaceSkillId ?? randomUUID(),
              scope: 'workspace',
              sourceStatus: 'uncertain-legacy-copy',
              migrationReason: `旧元 Skill 来源无法可靠匹配或基线缺失: ${current.masterSlug ?? entry.name}`,
            })
            unknown++
            changed = true
          } else if (suspectedBuiltin) {
            // B6：疑似官方元 Skill（slug 命中）但缺少可验证来源，保守保留独立 workspace 副本。
            writeSource(dir, {
              workspaceSkillId: current?.workspaceSkillId ?? randomUUID(),
              scope: 'workspace',
              sourceStatus: 'unknown-legacy',
              migrationReason: `疑似元 Skill 但缺少可靠来源标记: ${entry.name}`,
            })
            unknown++
            changed = true
          } else {
            // A1/A2：普通用户自建 workspace Skill 没有元 Skill 来源证据，保持原样，不擅自归类为全局。
            const workspaceSkillId = current?.workspaceSkillId ?? randomUUID()
            if (!current?.workspaceSkillId) {
              writeSource(dir, { ...(current ?? {}), workspaceSkillId, scope: 'workspace' })
              changed = true
            }
          }
          void enabled
        }
      }
      if (changed) writeWorkspaceSkillOverrides(workspaceSlug, overrides)
      state.completedWorkspaces = [...new Set([...state.completedWorkspaces, workspaceSlug])]
      state.failedEntries = state.failedEntries.filter((item) => !item.startsWith(`${workspaceSlug}:`))
      writeMigrationState(state)
    } catch (error) {
      const message = `${workspaceSlug}: ${error instanceof Error ? error.message : String(error)}`
      failed.push(message)
      state.failedEntries = [...state.failedEntries.filter((item) => !item.startsWith(`${workspaceSlug}:`)), message]
      writeMigrationState(state)
    }
  }
  state.schemaVersion = 3
  if (failed.length === 0) {
    state.status = 'completed'
    state.completedAt = new Date().toISOString()
    state.failedEntries = []
  } else {
    state.status = 'failed'
    delete state.completedAt
  }
  writeMigrationState(state)
  return { migrated, unknown, legacyMasters, failed }
}

function scanWorkspaceSkills(workspaceSlug: string): ResolvedSkillMeta[] {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const result: ResolvedSkillMeta[] = []
  for (const [root, enabled] of [[workspaceSkillsRoot(workspaceSlug), true], [workspaceInactiveRoot(workspaceSlug), false]] as const) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      assertSafeSkillSegment(entry.name, 'workspace Skill slug')
      if (!existsSync(join(root, entry.name, 'SKILL.md')) || !enabled) continue
      const content = readFileSync(join(root, entry.name, 'SKILL.md'), 'utf-8')
      const meta = parseMeta(content, entry.name)
      const source = readSource(join(root, entry.name))
      const workspaceSkillId = ensureWorkspaceSkillId(join(root, entry.name), source)
      result.push({
        workspaceSkillId,
        slug: entry.name,
        name: meta.name,
        version: parseSkillVersion(join(root, entry.name)),
        path: join(root, entry.name),
        scope: 'workspace',
        actualSource: 'workspace',
        ...(source?.sourceSkillId ? { sourceSkillId: source.sourceSkillId } : {}),
        ...(source?.workspaceSkillId ? { workspaceSkillId: source.workspaceSkillId } : {}),
        ...(source?.sourceSkillType ? { sourceSkillType: source.sourceSkillType } : {}),
        ...(source?.sourceVersion ? { sourceVersion: source.sourceVersion } : {}),
        ...(source?.copiedAt ? { copiedAt: source.copiedAt } : {}),
        ...(source?.replacementForSkillId ? { replacementForSkillId: source.replacementForSkillId } : {}),
        ...(source?.sourceStatus ? { sourceStatus: source.sourceStatus } : {}),
      })
    }
  }
  return result
}

export function resolveEffectiveSkills(workspaceSlug: string): ResolvedSkillMeta[] {
  return resolveSkills(workspaceSlug).skills
}

function resolveSkills(workspaceSlug: string): RuntimeSkillsProjection {
  const overrides = readWorkspaceSkillOverrides(workspaceSlug)
  const local = scanWorkspaceSkills(workspaceSlug)
  const globalsById = new Map(allGlobalManifests().map((skill) => [skill.skillId, skill]))
  // restoreGlobalSkill 只清除 replacement，不删除副本；带来源的 active 副本此时作为备份保留，
  // 不能再次以同 slug 抢占已恢复的全局源。来源删除或 replacement 状态仍允许副本继续生效。
  const effectiveLocal = local.filter((skill) => {
    if (!skill.sourceSkillId) return true
    const source = globalsById.get(skill.sourceSkillId)
    const override = source ? overrides.globalSkills[source.skillId] : undefined
    if (source && override?.enabled === true && !override.replacementWorkspaceSkillId && !override.replacementWorkspaceSkillSlug) return false
    // replacement 必须按稳定 ID 命中；仅旧数据缺少 ID 时才以来源 ID 回退，绝不按 slug 猜测。
    if (source && override?.enabled === false && (override.replacementWorkspaceSkillId || override.replacementWorkspaceSkillSlug)) {
      return override.replacementWorkspaceSkillId
        ? skill.workspaceSkillId === override.replacementWorkspaceSkillId
        : skill.sourceSkillId === source.skillId
    }
    return true
  })
  const localBySlug = new Map(effectiveLocal.map((skill) => [skill.slug, skill]))
  const result: ResolvedSkillMeta[] = []
  const diagnostics: RuntimeSkillsProjection['diagnostics'] = []

  for (const global of allGlobalManifests()) {
    const override = overrides.globalSkills[global.skillId]
    if (override?.enabled === false) {
      const replacementPresent = override.replacementWorkspaceSkillId
        ? local.some((skill) => skill.workspaceSkillId === override.replacementWorkspaceSkillId)
        : Boolean(override.replacementWorkspaceSkillSlug && local.some((skill) => skill.sourceSkillId === global.skillId))
      if ((override.replacementWorkspaceSkillId || override.replacementWorkspaceSkillSlug) && !replacementPresent) {
        diagnostics.push({
          code: 'replacement-missing',
          skillId: global.skillId,
          slug: override.replacementWorkspaceSkillSlug,
          message: `工作区副本不存在或已禁用，原全局 Skill 仍保持禁用: ${global.slug}`,
        })
      }
      continue
    }
    const localConflict = localBySlug.get(global.slug)
    if (localConflict) {
      diagnostics.push({
        code: 'workspace-slug-conflict',
        skillId: global.skillId,
        slug: global.slug,
        message: `工作区 Skill 与全局 Skill 同名，已按工作区优先加载: ${global.slug}`,
      })
      continue
    }
    result.push({
      slug: global.slug,
      name: global.name,
      version: global.version,
      path: sourcePath(global),
      scope: 'global',
      sourceSkillId: global.skillId,
      sourceStatus: 'available',
      actualSource: 'global',
      ...(global.source ? {
        sourceSkillType: global.source.sourceSkillType,
        sourceVersion: global.source.sourceVersion,
        copiedAt: global.source.copiedAt,
      } : {}),
    })
  }

  for (const skill of effectiveLocal) {
    if (result.some((item) => item.slug === skill.slug)) {
      diagnostics.push({ code: 'workspace-slug-conflict', slug: skill.slug, message: `重复 Skill 已忽略: ${skill.slug}` })
      continue
    }
    result.push(skill)
  }
  return { path: '', skills: result, diagnostics }
}

export function prepareRuntimeSkills(workspaceSlug: string): RuntimeSkillsProjection {
  ensureGlobalSkillSystemReady()
  const resolution = resolveSkills(workspaceSlug)
  const resolved = resolution.skills
  const fingerprint = createHash('sha256').update(resolved.map((skill) => `${skill.slug}:${skill.path}:${skill.version}:${skillDirectoryHash(skill.path)}`).sort().join('\n')).digest('hex').slice(0, 16)
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(fingerprint, 'runtime projection directory')
  const projection = safeSkillPath(runtimeRoot(workspaceSlug), fingerprint, 'runtime projection directory')
  const skillsDir = safeSkillPath(projection, 'skills', 'runtime skills directory')
  if (!existsSync(skillsDir)) {
    const temporary = `${projection}.${randomUUID()}.tmp`
    mkdirSync(temporary, { recursive: true })
    try {
      for (const skill of resolved) {
        assertSafeSkillSegment(skill.slug, 'runtime Skill slug')
        const temporarySkills = safeSkillPath(temporary, 'skills', 'runtime skills directory')
        copySkillDirectorySafely(skill.path, safeSkillPath(temporarySkills, skill.slug, 'runtime Skill slug'))
      }
      mkdirSync(join(temporary, '.claude-plugin'), { recursive: true })
      writeJsonFileAtomic(join(temporary, '.claude-plugin', 'plugin.json'), {
        name: `profer-runtime-${workspaceSlug}`,
        version: '1.0.0',
      })
      writeJsonFileAtomic(join(temporary, 'runtime-manifest.json'), { schemaVersion: 1, skills: resolved.map(({ path: _, ...item }) => item) })
      renameSync(temporary, projection)
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
      throw error
    }
  }
  cleanupStaleRuntimeProjections(workspaceSlug, fingerprint)
  return { path: projection, skills: resolved, diagnostics: resolution.diagnostics }
}

/** 仅删除超过 7 天且不等于当前投影的受控 fingerprint 目录，避免影响进行中的 Agent run。 */
function cleanupStaleRuntimeProjections(workspaceSlug: string, currentFingerprint: string): void {
  const root = runtimeRoot(workspaceSlug)
  if (!existsSync(root)) return
  const oldestAllowed = Date.now() - RUNTIME_PROJECTION_MAX_AGE_MS
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === currentFingerprint || !/^[a-f0-9]{16}$/.test(entry.name)) continue
    const candidate = safeSkillPath(root, entry.name, 'runtime projection directory')
    try {
      if (statSync(candidate).mtimeMs < oldestAllowed) rmSync(candidate, { recursive: true, force: true })
    } catch (error) {
      console.warn(`[全局 Skill] 清理过期 runtime projection 失败: ${candidate}`, error)
    }
  }
}

export function getRuntimeSkillsPath(projection: RuntimeSkillsProjection): string {
  return join(projection.path, 'skills')
}

function skillDirectoryHash(dir: string, normalize?: (relativePath: string, content: Buffer) => Buffer): string {
  const hash = createHash('sha256')
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.source.json' || entry.name === 'skill.manifest.json' || !shouldCopySkillEntry(entry.name) || entry.isSymbolicLink()) continue
      const full = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(full, rel)
      else if (entry.isFile()) {
        const raw = readFileSync(full)
        hash.update(rel).update('\\0').update(normalize ? normalize(rel, raw) : raw).update('\\0')
      }
    }
  }
  try { visit(dir, '') } catch { hash.update('unreadable') }
  return hash.digest('hex')
}

/** bundle 只提升版本号时，旧 master 仍视为未修改；正文或资源变化仍会被识别。 */
function skillDirectoryHashIgnoringVersion(dir: string): string {
  return skillDirectoryHash(dir, (relativePath, content) => {
    if (relativePath !== 'SKILL.md') return content
    return Buffer.from(content.toString('utf-8').replace(/^(version\s*:)\s*[^\r\n]+$/m, '$1 <bundle-version>'), 'utf-8')
  })
}
