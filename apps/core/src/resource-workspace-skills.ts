import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GlobalSkillManifest, SkillImportSource, SkillMeta } from '@profer/shared'
import { assertSafeSkillSegment, canonicalSkillSegmentKey } from '@profer/agent-provider-pi/skills/skill-path-security'
import { ensureSkillCard, hasSkillCard, readSkillDescriptor } from '@profer/agent-provider-pi/skills/skill-manifest'
import { atomicWriteFile, atomicWriteJson } from '../../../packages/session-store/src/atomic-write'
import { assertResourcePath, coreWorkspaceDirectory, readResourceObject, resourceObject, resourceText } from './resource-paths'
import type { CoreResourceOperationContext } from './resource-paths'
import { readCoreGlobalSkillDefinitions, resolveCoreSkillSources } from './skill-sources'

export const CORE_WORKSPACE_SKILL_ARITY: Record<string, [number, number]> = {
  getOtherWorkspaceSkills: [1, 1], importSkillFromWorkspace: [3, 3],
  updateSkillFromSource: [2, 2], promoteWorkspaceSkillToGlobal: [3, 4],
}
const excluded = new Set(['skill-library.json', 'skill.manifest.json', '.source.json', '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__'])
function segment(value: unknown, field = 'Skill slug'): string {
  return assertSafeSkillSegment(resourceText(value), field)
}
/** Core 拒绝所有软链（包括悬空链接），不沿用桌面端路径访问行为。 */
function tree(path: string): void {
  assertResourcePath(path)
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isDirectory()) for (const entry of readdirSync(path)) tree(join(path, entry))
  else if (!stat.isFile()) throw new Error('Core Skill仅支持普通文件和目录')
}
function copy(source: string, target: string): void {
  mkdirSync(target)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue
    const from = join(source, entry.name), to = join(target, entry.name)
    if (entry.isDirectory()) copy(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
    else throw new Error('Core Skill仅支持普通文件和目录')
  }
}
function entries(directory: string) {
  return ['skills', 'skills-inactive'].flatMap(kind => {
    const root = join(directory, kind); tree(root)
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.')).map(entry => {
      segment(entry.name)
      return { slug: entry.name, path: join(root, entry.name), enabled: kind === 'skills', isDirectory: entry.isDirectory() }
    })
  })
}
function find(directory: string, slug: string) {
  const matches = entries(directory).filter(entry => canonicalSkillSegmentKey(entry.slug) === canonicalSkillSegmentKey(slug))
  if (matches.length > 1) throw new Error('Core工作区同名Skill重复')
  const item = matches[0]
  if (!item?.isDirectory || !existsSync(join(item.path, 'SKILL.md'))) throw new Error('Core工作区Skill不存在或缺少SKILL.md')
  if (!lstatSync(join(item.path, 'SKILL.md')).isFile()) throw new Error('Core Skill正文不是普通文件')
  return item
}
function importSource(path: string): SkillImportSource | undefined {
  const source = readResourceObject(join(path, '.source.json'))
  if (!source || source.sourceWorkspaceSlug === undefined) return undefined
  segment(source.sourceWorkspaceSlug, 'sourceWorkspaceSlug')
  for (const field of ['sourceWorkspaceName', 'importedAt', 'sourceVersion']) resourceText(source[field], 8192)
  if (source.workspaceSkillId !== undefined) segment(source.workspaceSkillId, 'workspaceSkillId')
  return source as unknown as SkillImportSource
}
function newer(a: string, b: string): boolean {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) { const diff = (left[i] ?? 0) - (right[i] ?? 0); if (diff !== 0) return diff > 0 }
  return false
}
/** 适配现有工作区管理列表，只读取旧来源元数据，不执行迁移或回填。 */
export function coreWorkspaceSkillImportMeta(context: CoreResourceOperationContext, path: string, slug: string): Pick<SkillMeta, 'importSource' | 'hasUpdate'> {
  const source = importSource(path)
  if (!source) return {}
  const workspace = context.workspaces.list().find(item => item.slug === source.sourceWorkspaceSlug)
  if (!workspace) return { importSource: source, hasUpdate: false }
  const { directory } = coreWorkspaceDirectory(context, workspace.slug)
  const candidates = entries(directory).filter(entry => entry.isDirectory && canonicalSkillSegmentKey(entry.slug) === canonicalSkillSegmentKey(slug) && existsSync(join(entry.path, 'SKILL.md')))
  if (candidates.length > 1) throw new Error('Core来源工作区同名Skill重复')
  const version = candidates[0] ? readSkillDescriptor(candidates[0].path, candidates[0].slug).descriptor.version ?? '0.0.0' : undefined
  return { importSource: source, hasUpdate: version !== undefined && newer(version, source.sourceVersion) }
}
function meta(item: { path: string; slug: string; enabled: boolean }, source?: SkillImportSource): SkillMeta {
  const raw = readResourceObject(join(item.path, '.source.json'))
  return { ...readSkillDescriptor(item.path, item.slug).descriptor, slug: item.slug, scope: 'workspace', enabled: item.enabled, actualSource: item.enabled ? 'workspace' : 'none', workspaceSkillId: typeof raw?.workspaceSkillId === 'string' ? raw.workspaceSkillId : undefined, ...(source ? { importSource: source, hasUpdate: false } : {}) }
}
function stage(source: string, target: string, prepare: (path: string) => void): string {
  tree(source); assertResourcePath(target)
  mkdirSync(dirname(target), { recursive: true })
  const path = join(dirname(target), `.stage-${randomUUID()}`)
  try { copy(source, path); prepare(path); return path }
  catch (error) { rmSync(path, { recursive: true, force: true }); throw error }
}
function replace(staged: string, target: string): void {
  const backup = join(dirname(target), `.backup-${randomUUID()}`), had = existsSync(target)
  try {
    if (had) renameSync(target, backup)
    try { renameSync(staged, target) }
    catch (error) { if (had) renameSync(backup, target); throw error }
    if (had) rmSync(backup, { recursive: true })
  } finally { if (existsSync(staged)) rmSync(staged, { recursive: true }) }
}
function writeSource(path: string, source: SkillImportSource): void {
  writeFileSync(join(path, '.source.json'), JSON.stringify(source, null, 2))
}
// 沿用全局库的 frontmatter 字段规范化语义，不依赖桌面管理器。
function frontmatter(content: string, field: string, value: string): string {
  const match = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/)
  if (!match) return `---\n${field}: ${JSON.stringify(value)}\n---\n\n${content}`
  const body = match[2]!, pattern = new RegExp(`^${field}[ \\t]*:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, 'm')
  const updated = pattern.test(body) ? body.replace(pattern, () => `${field}: ${JSON.stringify(value)}`) : `${body}\n${field}: ${JSON.stringify(value)}`
  return `${match[1]}${updated}${match[3]}${content.slice(match[0].length)}`
}
export async function executeCoreWorkspaceSkillOperation(context: CoreResourceOperationContext, operation: string, args: unknown[]): Promise<unknown> {
  const { workspace, directory } = coreWorkspaceDirectory(context, args[0])
  if (operation === 'getOtherWorkspaceSkills') {
    return context.workspaces.list().filter(other => other.slug !== workspace.slug).flatMap(other => {
      const root = coreWorkspaceDirectory(context, other.slug).directory
      const skills = entries(root).filter(item => item.isDirectory && existsSync(join(item.path, 'SKILL.md'))).map(item => ({ ...meta(item), ...coreWorkspaceSkillImportMeta(context, item.path, item.slug) }))
      return skills.length ? [{ workspaceName: other.name, workspaceSlug: other.slug, skills }] : []
    })
  }
  if (operation === 'importSkillFromWorkspace') {
    const origin = coreWorkspaceDirectory(context, args[1]), item = find(origin.directory, segment(args[2]))
    if (entries(directory).some(entry => canonicalSkillSegmentKey(entry.slug) === canonicalSkillSegmentKey(item.slug))) throw new Error('Core工作区同名Skill已存在')
    const target = join(directory, 'skills', item.slug), raw = readResourceObject(join(item.path, '.source.json'))
    const source: SkillImportSource = { workspaceSkillId: raw?.workspaceSkillId === undefined ? randomUUID() : segment(raw.workspaceSkillId, 'workspaceSkillId'), sourceWorkspaceSlug: origin.workspace.slug, sourceWorkspaceName: origin.workspace.name, importedAt: new Date().toISOString(), sourceVersion: readSkillDescriptor(item.path, item.slug).descriptor.version ?? '0.0.0' }
    replace(stage(item.path, target, path => writeSource(path, source)), target)
    return meta({ ...item, path: target, enabled: true }, source)
  }
  const item = find(directory, segment(args[1]))
  if (operation === 'updateSkillFromSource') {
    const old = importSource(item.path)
    if (!old) throw new Error('Core Skill不是从其他工作区导入的')
    if (old.sourceWorkspaceSlug === workspace.slug) throw new Error('Core Skill来源不能是当前工作区')
    const origin = coreWorkspaceDirectory(context, old.sourceWorkspaceSlug), original = find(origin.directory, item.slug)
    const source = { ...old, sourceWorkspaceName: origin.workspace.name, sourceVersion: readSkillDescriptor(original.path, original.slug).descriptor.version ?? '0.0.0' }
    replace(stage(original.path, item.path, path => {
      if (!hasSkillCard(path) && hasSkillCard(item.path)) copyFileSync(join(item.path, 'SKILL.json'), join(path, 'SKILL.json'))
      writeSource(path, source)
    }), item.path)
    return meta(item, source)
  }
  if (operation !== 'promoteWorkspaceSkillToGlobal') throw new Error('Core工作区Skill操作不支持')
  if (!item.enabled) throw new Error('Core只能提升已启用的工作区Skill')
  if (!Array.isArray(args[2]) || args[2].length > 1000) throw new Error('Core目标工作区列表无效')
  if (args[3] !== undefined && typeof args[3] !== 'boolean') throw new Error('Core保留Skill副本参数无效')
  const keep = args[3] !== false, globals = readCoreGlobalSkillDefinitions(context.config)
  if (globals.some(global => canonicalSkillSegmentKey(global.slug) === canonicalSkillSegmentKey(item.slug))) throw new Error('Core全局Skill slug已存在')
  const targets = [...new Set(args[2].map(value => segment(value, 'target workspaceSlug')))].map(slug => coreWorkspaceDirectory(context, slug).directory)
  // 创建全局定义前，先验证所有目标工作区和覆盖配置。
  const changes = targets.map(root => {
    resolveCoreSkillSources(context.config, root)
    const path = assertResourcePath(join(root, 'skill-overrides.json'))
    return { path, before: existsSync(path) ? readFileSync(path, 'utf8') : undefined, value: readResourceObject(path) ?? { schemaVersion: 1, globalSkills: {} } }
  })
  const inactive = assertResourcePath(join(directory, 'skills-inactive', item.slug))
  if (keep && entries(directory).some(entry => !entry.enabled && canonicalSkillSegmentKey(entry.slug) === canonicalSkillSegmentKey(item.slug))) throw new Error('Core不活跃目录已有同名Skill')
  const descriptor = readSkillDescriptor(item.path, item.slug).descriptor, now = new Date().toISOString()
  const manifest: GlobalSkillManifest = { schemaVersion: 1, skillId: randomUUID(), slug: item.slug, type: 'user-global', version: '1.0.0', name: descriptor.name, description: descriptor.description ?? '', createdAt: now, updatedAt: now }
  const target = assertResourcePath(join(context.config.configDir, 'global-skills', 'user', manifest.skillId))
  const staged = stage(item.path, target, path => {
    let content = readFileSync(join(path, 'SKILL.md'), 'utf8')
    for (const [field, value] of Object.entries({ name: manifest.name, description: manifest.description ?? '', version: manifest.version })) content = frontmatter(content, field, value)
    writeFileSync(join(path, 'SKILL.md'), content)
    const card = readResourceObject(join(path, 'SKILL.json'))
    if (card?.version !== undefined) writeFileSync(join(path, 'SKILL.json'), JSON.stringify({ ...card, version: manifest.version }, null, 2))
    ensureSkillCard(path)
    writeFileSync(join(path, 'skill-library.json'), JSON.stringify(manifest, null, 2))
  })
  const saved = keep ? inactive : join(dirname(item.path), `.promoted-${randomUUID()}`)
  let committed = false
  const written: typeof changes = []
  try {
    renameSync(staged, target); committed = true
    for (const change of changes) {
      const map = resourceObject(change.value.globalSkills)
      map[manifest.skillId] = { enabled: true, updatedAt: now }
      written.push(change)
      await atomicWriteJson(change.path, change.value)
    }
    mkdirSync(dirname(saved), { recursive: true }); renameSync(item.path, saved)
  } catch (error) {
    const errors: unknown[] = [error]
    for (const change of written.reverse()) try {
      if (change.before === undefined) rmSync(change.path, { force: true })
      else await atomicWriteFile(change.path, change.before)
    } catch (restoreError) { errors.push(restoreError) }
    if (committed) try { rmSync(target, { recursive: true }) } catch (restoreError) { errors.push(restoreError) }
    if (errors.length > 1) throw new AggregateError(errors, 'Core Skill提升及恢复失败')
    throw error
  } finally { if (existsSync(staged)) rmSync(staged, { recursive: true }) }
  if (!keep) rmSync(saved, { recursive: true })
  return manifest
}
