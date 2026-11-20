import { CORE_GLOBAL_SKILL_ARITY, executeCoreGlobalSkillOperation } from './resource-global-skills'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep, relative } from 'node:path'
import { atomicWriteFile, atomicWriteJson } from '../../../packages/session-store/src/atomic-write'
import { assertSafeSkillSegment, canonicalSkillSegmentKey } from '@profer/agent-provider-pi/skills/skill-path-security'
import { readSkillDescriptor, readSkillManifest } from '@profer/agent-provider-pi/skills/skill-manifest'
import { CORE_PRESET_OPERATION_ARITY, executeCorePresetOperation } from './resource-presets'
import { parseSkillManifest, SKILL_MANIFEST_FILENAME, SKILL_MANIFEST_SCHEMA_VERSION } from '@profer/shared'
import { resolveCoreSkillSources } from './skill-sources'

export type { CoreResourceOperationContext, CoreResourceOperationBody } from './resource-paths'
import type { CoreResourceOperationContext, CoreResourceOperationBody } from './resource-paths'
import { assertResourcePath, coreWorkspaceDirectory, readResourceObject, resourceObject, resourceText } from './resource-paths'
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Core资源布尔参数无效'); return value }
function segment(value: unknown): string { const result = resourceText(value); return assertSafeSkillSegment(result, 'Skill slug') }
function safeTree(path: string): void {
  assertResourcePath(path)
  if (existsSync(path) && lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) safeTree(join(path, entry))
}
function mcp(path: string) {
  const raw = readResourceObject(path) ?? { servers: {} }
  const servers = resourceObject(raw.servers)
  validateMcpServers(servers)
  return { raw, servers: servers as Record<string, Record<string, unknown>> }
}
function validateMcpServers(servers: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(servers)) {
    segment(name)
    if (name === 'planning' || name === 'goal') throw new Error('Core用户MCP不能覆盖内置控制服务器')
    const entry = resourceObject(value)
    for (const key of ['command', 'url', 'type']) if (entry[key] !== undefined) resourceText(entry[key], 8192)
    if (entry.type !== undefined && !['stdio', 'http', 'sse'].includes(String(entry.type))) throw new Error('Core MCP transport不支持')
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.length > 256 || entry.args.some(v => typeof v !== 'string' || v.length > 8192))) throw new Error('Core MCP args无效')
    for (const field of ['env', 'headers']) if (entry[field] !== undefined) {
      const map = resourceObject(entry[field]); if (Object.values(map).some(v => typeof v !== 'string')) throw new Error('Core MCP凭据映射无效')
    }
    if (entry.enabled !== undefined) bool(entry.enabled)
  }
}
function mergeMcp(base: Record<string, Record<string, unknown>>, local: Record<string, Record<string, unknown>>) {
  const result = structuredClone(base)
  for (const [name, entry] of Object.entries(local)) {
    result[name] = { ...base[name], ...entry }
    for (const key of ['env', 'headers']) if (base[name]?.[key] || entry[key]) result[name]![key] = { ...resourceObject(base[name]?.[key] ?? {}), ...resourceObject(entry[key] ?? {}) }
  }
  for (const entry of Object.values(result)) entry.type ??= entry.command ? 'stdio' : entry.url ? 'http' : undefined
  return result
}
function resourceMemory(directory: string, project: boolean) {
  const profile = join(directory, project ? 'profile.md' : 'workspace-profile.md')
  assertResourcePath(profile)
  const memory = join(directory, project ? 'memory' : '.profer/memory'); safeTree(memory)
  let count = 0, total = 0
  const collect = (dir: string) => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir)) { const path = join(dir, entry), st = statSync(path); if (st.isDirectory()) collect(path); else { count++; total += st.size } } }
  collect(memory)
  return { workspaceProfile: { exists: existsSync(profile), path: profile, size: existsSync(profile) ? statSync(profile).size : 0 }, autoMemory: { directory: memory, indexExists: existsSync(join(memory, 'MEMORY.md')), fileCount: count, totalSize: total } }
}
function skillChild(root: string, value: unknown): string {
  const path = resourceText(value, 4096)
  const parts = path.split('/')
  if (!parts.length || parts.some(part => !part)) throw new Error('Core Skill相对路径无效')
  for (const part of parts) segment(part)
  const target = join(root, ...parts)
  if (relative(root, target).startsWith('..')) throw new Error('Core Skill路径越界')
  return assertResourcePath(target)
}
function skillFiles(root: string, directory = root): unknown[] {
  return readdirSync(directory).sort().map(name => {
    const path = join(directory, name), st = statSync(path), rel = relative(root, path).split(sep).join('/')
    return { name, relativePath: rel, type: st.isDirectory() ? 'directory' : 'file', size: st.size, ...(st.isDirectory() ? { children: skillFiles(root, path) } : {}) }
  })
}
const arity: Record<string, [number, number]> = {
  getWorkspaceMcpConfig: [1,1], saveWorkspaceMcpConfig: [2,2], getWorkspaceCapabilities: [1,1],
  getAllWorkspaceSkills: [1,2], getWorkspaceSkillsDir: [1,1], getDefaultSkillSlugs: [0,0],
  createWorkspaceSkill: [5,5], deleteWorkspaceSkill: [2,2], toggleWorkspaceSkill: [3,4],
  readWorkspaceSkillContent: [2,2], writeWorkspaceSkillContent: [3,3], readWorkspaceSkillCard: [2,2], writeWorkspaceSkillCard: [3,3],
  listSkillFiles: [2,2], readSkillFile: [3,3], writeSkillFile: [4,4], createSkillEntry: [4,4], deleteSkillEntry: [3,3], renameSkillEntry: [4,4],
  ...CORE_PRESET_OPERATION_ARITY,
  ...CORE_GLOBAL_SKILL_ARITY,
}
export const CORE_RESOURCE_OPERATIONS = Object.freeze(Object.keys(arity))
/** 固定操作集合；未知及尚不支持的操作明确拒绝，不存在桌面fallback。 */
async function executeResourceOperation(context: CoreResourceOperationContext, body: CoreResourceOperationBody): Promise<unknown> {
  const input = resourceObject(body)
  const operation = resourceText(input.operation)
  if (!Object.hasOwn(arity, operation)) throw new Error(`Core资源操作不支持：${operation}`)
  const args = input.args
  const [min, max] = arity[operation]!
  if (!Array.isArray(args) || args.length < min || args.length > max || JSON.stringify(args).length > 2_000_000) throw new Error('Core资源参数数量或长度无效')
  if (Object.hasOwn(CORE_GLOBAL_SKILL_ARITY, operation)) return executeCoreGlobalSkillOperation(context, operation, args)
  if (Object.hasOwn(CORE_PRESET_OPERATION_ARITY, operation)) return executeCorePresetOperation(context, operation, args)
  if (operation === 'getDefaultSkillSlugs') {
    const root = join(context.config.configDir, 'global-skills', 'builtin'); safeTree(root)
    return existsSync(root) ? readdirSync(root).map(id => resourceText(readResourceObject(join(root, id, 'skill-library.json'))?.slug)) : []
  }
  const { workspace, directory } = coreWorkspaceDirectory(context, args[0])
  const mcpPath = join(directory, 'mcp.json')
  if (operation === 'getWorkspaceMcpConfig' || operation === 'saveWorkspaceMcpConfig') {
    const base = mcp(mcpPath), local = workspace.storageMode === 'project' ? mcp(join(directory, 'mcp.local.json')) : { servers: {} as Record<string, Record<string, unknown>> }
    if (operation === 'getWorkspaceMcpConfig') return { ...base.raw, servers: mergeMcp(base.servers, local.servers) }
    const next = resourceObject(args[1]); const nextServers = resourceObject(next.servers)
    validateMcpServers(nextServers)
    const servers: Record<string,Record<string,unknown>> = {}, locals: Record<string,Record<string,unknown>> = {}
    for (const [name,value] of Object.entries(nextServers)) {
      const draft = structuredClone(resourceObject(value)), prior = base.servers[name], overlay = local.servers[name]
      if (workspace.storageMode !== 'project') { servers[name]=draft; continue }
      if (overlay && !prior) { locals[name]=draft; continue }
      const localDraft: Record<string,unknown> = overlay ? structuredClone(overlay) : {}
      for (const key of Object.keys(overlay ?? {})) {
        if (key === 'env' || key === 'headers') continue
        if (draft[key] === undefined) delete localDraft[key]; else localDraft[key]=draft[key]
        if (prior?.[key] === undefined) delete draft[key]; else draft[key]=prior[key]
      }
      for (const key of ['env','headers']) {
        const map={...resourceObject(draft[key]??{})}, original=resourceObject(prior?.[key]??{}), oldLocal=resourceObject(overlay?.[key]??{}), owned:Record<string,unknown>={}
        for (const field of Object.keys(map)) if (Object.hasOwn(oldLocal,field) || !Object.hasOwn(original,field)) { owned[field]=map[field]; delete map[field] }
        for (const field of Object.keys(oldLocal)) if (Object.hasOwn(original,field)) map[field]=original[field]
        if (Object.keys(map).length) draft[key]=map; else delete draft[key]
        if (Object.keys(owned).length) localDraft[key]=owned; else delete localDraft[key]
      }
      servers[name]=draft
      if (Object.keys(localDraft).length) locals[name]=localDraft
    }
    validateMcpServers(servers); validateMcpServers(locals)
    const baseValue={...base.raw,...next,servers}
    if (workspace.storageMode === 'project') {
      const localPath=join(directory,'mcp.local.json'), localRaw=readResourceObject(localPath)??{}
      // 预先完成全部验证；任一步写失败恢复原始字节，失败不吞。
      const beforeBase=existsSync(mcpPath)?readFileSync(mcpPath,'utf8'):undefined, beforeLocal=existsSync(localPath)?readFileSync(localPath,'utf8'):undefined
      try { await atomicWriteJson(localPath,{...localRaw,servers:locals}); await atomicWriteJson(mcpPath,baseValue) }
      catch(error) {
        try { if(beforeLocal===undefined) rmSync(localPath,{force:true}); else await atomicWriteFile(localPath,beforeLocal); if(beforeBase===undefined) rmSync(mcpPath,{force:true}); else await atomicWriteFile(mcpPath,beforeBase) }
        catch(restoreError) { throw new AggregateError([error,restoreError],'Core MCP保存及恢复失败') }
        throw error
      }
    } else await atomicWriteJson(mcpPath,baseValue)
    return
  }
  for (const root of ['skills', 'skills-inactive']) safeTree(join(directory, root))
  safeTree(join(context.config.configDir, 'global-skills'))
  assertResourcePath(join(directory, 'skill-overrides.json'))
  const projection = resolveCoreSkillSources(context.config, directory)
  const local = ['skills', 'skills-inactive'].flatMap(root => {
    const path = join(directory, root)
    return existsSync(path) ? readdirSync(path).filter(slug => !slug.startsWith('.') && existsSync(join(path, slug, 'SKILL.md'))).map(slug => ({ ...readResourceObject(join(path, slug, '.source.json')), ...readSkillDescriptor(join(path, slug), slug).descriptor, slug, enabled: root === 'skills', actualSource: root === 'skills' ? 'workspace' : 'none', path: join(path, slug) })) : []
  })
  if (operation === 'getWorkspaceSkillsDir') return join(directory, 'skills')
  if (operation === 'getWorkspaceCapabilities') return { builtinMcpServers: [], memory: resourceMemory(directory, workspace.storageMode === 'project'), mcpServers: Object.entries(mergeMcp(mcp(mcpPath).servers, workspace.storageMode === 'project' ? mcp(join(directory, 'mcp.local.json')).servers : {})).map(([name, value]) => ({ name, ...value })), skills: projection.skills.map(skill => ({ ...skill, enabled: true })) }
  if (operation === 'getAllWorkspaceSkills') {
    if (args[1] !== undefined) bool(args[1])
    // projection只含生效来源；全局禁用条目也必须可重新启用。
    const global = resolveCoreSkillSources(context.config).skills.map(skill => ({ ...skill, enabled: projection.skills.some(item => item.sourceSkillId === skill.sourceSkillId && item.actualSource === 'global') }))
    return args[1] ? [...local, ...global] : local
  }
  const slug = segment(args[1]), item = local.find(entry => canonicalSkillSegmentKey(entry.slug) === canonicalSkillSegmentKey(slug))
  if (operation === 'toggleWorkspaceSkill') {
    const enabled = bool(args[2]), source = args[3] === undefined ? undefined : resourceText(args[3])
    if (source || (!item && source === undefined)) {
      const globals = resolveCoreSkillSources(context.config).skills
      const global = globals.find(entry => source ? entry.sourceSkillId === segment(source) : entry.slug === slug)
      if (!global?.sourceSkillId) throw new Error('Core全局Skill来源不存在')
      const path = join(directory, 'skill-overrides.json'), overrides = readResourceObject(path) ?? { schemaVersion: 1, globalSkills: {} }
      await atomicWriteJson(path, { ...overrides, globalSkills: { ...resourceObject(overrides.globalSkills), [global.sourceSkillId]: { ...resourceObject(resourceObject(overrides.globalSkills)[global.sourceSkillId] ?? {}), enabled } } }); return
    }
    if (!item) throw new Error('Core工作区Skill不存在')
    if (item.enabled === enabled) return
    const target = join(directory, enabled ? 'skills' : 'skills-inactive', slug); assertResourcePath(target)
    if (existsSync(target)) throw new Error('Core Skill目标已存在')
    mkdirSync(dirname(target), { recursive: true }); renameSync(item.path, target); return
  }
  if (operation === 'createWorkspaceSkill') {
    if (item) throw new Error('Core工作区Skill已存在')
    const name = resourceText(args[2], 512), description = resourceText(args[3], 8192), content = resourceText(args[4], 1_000_000)
    if (!name.trim()) throw new Error('Core Skill名称不能为空')
    const path = join(directory, 'skills', slug); assertResourcePath(path)
    if (existsSync(path) || existsSync(join(directory, 'skills-inactive', slug))) throw new Error('Core Skill目标已存在')
    mkdirSync(path, { recursive: true })
    await atomicWriteFile(join(path, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nversion: 1.0.0\n---\n\n${content}`)
    await atomicWriteJson(join(path, '.source.json'), { scope: 'workspace', workspaceSkillId: randomUUID() }); return
  }
  if (!item) throw new Error('Core工作区Skill不存在；全局Skill不可直接修改')
  if (operation === 'listSkillFiles') return skillFiles(item.path)
  if (['readSkillFile','writeSkillFile','createSkillEntry','deleteSkillEntry','renameSkillEntry'].includes(operation)) {
    const path = skillChild(item.path, args[2])
    if (operation === 'readSkillFile') {
      const st = statSync(path)
      if (!st.isFile() || st.size > 1_000_000) throw new Error('Core Skill文件不是普通小文件')
      const bytes = readFileSync(path), binary = bytes.includes(0)
      return { relativePath: args[2], size: st.size, isText: !binary, ...(binary ? {} : { content: bytes.toString('utf8') }) }
    }
    if (args[2] === '.source.json' && operation !== 'readSkillFile') throw new Error('Core Skill来源身份不可改写')
    if (operation === 'writeSkillFile') { await atomicWriteFile(path, resourceText(args[3], 1_000_000)); return }
    if (operation === 'createSkillEntry') {
      if (existsSync(path)) throw new Error('Core Skill目标已存在')
      if (args[3] === 'directory') mkdirSync(path, { recursive: true })
      else if (args[3] === 'file') await atomicWriteFile(path, '')
      else throw new Error('Core Skill条目类型无效')
      return
    }
    if (args[2] === 'SKILL.md' || args[2] === '.source.json') throw new Error('Core Skill身份或正文不能删除/改名')
    if (operation === 'deleteSkillEntry') { rmSync(path, { recursive: true }); return }
    if (args[3] === '.source.json' || args[3] === 'SKILL.md') throw new Error('Core Skill身份或正文不能作为重命名覆盖目标')
    const target = skillChild(item.path, args[3])
    if (existsSync(target)) throw new Error('Core Skill目标已存在')
    mkdirSync(dirname(target), { recursive: true }); renameSync(path, target); return
  }
  if (operation === 'readWorkspaceSkillContent') return readFileSync(join(item.path, 'SKILL.md'), 'utf8')
  if (operation === 'writeWorkspaceSkillContent') { await atomicWriteFile(join(item.path, 'SKILL.md'), resourceText(args[2], 1_000_000)); return }
  if (operation === 'readWorkspaceSkillCard') return { ...readSkillManifest(item.path), doctor: [] }
  if (operation === 'writeWorkspaceSkillCard') {
    const path = join(item.path, SKILL_MANIFEST_FILENAME)
    const merged = readResourceObject(path) ?? {}
    const patch = resourceObject(args[2])
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') { delete merged[key]; continue }
      if (['interface','policy','triggers','dependencies','requires'].includes(key)) {
        const group = { ...resourceObject(merged[key] ?? {}) }
        for (const [field, v] of Object.entries(resourceObject(value))) {
          if (v === null || v === '' || Array.isArray(v) && v.length === 0) delete group[field]
          else group[field] = v
        }
        if (Object.keys(group).length) merged[key] = group; else delete merged[key]
      } else merged[key] = value
    }
    merged.schemaVersion = SKILL_MANIFEST_SCHEMA_VERSION
    const parsed = parseSkillManifest(merged)
    if (!parsed.manifest || parsed.issues.some(issue => issue.severity === 'error')) throw new Error('Core Skill卡片校验未通过')
    if (Object.keys(merged).every(key => key === 'schemaVersion')) { if (existsSync(path)) rmSync(path); return { present: false, issues: [], doctor: [] } }
    await atomicWriteJson(path, merged); return { ...readSkillManifest(item.path), doctor: [] }
  }
  if (operation === 'deleteWorkspaceSkill') { rmSync(item.path, { recursive: true }); return }
  throw new Error(`Core资源操作未实现：${operation}`)
}

// 同一Core的资源读改写串行，防止并发开关或预设更新丢字段。
const resourceQueues = new Map<string, Promise<unknown>>()
export async function executeCoreResourceOperation(context: CoreResourceOperationContext, body: CoreResourceOperationBody): Promise<unknown> {
  const key = resolve(context.config.configDir)
  const previous = resourceQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => executeResourceOperation(context, body))
  resourceQueues.set(key, current)
  try { return await current } finally { if (resourceQueues.get(key) === current) resourceQueues.delete(key) }
}
