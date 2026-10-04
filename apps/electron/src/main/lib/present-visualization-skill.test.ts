/**
 * `present-visualization` 内置 Skill 的路由契约。
 *
 * 用例直接读仓库里真实发布的 `default-skills/present-visualization/`（不是临时造的替身），
 * 这样模块清单、frontmatter、触发词与工具依赖任何一项写坏都会在这里失败。
 *
 * 设计意图：可视化工具本身常驻注册，但「什么时候用、怎么选形式、片段怎么写」只在任务相关时
 * 通过 skill_routing 注入；工具缺失（预设关了 preview 组或单工具）时 Skill 必须整体不可路由。
 * 1.4.0 起触发词与工具依赖由 SKILL.json 声明（模块自己声明依赖），侧车已删除。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEffectiveAgentPresetPolicy, type AgentPreset } from '@profer/shared'
import { createSkillRoutingSnapshot, routeSkillsForTask } from './skill-routing'
import { doctorSkill } from './skill-doctor'
import { readSkillVersion } from './skill-manifest'
import { PRESENT_VISUALIZATION_DESCRIPTION } from './agent-visualization-tools'

const SLUG = 'present-visualization'
const bundledSkillDir = new URL('../../../default-skills/present-visualization', import.meta.url).pathname
const VIZ_TOOL = 'mcp__visualization__present_visualization'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(overrides: Partial<AgentPreset> = {}, tools: string[] = [VIZ_TOOL]) {
  const root = mkdtempSync(join(tmpdir(), 'profer-viz-skill-'))
  roots.push(root)
  mkdirSync(join(root, 'skills'), { recursive: true })
  cpSync(bundledSkillDir, join(root, 'skills', SLUG), { recursive: true })
  const policy = createEffectiveAgentPresetPolicy(
    { id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, ...overrides },
    { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' },
    { runtimeSupportsSubagents: true, loadedMcpServerNames: [] },
  )
  return {
    root,
    policy,
    toolNames: tools,
    projection: {
      path: root,
      skills: [{ slug: SLUG, name: SLUG, path: join(root, 'skills', SLUG), version: '1.0.0', scope: 'workspace' as const, actualSource: 'workspace' as const }],
      diagnostics: [],
    },
  }
}

describe('present-visualization Skill：按需注入', () => {
  test('模块清单声明触发词、工具依赖与版本（侧车已迁走），医生无 error/warning', async () => {
    expect(existsSync(join(bundledSkillDir, 'SKILL.json'))).toBe(true)
    expect(existsSync(join(bundledSkillDir, 'profer-routing.json'))).toBe(false)
    // 版本取自模块卡片（与运行时的优先级一致），不要在测试里钉一个会过期的字面量。
    expect(readSkillVersion(bundledSkillDir)).toBe(JSON.parse(readFileSync(join(bundledSkillDir, 'SKILL.json'), 'utf8')).version)
    expect(readSkillVersion(bundledSkillDir)).toMatch(/^\d+\.\d+\.\d+$/)

    const snapshot = await createSkillRoutingSnapshot(fixture())
    const rules = snapshot.skills[0]?.rules
    expect(rules?.keywords).toContain('柱状图')
    expect(rules?.excludeKeywords).toContain('不要图表')
    expect(rules?.requiredTools).toEqual(['present_visualization'])
    expect(rules?.requiredToolGroups).toEqual(['preview'])

    const report = doctorSkill({ dir: bundledSkillDir, slug: SLUG, rules })
    expect(report.issues.filter(issue => issue.severity !== 'info')).toEqual([])
  })

  test('真实内置 Skill 可解析，关键字命中时注入正文', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture())
    expect(snapshot.skills[0]?.blocked).toBeUndefined()
    expect(snapshot.allowedSlugs).toEqual([SLUG])

    for (const message of ['把 1—6 月的收入成本做成柱状图', '画个流程图说明审批链路', 'visualize the monthly trend as a bar chart']) {
      const result = routeSkillsForTask(snapshot, { userMessage: message })
      expect(result.selected.map(item => item.slug)).toContain(SLUG)
      expect(result.selected.find(item => item.slug === SLUG)?.reason).toBe('configured-keyword')
      expect(result.prompt).toContain('先选最小合适形式')
    }
  })

  test('学生学习类意图触发，并把教学规范与公式规范一起注入', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture())
    for (const message of ['帮我讲解一下快速排序是怎么工作的', '模拟一下 TCP 三次握手的过程', '一步步推导一遍这个公式', 'walk me through how quicksort partitions the array']) {
      const result = routeSkillsForTask(snapshot, { userMessage: message })
      expect(result.selected.map(item => item.slug)).toContain(SLUG)
      expect(result.prompt).toContain('教学/讲解场景')
      expect(result.prompt).toContain('每步只变一个东西')
      expect(result.prompt).toContain('公式与数学符号')
    }
  })

  test('显式要 LaTeX 会触发；光提“公式”不会', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture())
    for (const message of ['把这段推导用 latex 写清楚', '把里面的数学公式整理成看得懂的样子']) {
      expect(routeSkillsForTask(snapshot, { userMessage: message }).selected.map(item => item.slug)).toContain(SLUG)
    }
    // “公式”本身太宽（Excel 公式、校验公式），不单独作为触发词
    for (const message of ['这个 Excel 公式怎么写', '校验公式里的正则是什么意思']) {
      expect(routeSkillsForTask(snapshot, { userMessage: message }).selected.map(item => item.slug)).not.toContain(SLUG)
    }
  })

  test('常驻工具描述带着片段公式写法，短到能常驻', () => {
    expect(PRESENT_VISUALIZATION_DESCRIPTION).toContain('\\(...\\)')
    expect(PRESENT_VISUALIZATION_DESCRIPTION).toContain('$...$ is not rendered')
    expect(Buffer.byteLength(PRESENT_VISUALIZATION_DESCRIPTION, 'utf8')).toBeLessThan(1600)
  })

  test('纯文字问答不因教学词误触发', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture())
    for (const message of ['解释一下这个报错是什么含义', '帮我看下这个测试为什么失败', '不要动画，直接给结论', '这个函数的签名是什么']) {
      const result = routeSkillsForTask(snapshot, { userMessage: message })
      expect(result.selected.map(item => item.slug)).not.toContain(SLUG)
    }
  })

  test('无关任务与显式排除不触发', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture())
    for (const message of ['帮我总结这份合同.pdf 的关键条款', '不要图表，用文字说明就够了', '你好']) {
      const result = routeSkillsForTask(snapshot, { userMessage: message })
      expect(result.selected.map(item => item.slug)).not.toContain(SLUG)
      expect(result.prompt).not.toContain('先选最小合适形式')
    }
  })

  test('可视化工具缺失或 preview 组被关闭时 Skill 不可路由', async () => {
    const noTool = await createSkillRoutingSnapshot(fixture({}, []))
    expect(noTool.allowedSlugs).not.toContain(SLUG)
    expect(noTool.skills[0]?.blocked).toBe('tool-unavailable')
    const explicit = routeSkillsForTask(noTool, { userMessage: '/skill:present-visualization 画个柱状图' })
    expect(explicit.prompt).toContain('tool-unavailable')
    expect(explicit.prompt).not.toContain('先选最小合适形式')

    const groupOff = await createSkillRoutingSnapshot(fixture({ disabledToolGroups: ['preview'] }, [VIZ_TOOL]))
    expect(groupOff.skills[0]?.blocked).toBe('tool-group-disabled')

    const toolOff = await createSkillRoutingSnapshot(fixture({ disabledTools: ['present_visualization'] }, [VIZ_TOOL]))
    expect(toolOff.skills[0]?.blocked).toBe('tool-unavailable')
  })

  test('显式引用与路由正文都不超过预算，正文只注入一次', async () => {
    const snapshot = await createSkillRoutingSnapshot(fixture())
    const result = routeSkillsForTask(snapshot, { userMessage: '/skill:present-visualization 把这组数据做成折线图' })
    expect(result.selected.find(item => item.slug === SLUG)?.reason).toBe('explicit')
    expect(result.prompt.match(/<skill name="present-visualization"/g)).toHaveLength(1)
    expect(result.prompt).toContain('data-profer-object-id')
  })
})
