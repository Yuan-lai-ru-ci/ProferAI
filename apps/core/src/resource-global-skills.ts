import type { GlobalSkillDeleteBlockers, GlobalSkillWorkspaceReference } from '@profer/shared'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { atomicWriteFile, atomicWriteJson } from '../../../packages/session-store/src/atomic-write'
import { assertSafeSkillSegment, canonicalSkillSegmentKey } from '@profer/agent-provider-pi/skills/skill-path-security'
import { ensureSkillCard, hasSkillCard, skillCardDismissalKey } from '@profer/agent-provider-pi/skills/skill-manifest'
import { resolveCoreSkillSources } from './skill-sources'
import { applyCoreSkillCardDecision, readCoreSkillCard, readCoreSkillCardDismissals, writeCoreSkillCard } from './resource-skill-cards'
import { assertResourcePath, coreWorkspaceDirectory, readResourceObject, resourceObject, resourceText } from './resource-paths'
import type { CoreResourceOperationContext } from './resource-paths'

// 与global-skill-manager相同的frontmatter字段更新语义；JSON引号保证换行安全。
function frontmatter(content: string, field: string, value: string): string {
  const match=content.match(/^(---\s*\n)([\s\S]*?)(\n---)/)
  if (!match) return `---\n${field}: ${JSON.stringify(value)}\n---\n\n${content}`
  const body=match[2]!, pattern=new RegExp(`^${field}\\s*:.*$`,'m')
  const updated=pattern.test(body)?body.replace(pattern,`${field}: ${JSON.stringify(value)}`):`${body}\n${field}: ${JSON.stringify(value)}`
  return `${match[1]}${updated}${match[3]}${content.slice(match[0].length)}`
}
async function metadata(content: string) {
  if (!/^---\s*\n/.test(content)) throw new Error('Core全局Skill正文缺少frontmatter')
  const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent')
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content)
  if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) throw new Error('Core全局Skill正文名称无效')
  if (frontmatter.description !== undefined && typeof frontmatter.description !== 'string') throw new Error('Core全局Skill正文描述无效')
  return { name: frontmatter.name, description: frontmatter.description as string | undefined }
}
function replaceDirectory(source: string | undefined,target: string,prepare:(stage:string)=>void) {
  const stage=join(dirname(target),`.stage-${randomUUID()}`), backup=join(dirname(target),`.backup-${randomUUID()}`)
  assertResourcePath(target); if(source) tree(source)
  mkdirSync(dirname(target),{recursive:true})
  try {
    if(source) cpSync(source,stage,{recursive:true}); else mkdirSync(stage)
    prepare(stage)
    const had=existsSync(target)
    if(had) renameSync(target,backup)
    try { renameSync(stage,target) } catch(error) { if(had) renameSync(backup,target); throw error }
    if(had) rmSync(backup,{recursive:true})
  } finally { if(existsSync(stage)) rmSync(stage,{recursive:true}) }
}
export const CORE_GLOBAL_SKILL_ARITY: Record<string,[number,number]> = {
  'globalSkill.list': [0,1], 'globalSkill.read': [1,1], 'globalSkill.createUser': [4,5], 'globalSkill.save': [4,4],
  'globalSkill.readCard': [1,1], 'globalSkill.writeCard': [2,2],
  'globalSkill.getDeleteBlockers': [1,1], 'globalSkill.deleteUser': [1,2],
  'globalSkill.copyToUser': [1,2], 'globalSkill.copyToWorkspace': [2,2], 'globalSkill.setEnabled': [3,3],
  'globalSkill.getOverrides': [1,1], 'globalSkill.restore': [2,2], 'globalSkill.readWorkspaceCopy': [2,2], 'globalSkill.saveWorkspaceCopy': [3,3],
}
function tree(path: string): void {
  assertResourcePath(path)
  if (existsSync(path)) for (const item of readdirSync(path, { withFileTypes: true })) {
    const child = join(path,item.name); assertResourcePath(child); if (item.isDirectory()) tree(child)
  }
}
function globals(context: CoreResourceOperationContext) {
  const root = join(context.config.configDir,'global-skills'); tree(root)
  return ['builtin','user'].flatMap(kind => {
    const dir = join(root,kind)
    return existsSync(dir) ? readdirSync(dir).filter(id => !id.startsWith('.')).map(id => {
      assertSafeSkillSegment(id,'skillId'); const path = join(dir,id)
      const manifest = readResourceObject(join(path,'skill-library.json')) ?? readResourceObject(join(path,'skill.manifest.json'))
      if (!manifest || manifest.schemaVersion !== 1 || manifest.skillId !== id || manifest.type !== (kind === 'builtin' ? 'builtin-meta' : 'user-global') || typeof manifest.slug !== 'string' || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !existsSync(join(path,'SKILL.md'))) throw new Error('Core全局Skill账本损坏')
      assertSafeSkillSegment(manifest.slug,'slug')
      return { manifest, path }
    }) : []
  })
}
function overrides(directory: string) {
  const value = readResourceObject(join(directory,'skill-overrides.json')) ?? { schemaVersion: 1, globalSkills: {} }
  if (value.schemaVersion !== 1) throw new Error('Core Skill覆盖schema错误')
  for (const item of Object.values(resourceObject(value.globalSkills))) if (typeof resourceObject(item).enabled !== 'boolean') throw new Error('Core Skill覆盖损坏')
  return value
}
function deleteReferences(context: CoreResourceOperationContext, manifest: Record<string, unknown>): GlobalSkillDeleteBlockers {
  const skillId = String(manifest.skillId)
  const references: GlobalSkillWorkspaceReference[] = context.workspaces.list().map(workspace => {
    const { directory } = coreWorkspaceDirectory(context, workspace.slug)
    const override = resourceObject(resourceObject(overrides(directory).globalSkills)[skillId] ?? {})
    const local = ['skills', 'skills-inactive'].flatMap(kind => {
      const root = join(directory, kind); tree(root)
      return existsSync(root) ? readdirSync(root).filter(slug => existsSync(join(root, slug, 'SKILL.md'))).map(slug => ({ slug, enabled: kind === 'skills', source: readResourceObject(join(root, slug, '.source.json')) ?? {} })) : []
    })
    const replacement = override.replacementWorkspaceSkillId
      ? local.find(item => item.source.workspaceSkillId === override.replacementWorkspaceSkillId)
      : override.replacementWorkspaceSkillSlug ? local.find(item => item.source.sourceSkillId === skillId) : undefined
    const conflict = local.find(item => item.enabled && canonicalSkillSegmentKey(item.slug) === canonicalSkillSegmentKey(String(manifest.slug)))
    const base = { workspaceSlug: workspace.slug, workspaceName: workspace.name }
    const effective = resolveCoreSkillSources(context.config, directory)
    if (effective.skills.some(skill => skill.actualSource === 'global' && skill.sourceSkillId === skillId)) return { ...base, status: 'enabled', actualSource: 'global', reason: 'active-global-skill', blocksDeletion: true }
    if (replacement) return { ...base, status: 'replaced-by-workspace-copy', actualSource: 'workspace', reason: 'workspace-copy-replacement', blocksDeletion: false, ...(typeof replacement.source.workspaceSkillId === 'string' ? { workspaceSkillId: replacement.source.workspaceSkillId } : {}) }
    if (override.enabled === false) return { ...base, status: 'disabled', actualSource: 'none', reason: 'disabled-in-workspace', blocksDeletion: false }
    if (conflict) return { ...base, status: 'workspace-only', actualSource: 'workspace', reason: 'workspace-local-skill', blocksDeletion: false, ...(typeof conflict.source.workspaceSkillId === 'string' ? { workspaceSkillId: conflict.source.workspaceSkillId } : {}) }
    return { ...base, status: 'enabled', actualSource: 'global', reason: 'active-global-skill', blocksDeletion: true }
  })
  return { skillId, skillType: manifest.type === 'builtin-meta' ? 'builtin-meta' : 'user-global', references }
}
async function deleteUserSkill(context: CoreResourceOperationContext, item: { manifest: Record<string, unknown>; path: string }, confirmation: unknown): Promise<void> {
  if (item.manifest.type !== 'user-global') throw new Error('Core内置Skill不可删除')
  const id = String(item.manifest.skillId)
  const blockers = deleteReferences(context, item.manifest).references.filter(reference => reference.blocksDeletion)
  if (blockers.length) throw new Error(`仍有 ${blockers.length} 个工作区正在使用该全局 Skill，请先停用或切换为副本`)
  if (confirmation !== `delete:${id}`) throw new Error('删除全局 Skill 需要二次确认')
  const writes: Array<{ path: string; value: Record<string, unknown>; before: string }> = []
  for (const workspace of context.workspaces.list()) {
    const { directory } = coreWorkspaceDirectory(context, workspace.slug)
    const path = join(directory, 'skill-overrides.json'), value = overrides(directory), map = resourceObject(value.globalSkills)
    if (!Object.hasOwn(map, id)) continue
    delete map[id]
    writes.push({ path, value, before: readFileSync(path, 'utf8') })
  }
  const indexPath = join(context.config.configDir, 'global-skills', 'index.json'), index = readResourceObject(indexPath)
  if (index) {
    const skills = resourceObject(index.skills); delete skills[id]
    writes.push({ path: indexPath, value: index, before: readFileSync(indexPath, 'utf8') })
  }
  const backup = join(dirname(item.path), `.deleting-${randomUUID()}`)
  assertResourcePath(backup)
  renameSync(item.path, backup)
  try {
    for (const { path, value } of writes) await atomicWriteJson(path, value)
    rmSync(backup, { recursive: true })
  } catch (error) {
    const failures: unknown[] = [error]
    try { renameSync(backup, item.path) } catch (restoreError) { failures.push(restoreError) }
    for (const { path, before } of writes) {
      try { await atomicWriteFile(path, before) } catch (restoreError) { failures.push(restoreError) }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Core全局Skill删除及恢复失败')
    throw error
  }
}
export async function executeCoreGlobalSkillOperation(context: CoreResourceOperationContext, operation: string, args: unknown[]): Promise<unknown> {
  const entries = globals(context)
  if (operation === 'globalSkill.list') {
    const dir = args[0] == null ? undefined : coreWorkspaceDirectory(context,args[0]).directory
    const map = dir ? resourceObject(overrides(dir).globalSkills) : {}
    const dismissed = dir ? undefined : readCoreSkillCardDismissals(context.config.configDir)
    return entries.map(({manifest, path}) => {
      const override = resourceObject(map[String(manifest.skillId)] ?? {})
      const needsCardReminder = dismissed && manifest.type === 'user-global' && !hasSkillCard(path)
        && !dismissed.has(skillCardDismissalKey('global', String(manifest.skillId)))
      return { ...manifest, ...(needsCardReminder ? { needsCardReminder: true } : {}), enabledInWorkspace: override.enabled ?? true, replacedInWorkspace: Boolean(override.replacementWorkspaceSkillId), actualSource: override.replacementWorkspaceSkillId ? 'workspace' : override.enabled === false ? 'none' : 'global', sourceStatus: 'available', ...(override.replacementWorkspaceSkillId ? { workspaceSkillId: override.replacementWorkspaceSkillId, replacementForSkillId: manifest.skillId } : {}) }
    })
  }
  if (operation === 'globalSkill.getOverrides') return overrides(coreWorkspaceDirectory(context,args[0]).directory)
  if (operation === 'globalSkill.readWorkspaceCopy' || operation === 'globalSkill.saveWorkspaceCopy') {
    const {directory} = coreWorkspaceDirectory(context,args[0]); const id = resourceText(args[1])
    const copies = ['skills','skills-inactive'].flatMap(kind => {
      const root = join(directory,kind); tree(root)
      return existsSync(root) ? readdirSync(root).map(slug => join(root,slug)).filter(path => readResourceObject(join(path,'.source.json'))?.workspaceSkillId === id) : []
    })
    if (copies.length !== 1) throw new Error('Core工作区Skill稳定ID不存在或重复')
    const path = join(copies[0]!,'SKILL.md'); assertResourcePath(path)
    if (operation === 'globalSkill.readWorkspaceCopy') return readFileSync(path,'utf8')
    await atomicWriteFile(path,resourceText(args[2],1_000_000)); return
  }
  if (operation === 'globalSkill.createUser') {
    const slug = resourceText(args[0]); assertSafeSkillSegment(slug,'slug')
    if (entries.some(e => canonicalSkillSegmentKey(String(e.manifest.slug)) === canonicalSkillSegmentKey(slug))) throw new Error('Core全局Skill slug已存在')
    const name = resourceText(args[1],512), description = resourceText(args[2],8192), content = resourceText(args[3],1_000_000)
    if (!name.trim()) throw new Error('Core全局Skill名称不能为空')
    const id = randomUUID(), path = join(context.config.configDir,'global-skills','user',id); assertResourcePath(path)
    const manifest = { schemaVersion: 1, skillId: id, slug, name, description, type: 'user-global', version: '1.0.0', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const normalized=frontmatter(frontmatter(frontmatter(content,'name',name),'description',description),'version',manifest.version)
    await metadata(normalized)
    if (args[4] !== undefined && typeof args[4] !== 'boolean') throw new Error('Core Skill导入参数无效')
    replaceDirectory(undefined, path, stage => {
      writeFileSync(join(stage, 'SKILL.md'), normalized)
      if (args[4] !== true) ensureSkillCard(stage)
      writeFileSync(join(stage, 'skill-library.json'), JSON.stringify(manifest, null, 2))
    }); return manifest
  }
  const workspaceOp = operation === 'globalSkill.setEnabled' || operation === 'globalSkill.restore'
  const id = resourceText(args[workspaceOp ? 1 : 0]); assertSafeSkillSegment(id,'skillId')
  const item = entries.find(e => e.manifest.skillId === id)
  if (!item) throw new Error('Core全局Skill不存在')
  if (operation === 'globalSkill.getDeleteBlockers') return deleteReferences(context, item.manifest)
  if (operation === 'globalSkill.deleteUser') return deleteUserSkill(context, item, args[1])
  if (operation === 'globalSkill.read') return readFileSync(join(item.path,'SKILL.md'),'utf8')
  if (operation === 'globalSkill.readCard') return readCoreSkillCard(item.path)
  if (operation === 'globalSkill.writeCard' || operation === 'globalSkill.resolveCardReminder') {
    if (item.manifest.type !== 'user-global') throw new Error('Core内置Skill不可直接修改')
    if (operation === 'globalSkill.writeCard') return writeCoreSkillCard(item.path, args[1])
    const decision = args[1]
    if (decision !== 'create' && decision !== 'dismiss') throw new Error('Skill 路由卡片提醒选项无效')
    return applyCoreSkillCardDecision(context.config.configDir, item.path, skillCardDismissalKey('global', id), decision)
  }
  if (operation === 'globalSkill.copyToUser') {
    const slug=resourceText(args[1]??`${item.manifest.slug}-copy`); assertSafeSkillSegment(slug,'slug')
    if(entries.some(e=>canonicalSkillSegmentKey(String(e.manifest.slug))===canonicalSkillSegmentKey(slug))) throw new Error('Core全局Skill slug已存在')
    const id=randomUUID(), target=join(context.config.configDir,'global-skills','user',id)
    const manifest={...item.manifest,skillId:id,slug,type:'user-global',version:'1.0.0',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
    replaceDirectory(item.path,target,stage=>{
      for(const name of ['.source.json','skill-library.json','skill.manifest.json']) rmSync(join(stage,name),{force:true})
      const content=frontmatter(frontmatter(readFileSync(join(stage,'SKILL.md'),'utf8'),'name',String(item.manifest.name)),'version',manifest.version)
      writeFileSync(join(stage,'SKILL.md'),content);writeFileSync(join(stage,'skill-library.json'),JSON.stringify(manifest,null,2))
    }); return manifest
  }
  if (workspaceOp) {
    const {directory} = coreWorkspaceDirectory(context,args[0]); const value = overrides(directory), map = resourceObject(value.globalSkills)
    if (operation === 'globalSkill.restore') map[id] = { enabled: true }
    else { if (typeof args[2] !== 'boolean') throw new Error('Core Skill enabled无效'); map[id] = { ...resourceObject(map[id] ?? {}), enabled: args[2] } }
    await atomicWriteJson(join(directory,'skill-overrides.json'),value); return
  }
  if (operation === 'globalSkill.copyToWorkspace' || operation === 'globalSkill.save' && args[3] === 'workspace') {
    const slug = args[operation === 'globalSkill.copyToWorkspace' ? 1 : 2], {directory} = coreWorkspaceDirectory(context,slug)
    const target = join(directory,'skills',String(item.manifest.slug)); assertResourcePath(target)
    if (existsSync(target) || existsSync(join(directory,'skills-inactive',String(item.manifest.slug)))) throw new Error('Core工作区同名Skill已存在')
    const content = operation === 'globalSkill.save' ? resourceText(args[1],1_000_000) : readFileSync(join(item.path,'SKILL.md'),'utf8')
    const value = overrides(directory), map = resourceObject(value.globalSkills), workspaceSkillId = randomUUID()
    cpSync(item.path,target,{recursive:true}); await atomicWriteFile(join(target,'SKILL.md'),content)
    await atomicWriteJson(join(target,'.source.json'),{ scope: 'workspace', workspaceSkillId, sourceSkillId: id, sourceSkillType: item.manifest.type, sourceVersion: item.manifest.version, sourceStatus: 'available' })
    const override = { enabled: false, replacementWorkspaceSkillId: workspaceSkillId, replacementWorkspaceSkillSlug: item.manifest.slug }; map[id] = override
    await atomicWriteJson(join(directory,'skill-overrides.json'),value)
    return { skill: item.manifest, workspaceSlug: slug, workspaceSkillSlug: item.manifest.slug, workspaceSkillId, override }
  }
  if (operation === 'globalSkill.save') {
    if (args[3] !== 'global') throw new Error('Core Skill保存作用域无效')
    if (item.manifest.type === 'builtin-meta') throw new Error('Core内置Skill不可直接修改')
    const content = resourceText(args[1],1_000_000), version = String(item.manifest.version).split('.').map(Number)
    if (version.length !== 3 || version.some(v => !Number.isInteger(v))) throw new Error('Core Skill版本损坏')
    const fields=await metadata(content)
    const updated = { ...item.manifest, name:fields.name!, description:fields.description??'', version: `${version[0]}.${version[1]}.${version[2]!+1}`, updatedAt: new Date().toISOString() }
    const normalized=frontmatter(content,'version',updated.version)
    replaceDirectory(item.path,item.path,stage=>{
      writeFileSync(join(stage,'SKILL.md'),normalized)
      // 模块清单是descriptor最高优先级，存在时同步展示字段，防止运行投影继续使用旧名称版本。
      const card=readResourceObject(join(stage,'SKILL.json'))
      if (card) writeFileSync(join(stage,'SKILL.json'), JSON.stringify({
        ...card,
        ...(card.name !== undefined ? { name: updated.name } : {}),
        ...(card.description !== undefined ? { description: updated.description } : {}),
        ...(card.version !== undefined ? { version: updated.version } : {}),
      }, null, 2))
      writeFileSync(join(stage,'skill-library.json'),JSON.stringify(updated,null,2))
    }); return updated
  }
  throw new Error('Core全局Skill操作不支持')
}
