import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEffectiveAgentPresetPolicy } from '@profer/shared'
import { resolveCoreSkillSources } from './skill-sources'
import { prepareCoreWorkspaceSkills } from './skill-resources'

test('Core全局Skill按稳定来源ID替换，inactive/缺失替换不复活全局源且读取不迁移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-global-skill-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') }
  const workspaceConfigDir = join(root, 'workspaces', 'fixture')
  const global = join(root, 'global-skills', 'user', 'global-id')
  const local = join(workspaceConfigDir, 'skills', 'renamed-copy')
  const inactive = join(workspaceConfigDir, 'skills-inactive', 'inactive-copy')
  try {
    for (const dir of [global, local, inactive]) await mkdir(dir, { recursive: true })
    const manifest = JSON.stringify({ schemaVersion: 1, skillId: 'global-id', slug: 'global-skill', type: 'user-global', name: 'Global fixture', version: '1', createdAt: 'fixture', updatedAt: 'fixture' })
    const globalPath = join(global, 'skill.manifest.json')
    await writeFile(globalPath, manifest)
    await writeFile(join(global, 'SKILL.md'), '---\nname: global-skill\ndescription: Harmless global fixture\n---\n\nGLOBAL_SOURCE_SENTINEL\n')
    const source = JSON.stringify({ scope: 'workspace', workspaceSkillId: 'stable-copy-id', sourceSkillId: 'global-id', sourceSkillType: 'user-global' })
    await writeFile(join(local, '.source.json'), source)
    await writeFile(join(local, 'SKILL.md'), '---\nname: renamed-copy\ndescription: Harmless replacement fixture\n---\n\nREPLACEMENT_SOURCE_SENTINEL\n')
    await writeFile(join(inactive, '.source.json'), JSON.stringify({ workspaceSkillId: 'inactive-id', sourceSkillId: 'global-id' }))
    await writeFile(join(inactive, 'SKILL.md'), '---\nname: inactive-copy\ndescription: Disabled fixture\n---\n\nNEVER_LOAD_INACTIVE\n')
    const overridesPath = join(workspaceConfigDir, 'skill-overrides.json')
    const writeOverride = async (value: object) => writeFile(overridesPath, JSON.stringify({ schemaVersion: 1, globalSkills: { 'global-id': { ...value, updatedAt: 'fixture' } } }))
    await writeOverride({ enabled: false, replacementWorkspaceSkillId: 'stable-copy-id', replacementWorkspaceSkillSlug: 'old-name' })
    expect(resolveCoreSkillSources(config, workspaceConfigDir).skills.map(skill => skill.slug)).toEqual(['renamed-copy'])
    const policy = createEffectiveAgentPresetPolicy({ id: 'fixture', name: 'fixture', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 }, { presetId: 'fixture', presetScope: 'builtin-meta' })
    const replacement = await prepareCoreWorkspaceSkills({ config, workspaceConfigDir, sessionId: crypto.randomUUID(), runId: crypto.randomUUID(), policy, toolNames: ['Read'], prompt: '/skill:renamed-copy' })
    expect(replacement.task).toContain('REPLACEMENT_SOURCE_SENTINEL')
    expect(replacement.system).not.toContain('name="global-skill"')
    expect(replacement.task).not.toContain('NEVER_LOAD_INACTIVE')
    await writeOverride({ enabled: true })
    const restored = resolveCoreSkillSources(config, workspaceConfigDir)
    expect(restored.skills.map(skill => skill.slug)).toEqual(['global-skill'])
    const globalPrompt = await prepareCoreWorkspaceSkills({ config, workspaceConfigDir, sessionId: crypto.randomUUID(), runId: crypto.randomUUID(), policy, toolNames: ['Read'], prompt: '/skill:global-skill' })
    expect(globalPrompt.task).toContain('GLOBAL_SOURCE_SENTINEL')
    expect(globalPrompt.task).not.toContain('REPLACEMENT_SOURCE_SENTINEL')
    await writeOverride({ enabled: false, replacementWorkspaceSkillId: 'missing-id' })
    const missing = resolveCoreSkillSources(config, workspaceConfigDir)
    expect(missing.skills).toEqual([])
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'replacement-missing' }))
    await writeOverride({ enabled: false, replacementWorkspaceSkillId: 'inactive-id' })
    expect(resolveCoreSkillSources(config, workspaceConfigDir).skills).toEqual([])
    expect(await readFile(globalPath, 'utf8')).toBe(manifest)
    expect(await Bun.file(join(global, 'skill-library.json')).exists()).toBe(false)
    expect(await readFile(join(local, '.source.json'), 'utf8')).toBe(source)
  } finally { await rm(root, { recursive: true, force: true }) }
})
