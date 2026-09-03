import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetGlobalSkillRoots,
  __replaceStagedDirectoryForTest,
  configureGlobalSkillSystem,
  ensureGlobalSkillSystemReady,
  __setGlobalSkillRoots,
  copyGlobalSkillToUserGlobal,
  createUserGlobalSkill,
  copyGlobalSkillToWorkspace,
  deleteUserGlobalSkill,
  getGlobalSkillDeleteBlockers,
  editGlobalSkill,
  listGlobalSkills,
  migrateLegacyWorkspaceSkills,
  prepareRuntimeSkills,
  readGlobalSkillContent,
  readWorkspaceSkillCopyContent,
  saveWorkspaceSkillCopyContent,
  resolveEffectiveSkills,
  restoreGlobalSkill,
  seedBuiltinGlobalSkills,
  setGlobalSkillEnabled,
} from './global-skill-manager'
import { getWorkspaceSkills, toggleWorkspaceSkill } from './agent-workspace-manager'

const roots: string[] = []
function setup(): { global: string; bundle: string; workspaces: string } {
  const base = mkdtempSync(join(tmpdir(), 'profer-global-skill-'))
  roots.push(base)
  const result = { global: join(base, 'global-skills'), bundle: join(base, 'bundle'), workspaces: join(base, 'workspaces') }
  mkdirSync(join(result.bundle, 'demo'), { recursive: true })
  writeFileSync(join(result.bundle, 'demo', 'SKILL.md'), '---\nname: 演示\nversion: 1.0.0\n---\n\n# 演示\n')
  __setGlobalSkillRoots(result.global, result.workspaces)
  seedBuiltinGlobalSkills(result.bundle)
  return result
}
afterEach(() => { __resetGlobalSkillRoots(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('global-skill-manager BDD', () => {
  test('首次 Agent runtime prepare 会同步完成 builtin seed 与迁移，不依赖延后启动任务', () => {
    const base = mkdtempSync(join(tmpdir(), 'profer-global-skill-first-run-'))
    roots.push(base)
    const global = join(base, 'global')
    const workspaces = join(base, 'workspaces')
    const bundle = join(base, 'bundle')
    mkdirSync(join(bundle, 'first-run'), { recursive: true })
    writeFileSync(join(bundle, 'first-run', 'SKILL.md'), `---
name: 首次运行
version: 1.0.0
---
`)
    __setGlobalSkillRoots(global, workspaces)
    configureGlobalSkillSystem(bundle)

    const projection = prepareRuntimeSkills('first-workspace')
    expect(projection.skills.map((skill) => skill.slug)).toEqual(['first-run'])
    expect(existsSync(join(projection.path, 'skills', 'first-run', 'SKILL.md'))).toBe(true)
    // 幂等门控不得重复创建或改变有效技能。
    ensureGlobalSkillSystemReady()
    expect(listGlobalSkills().map((skill) => skill.slug)).toEqual(['first-run'])
  })

  test('索引损坏或缺失时仍以 manifest 恢复全局 Skill', () => {
    const paths = setup()
    writeFileSync(join(paths.global, 'index.json'), '{not-json')
    expect(listGlobalSkills().map((skill) => skill.slug)).toEqual(['demo'])
    rmSync(join(paths.global, 'index.json'), { force: true })
    expect(listGlobalSkills().map((skill) => skill.slug)).toEqual(['demo'])
  })

  test('builtin 全局唯一且只读；可复制为 user-global', () => {
    setup()
    const builtin = listGlobalSkills()[0]!
    expect(builtin.type).toBe('builtin-meta')
    expect(() => deleteUserGlobalSkill(builtin.skillId, `delete:${builtin.skillId}`)).toThrow('只读')
    expect(() => editGlobalSkill(builtin.skillId, 'a', 'global', 'changed')).toThrow('只读')
    const copy = copyGlobalSkillToUserGlobal(builtin.skillId, 'my-demo')
    expect(copy.type).toBe('user-global')
    expect(copy.source?.sourceSkillId).toBe(builtin.skillId)
    expect(readGlobalSkillContent(copy.skillId)).toContain('name: "my-demo"')
    expect(() => deleteUserGlobalSkill(copy.skillId)).toThrow('删除全局定义不可撤销')
  })

  test('用户可以创建独立的 user-global Skill，创建时不绑定工作区', () => {
    setup()
    const created = createUserGlobalSkill('release-check', '发布检查', '检查发布前条件', '# 发布检查\n\n逐项检查。')
    expect(created.type).toBe('user-global')
    expect(created.slug).toBe('release-check')
    expect(created.version).toBe('1.0.0')
    expect(readGlobalSkillContent(created.skillId)).toContain('name: 发布检查')
    expect(listGlobalSkills().find((skill) => skill.skillId === created.skillId)?.type).toBe('user-global')
    expect(getGlobalSkillDeleteBlockers(created.skillId).references).toHaveLength(0)
    expect(() => createUserGlobalSkill('release-check', '重复', '', '')).toThrow('slug 已存在')
  })

  test('所有外部 workspace/slug 路径片段都拒绝穿越与绝对路径', () => {
    setup()
    const builtin = listGlobalSkills()[0]!
    expect(() => copyGlobalSkillToWorkspace(builtin.skillId, '../escaped')).toThrow()
    expect(() => copyGlobalSkillToWorkspace(builtin.skillId, 'C:\\escaped')).toThrow()
    expect(() => copyGlobalSkillToUserGlobal(builtin.skillId, '../escaped')).toThrow()
    expect(() => copyGlobalSkillToUserGlobal(builtin.skillId, 'foo/bar')).toThrow()
    expect(() => listGlobalSkills('../workspace')).toThrow()
    expect(existsSync(join(roots[roots.length - 1]!, 'escaped'))).toBe(false)
  })

  test('工作区副本使用稳定 ID；目录重命名后覆盖、详情和恢复仍按 ID 关联', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const copied = copyGlobalSkillToWorkspace(builtin.skillId, 'a')
    expect(copied.workspaceSkillId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(readFileSync(join(paths.workspaces, 'a', 'skills', 'demo', '.source.json'), 'utf8')).workspaceSkillId).toBe(copied.workspaceSkillId)
    renameSync(join(paths.workspaces, 'a', 'skills', 'demo'), join(paths.workspaces, 'a', 'skills', 'renamed'))
    const resolved = resolveEffectiveSkills('a')
    expect(resolved.filter((skill) => skill.workspaceSkillId === copied.workspaceSkillId)).toHaveLength(1)
    expect(resolved.find((skill) => skill.workspaceSkillId === copied.workspaceSkillId)?.slug).toBe('renamed')
    expect(listGlobalSkills('a').find((skill) => skill.skillId === builtin.skillId)?.workspaceSkillId).toBe(copied.workspaceSkillId)
    restoreGlobalSkill('a', builtin.skillId)
    expect(resolveEffectiveSkills('a').find((skill) => skill.slug === 'demo')?.scope).toBe('global')
    expect(JSON.parse(readFileSync(join(paths.workspaces, 'a', 'skills', 'renamed', '.source.json'), 'utf8')).workspaceSkillId).toBe(copied.workspaceSkillId)
  })

  test('工作区副本按稳定 ID 读写，目录改名后不会回写全局来源', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const copied = copyGlobalSkillToWorkspace(builtin.skillId, 'a')
    renameSync(join(paths.workspaces, 'a', 'skills', 'demo'), join(paths.workspaces, 'a', 'skills', 'renamed'))

    expect(readWorkspaceSkillCopyContent('a', copied.workspaceSkillId)).toContain('# 演示')
    saveWorkspaceSkillCopyContent('a', copied.workspaceSkillId, `---
name: 本地重命名副本
version: 2.0.0
---

# 仅工作区`)
    expect(readWorkspaceSkillCopyContent('a', copied.workspaceSkillId)).toContain('仅工作区')
    expect(readGlobalSkillContent(builtin.skillId)).toContain('# 演示')
    expect(resolveEffectiveSkills('a').find((skill) => skill.workspaceSkillId === copied.workspaceSkillId)?.slug).toBe('renamed')
  })

  test('工作区复制替换只影响当前 workspace 且不重复解析', () => {
    setup()
    const builtin = listGlobalSkills()[0]!
    copyGlobalSkillToWorkspace(builtin.skillId, 'a')
    expect(resolveEffectiveSkills('a').filter((s) => s.slug === 'demo')).toHaveLength(1)
    expect(resolveEffectiveSkills('b').filter((s) => s.slug === 'demo')).toHaveLength(1)
    setGlobalSkillEnabled('b', builtin.skillId, false)
    expect(resolveEffectiveSkills('b').some((s) => s.slug === 'demo')).toBe(false)
    copyGlobalSkillToWorkspace(builtin.skillId, 'c')
    expect(() => setGlobalSkillEnabled('c', builtin.skillId, true)).toThrow('显式恢复')
  })

  test('用户全局 Skill 删除前必须解除有效引用，独立副本不阻塞也不写来源墓碑', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const user = copyGlobalSkillToUserGlobal(builtin.skillId, 'my-demo')
    setGlobalSkillEnabled('using-global', user.skillId, true)
    const copied = copyGlobalSkillToWorkspace(user.skillId, 'using-copy')

    const blockers = getGlobalSkillDeleteBlockers(user.skillId)
    expect(blockers.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceSlug: 'using-global', status: 'enabled', actualSource: 'global', blocksDeletion: true, reason: 'active-global-skill' }),
      expect.objectContaining({ workspaceSlug: 'using-copy', status: 'replaced-by-workspace-copy', actualSource: 'workspace', blocksDeletion: false, reason: 'workspace-copy-replacement', workspaceSkillId: copied.workspaceSkillId }),
    ]))
    expect(() => deleteUserGlobalSkill(user.skillId, `delete:${user.skillId}`)).toThrow('仍有 1 个工作区')

    setGlobalSkillEnabled('using-global', user.skillId, false)
    expect(getGlobalSkillDeleteBlockers(user.skillId).references.every((reference) => !reference.blocksDeletion)).toBe(true)
    deleteUserGlobalSkill(user.skillId, `delete:${user.skillId}`)
    expect(existsSync(join(paths.workspaces, 'using-copy', 'skills', 'my-demo'))).toBe(true)
    expect(resolveEffectiveSkills('using-copy').find((skill) => skill.workspaceSkillId === copied.workspaceSkillId)?.scope).toBe('workspace')
    expect(listGlobalSkills('using-copy').some((skill) => skill.skillId === user.skillId)).toBe(false)
    expect(JSON.parse(readFileSync(join(paths.workspaces, 'using-copy', 'skill-overrides.json'), 'utf8')).globalSkills[user.skillId]).toBeUndefined()
  })

  test('用户全局 Skill 保存会更新唯一全局定义，两个工作区随后解析同一新版本', () => {
    setup()
    const builtin = listGlobalSkills()[0]!
    const user = copyGlobalSkillToUserGlobal(builtin.skillId, 'my-demo')
    const before = readGlobalSkillContent(user.skillId)
    const updated = editGlobalSkill(user.skillId, 'a', 'global', `${before}\n全局修改。`)
    expect('type' in updated && updated.type).toBe('user-global')
    expect(readGlobalSkillContent(user.skillId)).toContain('全局修改。')
    expect(resolveEffectiveSkills('a').find((skill) => skill.sourceSkillId === user.skillId)?.version).toBe('1.0.1')
    expect(resolveEffectiveSkills('b').find((skill) => skill.sourceSkillId === user.skillId)?.version).toBe('1.0.1')
  })

  test('仅当前工作区编辑以事务创建副本，失败不会留下副本或覆盖记录', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const result = editGlobalSkill(builtin.skillId, 'a', 'workspace', '---\nname: 本地演示\nversion: 2.0.0\n---\n\n# 本地\n')
    expect('workspaceSkillSlug' in result && result.workspaceSkillSlug).toBe('demo')
    expect(resolveEffectiveSkills('a').filter((skill) => skill.slug === 'demo')).toHaveLength(1)
    expect(resolveEffectiveSkills('a').find((skill) => skill.slug === 'demo')?.scope).toBe('workspace')
    expect(existsSync(join(paths.workspaces, 'a', 'skills', 'demo', 'SKILL.md'))).toBe(true)
    expect(() => editGlobalSkill(builtin.skillId, 'a', 'workspace', 'x')).not.toThrow()
  })

  test('副本删除后只有显式恢复才重新加载原全局 Skill', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    copyGlobalSkillToWorkspace(builtin.skillId, 'a')
    rmSync(join(paths.workspaces, 'a', 'skills', 'demo'), { recursive: true, force: true })
    expect(resolveEffectiveSkills('a').some((skill) => skill.slug === 'demo')).toBe(false)
    restoreGlobalSkill('a', builtin.skillId)
    expect(resolveEffectiveSkills('a').filter((skill) => skill.slug === 'demo')).toHaveLength(1)
    expect(resolveEffectiveSkills('a').find((skill) => skill.slug === 'demo')?.scope).toBe('global')
    expect(existsSync(join(paths.workspaces, 'a', 'skills', 'demo', 'SKILL.md'))).toBe(false)
  })

  test('复制与 runtime projection 统一过滤工程目录和符号链接', () => {
    const paths = setup()
    const source = join(paths.bundle, 'demo')
    mkdirSync(join(source, 'node_modules', 'bad'), { recursive: true })
    mkdirSync(join(source, 'dist'), { recursive: true })
    writeFileSync(join(source, 'node_modules', 'bad', 'index.js'), 'bad')
    writeFileSync(join(source, 'dist', 'bundle.js'), 'bad')
    // 重新 seed 才会把 bundle 的新增内容作为 builtin 新版本来源；版本升级模拟全量复制。
    writeFileSync(join(source, 'SKILL.md'), `---
name: 演示
version: 1.0.1
---

# 演示`)
    seedBuiltinGlobalSkills(paths.bundle)
    const builtin = listGlobalSkills()[0]!
    const copied = copyGlobalSkillToWorkspace(builtin.skillId, 'a')
    expect(existsSync(join(paths.workspaces, 'a', 'skills', copied.workspaceSkillSlug, 'node_modules'))).toBe(false)
    expect(existsSync(join(paths.workspaces, 'a', 'skills', copied.workspaceSkillSlug, 'dist'))).toBe(false)
    const projection = prepareRuntimeSkills('a')
    expect(existsSync(join(projection.path, 'skills', copied.workspaceSkillSlug, 'node_modules'))).toBe(false)
    expect(existsSync(join(projection.path, 'skills', copied.workspaceSkillSlug, 'dist'))).toBe(false)
  })

  test('runtime projection 使用内容指纹，新运行创建新投影且只安全清理过期缓存', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const first = prepareRuntimeSkills('a')
    const firstSkill = join(first.path, 'skills', builtin.slug, 'SKILL.md')
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(first.path, old, old)
    const updated = `${readGlobalSkillContent(builtin.skillId)}
# 新内容`
    // 先复制到 user-global 后更新，避免破坏 builtin 只读约束。
    const user = copyGlobalSkillToUserGlobal(builtin.skillId, 'cache-demo')
    editGlobalSkill(user.skillId, 'a', 'global', updated)
    const second = prepareRuntimeSkills('a')
    expect(second.path).not.toBe(first.path)
    expect(existsSync(firstSkill)).toBe(false)
    expect(existsSync(join(second.path, 'skills', 'cache-demo', 'SKILL.md'))).toBe(true)
  })

  test('有效投影同时满足 Claude plugin root 与 Pi skill root，且不重复加载', () => {
    setup()
    const builtin = listGlobalSkills()[0]!
    const projection = prepareRuntimeSkills('a')
    expect(projection.skills).toHaveLength(1)
    expect(existsSync(join(projection.path, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(projection.path, 'skills', builtin.slug, 'SKILL.md'))).toBe(true)
  })

  test('目录替换失败时恢复原目录，原目录内容仍可读', () => {
    const base = mkdtempSync(join(tmpdir(), 'profer-directory-replace-'))
    roots.push(base)
    const target = join(base, 'target')
    const staged = join(base, 'staged')
    mkdirSync(target, { recursive: true })
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), '旧源')
    writeFileSync(join(staged, 'SKILL.md'), '新源')

    expect(() => __replaceStagedDirectoryForTest(staged, target, true)).toThrow('模拟新目录切换失败')
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('旧源')
    expect(existsSync(staged)).toBe(false)
  })

  test('新旧来源格式兼容，workspace source 不会调用旧工作区回源解析', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'profer-scan-source-'))
    roots.push(configRoot)
    const previousConfigRoot = process.env.PROFER_CONFIG_DIR
    process.env.PROFER_CONFIG_DIR = configRoot
    const { getWorkspaceSkillsDir, getInactiveSkillsDir } = await import('./config-paths')
    const active = join(getWorkspaceSkillsDir('scan'), 'new-copy')
    const legacy = join(getInactiveSkillsDir('scan'), 'legacy-copy')
    mkdirSync(active, { recursive: true })
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(active, 'SKILL.md'), '---\\nname: 新副本\\nversion: 1.0.0\\n---\\n')
    writeFileSync(join(active, '.source.json'), JSON.stringify({ sourceSkillId: 'builtin-new', sourceSkillType: 'builtin-meta', sourceVersion: '1.0.0', copiedAt: '2026-08-27T00:00:00.000Z', scope: 'workspace', replacementForSkillId: 'builtin-new', sourceStatus: 'available' }))
    writeFileSync(join(legacy, 'SKILL.md'), '---\\nname: 旧导入\\nversion: 1.0.0\\n---\\n')
    writeFileSync(join(legacy, '.source.json'), JSON.stringify({ sourceWorkspaceSlug: 'missing-source', sourceWorkspaceName: '旧来源', importedAt: '2026-08-27T00:00:00.000Z', sourceVersion: '1.0.0' }))
    const { scanSkillsInDir } = await import('./agent-workspace-manager')
    const result = scanSkillsInDir(getWorkspaceSkillsDir('scan'), true)
    const newCopy = result.find((skill) => skill.slug === 'new-copy')
    expect(newCopy?.sourceSkillId).toBe('builtin-new')
    expect(newCopy?.sourceSkillType).toBe('builtin-meta')
    expect(newCopy?.actualSource).toBe('workspace')
    const oldCopy = scanSkillsInDir(getInactiveSkillsDir('scan'), false).find((skill) => skill.slug === 'legacy-copy')
    expect(oldCopy?.importSource?.sourceWorkspaceSlug).toBe('missing-source')
    expect(oldCopy?.actualSource).toBe('none')
    if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
    else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  })

  test('工作区 Skill 列表保留 inactive 副本，并保留稳定 ID 与来源元数据', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'profer-workspace-skill-list-'))
    roots.push(configRoot)
    const previousConfigRoot = process.env.PROFER_CONFIG_DIR
    process.env.PROFER_CONFIG_DIR = configRoot
    const { getWorkspaceSkillsDir, getInactiveSkillsDir } = await import('./config-paths')
    const inactive = join(getInactiveSkillsDir('listed'), 'disabled-copy')
    mkdirSync(inactive, { recursive: true })
    writeFileSync(join(inactive, 'SKILL.md'), '---\\nname: 已关闭副本\\ndescription: 保留来源\\nversion: 1.2.3\\n---\\n\\n# 内容\\n')
    writeFileSync(join(inactive, '.source.json'), JSON.stringify({
      scope: 'workspace',
      workspaceSkillId: 'workspace-disabled-copy',
      sourceSkillId: 'builtin-demo',
      sourceSkillType: 'builtin-meta',
      sourceVersion: '1.2.3',
      sourceStatus: 'available',
    }))

    const result = getWorkspaceSkills('listed')
    const skill = result.find((item) => item.slug === 'disabled-copy')
    expect(skill?.enabled).toBe(false)
    expect(skill?.actualSource).toBe('none')
    expect(skill?.workspaceSkillId).toBe('workspace-disabled-copy')
    expect(skill?.sourceSkillId).toBe('builtin-demo')
    expect(skill?.sourceSkillType).toBe('builtin-meta')
    expect(existsSync(join(getWorkspaceSkillsDir('listed'), 'disabled-copy'))).toBe(false)
    if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
    else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  })

  test('旧 schema 已完成但误标 unknown 的干净副本会重新分类为 builtin-meta 引用', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const root = join(paths.workspaces, 'legacy-reclassified', 'skills', builtin.slug)
    const legacyMaster = join(paths.global, 'legacy-default-skills', builtin.slug)
    cpSync(join(paths.bundle, 'demo'), legacyMaster, { recursive: true })
    cpSync(join(paths.bundle, 'demo'), root, { recursive: true })
    writeFileSync(join(root, '.source.json'), JSON.stringify({
      workspaceSkillId: 'legacy-workspace-id',
      scope: 'workspace',
      sourceStatus: 'unknown-legacy',
      migrationReason: `疑似元 Skill 但缺少可靠来源标记: ${builtin.slug}`,
    }))
    writeFileSync(join(paths.global, 'skill-system-migration.json'), JSON.stringify({
      schemaVersion: 2,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedWorkspaces: ['legacy-reclassified'],
      migratedLegacyMasters: [],
      failedEntries: [],
    }))

    const result = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(result.migrated).toBe(1)
    expect(existsSync(root)).toBe(false)
    expect(resolveEffectiveSkills('legacy-reclassified').find((skill) => skill.slug === builtin.slug)?.actualSource).toBe('global')
    expect(JSON.parse(readFileSync(join(paths.global, 'skill-system-migration.json'), 'utf8')).schemaVersion).toBe(3)
  })

  test('B1/B2：来源可靠且内容未修改的 active/inactive 副本转为全局引用，正文备份后退出 runtime', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const cases: Array<[string, boolean]> = [['b1-active', true], ['b2-inactive', false]]
    for (const [workspace, active] of cases) {
      const root = join(paths.workspaces, workspace, active ? 'skills' : 'skills-inactive', builtin.slug)
      cpSync(join(paths.bundle, 'demo'), root, { recursive: true })
      writeFileSync(join(root, '.source.json'), JSON.stringify({ sourceKind: 'master', masterSlug: builtin.slug, importedAt: '2026-01-01T00:00:00.000Z' }))
    }
    const result = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(result.migrated).toBe(2)
    expect(existsSync(join(paths.workspaces, 'b1-active', 'skills', builtin.slug))).toBe(false)
    expect(existsSync(join(paths.workspaces, 'b2-inactive', 'skills-inactive', builtin.slug))).toBe(false)
    expect(existsSync(join(paths.workspaces, 'b1-active', '.migration-backup', 'retired-skills', 'active', builtin.slug))).toBe(true)
    expect(resolveEffectiveSkills('b1-active').find((skill) => skill.slug === builtin.slug)?.actualSource).toBe('global')
    expect(resolveEffectiveSkills('b2-inactive').find((skill) => skill.slug === builtin.slug)).toBeUndefined()
  })

  test('repair：schema 3 completed 仍使用历史备份中的旧正文证据，多工作区幂等迁移', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const oldSkill = '---\nname: 演示\nversion: 0.9.0\n---\n\n# Proma 旧正文\n'
    const legacyMaster = join(paths.global, 'legacy-default-skills', builtin.slug)
    mkdirSync(legacyMaster, { recursive: true })
    writeFileSync(join(legacyMaster, 'SKILL.md'), oldSkill)
    for (const workspace of ['repair-a', 'repair-b']) {
      const current = join(paths.workspaces, workspace, 'skills', builtin.slug)
      mkdirSync(current, { recursive: true })
      writeFileSync(join(current, 'SKILL.md'), oldSkill)
      const backup = join(paths.workspaces, workspace, '.migration-backup', 'skills', 'skills', builtin.slug)
      mkdirSync(backup, { recursive: true })
      writeFileSync(join(backup, 'SKILL.md'), oldSkill)
      writeFileSync(join(current, '.source.json'), JSON.stringify({ scope: 'workspace', sourceStatus: 'unknown-legacy', migrationReason: '历史迁移误分类' }))
    }
    writeFileSync(join(paths.global, 'skill-system-migration.json'), JSON.stringify({
      schemaVersion: 3,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedWorkspaces: ['repair-a', 'repair-b'],
      migratedLegacyMasters: [],
      failedEntries: [],
    }))

    const first = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(first.migrated).toBe(2)
    for (const workspace of ['repair-a', 'repair-b']) {
      expect(existsSync(join(paths.workspaces, workspace, 'skills', builtin.slug))).toBe(false)
      expect(existsSync(join(paths.workspaces, workspace, '.migration-backup', 'retired-skills', 'active', builtin.slug))).toBe(true)
      expect(JSON.parse(readFileSync(join(paths.workspaces, workspace, 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId].enabled).toBe(true)
    }
    const second = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(second.migrated).toBe(0)
    expect(second.failed).toEqual([])
  })

  test('repair：已有历史备份正文不可被当前副本覆盖，二次运行 migrated=0 且结构不变', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const workspace = join(paths.workspaces, 'immutable-history')
    const current = join(workspace, 'skills', builtin.slug)
    const backup = join(workspace, '.migration-backup', 'skills', 'skills', builtin.slug)
    const historicalContent = '---\nname: 演示\nversion: 0.9.0\n---\n\n# Proma 历史正文\n'
    const userContent = '---\nname: 演示\nversion: 0.9.0\n---\n\n# 用户修改正文\n'
    mkdirSync(current, { recursive: true })
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(current, 'SKILL.md'), userContent)
    writeFileSync(join(backup, 'SKILL.md'), historicalContent)
    const beforeHash = readFileSync(join(backup, 'SKILL.md'), 'utf8')
    const first = migrateLegacyWorkspaceSkills(paths.bundle)
    const afterFirstStructure = readFileSync(join(current, 'SKILL.md'), 'utf8')
    const second = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(first.migrated).toBe(0)
    expect(second.migrated).toBe(0)
    expect(second.unknown).toBe(0)
    expect(second.failed).toEqual([])
    expect(readFileSync(join(backup, 'SKILL.md'), 'utf8')).toBe(beforeHash)
    expect(readFileSync(join(current, 'SKILL.md'), 'utf8')).toBe(afterFirstStructure)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(backup)).toBe(true)
  })

  test('repair 幂等：已退休正文与对应 override 存在时，残留同正文副本不再次迁移', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const workspaceRoot = join(paths.workspaces, 'already-consumed')
    const current = join(workspaceRoot, 'skills', builtin.slug)
    const retired = join(workspaceRoot, '.migration-backup', 'retired-skills', 'active', builtin.slug)
    mkdirSync(current, { recursive: true })
    mkdirSync(retired, { recursive: true })
    const content = '---\nname: 演示\nversion: 0.9.0\n---\n\n# 旧正文\n'
    writeFileSync(join(current, 'SKILL.md'), content)
    writeFileSync(join(retired, 'SKILL.md'), content)
    writeFileSync(join(workspaceRoot, 'skill-overrides.json'), JSON.stringify({
      schemaVersion: 1,
      globalSkills: { [builtin.skillId]: { enabled: true, updatedAt: '2026-09-02T00:00:00.000Z' } },
    }))
    const before = readFileSync(join(current, 'SKILL.md'), 'utf8')
    const first = migrateLegacyWorkspaceSkills(paths.bundle)
    const afterFirst = readFileSync(join(current, 'SKILL.md'), 'utf8')
    const second = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(first.migrated).toBe(0)
    expect(second.migrated).toBe(0)
    expect(second.unknown).toBe(0)
    expect(second.failed).toEqual([])
    expect(afterFirst).toBe(before)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(retired)).toBe(true)
  })

  test('local toggle：明确空字符串和未传 sourceSkillId 都优先移动工作区副本，不修改同名全局 override', async () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const configRoot = mkdtempSync(join(tmpdir(), 'profer-toggle-local-'))
    roots.push(configRoot)
    const previousConfigRoot = process.env.PROFER_CONFIG_DIR
    process.env.PROFER_CONFIG_DIR = configRoot
    const { getWorkspaceSkillsDir, getInactiveSkillsDir } = await import('./config-paths')
    const local = join(getWorkspaceSkillsDir('toggle-local'), builtin.slug)
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, 'SKILL.md'), '---\nname: 本地\nversion: 1.0.0\n---\n\n# 本地\n')
    toggleWorkspaceSkill('toggle-local', builtin.slug, false, '')
    expect(existsSync(join(getWorkspaceSkillsDir('toggle-local'), builtin.slug))).toBe(false)
    expect(existsSync(join(getInactiveSkillsDir('toggle-local'), builtin.slug))).toBe(true)
    expect(existsSync(join(configRoot, 'agent-workspaces', 'toggle-local', 'skill-overrides.json'))).toBe(false)
    toggleWorkspaceSkill('toggle-local', builtin.slug, true)
    expect(existsSync(join(getWorkspaceSkillsDir('toggle-local'), builtin.slug))).toBe(true)
    if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
    else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  })

  test('B1/B2：真实旧版无 source metadata 时通过 legacy default-skills 内容识别并转为全局引用', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const legacyMaster = join(paths.global, 'legacy-default-skills', builtin.slug)
    cpSync(join(paths.bundle, 'demo'), legacyMaster, { recursive: true })
    const cases: Array<[string, boolean]> = [['legacy-no-meta-active', true], ['legacy-no-meta-inactive', false]]
    for (const [workspace, active] of cases) {
      const root = join(paths.workspaces, workspace, active ? 'skills' : 'skills-inactive', builtin.slug)
      cpSync(legacyMaster, root, { recursive: true })
    }
    const result = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(result.migrated).toBe(2)
    expect(existsSync(join(paths.workspaces, 'legacy-no-meta-active', 'skills', builtin.slug))).toBe(false)
    expect(existsSync(join(paths.workspaces, 'legacy-no-meta-inactive', 'skills-inactive', builtin.slug))).toBe(false)
    const activeOverride = JSON.parse(readFileSync(join(paths.workspaces, 'legacy-no-meta-active', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    const inactiveOverride = JSON.parse(readFileSync(join(paths.workspaces, 'legacy-no-meta-inactive', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    expect(activeOverride.enabled).toBe(true)
    expect(inactiveOverride.enabled).toBe(false)
    expect(existsSync(join(paths.workspaces, 'legacy-no-meta-active', '.migration-backup', 'retired-skills', 'active', builtin.slug))).toBe(true)
  })

  test('modified meta automation：source-less 修改版与旧 master 不同则保留 active workspace replacement', () => {
    const paths = setup()
    const automationBundle = join(paths.bundle, 'automation')
    mkdirSync(automationBundle, { recursive: true })
    writeFileSync(join(automationBundle, 'SKILL.md'), '---\nname: automation\nversion: 1.0.0\n---\n\n# automation 旧 master\n')
    seedBuiltinGlobalSkills(paths.bundle)
    const builtin = listGlobalSkills().find((skill) => skill.slug === 'automation')!
    const legacyMaster = join(paths.global, 'legacy-default-skills', builtin.slug)
    cpSync(automationBundle, legacyMaster, { recursive: true })
    const current = join(paths.workspaces, 'source-less-modified', 'skills', builtin.slug)
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'SKILL.md'), `---
name: automation改
version: 1.0.0
---

# 用户修改
`)


    const result = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(result.migrated).toBe(1)
    expect(existsSync(current)).toBe(true)
    const source = JSON.parse(readFileSync(join(current, '.source.json'), 'utf8'))
    expect(source.sourceSkillId).toBe(builtin.skillId)
    expect(source.sourceSkillType).toBe('builtin-meta')
    expect(source.sourceVersion).toBe(builtin.version)
    expect(source.replacementForSkillId).toBe(builtin.skillId)
    expect(source.sourceStatus).toBe('modified-legacy-copy')
    const override = JSON.parse(readFileSync(join(paths.workspaces, 'source-less-modified', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    expect(override.replacementWorkspaceSkillId).toBe(source.workspaceSkillId)
    expect(override.replacementWorkspaceSkillSlug).toBe(builtin.slug)
    expect(resolveEffectiveSkills('source-less-modified').find((skill) => skill.scope === 'workspace')?.name).toBe('automation改')
    const runtime = prepareRuntimeSkills('source-less-modified')
    expect(readFileSync(join(runtime.path, 'skills', builtin.slug, 'SKILL.md'), 'utf8')).toContain('automation改')
    expect(existsSync(join(paths.workspaces, 'source-less-modified', '.migration-backup', 'retired-skills', 'active', builtin.slug))).toBe(false)
    const beforeSecond = {
      content: readFileSync(join(current, 'SKILL.md'), 'utf8'),
      source: readFileSync(join(current, '.source.json'), 'utf8'),
      override: readFileSync(join(paths.workspaces, 'source-less-modified', 'skill-overrides.json'), 'utf8'),
    }
    const second = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(second.migrated).toBe(0)
    expect(existsSync(current)).toBe(true)
    expect(readFileSync(join(current, 'SKILL.md'), 'utf8')).toBe(beforeSecond.content)
    expect(readFileSync(join(current, '.source.json'), 'utf8')).toBe(beforeSecond.source)
    expect(readFileSync(join(paths.workspaces, 'source-less-modified', 'skill-overrides.json'), 'utf8')).toBe(beforeSecond.override)
  })

  test('source-less inactive 修改副本保留 disabled replacement，不进入 runtime', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const legacyMaster = join(paths.global, 'legacy-default-skills', builtin.slug)
    cpSync(join(paths.bundle, 'demo'), legacyMaster, { recursive: true })
    const current = join(paths.workspaces, 'source-less-modified-inactive', 'skills-inactive', builtin.slug)
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'SKILL.md'), `---
name: 演示修改版（已关闭）
version: 1.0.0
---

# 用户修改
`)

    const result = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(result.migrated).toBe(1)
    expect(existsSync(current)).toBe(true)
    const source = JSON.parse(readFileSync(join(current, '.source.json'), 'utf8'))
    const override = JSON.parse(readFileSync(join(paths.workspaces, 'source-less-modified-inactive', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    expect(source.sourceStatus).toBe('preserved-legacy-disabled-copy')
    expect(source.workspaceSkillId).toMatch(/^[0-9a-f-]{36}$/)
    expect(source.sourceSkillId).toBe(builtin.skillId)
    expect(override.enabled).toBe(false)
    expect(override.replacementWorkspaceSkillId).toBe(source.workspaceSkillId)
    expect(override.replacementWorkspaceSkillSlug).toBe(builtin.slug)
    expect(resolveEffectiveSkills('source-less-modified-inactive').find((skill) => skill.slug === builtin.slug)).toBeUndefined()
    expect(existsSync(join(paths.workspaces, 'source-less-modified-inactive', '.migration-backup', 'retired-skills', 'inactive', builtin.slug))).toBe(false)
    const beforeSecond = {
      source: readFileSync(join(current, '.source.json'), 'utf8'),
      override: readFileSync(join(paths.workspaces, 'source-less-modified-inactive', 'skill-overrides.json'), 'utf8'),
    }
    const second = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(second.migrated).toBe(0)
    expect(existsSync(current)).toBe(true)
    expect(readFileSync(join(current, '.source.json'), 'utf8')).toBe(beforeSecond.source)
    expect(readFileSync(join(paths.workspaces, 'source-less-modified-inactive', 'skill-overrides.json'), 'utf8')).toBe(beforeSecond.override)
  })

  test('source-less 副本缺少可靠旧 master 时不使用当前 builtin 或历史备份退休', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const current = join(paths.workspaces, 'source-less-no-master', 'skills', builtin.slug)
    const historicalBackup = join(paths.workspaces, 'source-less-no-master', '.migration-backup', 'skills', 'skills', builtin.slug)
    cpSync(join(paths.bundle, 'demo'), current, { recursive: true })
    cpSync(join(paths.bundle, 'demo'), historicalBackup, { recursive: true })

    const first = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(first.migrated).toBe(0)
    expect(first.unknown).toBe(1)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(join(paths.workspaces, 'source-less-no-master', '.migration-backup', 'retired-skills', 'active', builtin.slug))).toBe(false)
    expect(JSON.parse(readFileSync(join(current, '.source.json'), 'utf8')).sourceStatus).toBe('unknown-legacy')
    const second = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(second.migrated).toBe(0)
    expect(second.unknown).toBe(0)
    expect(existsSync(current)).toBe(true)
  })

  test('B3/B4：来源可靠但内容被修改时保留独立 workspace 副本，active/inactive 状态与诊断不变', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    // sourceKind 只说明来源，不说明正文未修改；必须提供可比对的旧 master 才能分类 B3/B4。
    cpSync(join(paths.bundle, 'demo'), join(paths.global, 'legacy-default-skills', builtin.slug), { recursive: true })
    const cases: Array<[string, boolean]> = [['b3-active', true], ['b4-inactive', false]]
    for (const [workspace, active] of cases) {
      const root = join(paths.workspaces, workspace, active ? 'skills' : 'skills-inactive', builtin.slug)
      cpSync(join(paths.bundle, 'demo'), root, { recursive: true })
      writeFileSync(join(root, 'SKILL.md'), `---\nname: 演示\nversion: 1.0.0\n---\n\n# 用户修改 ${workspace}\n`)
      writeFileSync(join(root, '.source.json'), JSON.stringify({ sourceKind: 'master', masterSlug: builtin.slug, importedAt: '2026-01-01T00:00:00.000Z' }))
    }
    migrateLegacyWorkspaceSkills(paths.bundle)
    const activeSource = JSON.parse(readFileSync(join(paths.workspaces, 'b3-active', 'skills', builtin.slug, '.source.json'), 'utf8'))
    const inactiveSource = JSON.parse(readFileSync(join(paths.workspaces, 'b4-inactive', 'skills-inactive', builtin.slug, '.source.json'), 'utf8'))
    expect(activeSource.sourceStatus).toBe('modified-legacy-copy')
    expect(inactiveSource.sourceStatus).toBe('preserved-legacy-disabled-copy')
    const activeOverride = JSON.parse(readFileSync(join(paths.workspaces, 'b3-active', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    const inactiveOverride = JSON.parse(readFileSync(join(paths.workspaces, 'b4-inactive', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    expect(activeOverride.replacementWorkspaceSkillId).toBe(activeSource.workspaceSkillId)
    expect(inactiveOverride.enabled).toBe(false)
    expect(resolveEffectiveSkills('b3-active').find((skill) => skill.scope === 'workspace')?.slug).toBe(builtin.slug)
    expect(resolveEffectiveSkills('b4-inactive').find((skill) => skill.scope === 'workspace')).toBeUndefined()
  })

  test('B7：多个工作区相同来源只保留一个 builtin manifest，各自保存独立覆盖状态', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    for (const workspace of ['b7-a', 'b7-b']) {
      const root = join(paths.workspaces, workspace, 'skills', builtin.slug)
      cpSync(join(paths.bundle, 'demo'), root, { recursive: true })
    }
    migrateLegacyWorkspaceSkills(paths.bundle)
    expect(listGlobalSkills().filter((skill) => skill.type === 'builtin-meta' && skill.slug === builtin.slug)).toHaveLength(1)
    expect(existsSync(join(paths.workspaces, 'b7-a', 'skill-overrides.json'))).toBe(true)
    expect(existsSync(join(paths.workspaces, 'b7-b', 'skill-overrides.json'))).toBe(true)
  })

  test('单工作区迁移失败会保持 failed 状态，修复后可重入完成而非错误标记 completed', () => {
    const paths = setup()
    const broken = join(paths.workspaces, 'broken')
    mkdirSync(broken, { recursive: true })
    // 用同名普通文件模拟被意外占用的 skills 根，readdir 会失败但不会影响其他工作区。
    writeFileSync(join(broken, 'skills'), 'not a directory')
    const failed = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(failed.failed.some((item) => item.startsWith('broken:'))).toBe(true)
    expect(JSON.parse(readFileSync(join(paths.global, 'skill-system-migration.json'), 'utf8')).status).toBe('failed')

    rmSync(join(broken, 'skills'), { force: true })
    mkdirSync(join(broken, 'skills'), { recursive: true })
    const retried = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(retried.failed).toEqual([])
    expect(JSON.parse(readFileSync(join(paths.global, 'skill-system-migration.json'), 'utf8')).status).toBe('completed')
  })

  test('旧工作区迁移保留 active/inactive 内容与状态，未知来源显式标记且可重入', () => {
    const paths = setup()
    const builtin = listGlobalSkills()[0]!
    const legacyMaster = join(paths.global, 'legacy-default-skills', 'demo')
    mkdirSync(legacyMaster, { recursive: true })
    writeFileSync(join(legacyMaster, 'SKILL.md'), '---\nname: 演示\nversion: 0.9.0\n---\n\n# 用户改过的元 Skill\n')

    const active = join(paths.workspaces, 'legacy-active', 'skills', 'demo')
    const inactive = join(paths.workspaces, 'legacy-inactive', 'skills-inactive', 'demo')
    const unknown = join(paths.workspaces, 'unknown', 'skills', 'mystery')
    mkdirSync(active, { recursive: true })
    mkdirSync(inactive, { recursive: true })
    mkdirSync(unknown, { recursive: true })
    writeFileSync(join(active, 'SKILL.md'), '---\nname: 演示\nversion: 0.8.0\n---\n\n# 用户 active 内容\n')
    writeFileSync(join(inactive, 'SKILL.md'), '---\nname: 演示\nversion: 0.8.0\n---\n\n# 用户 inactive 内容\n')
    writeFileSync(join(unknown, 'SKILL.md'), '---\nname: 神秘\nversion: 1.0.0\n---\n\n# 未知来源\n')
    writeFileSync(join(active, '.source.json'), JSON.stringify({ sourceKind: 'master', masterSlug: 'demo', importedAt: '2026-01-01T00:00:00.000Z' }))
    writeFileSync(join(inactive, '.source.json'), JSON.stringify({ sourceKind: 'master', masterSlug: 'demo', importedAt: '2026-01-01T00:00:00.000Z' }))
    const unknownMaster = join(paths.workspaces, 'unknown-master', 'skills', 'mystery-master')
    mkdirSync(unknownMaster, { recursive: true })
    writeFileSync(join(unknownMaster, 'SKILL.md'), '---\nname: 神秘元 Skill\nversion: 1.0.0\n---\n\n# 未知元来源\n')
    writeFileSync(join(unknownMaster, '.source.json'), JSON.stringify({ sourceKind: 'master', masterSlug: 'removed-master' }))

    const first = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(first.migrated).toBe(2)
    // B5 unknown-master 被标记为不确定；无任何来源证据的 mystery 属于 A 类普通 workspace Skill，不计入 unknown。
    expect(first.unknown).toBe(1)
    expect(readFileSync(join(active, 'SKILL.md'), 'utf8')).toContain('用户 active 内容')
    expect(readFileSync(join(inactive, 'SKILL.md'), 'utf8')).toContain('用户 inactive 内容')
    expect(JSON.parse(readFileSync(join(active, '.source.json'), 'utf8')).sourceSkillId).toBe(builtin.skillId)
    expect(JSON.parse(readFileSync(join(inactive, '.source.json'), 'utf8')).sourceSkillId).toBe(builtin.skillId)
    expect(JSON.parse(readFileSync(join(unknown, '.source.json'), 'utf8')).workspaceSkillId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(readFileSync(join(unknownMaster, '.source.json'), 'utf8')).sourceStatus).toBe('uncertain-legacy-copy')
    expect(JSON.parse(readFileSync(join(unknownMaster, '.source.json'), 'utf8')).masterSlug).toBe('removed-master')
    const activeOverride = JSON.parse(readFileSync(join(paths.workspaces, 'legacy-active', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    const inactiveOverride = JSON.parse(readFileSync(join(paths.workspaces, 'legacy-inactive', 'skill-overrides.json'), 'utf8')).globalSkills[builtin.skillId]
    expect(activeOverride.enabled).toBe(false)
    expect(activeOverride.replacementWorkspaceSkillSlug).toBe('demo')
    expect(inactiveOverride.enabled).toBe(false)
    expect(inactiveOverride.replacementWorkspaceSkillSlug).toBe('demo')
    expect(inactiveOverride.replacementWorkspaceSkillId).toBe(JSON.parse(readFileSync(join(inactive, '.source.json'), 'utf8')).workspaceSkillId)
    expect(inactiveOverride.disabledReason).toBe('preserved-legacy-disabled-copy')
    expect(existsSync(join(paths.workspaces, 'legacy-active', '.migration-backup'))).toBe(true)
    expect(listGlobalSkills().some((skill) => skill.type === 'user-global' && skill.slug === 'demo-legacy')).toBe(true)

    const second = migrateLegacyWorkspaceSkills(paths.bundle)
    expect(second.migrated).toBe(0)
    expect(second.unknown).toBe(0)
    expect(second.legacyMasters).toBe(0)
    expect(JSON.parse(readFileSync(join(paths.global, 'skill-system-migration.json'), 'utf8')).status).toBe('completed')
  })
})
