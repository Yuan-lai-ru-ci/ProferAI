/**
 * 模块清单（SKILL.json）参与路由的契约。
 *
 * 这里钉死「清单是模块自己声明的真相」：触发词、依赖、implicit 都能只靠清单生效，
 * 旧侧车只是迁移期回退；清单坏掉时不能把 Skill 变不可用，而要退回 frontmatter + 侧车。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEffectiveAgentPresetPolicy, type AgentPreset } from '@profer/shared'
import { createSkillRoutingSnapshot, routeSkillsForTask } from './skill-routing'

const SLUG = 'demo-visual'
const TOOL = 'mcp__visualization__present_visualization'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(options: {
  manifest?: unknown | string
  sidecar?: unknown
  frontmatter?: string
  preset?: Partial<AgentPreset>
  tools?: string[]
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'profer-skill-manifest-routing-'))
  roots.push(root)
  const dir = join(root, 'skills', SLUG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), options.frontmatter ?? '---\nname: 演示可视化\ndescription: 用于把数据画成图表的演示技能。\n---\n正文契约 BODY_CONTRACT\n')
  if (options.manifest !== undefined) writeFileSync(join(dir, 'SKILL.json'), typeof options.manifest === 'string' ? options.manifest : JSON.stringify(options.manifest))
  if (options.sidecar !== undefined) writeFileSync(join(dir, 'profer-routing.json'), JSON.stringify(options.sidecar))
  const policy = createEffectiveAgentPresetPolicy(
    { id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, ...options.preset },
    { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' },
    { runtimeSupportsSubagents: true, loadedMcpServerNames: [] },
  )
  return {
    policy,
    toolNames: options.tools ?? [TOOL],
    projection: {
      path: root,
      skills: [{ slug: SLUG, name: SLUG, path: dir, version: '1.0.0', scope: 'workspace' as const, actualSource: 'workspace' as const }],
      diagnostics: [],
    },
  }
}

describe('模块清单驱动的路由', () => {
  test('只有清单也能按触发词路由并注入正文', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture({ manifest: { schemaVersion: 1, triggers: { keywords: ['季度核算'] } } }))
    expect(snapshot.skills[0]?.blocked).toBeUndefined()
    expect(snapshot.skills[0]?.rules.keywords).toEqual(['季度核算'])

    const hit = routeSkillsForTask(snapshot, { userMessage: '帮我做一张季度核算的图' })
    expect(hit.selected).toEqual([{ slug: SLUG, reason: 'configured-keyword' }])
    expect(hit.prompt).toContain('BODY_CONTRACT')

    expect(routeSkillsForTask(snapshot, { userMessage: '帮我看看这段代码' }).selected).toEqual([])
  })

  test('清单里的 toolGroups / tools 依赖与代码兜底一样能拦住不可用 Skill', async () => {
    const manifest = { schemaVersion: 1, dependencies: { toolGroups: ['preview'], tools: ['present_visualization'] } }
    const noTool = await createSkillRoutingSnapshot(fixture({ manifest, tools: [] }))
    expect(noTool.skills[0]?.blocked).toBe('tool-unavailable')
    expect(noTool.allowedSlugs).toEqual([])

    const groupOff = await createSkillRoutingSnapshot(fixture({ manifest, preset: { disabledToolGroups: ['preview'] } }))
    expect(groupOff.skills[0]?.blocked).toBe('tool-group-disabled')

    const ok = await createSkillRoutingSnapshot(fixture({ manifest }))
    expect(ok.skills[0]?.blocked).toBeUndefined()
  })

  test('policy.implicit=false 只接受显式引用（与侧车 implicit 同义）', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture({ manifest: { schemaVersion: 1, policy: { implicit: false }, triggers: { keywords: ['季度核算'] } } }))
    expect(routeSkillsForTask(snapshot, { userMessage: '帮我做一张季度核算的图' }).selected).toEqual([])

    const explicit = routeSkillsForTask(snapshot, { userMessage: `/skill:${SLUG} 做一张图` })
    expect(explicit.selected).toEqual([{ slug: SLUG, reason: 'explicit' }])
    expect(explicit.prompt).toContain('BODY_CONTRACT')
  })

  test('清单逐字段优先于侧车：触发词以清单为准，未声明的字段继续用侧车', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture({
      manifest: { schemaVersion: 1, triggers: { keywords: ['季度核算'] } },
      sidecar: { keywords: ['只听侧车的词'], excludeKeywords: ['不要核算'] },
    }))
    expect(snapshot.skills[0]?.rules.keywords).toEqual(['季度核算'])
    expect(snapshot.skills[0]?.rules.excludeKeywords).toEqual(['不要核算'])
    expect(routeSkillsForTask(snapshot, { userMessage: '来一张季度核算的图' }).selected.map(item => item.slug)).toEqual([SLUG])
    // 侧车独有的触发词在清单声明自己的词表后不再生效（清单是权威），排除词仍生效。
    expect(routeSkillsForTask(snapshot, { userMessage: '来一张只听侧车的词的图' }).selected).toEqual([])
    expect(routeSkillsForTask(snapshot, { userMessage: '来一张季度核算的图，不要核算' }).selected).toEqual([])
  })

  test('清单损坏时退回 frontmatter + 侧车，Skill 不会被清单问题挡掉', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture({ manifest: '{ 坏清单', sidecar: { keywords: ['季度核算'] } }))
    expect(snapshot.skills[0]?.blocked).toBeUndefined()
    expect(snapshot.skills[0]?.description).toBe('用于把数据画成图表的演示技能。')
    expect(routeSkillsForTask(snapshot, { userMessage: '来一张季度核算的图' }).selected.map(item => item.slug)).toEqual([SLUG])
  })

  test('清单的短描述成为路由描述文本（回退 frontmatter 描述）', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture({
      manifest: { schemaVersion: 1, interface: { shortDescription: '清单短描述' } },
    }))
    expect(snapshot.skills[0]?.description).toBe('清单短描述')
    expect(snapshot.skills[0]?.name).toBe('演示可视化')
  })
})
