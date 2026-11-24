import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWorkspace, AgentPreset, GlobalSkillDeleteBlockers, GlobalSkillManifest } from '@profer/shared'
import type { CoreResourceOperationContext } from './resource-paths'
import { executeCoreResourceOperation } from './resource-operations'

const roots: string[] = []
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-management-gap-'))); roots.push(root)
  const workspaces = ['one', 'two'].map(slug => ({ id: slug, slug, name: slug } as AgentWorkspace))
  const context: CoreResourceOperationContext = {
    config: { host: 'localhost', port: 7788, configDir: root, workspaceRoot: join(root, 'workspaces') },
    workspaces: { list: () => workspaces }, sessions: { list: () => [] }, automations: { list: () => [] },
  }
  const directory = (slug: string) => join(context.config.workspaceRoot, slug)
  workspaces.forEach(w => mkdirSync(directory(w.slug), { recursive: true }))
  const call = (operation: string, ...args: unknown[]) => executeCoreResourceOperation(context, { operation, args })
  return { root, context, directory, call }
}

test('Given 活跃全局 Skill When 查询和删除 Then 返回真实引用，提交时重新审计且必须二次确认', async () => {
  const f = fixture()
  const skill = await f.call('globalSkill.createUser', 'sample', 'Sample', '', 'body') as GlobalSkillManifest
  const report = await f.call('globalSkill.getDeleteBlockers', skill.skillId) as GlobalSkillDeleteBlockers
  expect(report.references.filter(r => r.blocksDeletion)).toHaveLength(2)
  await expect(f.call('globalSkill.deleteUser', skill.skillId, `delete:${skill.skillId}`)).rejects.toThrow('正在使用')
  await f.call('globalSkill.setEnabled', 'one', skill.skillId, false)
  await f.call('globalSkill.setEnabled', 'two', skill.skillId, false)
  await expect(f.call('globalSkill.deleteUser', skill.skillId)).rejects.toThrow('二次确认')
  await f.call('globalSkill.deleteUser', skill.skillId, `delete:${skill.skillId}`)
  expect(await f.call('globalSkill.list')).toEqual([])
  expect((await f.call('globalSkill.getOverrides', 'one') as { globalSkills: object }).globalSkills).toEqual({})
})

test('Given 全局 Skill 已复制或被本地同名覆盖 When 删除 Then 不阻塞且保留独立副本、清理管理索引', async () => {
  const f = fixture()
  const skill = await f.call('globalSkill.createUser', 'sample', 'Sample', '', 'body') as GlobalSkillManifest
  const index = join(f.root, 'global-skills', 'index.json')
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, skills: { [skill.skillId]: { skillId: skill.skillId } }, future: true }))
  await f.call('globalSkill.copyToWorkspace', skill.skillId, 'one')
  await f.call('createWorkspaceSkill', 'two', 'sample', 'Local', '', 'local')
  const report = await f.call('globalSkill.getDeleteBlockers', skill.skillId) as GlobalSkillDeleteBlockers
  expect(report.references.map(r => r.status)).toEqual(['replaced-by-workspace-copy', 'workspace-only'])
  await f.call('globalSkill.deleteUser', skill.skillId, `delete:${skill.skillId}`)
  expect(existsSync(join(f.directory('one'), 'skills', 'sample', 'SKILL.md'))).toBe(true)
  expect(JSON.parse(readFileSync(index, 'utf8'))).toEqual({ schemaVersion: 1, skills: {}, future: true })
})

test('Given 内置 Skill When 请求删除 Then 拒绝且不删除正文', async () => {
  const f = fixture(), path = join(f.root, 'global-skills', 'builtin', 'builtin-id')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'SKILL.md'), 'body')
  writeFileSync(join(path, 'skill-library.json'), JSON.stringify({ schemaVersion: 1, skillId: 'builtin-id', slug: 'builtin', name: 'Builtin', type: 'builtin-meta', version: '1.0.0' }))
  await expect(f.call('globalSkill.deleteUser', 'builtin-id', 'delete:builtin-id')).rejects.toThrow('内置')
  expect(existsSync(join(path, 'SKILL.md'))).toBe(true)
})

test('Given 工作区预设 When 提升到指定范围 Then 内容完整、身份换新且默认保留为禁用副本', async () => {
  const f = fixture()
  const source = await f.call('createAgentPreset', 'one', { name: 'Source', description: '', basePresetId: 'minimal', skillSlugs: ['sample'] }) as AgentPreset
  const promoted = await f.call('promoteWorkspacePresetToGlobal', 'one', source.id, ['two', 'two'], true) as AgentPreset
  expect(promoted).toMatchObject({ scope: 'user-global', name: source.name, skillSlugs: ['sample'] })
  expect(promoted.id).not.toBe(source.id)
  expect((await f.call('listAgentPresets', 'one') as AgentPreset[]).find(p => p.id === promoted.id)).toBeUndefined()
  expect((await f.call('listAgentPresets', 'one') as Array<AgentPreset & { enabledInWorkspace: boolean }>).find(p => p.id === source.id)?.enabledInWorkspace).toBe(false)
  expect((await f.call('listAgentPresets', 'two') as AgentPreset[]).find(p => p.id === promoted.id)).toBeDefined()
})

test('Given 仍被默认引用或目标非法 When 提升并删除原预设 Then 拒绝且不产生半成品全局预设', async () => {
  const f = fixture()
  const source = await f.call('createAgentPreset', 'one', { name: 'Source', description: '' }) as AgentPreset
  await expect(f.call('promoteWorkspacePresetToGlobal', 'one', source.id, ['missing'], true)).rejects.toThrow()
  await f.call('setDefaultPresetId', 'one', source.id)
  const before = await f.call('listGlobalAgentPresets')
  await expect(f.call('promoteWorkspacePresetToGlobal', 'one', source.id, ['two'], false)).rejects.toThrow('引用')
  expect(await f.call('listGlobalAgentPresets')).toEqual(before)
})

test('Given 未引用工作区预设 When 提升不保留 Then 删除原实体且可解析新全局实体', async () => {
  const f = fixture()
  const source = await f.call('createAgentPreset', 'one', { name: 'Source', description: '' }) as AgentPreset
  const promoted = await f.call('promoteWorkspacePresetToGlobal', 'one', source.id, ['one'], false) as AgentPreset
  const listed = await f.call('listAgentPresets', 'one') as AgentPreset[]
  expect(listed.some(p => p.id === source.id)).toBe(false)
  expect(listed.some(p => p.id === promoted.id)).toBe(true)
})

test('Given 全局源已恢复且旧副本仍在 When 审计删除 Then 不把备份副本误判成无引用', async () => {
  const f = fixture()
  const skill = await f.call('globalSkill.createUser', 'restored', 'Restored', '', 'body') as GlobalSkillManifest
  await f.call('globalSkill.copyToWorkspace', skill.skillId, 'one')
  await f.call('globalSkill.restore', 'one', skill.skillId)
  await f.call('globalSkill.setEnabled', 'two', skill.skillId, false)
  const report = await f.call('globalSkill.getDeleteBlockers', skill.skillId) as GlobalSkillDeleteBlockers
  expect(report.references[0]).toMatchObject({ blocksDeletion: true, actualSource: 'global' })
  await expect(f.call('globalSkill.deleteUser', skill.skillId, `delete:${skill.skillId}`)).rejects.toThrow('正在使用')
})

test('Given 目录格式工作区预设 When 提升删除 Then 保留未知配置、删除原文件并清理disabled列表', async () => {
  const f = fixture(), dir = join(f.directory('one'), 'presets')
  mkdirSync(dir)
  writeFileSync(join(dir, '_config.json'), JSON.stringify({ schema: 'profer.presets/1', defaultPresetId: 'standard', future: true, disabledWorkspacePresetIds: ['directory-source'] }))
  writeFileSync(join(dir, 'directory-source.json'), JSON.stringify({ schema: 'profer.preset/1', preset: { id: 'directory-source', name: 'Directory', description: '', createdAt: 1, updatedAt: 1 } }))
  const promoted = await f.call('promoteWorkspacePresetToGlobal', 'one', 'directory-source', ['two'], false) as AgentPreset
  expect(promoted.scope).toBe('user-global')
  expect(existsSync(join(dir, 'directory-source.json'))).toBe(false)
  expect(JSON.parse(readFileSync(join(dir, '_config.json'), 'utf8'))).toMatchObject({ future: true, disabledWorkspacePresetIds: [] })
})

test('Given 提升已提交全局但原预设审计失败 When 回滚 Then 移除新全局并逐字恢复来源', async () => {
  const f = fixture()
  const source = await f.call('createAgentPreset', 'one', { name: 'Rollback', description: '' }) as AgentPreset
  const path = join(f.directory('one'), 'agent-presets.json'), before = readFileSync(path, 'utf8')
  let reads = 0
  f.context.sessions = { list() { if (++reads > 2) throw new Error('fixture-audit-unavailable'); return [] } }
  await expect(f.call('promoteWorkspacePresetToGlobal', 'one', source.id, ['two'], false)).rejects.toThrow('fixture-audit-unavailable')
  expect(existsSync(join(f.root, 'agent-presets.json'))).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(before)
})
