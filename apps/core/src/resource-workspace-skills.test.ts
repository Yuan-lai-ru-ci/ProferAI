import { afterAll, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentWorkspace, GlobalSkillManifest, SkillMeta } from '@profer/shared'
import type { CoreConfig } from './config'
import { executeCoreResourceOperation } from './resource-operations'
import { resolveCoreSkillSources } from './skill-sources'

const roots: string[] = []
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'core-workspace-skills-'))); roots.push(root)
  const config: CoreConfig = { host: 'localhost', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces') }
  const workspaces: AgentWorkspace[] = [
    { id: 'source', slug: 'source', name: 'Source' } as AgentWorkspace,
    { id: 'target', slug: 'target', name: 'Target', storageMode: 'project', rootPath: join(root, 'project') } as AgentWorkspace,
    { id: 'empty', slug: 'empty', name: 'Empty' } as AgentWorkspace,
  ]
  const directory = (slug: string) => slug === 'target' ? join(root, 'project', '.profer') : join(config.workspaceRoot, slug)
  for (const workspace of workspaces) fs.mkdirSync(directory(workspace.slug), { recursive: true })
  const call = (operation: string, ...args: unknown[]) => executeCoreResourceOperation({ config, workspaces: { list: () => workspaces } }, { operation, args })
  const skill = async (slug = 'demo') => {
    await call('createWorkspaceSkill', 'source', slug, 'Demo', 'Description', 'source body')
    return join(directory('source'), 'skills', slug)
  }
  return { root, config, call, directory, skill }
}
function json(path: string) { return JSON.parse(fs.readFileSync(path, 'utf8')) }
function writeJson(path: string, value: unknown) { fs.writeFileSync(path, JSON.stringify(value)) }

test('other-workspace listing is read-only, excludes empty/current and returns active/inactive metadata', async () => {
  const f = fixture(), path = await f.skill()
  fs.mkdirSync(join(f.directory('source'), 'skills-inactive', 'legacy'), { recursive: true })
  fs.writeFileSync(join(f.directory('source'), 'skills-inactive', 'legacy', 'SKILL.md'), '---\nname: Legacy\n---\n')
  const before = fs.readFileSync(join(path, '.source.json'), 'utf8')
  expect(await f.call('getOtherWorkspaceSkills', 'target')).toMatchObject([
    { workspaceSlug: 'source', workspaceName: 'Source', skills: [{ slug: 'demo', enabled: true }, { slug: 'legacy', enabled: false }] },
  ])
  expect(fs.readFileSync(join(path, '.source.json'), 'utf8')).toBe(before)
  expect(fs.existsSync(join(f.directory('source'), 'skills-inactive', 'legacy', '.source.json'))).toBe(false)
})

test('import retains stable identity/card/assets, strips ledgers and caches, uses target Core project root', async () => {
  const f = fixture(), path = await f.skill(), source = json(join(path, '.source.json'))
  for (const name of ['skill-library.json', 'skill.manifest.json']) writeJson(join(path, name), { stale: true })
  fs.mkdirSync(join(path, 'scripts')); fs.writeFileSync(join(path, 'scripts', 'run.py'), 'print(1)')
  fs.mkdirSync(join(path, 'node_modules')); fs.writeFileSync(join(path, 'node_modules', 'bad'), 'cache')
  const imported = await f.call('importSkillFromWorkspace', 'target', 'source', 'DEMO') as SkillMeta
  expect(imported).toMatchObject({ slug: 'demo', enabled: true, workspaceSkillId: source.workspaceSkillId, importSource: { workspaceSkillId: source.workspaceSkillId, sourceWorkspaceSlug: 'source', sourceWorkspaceName: 'Source', sourceVersion: '1.0.0' } })
  const target = join(f.directory('target'), 'skills', 'demo')
  expect(fs.readFileSync(join(target, 'scripts', 'run.py'), 'utf8')).toBe('print(1)')
  expect(json(join(target, 'SKILL.json'))).toEqual(json(join(path, 'SKILL.json')))
  for (const name of ['skill-library.json', 'skill.manifest.json', 'node_modules']) expect(fs.existsSync(join(target, name))).toBe(false)
  expect(await f.call('getAllWorkspaceSkills', 'target')).toMatchObject([{ importSource: imported.importSource, hasUpdate: false }])
  expect(resolveCoreSkillSources(f.config, f.directory('target')).skills[0]?.workspaceSkillId).toBe(source.workspaceSkillId)
})

test('legacy import assigns target identity without changing the source', async () => {
  const f = fixture(), path = await f.skill()
  fs.rmSync(join(path, '.source.json')); fs.rmSync(join(path, 'SKILL.json'))
  const imported = await f.call('importSkillFromWorkspace', 'target', 'source', 'demo') as SkillMeta
  expect(imported.workspaceSkillId).toBeString()
  expect(fs.existsSync(join(path, '.source.json'))).toBe(false)
  expect(fs.existsSync(join(f.directory('target'), 'skills', 'demo', 'SKILL.json'))).toBe(false)
})

test('source update preserves inactive state/importedAt/ID, replaces assets and preserves missing source card', async () => {
  const f = fixture(), path = await f.skill()
  await f.call('importSkillFromWorkspace', 'target', 'source', 'demo')
  await f.call('toggleWorkspaceSkill', 'target', 'demo', false, '')
  const target = join(f.directory('target'), 'skills-inactive', 'demo'), before = json(join(target, '.source.json'))
  fs.writeFileSync(join(target, 'old.txt'), 'old')
  fs.rmSync(join(path, 'SKILL.json'))
  fs.writeFileSync(join(path, 'SKILL.md'), '---\nname: Demo\nversion: 2.0.0\n---\nupdated body')
  expect(await f.call('getAllWorkspaceSkills', 'target')).toMatchObject([{ hasUpdate: true }])
  const updated = await f.call('updateSkillFromSource', 'target', 'DEMO') as SkillMeta
  expect(updated).toMatchObject({ enabled: false, actualSource: 'none', hasUpdate: false, importSource: { ...before, sourceVersion: '2.0.0' } })
  expect(fs.readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('updated body')
  expect(fs.existsSync(join(target, 'old.txt'))).toBe(false)
  expect(fs.existsSync(join(target, 'SKILL.json'))).toBe(true)
  expect(fs.existsSync(join(f.directory('target'), 'skills', 'demo'))).toBe(false)
  fs.writeFileSync(join(path, 'SKILL.json'), JSON.stringify({ schemaVersion: 1, name: 'New source card' }))
  await f.call('updateSkillFromSource', 'target', 'demo')
  expect(json(join(target, 'SKILL.json')).name).toBe('New source card')
})

test('missing/unrelated source update does not modify local content', async () => {
  const f = fixture(), path = await f.skill()
  await expect(f.call('updateSkillFromSource', 'source', 'demo')).rejects.toThrow('不是从其他工作区')
  await f.call('importSkillFromWorkspace', 'target', 'source', 'demo')
  const target = join(f.directory('target'), 'skills', 'demo'), before = fs.readFileSync(join(target, '.source.json'), 'utf8')
  fs.rmSync(path, { recursive: true })
  await expect(f.call('updateSkillFromSource', 'target', 'demo')).rejects.toThrow('不存在')
  expect(fs.readFileSync(join(target, '.source.json'), 'utf8')).toBe(before)
  expect(fs.readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('source body')
})

test('import rejects canonical conflicts including inactive and orphan directories', async () => {
  const f = fixture(); await f.skill('Café')
  const root = join(f.directory('target'), 'skills-inactive', 'CAFÉ')
  fs.mkdirSync(root, { recursive: true })
  await expect(f.call('importSkillFromWorkspace', 'target', 'source', 'Cafe\u0301')).rejects.toThrow('同名')
  expect(fs.readdirSync(root)).toEqual([])
})

test('new operations validate arity, ownership, traversal, links and special file destinations', async () => {
  const f = fixture(), path = await f.skill()
  await expect(f.call('getOtherWorkspaceSkills', 'missing')).rejects.toThrow('工作区不存在')
  await expect(f.call('importSkillFromWorkspace', 'target', 'source', '../demo')).rejects.toThrow()
  await expect(f.call('importSkillFromWorkspace', 'target', '../source', 'demo')).rejects.toThrow()
  await expect(f.call('updateSkillFromSource', 'target')).rejects.toThrow('数量')
  fs.symlinkSync(join(f.root, 'absent'), join(path, 'dangling'))
  await expect(f.call('importSkillFromWorkspace', 'target', 'source', 'demo')).rejects.toThrow('软链')
  expect(fs.existsSync(join(f.directory('target'), 'skills', 'demo'))).toBe(false)
  fs.rmSync(join(path, 'dangling'))
  fs.symlinkSync(f.root, join(path, 'outside'))
  await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', [])).rejects.toThrow('软链')
  expect(fs.existsSync(join(f.config.configDir, 'global-skills'))).toBe(false)
})

test('promotion creates global ledger/card/assets, enables selected workspaces and deactivates local copy', async () => {
  const f = fixture(), path = await f.skill(), id = json(join(path, '.source.json')).workspaceSkillId
  fs.mkdirSync(join(path, 'references')); fs.writeFileSync(join(path, 'references', 'notes.md'), 'notes')
  writeJson(join(path, 'SKILL.json'), { schemaVersion: 1, name: 'Card title', version: '9.0.0' })
  writeJson(join(f.directory('target'), 'skill-overrides.json'), { schemaVersion: 1, future: true, globalSkills: { old: { enabled: false } } })
  const manifest = await f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', ['target', 'target']) as GlobalSkillManifest
  expect(manifest).toMatchObject({ schemaVersion: 1, slug: 'demo', name: 'Card title', type: 'user-global', version: '1.0.0' })
  const target = join(f.config.configDir, 'global-skills', 'user', manifest.skillId)
  expect(json(join(target, 'skill-library.json'))).toEqual(manifest)
  expect(fs.existsSync(join(target, '.source.json'))).toBe(false)
  expect(json(join(target, 'SKILL.json')).version).toBe('1.0.0')
  expect(fs.readFileSync(join(target, 'references', 'notes.md'), 'utf8')).toBe('notes')
  expect(fs.existsSync(path)).toBe(false)
  expect(json(join(f.directory('source'), 'skills-inactive', 'demo', '.source.json')).workspaceSkillId).toBe(id)
  expect(json(join(f.directory('target'), 'skill-overrides.json'))).toMatchObject({ future: true, globalSkills: { old: { enabled: false }, [manifest.skillId]: { enabled: true } } })
  expect(resolveCoreSkillSources(f.config, f.directory('source')).skills).toMatchObject([{ sourceSkillId: manifest.skillId, actualSource: 'global' }])
  expect(resolveCoreSkillSources(f.config, f.directory('target')).skills).toMatchObject([{ sourceSkillId: manifest.skillId }])
})

test('promotion normalizes multiline frontmatter without retaining stale YAML or replacing dollar sequences', async () => {
  const f = fixture(), path = await f.skill()
  fs.rmSync(join(path, 'SKILL.json'))
  fs.writeFileSync(join(path, 'SKILL.md'), '---\nname: "Cost $&"\ndescription: |\n  first line\n  second line\nversion: 7.0.0\n---\nbody')
  const manifest = await f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', []) as GlobalSkillManifest
  const content = fs.readFileSync(join(f.config.configDir, 'global-skills', 'user', manifest.skillId, 'SKILL.md'), 'utf8')
  const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent')
  expect(parseFrontmatter<Record<string, unknown>>(content).frontmatter).toMatchObject({ name: 'Cost $&', description: manifest.description, version: '1.0.0' })
  expect(content).not.toContain('\n  second line')
})

test('promotion can remove original and generates default card only when missing', async () => {
  const f = fixture(), path = await f.skill(); fs.rmSync(join(path, 'SKILL.json'))
  const manifest = await f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', [], false) as GlobalSkillManifest
  expect(fs.existsSync(path)).toBe(false)
  expect(fs.existsSync(join(f.directory('source'), 'skills-inactive', 'demo'))).toBe(false)
  expect(json(join(f.config.configDir, 'global-skills', 'user', manifest.skillId, 'SKILL.json'))).toEqual({ schemaVersion: 1 })
})

test('invalid promotion destinations, overrides, global collisions and inactive skill fail before writes', async () => {
  const f = fixture(), path = await f.skill()
  await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', ['target', 'missing'])).rejects.toThrow()
  await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', 'target')).rejects.toThrow()
  await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', [], 'yes')).rejects.toThrow()
  writeJson(join(f.directory('target'), 'skill-overrides.json'), { schemaVersion: 2, globalSkills: {} })
  await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', ['target'])).rejects.toThrow()
  expect(fs.existsSync(join(f.config.configDir, 'global-skills'))).toBe(false)
  expect(fs.existsSync(path)).toBe(true)
  await f.call('globalSkill.createUser', 'DEMO', 'Global', '', 'body')
  await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', [])).rejects.toThrow('slug已存在')
  await f.call('toggleWorkspaceSkill', 'source', 'demo', false, '')
  await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', [])).rejects.toThrow('已启用')
})

test('promotion rollback restores all touched overrides byte-for-byte and leaves original skill intact', async () => {
  const f = fixture(), path = await f.skill()
  const override = join(f.directory('target'), 'skill-overrides.json'), before = '{ "schemaVersion": 1, "future": 7, "globalSkills": {} }\n'
  fs.writeFileSync(override, before)
  const originalRename = fs.renameSync
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from) === path) throw new Error('fixture source move failure')
    return originalRename(from, to)
  })
  try {
    await expect(f.call('promoteWorkspaceSkillToGlobal', 'source', 'demo', ['target', 'empty'])).rejects.toThrow('fixture source move failure')
  } finally { rename.mockRestore() }
  expect(fs.readFileSync(override, 'utf8')).toBe(before)
  expect(fs.existsSync(join(f.directory('empty'), 'skill-overrides.json'))).toBe(false)
  expect(fs.existsSync(path)).toBe(true)
  expect(fs.readdirSync(join(f.config.configDir, 'global-skills', 'user'))).toEqual([])
})

test('source update rollback keeps old directory when staged swap fails', async () => {
  const f = fixture(), path = await f.skill()
  await f.call('importSkillFromWorkspace', 'target', 'source', 'demo')
  const target = join(f.directory('target'), 'skills', 'demo'), before = fs.readFileSync(join(target, 'SKILL.md'), 'utf8')
  fs.writeFileSync(join(path, 'SKILL.md'), '---\nname: New\nversion: 2.0.0\n---\nupdated')
  const originalRename = fs.renameSync
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from).includes('.stage-') && String(to) === target) throw new Error('fixture swap failure')
    return originalRename(from, to)
  })
  try { await expect(f.call('updateSkillFromSource', 'target', 'demo')).rejects.toThrow('fixture swap failure') }
  finally { rename.mockRestore() }
  expect(fs.readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(before)
  expect(fs.readdirSync(join(f.directory('target'), 'skills'))).toEqual(['demo'])
})
