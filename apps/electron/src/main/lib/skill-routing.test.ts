import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { prepareAgentSkillRouting } from './skill-runtime-routing'
import { DOMParser } from '@xmldom/xmldom'
import { join } from 'node:path'
import { createEffectiveAgentPresetPolicy, type AgentPreset } from '@profer/shared'
import { buildSkillCatalog, buildSkillRoutingNotice, createSkillRoutingSnapshot, routeSkillsForTask, type SkillRoutingSnapshot } from './skill-routing'

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
    const { snapshot: s } = await prepareAgentSkillRouting(f)
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
  test('快照只持有摘要与规则；正文在选中后读取，超预算返回引用', async () => {
    const s = await createSkillRoutingSnapshot(fixture({ skillSlugs: ['pdf'] }))
    expect(s.allowedSlugs).toContain('pdf')
    expect(s.skills.find(skill => skill.slug === 'pdf')?.description).toContain('Test pdf')
    expect(s.skills.find(skill => skill.slug === 'pdf')).not.toHaveProperty('body')
    expect(s.skills.find(skill => skill.slug === 'pdf')).not.toHaveProperty('bodyDeferred')
    const routed = routeSkillsForTask(s, { userMessage: '/skill:pdf', maxBodyChars: 2 })
    expect(routed.prompt).toContain('budget-deferred')
    expect(routed.prompt).not.toContain('BODY_pdf')
  })
  test('目录保留合法未选中项，隐藏禁用和禁止模型调用项；目录不读取正文', async () => {
    const f = fixture({ skillSlugs: ['pdf', 'alpha', 'beta'] })
    writeFileSync(join(f.root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: secret alpha\ndisable-model-invocation: true\n---\nBODY_alpha')
    const s = await createSkillRoutingSnapshot(f)
    // 已拿到摘要后删除正文文件，目录构建仍然不需要读取它。
    rmSync(join(f.root, 'skills', 'beta', 'SKILL.md'))
    const catalog = buildSkillCatalog(s)
    expect(catalog).toContain('name="pdf"')
    expect(catalog).toContain('name="beta"')
    expect(catalog).not.toContain('name="alpha"')
    expect(catalog).not.toContain('name="automation"')
    expect(catalog).not.toContain('BODY_')
  })
  test('共享长路径只声明一次，完整描述和特殊字符可以无损还原', async () => {
    const s = await createSkillRoutingSnapshot(fixture({ skillSlugs: ['pdf', 'beta'] }))
    const description = 'Use "quotes", apostrophe\'s, <xml> & 中文；完整触发说明。'.repeat(12)
    const skills = s.skills.filter(skill => !skill.blocked).map(skill => ({ ...skill, description }))
    const catalog = buildSkillCatalog({ ...s, skills })
    const document = new DOMParser().parseFromString(catalog, 'text/xml')
    const groups = document.getElementsByTagName('skill_root')
    expect(groups.length).toBe(1)
    expect(catalog.split(skills[0]!.rootPath)).toHaveLength(2)
    expect(catalog).not.toContain('&quot;quotes&quot;')
    for (const element of Array.from(document.getElementsByTagName('skill'))) {
      const skill = skills.find(item => item.slug === element.getAttribute('name'))!
      const root = element.parentNode as Element
      expect(join(root.getAttribute('path')!, element.getAttribute('location')!)).toBe(skill.filePath)
      expect(element.textContent).toBe(description)
    }
    expect(catalog).not.toContain('<xml>')
    const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    const oldEntries = skills.map(skill => `<skill name="${escapeXml(skill.slug)}" location="${escapeXml(skill.filePath)}">${escapeXml(description)}</skill>`).join('\n')
    expect(catalog.length).toBeLessThan(oldEntries.length)
  })
  test('多根目录各自还原，单项和不在根内的路径保留绝对位置，不扩权', async () => {
    const s = await createSkillRoutingSnapshot(fixture({ skillSlugs: ['pdf', 'beta'] }))
    const visible = s.skills.filter(skill => !skill.blocked)
    const otherRoot = '/very/long/path/to/another/authorized/skill/root'
    const skills = [
      ...visible,
      ...visible.map(skill => ({ ...skill, slug: `other-${skill.slug}`, rootPath: otherRoot, filePath: join(otherRoot, skill.slug, 'SKILL.md') })),
      { ...visible[0]!, slug: 'single', rootPath: '/single', filePath: '/single/one/SKILL.md' },
      { ...visible[0]!, slug: 'outside', rootPath: '/root', filePath: '/root-other/outside/SKILL.md' },
      { ...visible[1]!, slug: 'inside', rootPath: '/root', filePath: '/root/inside/SKILL.md' },
    ]
    const catalog = buildSkillCatalog({ skills, allowedSlugs: skills.map(skill => skill.slug) })
    const document = new DOMParser().parseFromString(catalog, 'text/xml')
    expect(document.getElementsByTagName('skill_root').length).toBe(2)
    for (const element of Array.from(document.getElementsByTagName('skill'))) {
      const skill = skills.find(item => item.slug === element.getAttribute('name'))!
      const parent = element.parentNode as Element
      const path = element.getAttribute('location')!
      expect(parent.tagName === 'skill_root' ? join(parent.getAttribute('path')!, path) : path).toBe(skill.filePath)
    }
    expect(buildSkillCatalog({ skills: [], allowedSlugs: [] })).toBe('')
  })
  test('实际文件读取：目录构建不读完整 SKILL.md，选中后只读该 Skill 正文', async () => {
    const f = fixture({ skillSlugs: ['pdf', 'beta'] })
    const read = spyOn(fs, 'readFileSync')
    const bodiesRead = () => read.mock.calls
      .map(([path]) => path)
      .filter((path): path is string => typeof path === 'string' && path.endsWith('SKILL.md'))
    try {
      const s = await createSkillRoutingSnapshot(f)
      buildSkillCatalog(s)
      expect(bodiesRead()).toEqual([])
      routeSkillsForTask(s, { userMessage: '/skill:pdf', maxRecommendations: 0 })
      expect(bodiesRead()).toEqual([fs.realpathSync(join(f.root, 'skills', 'pdf', 'SKILL.md'))])
    } finally {
      read.mockRestore()
    }
  })
  test('选中时正文已不可读给出诊断，普通任务不被阻断', async () => {
    const f = fixture({ skillSlugs: ['pdf'] })
    const s = await createSkillRoutingSnapshot(f)
    rmSync(join(f.root, 'skills', 'pdf', 'SKILL.md'))
    const result = routeSkillsForTask(s, { userMessage: '/skill:pdf' })
    expect(result.diagnostics).toContainEqual({ slug: 'pdf', code: 'unreadable' })
    expect(result.prompt).not.toContain('BODY_pdf')
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
