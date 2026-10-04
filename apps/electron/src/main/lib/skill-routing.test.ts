import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEffectiveAgentPresetPolicy, type AgentPreset } from '@profer/shared'
import { buildSkillRoutingNotice, createSkillRoutingSnapshot, routeSkillsForTask, type SkillRoutingSnapshot } from './skill-routing'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(overrides: Partial<AgentPreset> = {}, tools: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'profer-skill-routing-'))
  roots.push(root)
  const skills = ['code-honor', 'pdf', 'automation', 'agent-collaboration', 'alpha', 'beta']
  for (const slug of skills) {
    mkdirSync(join(root, 'skills', slug), { recursive: true })
    writeFileSync(join(root, 'skills', slug, 'SKILL.md'), `---\nname: ${slug === 'alpha' || slug === 'beta' ? 'shared-name' : slug}\ndescription: Test ${slug}\n---\n\nBODY_${slug}\n`)
  }
  // 依赖由模块自己声明（新约定）：夹具也不再指望代码表里的内置依赖。
  writeFileSync(join(root, 'skills', 'automation', 'SKILL.json'), JSON.stringify({ schemaVersion: 1, dependencies: { toolGroups: ['automation'] } }))
  writeFileSync(join(root, 'skills', 'agent-collaboration', 'SKILL.json'), JSON.stringify({ schemaVersion: 1, dependencies: { toolGroups: ['collaboration'], tools: ['delegate_agent'] } }))
  const policy = createEffectiveAgentPresetPolicy({ id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, ...overrides }, { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' }, { runtimeSupportsSubagents: true, loadedMcpServerNames: ['automation', 'collaboration'] })
  return { root, policy, toolNames: tools, projection: { path: root, skills: skills.map(slug => ({ slug, name: slug, path: join(root, 'skills', slug), version: '1', scope: 'workspace' as const, actualSource: 'workspace' as const })), diagnostics: [] } }
}
async function snapshot(overrides: Partial<AgentPreset> = {}, tools: string[] = []): Promise<SkillRoutingSnapshot> {
  return createSkillRoutingSnapshot(fixture(overrides, tools))
}

describe('Skill 路由：权限先于相关性', () => {
  test('内置 Skill 没有 SKILL.json 时仍受产品最低依赖约束（旧副本、清空卡片）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-skill-floor-'))
    roots.push(root)
    const slugs = ['automation', 'in-app-browser', 'pptx', 'guizang-ppt-skill']
    for (const slug of slugs) {
      mkdirSync(join(root, 'skills', slug), { recursive: true })
      writeFileSync(join(root, 'skills', slug, 'SKILL.md'), `---\nname: ${slug}\ndescription: Test ${slug}\n---\n\nBODY_${slug}\n`)
    }
    const policy = createEffectiveAgentPresetPolicy({ id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, disabledToolGroups: ['automation', 'browser', 'ppt-materials'] }, { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' }, { runtimeSupportsSubagents: true, loadedMcpServerNames: [] })
    const result = await createSkillRoutingSnapshot({ policy, toolNames: [], projection: { path: root, skills: slugs.map(slug => ({ slug, name: slug, path: join(root, 'skills', slug), version: '1', scope: 'workspace' as const, actualSource: 'workspace' as const })), diagnostics: [] } })
    expect(result.allowedSlugs).toEqual([])
    expect(result.skills.map(skill => skill.blocked)).toEqual(['tool-group-disabled', 'tool-group-disabled', 'tool-group-disabled', 'tool-group-disabled'])
  })
  test('undefined 保留可用目录，[] 全禁；推荐不能扩权且不泄露正文', async () => {
    const unrestricted = await snapshot()
    expect(unrestricted.allowedSlugs).toContain('pdf')
    const closed = await snapshot({ skillSlugs: [] })
    const result = routeSkillsForTask(closed, { userMessage: '/skill:pdf 帮我合并 PDF 文件' })
    expect(closed.allowedSlugs).toEqual([])
    expect(result.recommended).toEqual([])
    expect(result.prompt).toContain('preset-denied')
    expect(result.prompt).not.toContain('BODY_pdf')
    expect(result.prompt).not.toContain('/skills/')
  })
  test('相同 name 不吞掉 slug，歧义别名不默认选择第一个', async () => {
    const all = await snapshot()
    expect(all.allowedSlugs).toEqual(expect.arrayContaining(['alpha', 'beta']))
    const result = routeSkillsForTask(all, { userMessage: '/skill:shared-name' })
    expect(result.diagnostics.some(d => d.code === 'ambiguous')).toBe(true)
    expect(result.prompt).not.toContain('BODY_')
    expect(routeSkillsForTask(all, { userMessage: '/skill:beta' }).prompt).toContain('BODY_beta')
  })
  test('显式数组与文本引用合并去重，不扫描历史或 quoted_context', async () => {
    const result = routeSkillsForTask(await snapshot(), { userMessage: '请处理 /skill:pdf\n<quoted_context>/skill:alpha</quoted_context>', mentionedSkills: ['pdf'] })
    expect(result.selected.map(s => s.slug)).toEqual(['pdf'])
    expect(result.prompt.match(/BODY_pdf/g)).toHaveLength(1)
  })
  test('不存在、未能读取都明确反馈，且不阻塞普通任务', async () => {
    const f = fixture()
    rmSync(join(f.root, 'skills', 'pdf', 'SKILL.md'))
    const s = await createSkillRoutingSnapshot(f)
    const result = routeSkillsForTask(s, { userMessage: '/skill:pdf /skill:missing' })
    expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['unreadable', 'not-found']))
  })
  test('禁用 automation 组即使 Skill 白名单命中也不进入目录或正文', async () => {
    const s = await snapshot({ disabledToolGroups: ['automation'], skillSlugs: ['automation'] }, ['mcp__automation__create_automation'])
    expect(s.allowedSlugs).toEqual([])
    const result = routeSkillsForTask(s, { userMessage: '/skill:automation 每天检查项目' })
    expect(result.prompt).toContain('tool-group-disabled')
    expect(result.prompt).not.toContain('BODY_automation')
  })
  test('单工具禁用、MCP 白名单与实际工具缺失同样裁剪', async () => {
    const f = fixture({ disabledTools: ['fetch_report'], mcpServerNames: [] }, ['mcp__reports__fetch_report'])
    writeFileSync(join(f.root, 'skills', 'pdf', 'profer-routing.json'), JSON.stringify({ requiredTools: ['mcp__reports__fetch_report'], requiredMcpServers: ['reports'] }))
    const s = await createSkillRoutingSnapshot(f)
    expect(s.allowedSlugs).not.toContain('pdf')
    const missing = fixture()
    writeFileSync(join(missing.root, 'skills', 'pdf', 'profer-routing.json'), JSON.stringify({ requiredTools: ['fetch_report'] }))
    expect((await createSkillRoutingSnapshot(missing)).allowedSlugs).not.toContain('pdf')
  })
  test('侧车关键字驱动自定义 Skill，反例不触发；allowed-tools 不是依赖', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'skills', 'alpha', 'profer-routing.json'), JSON.stringify({ keywords: ['季度核算'], excludeKeywords: ['不要核算'] }))
    writeFileSync(join(f.root, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: beta\nallowed-tools: MissingTool\n---\nBODY_beta')
    const s = await createSkillRoutingSnapshot(f)
    expect(s.allowedSlugs).toContain('beta')
    expect(routeSkillsForTask(s, { userMessage: '请做季度核算' }).recommended.map(s => s.slug)).toContain('alpha')
    expect(routeSkillsForTask(s, { userMessage: '季度核算是什么，不要核算' }).recommended).toEqual([])
  })
  test('disable-model-invocation 禁止自动推荐，但显式引用可展开', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: pdf\ndisable-model-invocation: true\n---\nBODY_pdf')
    const s = await createSkillRoutingSnapshot(f)
    expect(routeSkillsForTask(s, { userMessage: '合并这些 PDF 文件' }).recommended).toEqual([])
    expect(routeSkillsForTask(s, { userMessage: '/skill:pdf' }).prompt).toContain('BODY_pdf')
  })
  test('队列复用快照，后续磁盘编辑不能改变本轮正文与策略', async () => {
    const f = fixture({ skillSlugs: ['pdf'] })
    const s = await createSkillRoutingSnapshot(f)
    writeFileSync(join(f.root, 'skills', 'pdf', 'SKILL.md'), 'CHANGED')
    const result = routeSkillsForTask(s, { userMessage: '/skill:pdf /skill:alpha' })
    expect(result.prompt).toContain('BODY_pdf')
    expect(result.prompt).not.toContain('CHANGED')
    expect(result.prompt).not.toContain('BODY_alpha')
  })
  test('qualified 引用不能截断为另一个 slug，完整失败诊断', async () => {
    const s = await snapshot()
    const result = routeSkillsForTask(s, { userMessage: '/skill:alpha:daily' })
    expect(result.selected).toEqual([])
    expect(result.diagnostics).toContainEqual({ slug: 'alpha:daily', code: 'not-found' })
    expect(result.prompt).not.toContain('BODY_alpha')
  })
  test('引用后的中英文标点结束技能名，但 qualified 和路径不能截断为合法 slug', async () => {
    const s = await snapshot()
    for (const punctuation of ['，', '。', '；', '！', '？', '、', ',', ';', '!', '?', ')', ']', '”', '’']) {
      const result = routeSkillsForTask(s, { userMessage: `/skill:beta${punctuation}继续` })
      expect(result.selected.map(skill => skill.slug)).toEqual(['beta'])
      expect(result.diagnostics).toEqual([])
      expect(result.prompt).toContain('BODY_beta')
    }
    for (const invalid of ['beta:daily', 'beta/daily']) {
      const result = routeSkillsForTask(s, { userMessage: `/skill:${invalid}，继续` })
      expect(result.selected).toEqual([])
      expect(result.diagnostics).toContainEqual({ slug: invalid, code: 'not-found' })
      expect(result.prompt).not.toContain('BODY_beta')
    }
  })
  test('短工具名歧义关闭；明确 MCP 全名可通过', async () => {
    const f = fixture({}, ['mcp__a__fetch_report', 'mcp__b__fetch_report'])
    const config = join(f.root, 'skills', 'pdf', 'profer-routing.json')
    writeFileSync(config, JSON.stringify({ requiredTools: ['fetch_report'] }))
    expect((await createSkillRoutingSnapshot(f)).allowedSlugs).not.toContain('pdf')
    writeFileSync(config, JSON.stringify({ requiredTools: ['mcp__a__fetch_report'] }))
    expect((await createSkillRoutingSnapshot(f)).allowedSlugs).toContain('pdf')
  })
  test('聚合正文读取预算不足仍保留合法 catalog，仅延后正文', async () => {
    const s = await createSkillRoutingSnapshot({ ...fixture({ skillSlugs: ['pdf'] }), scanBodyBudgetBytes: 0 })
    expect(s.allowedSlugs).toContain('pdf')
    expect(s.skills.find(skill => skill.slug === 'pdf')?.body).toBe('')
    expect(s.skills.find(skill => skill.slug === 'pdf')?.bodyDeferred).toBe(true)
    const routed = routeSkillsForTask(s, { userMessage: '/skill:pdf' })
    expect(routed.prompt).toContain('budget-deferred')
    expect(routed.prompt).not.toContain('BODY_pdf')
  })
  test('正文超预算不截断半份规则，返回读取指引且保留可用目录', async () => {
    const s = await snapshot()
    const result = routeSkillsForTask(s, { userMessage: '/skill:pdf', maxBodyChars: 2 })
    expect(result.prompt).not.toContain('BODY_pdf')
    expect(result.prompt).toContain('budget-deferred')
    expect(result.prompt).toContain('SKILL.md')
    expect(s.allowedSlugs).toContain('pdf')
  })
})

describe('Skill 未加载的用户提示', () => {
  test('显式引用失败时给出人话原因；只是正文超预算或没有失败时不提示', async () => {
    const closed = await snapshot({ skillSlugs: [] })
    const denied = routeSkillsForTask(closed, { userMessage: '/skill:pdf /skill:nope 帮我处理' })
    expect(buildSkillRoutingNotice(denied)).toBe('Skill 未加载：pdf（当前预设未启用）；nope（没有找到这个 Skill）')
    expect(buildSkillRoutingNotice(routeSkillsForTask(await snapshot(), { userMessage: '/skill:pdf 合并 PDF' }))).toBeUndefined()
    expect(buildSkillRoutingNotice({ prompt: '', selected: [], recommended: [], hints: [], diagnostics: [{ slug: 'pdf', code: 'budget-deferred' }] })).toBeUndefined()
  })
})
