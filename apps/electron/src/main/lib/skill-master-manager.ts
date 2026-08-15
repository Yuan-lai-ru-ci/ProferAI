/**
 * 全局元 Skill（Master）库管理器 + 工作区同步
 *
 * 把 ~/.profer/default-skills/ 从「随应用版本同步的种子模板」升级为
 * 「用户可编辑、带版本历史、可回退」的元 Skill 库。
 *
 * - 当前内容：~/.profer/default-skills/{slug}/（唯一编辑源，用户修改直接落盘）
 * - 历史快照：~/.profer/default-skills-history/{slug}/v{n}/（v1 为出厂基线；或首次保存）
 * - 版本索引：~/.profer/default-skills-history/{slug}/index.json
 *
 * 同步模型：
 * - 元 skill 是「唯一编辑源」，工作区里的是副本。
 * - 手动同步把元 skill 覆盖到选定工作区，并记录下发基线（baseline 内容哈希 + 版本）。
 * - 冲突检测基于「内容哈希」而非版本号：工作区副本相对上次同步基线被改过即视为冲突，
 *   从而正确捕捉“改了内容但没 bump version”的情况。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getConfigDir, getDefaultSkillsDir, getWorkspaceSkillsDir } from './config-paths'
import type { MasterSkillMeta, MasterSkillVersion, SyncSkillResult, SkillConflict, SkillImportSource } from '@profer/shared'

// ============================================================
// 测试替身：允许测试把真实 ~/.profer 路径替换成临时目录
// ============================================================

let testRootOverride: { masterSkillsDir: string; workspacesDir: string } | null = null

/** 测试用：覆盖默认 skill 库与工作区根目录（不触发真实用户目录读写） */
export function __setSkillMasterRoots(masterSkillsDir: string, workspacesDir: string): void {
  testRootOverride = { masterSkillsDir, workspacesDir }
}

/** 测试用：恢复真实目录 */
export function __resetSkillMasterRoots(): void {
  testRootOverride = null
}

function getMasterSkillsDirBase(): string {
  return testRootOverride?.masterSkillsDir ?? getDefaultSkillsDir()
}

function getWorkspacesDirBase(): string {
  if (testRootOverride?.workspacesDir) return testRootOverride.workspacesDir
  // 与 getConfigDir() 同根，保证 agent-workspaces 与 default-skills 平级
  return join(getConfigDir(), 'agent-workspaces')
}

/** 某工作区 skill 目录（active） */
function workspaceSkillsDirOf(workspaceSlug: string): string {
  if (testRootOverride) {
    return join(getWorkspacesDirBase(), workspaceSlug, 'skills')
  }
  return getWorkspaceSkillsDir(workspaceSlug)
}

// ============================================================
// 路径
// ============================================================

/** master 版本历史根目录 */
function getMasterHistoryRoot(): string {
  return join(getMasterSkillsDirBase(), '..', 'default-skills-history')
}

/** 某 skill 的版本历史目录 */
function getSkillHistoryDir(slug: string): string {
  return join(getMasterHistoryRoot(), slug)
}

/** 某 skill 版本索引文件 */
function getSkillIndexPath(slug: string): string {
  return join(getSkillHistoryDir(slug), 'index.json')
}

interface MasterIndex {
  slug: string
  /** 当前版本号（= 最后一次快照的 version），无快照时为 '' */
  currentVersion: string
  /** 出厂基线版本，首次保存时记录；未记录时为空 */
  baselineVersion?: string
  /** 快照列表（按 v{n} 升序） */
  snapshots: MasterSkillVersion[]
}

function readMasterIndex(slug: string): MasterIndex | null {
  const p = getSkillIndexPath(slug)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as MasterIndex
  } catch {
    return null
  }
}

function writeMasterIndex(slug: string, index: MasterIndex): void {
  const dir = getSkillHistoryDir(slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getSkillIndexPath(slug), JSON.stringify(index, null, 2), 'utf-8')
}

// ============================================================
// 元 skill 库 CRUD
// ============================================================

/** 取默认 skill 目录下所有元 skill slug（仅含 SKILL.md 的子目录） */
export function listMasterSkillSlugs(): string[] {
  const dir = getMasterSkillsDirBase()
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 读取元 skill 当前 SKILL.md 内容 */
export function readMasterSkillContent(slug: string): string {
  const p = join(getMasterSkillsDirBase(), slug, 'SKILL.md')
  if (!existsSync(p)) throw new Error(`元 Skill 不存在: ${slug}`)
  return readFileSync(p, 'utf-8')
}

/** 保存元 skill 当前内容，并自动创建一条新版本快照。 */
export function saveMasterSkill(slug: string, content: string, note?: string): MasterSkillVersion {
  const dir = join(getMasterSkillsDirBase(), slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // 版本 bump：frontmatter 里的 version patch+1，并写回
  const bumped = bumpSkillVersion(content)
  writeFileSync(join(dir, 'SKILL.md'), bumped, 'utf-8')

  // 记录快照
  const index = readMasterIndex(slug) ?? { slug, currentVersion: '', snapshots: [] }
  const newVersion = parseFrontmatterVersion(bumped)
  const snapshotId = `v${(index.snapshots.length || 0) + 1}`
  const version: MasterSkillVersion = {
    version: newVersion,
    snapshotId,
    createdAt: new Date().toISOString(),
    note,
  }
  // 首次保存时记录出厂基线版本
  if (!index.baselineVersion) index.baselineVersion = newVersion
  index.snapshots.push(version)
  index.currentVersion = newVersion
  writeMasterIndex(slug, index)

  // 落盘快照内容
  const snapDir = join(getSkillHistoryDir(slug), snapshotId)
  if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true })
  writeFileSync(join(snapDir, 'SKILL.md'), bumped, 'utf-8')

  return version
}

/** 修改元 skill 元数据（name / description 等），不 bump 版本 */
export function renameMasterSkillMeta(slug: string, patches: { name?: string; description?: string }): void {
  const content = readMasterSkillContent(slug)
  const rebuilt = patchMeta(content, patches)
  const dir = join(getMasterSkillsDirBase(), slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), rebuilt, 'utf-8')
}

/** 读取元 skill 版本历史 */
export function listMasterSkillHistory(slug: string): MasterSkillVersion[] {
  const index = readMasterIndex(slug)
  if (!index) {
    const content = readMasterSkillContent(slug)
    return [{
      version: parseFrontmatterVersion(content),
      snapshotId: 'v1',
      createdAt: new Date().toISOString(),
    }]
  }
  return index.snapshots
}

/** 读取元 skill 当前版本号（无则 ''） */
export function getMasterSkillCurrentVersion(slug: string): string {
  const index = readMasterIndex(slug)
  if (index?.currentVersion) return index.currentVersion
  return parseFrontmatterVersion(readMasterSkillContent(slug))
}

/** 读取某历史快照的 SKILL.md 内容 */
export function readMasterSkillVersionContent(slug: string, snapshotId: string): string {
  const p = join(getSkillHistoryDir(slug), snapshotId, 'SKILL.md')
  if (!existsSync(p)) throw new Error(`快照不存在: ${slug}/${snapshotId}`)
  return readFileSync(p, 'utf-8')
}

/** 回退元 skill 到指定历史快照（写入当前 + 记录一条新快照，保留完整历史） */
export function rollbackMasterSkill(slug: string, snapshotId: string, note?: string): MasterSkillVersion {
  const content = readMasterSkillVersionContent(slug, snapshotId)
  const dir = join(getMasterSkillsDirBase(), slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')

  const index = readMasterIndex(slug) ?? { slug, currentVersion: '', snapshots: [] }
  const nextSnapshotId = `v${(index.snapshots.length || 0) + 1}`
  const version: MasterSkillVersion = {
    version: parseFrontmatterVersion(content),
    snapshotId: nextSnapshotId,
    createdAt: new Date().toISOString(),
    note: note ?? `回退自 ${snapshotId}`,
  }
  index.snapshots.push(version)
  index.currentVersion = version.version
  writeMasterIndex(slug, index)

  const snapDir = join(getSkillHistoryDir(slug), nextSnapshotId)
  if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true })
  writeFileSync(join(snapDir, 'SKILL.md'), content, 'utf-8')
  return version
}

/** 生成 MasterSkillMeta 列表（供 UI 展示） */
export function listMasterSkills(): MasterSkillMeta[] {
  const slugs = listMasterSkillSlugs()
  // 一次扫描所有工作区来源，避免每个 skill 各扫一遍（卡顿根因）
  const syncedCount = countMasterSyncedAll()
  return slugs.map((slug) => {
    const content = readMasterSkillContent(slug)
    const meta = parseMasterFrontmatter(content)
    const index = readMasterIndex(slug)
    const currentVersion = parseFrontmatterVersion(content)
    const userModified = !!index?.baselineVersion && currentVersion !== index.baselineVersion
    return {
      slug,
      name: meta.name || slug,
      description: meta.description,
      group: meta.group,
      icon: meta.icon,
      version: currentVersion,
      userModified,
      syncedWorkspaceCount: syncedCount.get(slug) ?? 0,
      versionCount: index?.snapshots.length || 0,
    }
  })
}

/** 校验 slug 是否存在于元库 */
export function isMasterSkill(slug: string): boolean {
  return existsSync(join(getMasterSkillsDirBase(), slug, 'SKILL.md'))
}

// ============================================================
// 工作区同步 + 冲突检测
// ============================================================

const SOURCE_META_FILE = '.source.json'

/** master 来源标记内容 */
interface MasterSourceFile extends SkillImportSource {
  masterSlug: string
  baselineHash?: string
  baselineHashMap?: Record<string, string>
}

/**
 * 一次性扫描所有个人工作区 .source.json，按 masterSlug 分组统计同步副本数。
 * 避免 listMasterSkills 对每个 master skill 各做一遍全量递归扫描（卡顿根因）。
 * 同步阻塞主进程，仅供主进程 UI 加载时单次调用。
 */
export function countMasterSyncedAll(): Map<string, number> {
  const count = new Map<string, number>()
  for (const f of findWorkspaceSourceFiles()) {
    try {
      const src = JSON.parse(readFileSync(f, 'utf-8')) as MasterSourceFile
      if (src.sourceKind === 'master' && src.masterSlug) {
        count.set(src.masterSlug, (count.get(src.masterSlug) ?? 0) + 1)
      }
    } catch { /* 忽略损坏文件 */ }
  }
  return count
}

/** 统计已同步到多少个工作区（复用一次扫描结果） */
export function countMasterSyncedWorkspaces(masterSlug: string, countMap?: Map<string, number>): number {
  if (countMap) return countMap.get(masterSlug) ?? 0
  return countMasterSyncedAll().get(masterSlug) ?? 0
}

/**
 * 收集所有个人工作区 skills 下（含 skills-inactive）的 .source.json 路径。
 * .source.json 只存在于 skill 目录内，因此只遍历每个工作区的 skills 与
 * skills-inactive 子目录，绝不递归整个 agent-workspaces/ 根（避免遍历会话
 * 目录、workspace-files、.claude、node_modules 等无关/巨型目录带来的卡顿）。
 */
function findWorkspaceSourceFiles(): string[] {
  const root = getWorkspacesDirBase()
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const wsEntry of readdirSync(root, { withFileTypes: true })) {
    if (!wsEntry.isDirectory()) continue
    const wsDir = join(root, wsEntry.name)
    for (const skillsDirName of ['skills', 'skills-inactive']) {
      const skillsDir = join(wsDir, skillsDirName)
      if (existsSync(skillsDir)) {
        collectSourceFiles(skillsDir, out)
      }
    }
  }
  return out
}

/** 在一个 skill 目录树内收集 .source.json（仅一层 skill 结构，仍递归防御子目录） */
function collectSourceFiles(dir: string, out: string[]): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // skill 目录内一般无配置目录，防御性跳过噪音
        if (['.git', 'node_modules', 'dist', '.next', '.cache', '.turbo', '__pycache__'].includes(entry.name)) continue
        collectSourceFiles(full, out)
      } else if (entry.name === SOURCE_META_FILE) {
        out.push(full)
      }
    }
  } catch { /* 忽略不可读目录 */ }
}

/**
 * 同步单个元 skill 到目标工作区（覆盖式）。
 * - 无冲突或 force=true：直接覆盖
 * - 有冲突（副本被用户改过）且非 force：跳过并返回错误，交由 UI 决策
 * - 成功时写入 .source.json 记录 master 来源 + 基线哈希 + 基线版本
 */
export function syncMasterSkillToWorkspace(
  masterSlug: string,
  targetWorkspaceSlug: string,
  opts: { force?: boolean } = {},
): SyncSkillResult {
  const masterDir = join(getMasterSkillsDirBase(), masterSlug)
  if (!existsSync(join(masterDir, 'SKILL.md'))) {
    return { workspaceSlug: targetWorkspaceSlug, success: false, error: `元 Skill 不存在: ${masterSlug}` }
  }

  const targetDir = join(workspaceSkillsDirOf(targetWorkspaceSlug), masterSlug)

  // 冲突检测（除非强制覆盖）
  if (!opts.force) {
    const conflict = detectSkillConflictLocal(targetWorkspaceSlug, masterSlug)
    if (conflict.hasConflict) {
      return {
        workspaceSlug: targetWorkspaceSlug,
        success: false,
        error: `工作区已本地修改该 Skill（${conflict.changedFiles.length} 个文件），未覆盖；如需强制覆盖请重新选择“覆盖”。`,
      }
    }
  }

  // 覆盖式复制（确保目录内容 = 元 skill 当前内容）
  mkdirSync(targetDir, { recursive: true })
  safeReplaceSkillDir(masterDir, targetDir)

  // 记录来源基线
  const masterHash = dirHash(masterDir)
  const source: MasterSourceFile = {
    sourceWorkspaceSlug: 'master',
    sourceWorkspaceName: '全局元 Skill',
    importedAt: new Date().toISOString(),
    sourceVersion: parseFrontmatterVersion(readMasterSkillContent(masterSlug)),
    sourceKind: 'master',
    baselineVersion: parseFrontmatterVersion(readMasterSkillContent(masterSlug)),
    masterSlug,
    baselineHash: masterHash,
    baselineHashMap: buildDirHashMap(masterDir),
  }
  writeSkillImportSource(targetDir, source)

  return { workspaceSlug: targetWorkspaceSlug, success: true, version: source.baselineVersion }
}

/** 批量同步元 skill 到多个工作区（不中断，逐个返回结果） */
export function batchSyncMasterSkill(
  masterSlug: string,
  targetWorkspaceSlugs: string[],
  opts: { force?: boolean; forceSlugs?: string[] } = {},
): SyncSkillResult[] {
  return targetWorkspaceSlugs.map((slug) => {
    const force = opts.force || (opts.forceSlugs ?? []).includes(slug)
    return syncMasterSkillToWorkspace(masterSlug, slug, { force })
  })
}

/** 检测工作区某个 skill 相对 master 同步基线是否存在冲突（被用户改过） */
export function detectSkillConflict(workspaceSlug: string, skillSlug: string): SkillConflict {
  return detectSkillConflictLocal(workspaceSlug, skillSlug)
}

function detectSkillConflictLocal(workspaceSlug: string, skillSlug: string): SkillConflict {
  const skillDir = join(workspaceSkillsDirOf(workspaceSlug), skillSlug)
  if (!existsSync(skillDir)) {
    return { hasConflict: false, changedFiles: [] }
  }

  const source = readSkillImportSource(skillDir)
  if (!source || source.sourceKind !== 'master' || !source.baselineHash) {
    // 未建立 master 同步基线或来源未知：视为无冲突（首次同步由调用方处理）
    return { hasConflict: false, changedFiles: [] }
  }

  const currentHash = dirHash(skillDir)
  if (currentHash === source.baselineHash) {
    return { hasConflict: false, changedFiles: [] }
  }

  // 差异：找出相对基线变化过的文件
  const changedFiles = diffDirAgainstHash(skillDir, source.baselineHashMap)
  return { hasConflict: changedFiles.length > 0, changedFiles }
}

function readSkillImportSource(skillDir: string): MasterSourceFile | undefined {
  const p = join(skillDir, SOURCE_META_FILE)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as MasterSourceFile
  } catch {
    return undefined
  }
}

function writeSkillImportSource(skillDir: string, source: MasterSourceFile): void {
  writeFileSync(join(skillDir, SOURCE_META_FILE), JSON.stringify(source, null, 2), 'utf-8')
}

/** 安全替换目录：先 rm 再 cp，绕只读文件 EACCES */
function safeReplaceSkillDir(sourcePath: string, targetPath: string): void {
  if (existsSync(targetPath)) {
    rmrf(targetPath)
  }
  cpSync(sourcePath, targetPath, { recursive: true })
}

/** 递归删目录（精简，避免引外部） */
function rmrf(targetPath: string): void {
  if (!existsSync(targetPath)) return
  // 懒加载 node:fs rmSync（仅此处使用）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rmSync } = require('node:fs') as typeof import('node:fs')
  rmSync(targetPath, { recursive: true, force: true })
}

/** 计算一个目录下所有文件的相对路径 → 内容哈希 映射 */
function buildDirHashMap(dir: string): Record<string, string> {
  const map: Record<string, string> = {}
  collectFiles(dir, dir, map)
  return map
}

function collectFiles(rootDir: string, currentDir: string, out: Record<string, string>): void {
  try {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const full = join(currentDir, entry.name)
      const rel = entry.name
      if (entry.isDirectory()) {
        // 跳过常见噪音目录
        if (['.git', 'node_modules', 'dist', '.next', '.cache', '.turbo', '__pycache__'].includes(entry.name)) continue
        // 递归：rel 需保持相对 root
        collectFilesInto(rootDir, full, rel, out)
      } else {
        out[rel] = fileHash(full)
      }
    }
  } catch { /* 忽略 */ }
}

function collectFilesInto(rootDir: string, dir: string, baseRel: string, out: Record<string, string>): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = baseRel ? `${baseRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (['.git', 'node_modules', 'dist', '.next', '.cache', '.turbo', '__pycache__'].includes(entry.name)) continue
        collectFilesInto(rootDir, full, rel, out)
      } else {
        out[rel] = fileHash(full)
      }
    }
  } catch { /* 忽略 */ }
}

/** 目录整体内容哈希（纳入 .source.json 自身会变，故排除它） */
function dirHash(dir: string): string {
  const map = buildDirHashMap(dir)
  delete map[SOURCE_META_FILE] // 排除源标记文件自身
  const keys = Object.keys(map).sort()
  const h = createHash('sha256')
  for (const k of keys) {
    h.update(k).update('\x00').update(map[k]!).update('\x00')
  }
  return h.digest('hex')
}

/** 相对基线哈希表 diff，返回变化的文件相对路径列表 */
function diffDirAgainstHash(dir: string, baselineMap: Record<string, string> | undefined): string[] {
  if (!baselineMap) return []
  const current = buildDirHashMap(dir)
  delete current[SOURCE_META_FILE]
  const changed: string[] = []

  // 新增/变化
  for (const k of Object.keys(current)) {
    if (current[k] !== baselineMap[k]) changed.push(k)
  }
  // 删除
  for (const k of Object.keys(baselineMap)) {
    if (!(k in current)) changed.push(k)
  }
  return changed
}

function fileHash(absPath: string): string {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex')
  } catch {
    return ''
  }
}

// ============================================================
// 内部工具：版本 bump / frontmatter 读写
// ============================================================

/** 从 SKILL.md frontmatter 解析 version，无则 '0.0.0' */
function parseFrontmatterVersion(content: string): string {
  const fm = extractFrontmatter(content)
  if (!fm) return '0.0.0'
  const m = fm.match(/^version\s*:\s*["']?([\w.\-]+)["']?/m)
  return m?.[1] || '0.0.0'
}

/** 简单 frontmatter 解析（name/description/group/icon），用于 listMasterSkills */
function parseMasterFrontmatter(content: string): { name?: string; description?: string; group?: string; icon?: string } {
  const fm = extractFrontmatter(content)
  const out: { name?: string; description?: string; group?: string; icon?: string } = {}
  if (!fm) return out
  for (const line of fm.split('\n')) {
    const m = line.match(/^(name|description|group|icon)\s*:\s*(.*)$/)
    if (m && m[1]) {
      const v = (m[2] ?? '').trim().replace(/^["']|["']$/g, '')
      if (v) out[m[1] as 'name' | 'description' | 'group' | 'icon'] = v
    }
  }
  return out
}

/** 提取 frontmatter（去除 BOM），无则返回 null */
function extractFrontmatter(content: string): string | null {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/)
  return m?.[1] ?? null
}

/** 拆分 body（不含 frontmatter），无 frontmatter 返回原串 */
function splitFrontmatter(content: string): { fm: string | null; body: string } {
  const fm = extractFrontmatter(content)
  if (!fm) return { fm: null, body: content }
  const after = content.replace(/^---\s*\n[\s\S]*?\n---/, '').replace(/^\n/, '')
  return { fm, body: after }
}

/** 把 frontmatter 里 version 字段 patch+1，无 version 则追加 */
function bumpSkillVersion(content: string): string {
  const { fm, body } = splitFrontmatter(content)
  if (!fm) {
    return `---\nversion: 0.1.0\n---\n\n${body}`
  }
  const versionLine = fm.match(/^version\s*:\s*["']?([\w.\-]+)["']?/m)
  let newFm: string
  if (versionLine) {
    const current = versionLine[1] ?? '0.0.0'
    const next = bumpVersion(current)
    newFm = fm.replace(/^(version\s*:\s*["']?)([\w.\-]+)(["']?)$/m, `$1${next}$3`)
  } else {
    newFm = `version: 0.1.0\n${fm}`
  }
  return `---\n${newFm}\n---\n\n${body}`
}

/** patch frontmatter 里 name/description */
function patchMeta(content: string, patches: { name?: string; description?: string }): string {
  const { fm, body } = splitFrontmatter(content)
  if (!fm) return content
  let newFm = fm
  if (patches.name !== undefined) newFm = replaceFrontmatterValue(newFm, 'name', patches.name)
  if (patches.description !== undefined) newFm = replaceFrontmatterValue(newFm, 'description', patches.description)
  return `---\n${newFm}\n---\n\n${body}`
}

function replaceFrontmatterValue(fm: string, key: string, value: string): string {
  const lineRe = new RegExp(`^${key}\\s*:\\s*[^|>].*$`, 'm')
  if (lineRe.test(fm)) {
    return fm.replace(lineRe, `${key}: ${value}`)
  }
  return `${key}: ${value}\n${fm}`
}

/** 版本 patch+1；非法则返回 '0.1.0' */
function bumpVersion(v: string): string {
  if (!v) return '0.1.0'
  const parts = v.split('.')
  if (parts.length < 3) return `${v}.1`
  const patchPart = parts[2] ?? ''
  const patch = parseInt(patchPart, 10)
  if (Number.isNaN(patch)) return `${parts[0]}.${parts[1]}.1`
  const nextPatch = patch + 1
  const suffix = patchPart.replace(/^\d+/, '')
  return `${parts[0]}.${parts[1]}.${nextPatch}${suffix}`
}
