/**
 * 工作区技能路由卡片（SKILL.json）写入链路的契约。
 *
 * 这条链路是「用户在技能详情里填触发词与依赖」的实际落地点：UI → IPC → 工作区技能目录。
 * 盯三件事：写入后读取能拿到、清空后文件真的消失（回到回退路径）、非法输入不落盘。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { __resetGlobalSkillRoots, __setGlobalSkillRoots, createUserGlobalSkill, listGlobalSkills, readGlobalSkillCard, seedBuiltinGlobalSkills, writeGlobalSkillCard } from './global-skill-manager'
import { createWorkspaceSkill, getAllWorkspaceSkills, importSkillFromWorkspace, promoteWorkspaceSkillToGlobal, readWorkspaceSkillCard, toggleWorkspaceSkill, updateSkillFromSource, writeWorkspaceSkillCard } from './agent-workspace-manager'
import { resolveSkillCardReminder } from './skill-card-reminder'

// 工作区技能目录来自 config-paths（而不是 global-skill-manager 的测试替身），必须显式隔离配置根目录，
// 否则会在真实的 ~/.profer-dev/agent-workspaces/ 里留下测试技能。
const isolatedConfigRoot = mkdtempSync(join(tmpdir(), 'profer-workspace-skill-card-config-'))
const previousConfigRoot = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = isolatedConfigRoot
afterAll(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  rmSync(isolatedConfigRoot, { recursive: true, force: true })
})

const roots: string[] = [isolatedConfigRoot]
afterEach(() => {
  __resetGlobalSkillRoots()
  while (roots.length > 1) rmSync(roots.pop()!, { recursive: true, force: true })
})

let workspaceCounter = 0
/** 工作区技能目录由 config-paths 决定（PROFER_CONFIG_DIR 下），与 global-skill-manager 的测试替身无关。 */
function cardFile(slug: string): string {
  return join(isolatedConfigRoot, 'agent-workspaces', slug, 'skills', 'carded', 'SKILL.json')
}

function setup(legacy = true): { slug: string } {
  const base = mkdtempSync(join(tmpdir(), 'profer-workspace-skill-card-'))
  roots.push(base)
  const global = join(base, 'global-skills')
  const workspaces = join(base, 'workspaces')
  mkdirSync(global, { recursive: true })
  mkdirSync(workspaces, { recursive: true })
  __setGlobalSkillRoots(global, workspaces)
  // 每个用例用独立工作区 slug：隔离配置根目录在整个文件内共享，同名工作区会把上一用例的技能留下。
  const slug = `ws-${++workspaceCounter}`
  createWorkspaceSkill(slug, 'carded', '卡片技能', '用于把数据画成图表的演示技能。', '# 卡片技能\n')
  if (legacy) rmSync(cardFile(slug))
  return { slug }
}

describe('工作区技能卡片：读写链路', () => {
  test('新建 Skill 随正文生成默认卡片，保存未配置的卡片不会让它消失', async () => {
    const { slug } = setup(false)
    expect(JSON.parse(readFileSync(cardFile(slug), 'utf8'))).toEqual({ schemaVersion: 1 })
    expect(getAllWorkspaceSkills(slug, true).find(skill => skill.slug === 'carded')?.needsCardReminder).toBeFalsy()
    const next = await writeWorkspaceSkillCard(slug, 'carded', { dependencies: { tools: [] }, policy: { implicit: null } })
    expect(next.present).toBe(true)
    expect(next.manifest).toEqual({ schemaVersion: 1 })
  })

  test('没有卡片时读取为 present=false，且不报错', async () => {
    const { slug } = setup()
    const state = await readWorkspaceSkillCard(slug, 'carded')
    expect(state.present).toBe(false)
    expect(state.manifest).toBeUndefined()
    expect(state.issues).toEqual([])
  })

  test('写入触发词与依赖后能读回；没有工具清单时不瞎报依赖缺失', async () => {
    const { slug } = setup()
    const written = await writeWorkspaceSkillCard(slug, 'carded', {
      triggers: { keywords: ['柱状图', '折线图'] },
      dependencies: { toolGroups: ['preview'], tools: ['present_visualization'] },
    })
    expect(written.present).toBe(true)
    expect(written.manifest?.triggers?.keywords).toEqual(['柱状图', '折线图'])
    expect(written.manifest?.dependencies?.toolGroups).toEqual(['preview'])
    // 保存时没有运行时工具清单：医生不能凭空断言依赖可用或不可用（依赖门禁在路由时按真实清单判定）。
    expect(written.doctor.filter(issue => issue.severity === 'error')).toEqual([])
    expect(written.doctor.map(issue => issue.code)).not.toContain('dependency-tool-unavailable')

    const reread = await readWorkspaceSkillCard(slug, 'carded')
    expect(reread.present).toBe(true)
    expect(reread.manifest?.dependencies?.tools).toEqual(['present_visualization'])
  })

  test('清空后卡片文件被删除，回到无卡片回退路径', async () => {
    const { slug } = setup()
    await writeWorkspaceSkillCard(slug, 'carded', { policy: { implicit: false } })
    const file = cardFile(slug)
    expect(existsSync(file)).toBe(true)

    const cleared = await writeWorkspaceSkillCard(slug, 'carded', { policy: null })
    expect(cleared.present).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  test('非法输入报错且不落盘；不存在的技能直接拒绝', async () => {
    const { slug } = setup()
    const file = cardFile(slug)
    await expect(writeWorkspaceSkillCard(slug, 'carded', { triggers: { keywords: ['x'.repeat(200)] } })).rejects.toThrow(/校验未通过/)
    expect(existsSync(file)).toBe(false)
    await expect(writeWorkspaceSkillCard(slug, 'missing', { triggers: { keywords: ['词'] } })).rejects.toThrow(/Skill 不存在/)
    await expect(readWorkspaceSkillCard(slug, 'missing')).rejects.toThrow(/Skill 不存在/)
  })

  test('卡片保留未知字段，并把 frontmatter 里的名称/描述继续当作回退', async () => {
    const { slug } = setup()
    await writeWorkspaceSkillCard(slug, 'carded', { triggers: { keywords: ['柱状图'] } })
    // 手工往卡片里加一个未来字段，下一次保存不能把它冲掉。
    const file = cardFile(slug)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.futureField = { keep: true }
    writeFileSync(file, JSON.stringify(raw))

    const next = await writeWorkspaceSkillCard(slug, 'carded', { triggers: { keywords: ['折线图'] } })
    expect(next.manifest?.triggers?.keywords).toEqual(['折线图'])
    expect(JSON.parse(readFileSync(file, 'utf8')).futureField).toEqual({ keep: true })
  })

  test('旧 Skill 逐个提醒；拒绝只记当前 Skill，启停和刷新后保留，之后仍可主动创建', () => {
    const { slug } = setup()
    const reminder = () => getAllWorkspaceSkills(slug, true).find(skill => skill.slug === 'carded')!
    const old = reminder()
    const target = { scope: 'workspace' as const, workspaceSlug: slug, skillSlug: 'carded', workspaceSkillId: old.workspaceSkillId }
    expect(old.needsCardReminder).toBe(true)
    expect(() => resolveSkillCardReminder({ ...target, workspaceSkillId: 'stale' }, 'dismiss')).toThrow('Skill 已变更')
    resolveSkillCardReminder(target, 'dismiss')
    expect(existsSync(cardFile(slug))).toBe(false)
    expect(reminder().needsCardReminder).toBe(false)
    toggleWorkspaceSkill(slug, 'carded', false, '')
    expect(reminder()).toMatchObject({ enabled: false, needsCardReminder: false, workspaceSkillId: old.workspaceSkillId })
    toggleWorkspaceSkill(slug, 'carded', true, '')
    resolveSkillCardReminder(target, 'create')
    expect(JSON.parse(readFileSync(cardFile(slug), 'utf8'))).toEqual({ schemaVersion: 1 })
    expect(reminder().needsCardReminder).toBeFalsy()
  })

  test('副本独立询问；拒绝不会污染源，更新副本后保持原有选择', () => {
    const { slug } = setup()
    const copyWorkspace = `${slug}-copy`
    const copy = importSkillFromWorkspace(copyWorkspace, slug, 'carded')
    expect(getAllWorkspaceSkills(copyWorkspace, true).find(skill => skill.slug === 'carded')?.needsCardReminder).toBe(true)
    resolveSkillCardReminder({ scope: 'workspace', workspaceSlug: copyWorkspace, skillSlug: 'carded', workspaceSkillId: copy.importSource?.workspaceSkillId }, 'dismiss')
    updateSkillFromSource(copyWorkspace, 'carded')
    expect(getAllWorkspaceSkills(copyWorkspace, true).find(skill => skill.slug === 'carded')?.needsCardReminder).toBe(false)
    expect(getAllWorkspaceSkills(slug, true).find(skill => skill.slug === 'carded')?.needsCardReminder).toBe(true)
  })

  test('工作区副本自己创建的卡片在无卡源更新时保留，提升全局也保留依赖', async () => {
    const { slug } = setup()
    const copyWorkspace = `${slug}-copy`
    importSkillFromWorkspace(copyWorkspace, slug, 'carded')
    resolveSkillCardReminder({ scope: 'workspace', workspaceSlug: copyWorkspace, skillSlug: 'carded' }, 'create')
    await writeWorkspaceSkillCard(copyWorkspace, 'carded', { dependencies: { mcpServers: ['github'] } })
    updateSkillFromSource(copyWorkspace, 'carded')
    expect((await readWorkspaceSkillCard(copyWorkspace, 'carded')).manifest?.dependencies?.mcpServers).toEqual(['github'])
    expect(existsSync(cardFile(slug))).toBe(false)
    const promoted = promoteWorkspaceSkillToGlobal(copyWorkspace, 'carded', [])
    expect(readGlobalSkillCard(promoted.skillId).manifest?.dependencies?.mcpServers).toEqual(['github'])
  })

  test('确认补卡不会覆盖并发写入的已有卡片；损坏的卡片不作缺卡处理', () => {
    const { slug } = setup()
    const target = { scope: 'workspace' as const, workspaceSlug: slug, skillSlug: 'carded' }
    const card = '{坏文件内容'
    writeFileSync(cardFile(slug), card)
    expect(getAllWorkspaceSkills(slug, true).find(skill => skill.slug === 'carded')?.needsCardReminder).toBeFalsy()
    resolveSkillCardReminder(target, 'create')
    expect(readFileSync(cardFile(slug), 'utf8')).toBe(card)
  })

  test('全局新建默认带卡，导入单独 Markdown 等用户决定；内置源不能被提醒或直接修改', () => {
    setup()
    const created = createUserGlobalSkill('new-global', '全局新技能', '', '# 新技能')
    const declined = createUserGlobalSkill('declined-global', '先不建卡', '', '# 原文', { importMarkdown: true })
    const accepted = createUserGlobalSkill('accepted-global', '同意建卡', '', '# 原文', { importMarkdown: true })
    expect(readGlobalSkillCard(created.skillId).manifest).toEqual({ schemaVersion: 1 })
    expect(listGlobalSkills().filter(skill => skill.needsCardReminder).map(skill => skill.slug).sort()).toEqual(['accepted-global', 'declined-global'])
    resolveSkillCardReminder({ scope: 'global', skillId: declined.skillId }, 'dismiss')
    expect(readGlobalSkillCard(declined.skillId).present).toBe(false)
    expect(listGlobalSkills().filter(skill => skill.needsCardReminder).map(skill => skill.slug)).toEqual(['accepted-global'])
    resolveSkillCardReminder({ scope: 'global', skillId: accepted.skillId }, 'create')
    expect(readGlobalSkillCard(accepted.skillId).manifest).toEqual({ schemaVersion: 1 })
    expect(writeGlobalSkillCard(accepted.skillId, { dependencies: { mcpServers: ['github'] } }).manifest?.dependencies?.mcpServers).toEqual(['github'])
    const source = join(isolatedConfigRoot, 'builtin-fixture', 'locked')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), '---\nname: locked\n---\n')
    seedBuiltinGlobalSkills(dirname(source))
    expect(listGlobalSkills().find(skill => skill.slug === 'locked')?.needsCardReminder).toBeFalsy()
    expect(() => resolveSkillCardReminder({ scope: 'global', skillId: 'builtin-locked' }, 'create')).toThrow('只读')
  })

  test('没有 frontmatter 的正文不新增 YAML 错误诊断', async () => {
    const { slug } = setup()
    writeFileSync(join(dirname(cardFile(slug)), 'SKILL.md'), '# 普通正文\n')
    const state = await readWorkspaceSkillCard(slug, 'carded')
    expect(state.doctor.map(issue => issue.code)).not.toContain('frontmatter-invalid')
  })

  test('frontmatter 结构坏掉时报 frontmatter-invalid，而不是整条技能消失', async () => {
    const { slug } = setup()
    // YAML 结构错误：方括号没闭合。解析器是纯 ESM 包，只能经运行时动态 import 校验。
    writeFileSync(join(dirname(cardFile(slug)), 'SKILL.md'), '---\nname: 坏技能\ndescription: [未闭合\n---\n\n# 坏技能\n')

    const state = await readWorkspaceSkillCard(slug, 'carded')
    const invalid = state.doctor.find(issue => issue.code === 'frontmatter-invalid')
    expect(invalid?.severity).toBe('error')
    expect(invalid?.field).toBe('frontmatter')
  })
})
