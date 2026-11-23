import { afterAll, test, expect } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeCoreResourceOperation } from './resource-operations'
import type { CoreConfig } from './config'
import type { AgentWorkspace, GlobalSkillMeta, SkillMeta } from '@profer/shared'

const fixtureRoots: string[] = []
afterAll(() => { for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true }) })

function fixture(project = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-resource-')))
  fixtureRoots.push(root)
  const config: CoreConfig = { host: 'localhost', port: 7788, configDir: root, workspaceRoot: join(root, 'workspaces') }
  const workspace = { id: 'ws', slug: 'same', name: 'Same', ...(project ? { storageMode: 'project', rootPath: join(root, 'project') } : {}) } as AgentWorkspace
  const directory = project ? join(root, 'project', '.profer') : join(config.workspaceRoot, 'same')
  mkdirSync(directory, { recursive: true })
  const context = { config, workspaces: { list: () => [workspace] } }
  const call = (operation: string, ...args: unknown[]) => executeCoreResourceOperation(context, { operation, args })
  return { root, config, directory, context, call }
}
test('Core 工作区新建随附默认卡；旧 Skill 的拒绝与创建以各自身份持久化', async () => {
  const f = fixture(true)
  await f.call('createWorkspaceSkill', 'same', 'new-skill', 'New skill', 'Use when needed', 'body')
  expect(await f.call('readWorkspaceSkillCard', 'same', 'new-skill')).toMatchObject({ present: true, manifest: { schemaVersion: 1 } })
  expect(await f.call('writeWorkspaceSkillCard', 'same', 'new-skill', { policy: { implicit: null } })).toMatchObject({ present: true })
  const legacyDir = join(f.directory, 'skills', 'old-skill')
  mkdirSync(legacyDir)
  writeFileSync(join(legacyDir, 'SKILL.md'), '---\nname: Old Skill\n---\n')
  const target = { scope: 'workspace', workspaceSlug: 'same', skillSlug: 'old-skill' }
  const get = async () => (await f.call('getAllWorkspaceSkills', 'same') as SkillMeta[]).find(skill => skill.slug === 'old-skill')!
  expect((await get()).needsCardReminder).toBe(true)
  await expect(f.call('resolveSkillCardReminder', { ...target, workspaceSkillId: 'stale' }, 'dismiss')).rejects.toThrow('Skill 已变更')
  await f.call('resolveSkillCardReminder', target, 'dismiss')
  expect(existsSync(join(legacyDir, 'SKILL.json'))).toBe(false)
  expect(await get()).toMatchObject({ needsCardReminder: false, workspaceSkillId: expect.any(String) })
  await f.call('toggleWorkspaceSkill', 'same', 'old-skill', false, '')
  expect(await get()).toMatchObject({ enabled: false, needsCardReminder: false })
  await f.call('resolveSkillCardReminder', target, 'create')
  expect(await f.call('readWorkspaceSkillCard', 'same', 'old-skill')).toMatchObject({ present: true, manifest: { schemaVersion: 1 } })
})

test('Core 用户全局创建默认卡，导入没有卡且各自保留创建或拒绝决定', async () => {
  const f = fixture()
  const added = await f.call('globalSkill.createUser', 'new-skill', 'New', '', 'body') as GlobalSkillMeta
  const imported = await f.call('globalSkill.createUser', 'imported', 'Imported', '', 'body', true) as GlobalSkillMeta
  const other = await f.call('globalSkill.createUser', 'other', 'Other', '', 'body', true) as GlobalSkillMeta
  expect(await f.call('globalSkill.readCard', added.skillId)).toMatchObject({ manifest: { schemaVersion: 1 } })
  const reminderSlugs = async () => (await f.call('globalSkill.list') as GlobalSkillMeta[]).filter(skill => skill.needsCardReminder).map(skill => skill.slug).sort()
  expect(await reminderSlugs()).toEqual(['imported', 'other'])
  await f.call('resolveSkillCardReminder', { scope: 'global', skillId: imported.skillId }, 'dismiss')
  expect(await f.call('globalSkill.readCard', imported.skillId)).toMatchObject({ present: false })
  expect(await reminderSlugs()).toEqual(['other'])
  await f.call('resolveSkillCardReminder', { scope: 'global', skillId: other.skillId }, 'create')
  expect(await f.call('globalSkill.readCard', other.skillId)).toMatchObject({ present: true, manifest: { schemaVersion: 1 } })
  expect(await f.call('globalSkill.writeCard', other.skillId, { dependencies: { mcpServers: ['github'] } })).toMatchObject({ manifest: { dependencies: { mcpServers: ['github'] } } })
  expect(await reminderSlugs()).toEqual([])
})

test('资源工作区目录失效不补建；Skill条目不能改名覆盖来源身份', async () => {
  const f = fixture(true)
  const projectRoot = f.context.workspaces.list()[0]!.rootPath!
  rmSync(projectRoot, { recursive: true })
  await expect(f.call('saveWorkspaceMcpConfig', 'same', { servers: {} })).rejects.toThrow('目录不存在')
  expect(() => readFileSync(join(projectRoot, '.profer', 'mcp.json'), 'utf8')).toThrow()
  const local = fixture()
  await local.call('createWorkspaceSkill', 'same', 'example', 'Example', '', 'body')
  await local.call('createSkillEntry', 'same', 'example', 'test.txt', 'file')
  await expect(local.call('renameSkillEntry', 'same', 'example', 'test.txt', '.source.json')).rejects.toThrow()
})

test('未知操作、参数、所属工作区及路径拒绝', async () => {
  const { call } = fixture()
  await expect(call('constructor')).rejects.toThrow()
  await expect(call('getWorkspaceMcpConfig', 'missing')).rejects.toThrow()
  await expect(call('getWorkspaceMcpConfig', 'same', 'extra')).rejects.toThrow()
  await expect(call('createWorkspaceSkill', 'same', '../escape', 'n', 'd', 'c')).rejects.toThrow()
})
test('独立Core同slug Skill创建、读取、开关、删除不串根', async () => {
  const a = fixture(), b = fixture()
  await a.call('createWorkspaceSkill', 'same', 'example', 'Example', 'Description', 'A')
  expect(await a.call('readWorkspaceSkillContent', 'same', 'example')).toContain('A')
  await expect(b.call('readWorkspaceSkillContent', 'same', 'example')).rejects.toThrow()
  await a.call('toggleWorkspaceSkill', 'same', 'example', false, '')
  expect(await a.call('getAllWorkspaceSkills', 'same')).toMatchObject([{ slug: 'example', enabled: false }])
  await a.call('writeWorkspaceSkillContent', 'same', 'example', 'changed')
  await a.call('deleteWorkspaceSkill', 'same', 'example')
  expect(await a.call('getAllWorkspaceSkills', 'same')).toEqual([])
})
test('project MCP local凭据不泄漏base，未知字段保留，损坏拒绝写入', async () => {
  const { call, directory } = fixture(true)
  writeFileSync(join(directory, 'mcp.json'), JSON.stringify({ future: true, servers: { service: { type: 'http', url: 'https://base', headers: { Authorization: 'base' } } } }))
  writeFileSync(join(directory, 'mcp.local.json'), JSON.stringify({ servers: { service: { headers: { Authorization: 'secret' } } } }))
  const effective = await call('getWorkspaceMcpConfig', 'same')
  await call('saveWorkspaceMcpConfig', 'same', effective)
  expect(readFileSync(join(directory, 'mcp.json'), 'utf8')).not.toContain('secret')
  expect(JSON.parse(readFileSync(join(directory, 'mcp.json'), 'utf8')).future).toBe(true)
  writeFileSync(join(directory, 'mcp.json'), '{broken')
  await expect(call('saveWorkspaceMcpConfig', 'same', { servers: {} })).rejects.toThrow()
  expect(readFileSync(join(directory, 'mcp.json'), 'utf8')).toBe('{broken')
})
test('软链Skill及配置拒绝', async () => {
  const { call, directory, root } = fixture()
  mkdirSync(join(directory, 'skills'))
  symlinkSync(root, join(directory, 'skills', 'link'))
  await expect(call('writeWorkspaceSkillContent', 'same', 'link', 'overwrite')).rejects.toThrow()
  symlinkSync(join(root, 'absent'), join(directory, 'mcp.json'))
  await expect(call('saveWorkspaceMcpConfig', 'same', { servers: {} })).rejects.toThrow()
})

test('workspace预设保存后runtime同源解析、builtin基座展开及Core隔离', async () => {
  const a = fixture(true), b = fixture(true)
  const { resolveCorePreset } = await import('./preset-resources')
  const created = await a.call('createAgentPreset', 'same', { name: 'Scoped', description: 'test', basePresetId: 'minimal', skillSlugs: ['example'] }) as { id: string }
  await a.call('setDefaultPresetId', 'same', created.id)
  const workspace = a.context.workspaces.list()[0]!
  const result = resolveCorePreset(a.config, { workspaceId: workspace.id } as import('@profer/shared').AgentSessionMeta, workspace)
  expect(result.preset.id).toBe(created.id)
  expect(result.preset.skillSlugs).toEqual(['example'])
  expect(result.preset.disabledToolGroups?.length).toBeGreaterThan(0)
  await expect(b.call('setDefaultPresetId', 'same', created.id)).rejects.toThrow()
  await a.call('updateAgentPreset', 'same', created.id, { skillSlugs: [] })
  expect(resolveCorePreset(a.config, { workspaceId: workspace.id } as import('@profer/shared').AgentSessionMeta, workspace).preset.skillSlugs).toEqual([])
  await expect(a.call('updateAgentPreset', 'same', created.id, { permissionMode: 'invented' })).rejects.toThrow()
})
test('Skill卡片共享校验，保存后runtime读取同源', async () => {
  const { call, config, directory } = fixture()
  const { resolveCoreSkillSources } = await import('./skill-sources')
  await call('createWorkspaceSkill', 'same', 'example', 'Example', '', 'body')
  await call('writeWorkspaceSkillCard', 'same', 'example', { name: 'New name', version: '2.0.0' })
  expect(resolveCoreSkillSources(config, directory).skills[0]?.name).toBe('New name')
  await expect(call('writeWorkspaceSkillCard', 'same', 'example', { dependencies: { toolGroups: ['invented'] } })).rejects.toThrow()
  expect(resolveCoreSkillSources(config, directory).skills[0]?.version).toBe('2.0.0')
})
test('MCP保存后runtime同源读取、非法输入不写', async () => {
  const { call, directory } = fixture()
  const { loadCoreMcpServers } = await import('./mcp-resources')
  const { createEffectiveAgentPresetPolicy, BUILTIN_AGENT_PRESETS } = await import('@profer/shared')
  const policy = createEffectiveAgentPresetPolicy(BUILTIN_AGENT_PRESETS[0]!, { presetId: 'standard', presetScope: 'builtin-meta' }, { permissionMode: 'auto', runtimeSupportsSubagents: true })
  await call('saveWorkspaceMcpConfig', 'same', { servers: { service: { type: 'http', url: 'https://example.test' } } })
  expect(loadCoreMcpServers(directory, false, policy).service?.url).toBe('https://example.test')
  await expect(call('saveWorkspaceMcpConfig', 'same', { servers: { service: { args: [42] } } })).rejects.toThrow()
  expect(loadCoreMcpServers(directory, false, policy).service?.url).toBe('https://example.test')
})
test('Skill文件CRUD与越界、身份保护', async () => {
  const { call } = fixture()
  await call('createWorkspaceSkill', 'same', 'sample', 'Sample', '', 'body')
  await call('createSkillEntry', 'same', 'sample', 'docs/a.txt', 'file')
  await call('writeSkillFile', 'same', 'sample', 'docs/a.txt', 'hello')
  expect(await call('readSkillFile', 'same', 'sample', 'docs/a.txt')).toMatchObject({ content: 'hello', isText: true })
  await expect(call('writeSkillFile', 'same', 'sample', '../escape', 'bad')).rejects.toThrow()
  await expect(call('writeSkillFile', 'same', 'sample', '.source.json', '{}')).rejects.toThrow()
  await call('renameSkillEntry', 'same', 'sample', 'docs/a.txt', 'docs/b.txt')
  await call('deleteSkillEntry', 'same', 'sample', 'docs/b.txt')
  expect(await call('listSkillFiles', 'same', 'sample')).toBeArray()
})
test('Core Skill 管理列表返回元 Skill 和用户全局 Skill 的定义身份，而不是复制来源身份', async () => {
  const { call, config } = fixture()
  const builtin = join(config.configDir, 'global-skills', 'builtin', 'builtin-id')
  mkdirSync(builtin, { recursive: true })
  writeFileSync(join(builtin, 'skill-library.json'), JSON.stringify({ schemaVersion: 1, skillId: 'builtin-id', slug: 'builtin-skill', name: 'Builtin', version: '1.0.0', type: 'builtin-meta', description: 'Built in' }))
  writeFileSync(join(builtin, 'SKILL.md'), '---\nname: Builtin\n---\nbody')
  const user = await call('globalSkill.copyToUser', 'builtin-id', 'user-copy') as GlobalSkillMeta
  const userManifest = join(config.configDir, 'global-skills', 'user', user.skillId, 'skill-library.json')
  writeFileSync(userManifest, JSON.stringify({ ...user, source: { sourceSkillId: 'builtin-id', sourceSkillType: 'builtin-meta', sourceVersion: '0.9.0', copiedAt: 'fixture' } }))
  await call('toggleWorkspaceSkill', 'same', 'user-copy', false, user.skillId)

  expect(await call('getAllWorkspaceSkills', 'same')).toEqual([])
  expect(await call('getAllWorkspaceSkills', 'same', true)).toMatchObject([
    { slug: 'builtin-skill', sourceSkillId: 'builtin-id', sourceSkillType: 'builtin-meta', sourceVersion: '1.0.0', description: 'Built in', enabled: true, actualSource: 'global' },
    { slug: 'user-copy', sourceSkillId: user.skillId, sourceSkillType: 'user-global', sourceVersion: '1.0.0', enabled: false, actualSource: 'none' },
  ])
})
test('全局Skill三态开关不误改同名本地，运行读取同份覆盖', async () => {
  const { call, config, directory } = fixture()
  const root = join(config.configDir, 'global-skills', 'user', 'global-id')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'skill-library.json'), JSON.stringify({ schemaVersion: 1, skillId: 'global-id', slug: 'same-skill', name: 'Global', version: '1.0.0', type: 'user-global' }))
  writeFileSync(join(root, 'SKILL.md'), '---\nname: Global\n---\nglobal')
  await call('createWorkspaceSkill', 'same', 'same-skill', 'Local', '', 'local')
  await call('toggleWorkspaceSkill', 'same', 'same-skill', false, 'global-id')
  expect(await call('getAllWorkspaceSkills', 'same', true)).toMatchObject([{ enabled: true }, { enabled: false }])
  await call('toggleWorkspaceSkill', 'same', 'same-skill', false, '')
  const { resolveCoreSkillSources } = await import('./skill-sources')
  expect(resolveCoreSkillSources(config, directory).skills).toEqual([])
  await call('toggleWorkspaceSkill', 'same', 'same-skill', true, 'global-id')
  expect(resolveCoreSkillSources(config, directory).skills[0]?.actualSource).toBe('global')
})
test('目录schema预设保存保留未知配置，损坏实体拒绝重写', async () => {
  const { call, directory } = fixture(true)
  mkdirSync(join(directory, 'presets'))
  writeFileSync(join(directory, 'presets', '_config.json'), JSON.stringify({ schema: 'profer.presets/1', future: 'keep' }))
  const preset = await call('createAgentPreset', 'same', { name: 'Directory', description: 'test' }) as { id: string }
  await call('setDefaultPresetReference', 'same', { presetId: preset.id, presetScope: 'workspace', workspaceSlug: 'same' })
  expect(JSON.parse(readFileSync(join(directory, 'presets', '_config.json'), 'utf8')).future).toBe('keep')
  writeFileSync(join(directory, 'presets', `${preset.id}.json`), '{bad')
  await expect(call('updateAgentPreset', 'same', preset.id, { name: 'No overwrite' })).rejects.toThrow()
  expect(readFileSync(join(directory, 'presets', `${preset.id}.json`), 'utf8')).toBe('{bad')
})
test('preset删除引用审计不混认global同ID，复制导入冻结、JSON null可省略', async () => {
  const f = fixture(), other = { ...f.context.workspaces.list()[0]!, id: 'other', slug: 'other' }
  f.context.workspaces.list = () => [other,{...other,id:'ws',slug:'same'}]
  mkdirSync(join(f.config.workspaceRoot,'other'),{recursive:true})
  const p = await f.call('createAgentPreset','same',{name:'P',description:'',basePresetId:'minimal'}) as {id:string}
  const sessions: Array<{id:string;workspaceId?:string;presetReference?:import('@profer/shared').PresetReference}> = []
  Object.assign(f.context,{sessions:{list:()=>sessions},automations:{list:()=>[]}})
  expect(await f.call('listAgentPresets',null)).toBeArray()
  expect(await f.call('getDefaultPresetId',null)).toBe('standard')
  sessions.push({id:'reference',workspaceId:'ws',presetReference:{presetId:p.id,presetScope:'workspace',workspaceSlug:'same'}})
  await expect(f.call('deleteAgentPreset','same',p.id)).rejects.toThrow('会话:reference')
  const copied = await f.call('copyPresetToWorkspace',{presetId:p.id,presetScope:'workspace',workspaceSlug:'same'},'other') as {id:string}
  expect(copied.id).not.toBe(p.id)
  await f.call('importPresetFromWorkspace','other','same',p.id)
  await f.call('updateAgentPreset','same',p.id,{basePresetId:null})
  sessions[0]!.presetReference = {presetId:p.id,presetScope:'user-global'}
  await f.call('deleteAgentPreset','same',p.id)
  expect((await f.call('listAgentPresets','same') as Array<{id:string}>).some(v=>v.id===p.id)).toBe(false)
})
test('globalSkill管理读取保存同Core路径及workspace稳定ID副本',async()=>{
  const a=fixture(), b=fixture()
  const p = await a.call('globalSkill.createUser','global-example','Example','','body') as {skillId:string}
  expect(await a.call('globalSkill.read',p.skillId)).toContain('name: "Example"')
  await expect(b.call('globalSkill.read',p.skillId)).rejects.toThrow()
  await a.call('globalSkill.save',p.skillId,'---\nname: Updated\ndescription: new\n---\nupdated',null,'global')
  expect(await a.call('globalSkill.read',p.skillId)).toContain('version: "1.0.1"')
  const copy = await a.call('globalSkill.copyToWorkspace',p.skillId,'same') as {workspaceSkillId:string}
  expect(await a.call('globalSkill.readWorkspaceCopy','same',copy.workspaceSkillId)).toContain('name: Updated')
  await a.call('globalSkill.saveWorkspaceCopy','same',copy.workspaceSkillId,'local')
  expect(await a.call('readWorkspaceSkillContent','same','global-example')).toBe('local')
  expect(await a.call('getAllWorkspaceSkills','same')).toMatchObject([{workspaceSkillId:copy.workspaceSkillId,enabled:true,actualSource:'workspace'}])
  await a.call('globalSkill.restore','same',p.skillId)
  await a.call('globalSkill.setEnabled','same',p.skillId,false)
  expect(await a.call('globalSkill.list','same')).toMatchObject([{enabledInWorkspace:false}])
})
test('reserved MCP拒绝保存无副作用与相对项目根拒绝',async()=>{
  const f=fixture()
  await expect(f.call('saveWorkspaceMcpConfig','same',{servers:{planning:{type:'http',url:'https://bad'}}})).rejects.toThrow('内置')
  expect((await f.call('getWorkspaceMcpConfig','same') as {servers:object}).servers).toEqual({})
  const ws=f.context.workspaces.list()[0]!
  Object.assign(ws,{storageMode:'project',rootPath:'relative'})
  await expect(f.call('getWorkspaceMcpConfig','same')).rejects.toThrow('绝对路径')
})
test('review: local MCP凭据编辑不泄base，执行拒绝软链，未来preset与legacy默认保护', async()=>{
 const f=fixture(true)
 writeFileSync(join(f.directory,'mcp.json'),JSON.stringify({servers:{demo:{type:'http',url:'https://example.test',headers:{Authorization:'base'}}}}))
 writeFileSync(join(f.directory,'mcp.local.json'),JSON.stringify({future:1,servers:{demo:{headers:{Authorization:'old'}}}}))
 const view=await f.call('getWorkspaceMcpConfig','same') as {servers:Record<string,{headers:{Authorization:string}}>}
 view.servers.demo!.headers.Authorization='NEW_SECRET'; await f.call('saveWorkspaceMcpConfig','same',view)
 expect(readFileSync(join(f.directory,'mcp.json'),'utf8')).not.toContain('NEW_SECRET')
 expect(readFileSync(join(f.directory,'mcp.local.json'),'utf8')).toContain('NEW_SECRET')
 const future=JSON.stringify({version:999,presets:[],defaultPresetId:'standard'});writeFileSync(join(f.directory,'agent-presets.json'),future)
 await expect(f.call('createAgentPreset','same',{name:'N',description:''})).rejects.toThrow()
 expect(readFileSync(join(f.directory,'agent-presets.json'),'utf8')).toBe(future)
 const custom={id:'custom',name:'Custom',description:'',createdAt:1,updatedAt:1}
 writeFileSync(join(f.directory,'agent-presets.json'),JSON.stringify({presets:[custom],defaultPresetId:'custom'}))
 await expect(f.call('setWorkspacePresetEnabled','same','custom',false)).rejects.toThrow()
})
test('review:执行各资源入口拒绝父级及正文软链',async()=>{
 const f=fixture(), outside=fixture()
 const {loadCoreMcpServers}=await import('./mcp-resources'),{resolveCoreSkillSources}=await import('./skill-sources'),{resolveCorePreset}=await import('./preset-resources')
 writeFileSync(join(outside.directory,'mcp.json'),JSON.stringify({servers:{evil:{type:'http',url:'https://outside'}}}))
 symlinkSync(join(outside.directory,'mcp.json'),join(f.directory,'mcp.json'))
 expect(()=>loadCoreMcpServers(f.directory,false,{} as import('@profer/shared').EffectiveAgentPresetPolicy)).toThrow('软链')
 mkdirSync(join(f.config.configDir,'global-skills'),{recursive:true})
 symlinkSync(outside.directory,join(f.config.configDir,'global-skills','user'))
 expect(()=>resolveCoreSkillSources(f.config)).toThrow('软链')
 writeFileSync(join(outside.directory,'presets.json'),JSON.stringify({presets:[]}))
 symlinkSync(join(outside.directory,'presets.json'),join(f.directory,'agent-presets.json'))
 expect(()=>resolveCorePreset(f.config,{workspaceId:'ws'} as import('@profer/shared').AgentSessionMeta,f.context.workspaces.list()[0])).toThrow('软链')
})
test('review:全局Skill元数据一致、坏save无副作用、复制完整assets',async()=>{
 const f=fixture()
 const p=await f.call('globalSkill.createUser','demo','Demo','desc','body') as {skillId:string}
 const dir=join(f.config.configDir,'global-skills','user',p.skillId)
 mkdirSync(join(dir,'scripts'));writeFileSync(join(dir,'scripts','run.py'),'print(1)')
 const before=readFileSync(join(dir,'SKILL.md'),'utf8')
 await expect(f.call('globalSkill.save',p.skillId,'bad without frontmatter',null,'global')).rejects.toThrow()
 expect(readFileSync(join(dir,'SKILL.md'),'utf8')).toBe(before)
 await f.call('globalSkill.save',p.skillId,'---\nname: DIFFERENT\ndescription: new\n---\nbody',null,'global')
 expect(await f.call('globalSkill.list')).toMatchObject([{name:'DIFFERENT',description:'new',version:'1.0.1'}])
 const copied=await f.call('globalSkill.copyToUser',p.skillId,'demo-copy') as {skillId:string}
 expect(readFileSync(join(f.config.configDir,'global-skills','user',copied.skillId,'scripts','run.py'),'utf8')).toBe('print(1)')
})
test('review:MCP分层编辑后执行同源，disable与删除不复活local-only',async()=>{
 const f=fixture(true),{loadCoreMcpServers}=await import('./mcp-resources')
 writeFileSync(join(f.directory,'mcp.json'),JSON.stringify({future:1,servers:{demo:{type:'http',url:'https://example',headers:{Authorization:'base'}}}}))
 writeFileSync(join(f.directory,'mcp.local.json'),JSON.stringify({futureLocal:2,servers:{demo:{headers:{Authorization:'old'}},localOnly:{type:'http',url:'https://local'}}}))
 const view=await f.call('getWorkspaceMcpConfig','same') as {servers:Record<string,Record<string,unknown>>}
 view.servers.demo!.headers={Authorization:'new-secret'};view.servers.demo!.env={KEY:'new-env'}
 await f.call('saveWorkspaceMcpConfig','same',view)
 const loaded=loadCoreMcpServers(f.directory,true,{} as import('@profer/shared').EffectiveAgentPresetPolicy)
 expect(loaded.demo?.headers).toMatchObject({Authorization:'new-secret'})
 expect(readFileSync(join(f.directory,'mcp.json'),'utf8')).not.toContain('new-env')
 expect(JSON.parse(readFileSync(join(f.directory,'mcp.local.json'),'utf8')).futureLocal).toBe(2)
 view.servers.demo!.enabled=false;delete view.servers.localOnly
 await f.call('saveWorkspaceMcpConfig','same',view)
 expect(loadCoreMcpServers(f.directory,true,{} as import('@profer/shared').EffectiveAgentPresetPolicy)).toEqual({})
 delete view.servers.demo; await f.call('saveWorkspaceMcpConfig','same',view)
 expect((await f.call('getWorkspaceMcpConfig','same') as {servers:object}).servers).toEqual({})
})
test('UI全局预设引用开关、CRUD与引用报告，同源展开能力',async()=>{
 const f=fixture();Object.assign(f.context,{sessions:{list:()=>[]},automations:{list:()=>[]}})
 const p=await f.call('createAgentPreset',null,{name:'Global',description:'',basePresetId:'minimal'}) as {id:string}
 const ref={presetId:p.id,presetScope:'user-global'}
 await f.call('enableGlobalPresetInWorkspace','same',ref)
 expect(await f.call('getPresetReferenceReport',ref)).toMatchObject({canDelete:false,workspaceScopes:[{workspaceSlug:'same'}]})
 expect((await f.call('listAgentPresets','same',true) as Array<{id:string;disabledToolGroups?:string[]}>).find(v=>v.id===p.id)?.disabledToolGroups?.length).toBeGreaterThan(0)
 await f.call('disableGlobalPresetInWorkspace','same',ref)
 expect((await f.call('listAgentPresets','same',true) as Array<{id:string;enabledInWorkspace:boolean}>).find(v=>v.id===p.id)?.enabledInWorkspace).toBe(false)
 await f.call('updateAgentPreset',null,p.id,{name:'Updated'})
 await f.call('deleteAgentPreset',null,p.id)
 expect((await f.call('listAgentPresets',null) as Array<{id:string}>).some(v=>v.id===p.id)).toBe(false)
 await expect(f.call('enableGlobalPresetInWorkspace','same',{presetId:'x',presetScope:'workspace',workspaceSlug:'same'})).rejects.toThrow()
})
test('SDK frontmatter支持合法多行描述',async()=>{
 const f=fixture(),p=await f.call('globalSkill.createUser','yaml','Yaml','','body') as {skillId:string}
 await f.call('globalSkill.save',p.skillId,'---\nname: Yaml\ndescription: |\n  line one\n  line two\n---\nbody',null,'global')
 expect(await f.call('globalSkill.list')).toMatchObject([{description:'line one\nline two\n'}])
})
test('final review:清空默认不fallback，global未来版本与坏实体管理执行一致拒绝',async()=>{
 const f=fixture(),{resolveCorePreset}=await import('./preset-resources')
 await f.call('setDefaultPresetId','same','')
 expect(()=>resolveCorePreset(f.config,{workspaceId:'ws'} as import('@profer/shared').AgentSessionMeta,f.context.workspaces.list()[0])).toThrow('清空')
 mkdirSync(f.config.configDir,{recursive:true})
 const path=join(f.config.configDir,'agent-presets.json')
 for(const raw of [{version:999,presets:[]},{version:1,presets:[{id:'bad',name:123}]}]) {
  const bytes=JSON.stringify(raw);writeFileSync(path,bytes)
  await expect(f.call('listGlobalAgentPresets')).rejects.toThrow()
  await expect(f.call('listAgentPresets',null)).rejects.toThrow()
  expect(()=>resolveCorePreset(f.config,{presetReference:{presetId:'bad',presetScope:'user-global'}} as import('@profer/shared').AgentSessionMeta,undefined)).toThrow()
  expect(readFileSync(path,'utf8')).toBe(bytes)
 }
})
