/**
 * 关键词 + 字符 n-gram 两级路由的契约。
 *
 * 第一级（关键词 / 确定性信号）负责精度，第二级（字符 n-gram）负责召回，只在第一级
 * 一条都没命中时介入，并且必须过最短消息、最少命中 gram 数、领先第二名三倍多之外的闸。
 * 这些用例锁的就是"不要因为想更聪明而把噪声放进来"。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEffectiveAgentPresetPolicy } from '@profer/shared'
import { scoreSkillsLexically, selectLexicalFallback } from './skill-lexical-match'
import { createSkillRoutingSnapshot, routeSkillsForTask } from './skill-routing'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const LARK = { slug: 'lark-delivery', name: 'lark-delivery', description: '把长报告、方案、会议纪要与表格写入飞书文档或多维表格，并可以安排日程。' }
const THEME = { slug: 'theme-authoring', name: 'theme-authoring', description: '制作与调校 Profer 皮肤包：调色、tokens、明暗主题、标题栏配色与预览图。' }

function skillFixture(entries: readonly { slug: string; description: string; routing?: Record<string, unknown> }[]) {
  const root = mkdtempSync(join(tmpdir(), 'profer-skill-lexical-'))
  roots.push(root)
  for (const entry of entries) {
    mkdirSync(join(root, 'skills', entry.slug), { recursive: true })
    writeFileSync(join(root, 'skills', entry.slug, 'SKILL.md'), `---\nname: ${entry.slug}\ndescription: ${entry.description}\n---\n\nBODY_${entry.slug}\n`)
    if (entry.routing) writeFileSync(join(root, 'skills', entry.slug, 'profer-routing.json'), JSON.stringify(entry.routing))
  }
  const policy = createEffectiveAgentPresetPolicy(
    { id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 },
    { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' },
    { runtimeSupportsSubagents: true, loadedMcpServerNames: [] },
  )
  return createSkillRoutingSnapshot({
    projection: {
      path: root,
      skills: entries.map(entry => ({ slug: entry.slug, name: entry.slug, path: join(root, 'skills', entry.slug), version: '1', scope: 'workspace' as const, actualSource: 'workspace' as const })),
      diagnostics: [],
    },
    policy,
    toolNames: [],
  })
}

describe('字符 n-gram 召回层（纯函数）', () => {
  test('用词高度重叠时报出对应 Skill，分数与命中 gram 数可解释', () => {
    const matches = scoreSkillsLexically('帮我把这份会议纪要写进飞书的多维表格里', [LARK, THEME])
    expect(matches.map(match => match.slug)).toEqual(['lark-delivery'])
    expect(matches[0]!.matchedGrams).toBeGreaterThanOrEqual(3)
    expect(matches[0]!.score).toBeGreaterThan(6)
  })

  test('太短、无重叠、或两家打平时都不猜', () => {
    expect(scoreSkillsLexically('改一下', [LARK, THEME])).toEqual([])
    expect(scoreSkillsLexically('帮我把这段排序算法讲清楚', [LARK, THEME])).toEqual([])
    expect(selectLexicalFallback('把内容写进文档里并安排一下日程', [LARK, { ...LARK, slug: 'docx', name: 'docx' }])).toBeUndefined()
  })

  test('英文按 3-gram 起算，名字命中权重更高', () => {
    const english = { slug: 'present-visualization', name: 'present-visualization', description: 'Inline interactive explanations in the conversation.' }
    const other = { slug: 'pptx', name: 'pptx', description: 'Build a slide deck from an outline.' }
    const matches = scoreSkillsLexically('please add an inline visualization of this flow', [english, other])
    expect(matches[0]?.slug).toBe('present-visualization')
    expect(matches[0]!.score).toBeGreaterThan(matches[1]?.score ?? 0)
  })
})

describe('两级结合：关键词优先，n-gram 只兜底', () => {
  test('关键词命中时不跑兜底，也不会多带一个 Skill', async () => {
    const snapshot = await skillFixture([
      { slug: 'lark-delivery', description: LARK.description, routing: { keywords: ['飞书'] } },
      { slug: 'theme-authoring', description: THEME.description },
    ])
    const result = routeSkillsForTask(snapshot, { userMessage: '把这份会议纪要写进飞书的多维表格里' })
    expect(result.selected.map(item => `${item.slug}:${item.reason}`)).toEqual(['lark-delivery:configured-keyword'])
  })

  test('关键词零命中时按用词重叠兜底一次，并写明理由', async () => {
    const snapshot = await skillFixture([
      { slug: 'lark-delivery', description: LARK.description },
      { slug: 'theme-authoring', description: THEME.description },
    ])
    const result = routeSkillsForTask(snapshot, { userMessage: '帮我把这份会议纪要写进飞书的多维表格里' })
    expect(result.selected.map(item => `${item.slug}:${item.reason}`)).toEqual(['lark-delivery:lexical-fallback'])
    expect(result.prompt).toContain('BODY_lark-delivery')
    expect(result.prompt).toContain('lark-delivery: lexical-fallback')
  })

  test('与用户意图无关时保持沉默', async () => {
    const snapshot = await skillFixture([
      { slug: 'lark-delivery', description: LARK.description },
      { slug: 'theme-authoring', description: THEME.description },
    ])
    const result = routeSkillsForTask(snapshot, { userMessage: '帮我把这段快速排序的代码改成迭代写法' })
    expect(result.selected).toEqual([])
    expect(result.prompt).toBe('')
  })

  test('显式引用过 Skill 后不再补兜底', async () => {
    const snapshot = await skillFixture([{ slug: 'lark-delivery', description: LARK.description }])
    const result = routeSkillsForTask(snapshot, { userMessage: '/skill:lark-delivery 帮我把这份会议纪要写进飞书的多维表格里' })
    expect(result.selected.map(item => `${item.slug}:${item.reason}`)).toEqual(['lark-delivery:explicit'])
  })

  test('implicit:false 的 Skill 既不参与关键词也不参与兜底，只能显式引用', async () => {
    const snapshot = await skillFixture([
      { slug: 'lark-delivery', description: LARK.description, routing: { implicit: false, keywords: ['飞书'] } },
    ])
    expect(routeSkillsForTask(snapshot, { userMessage: '把这份会议纪要写进飞书的多维表格里' }).selected).toEqual([])
    expect(routeSkillsForTask(snapshot, { userMessage: '/skill:lark-delivery 写进飞书' }).selected.map(item => `${item.slug}:${item.reason}`)).toEqual(['lark-delivery:explicit'])
  })

  test('预设拒绝的 Skill 不会经由兜底被召回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-skill-lexical-denied-'))
    roots.push(root)
    mkdirSync(join(root, 'skills', LARK.slug), { recursive: true })
    writeFileSync(join(root, 'skills', LARK.slug, 'SKILL.md'), `---\nname: ${LARK.slug}\ndescription: ${LARK.description}\n---\n\nBODY_${LARK.slug}\n`)
    const policy = createEffectiveAgentPresetPolicy(
      { id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, skillSlugs: [] },
      { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' },
      { runtimeSupportsSubagents: true, loadedMcpServerNames: [] },
    )
    const snapshot = await createSkillRoutingSnapshot({
      projection: { path: root, skills: [{ slug: LARK.slug, name: LARK.slug, path: join(root, 'skills', LARK.slug), version: '1', scope: 'workspace' as const, actualSource: 'workspace' as const }], diagnostics: [] },
      policy,
      toolNames: [],
    })
    const result = routeSkillsForTask(snapshot, { userMessage: '帮我把这份会议纪要写进飞书的多维表格里' })
    expect(result.selected).toEqual([])
    expect(result.prompt).toBe('')
  })
})
