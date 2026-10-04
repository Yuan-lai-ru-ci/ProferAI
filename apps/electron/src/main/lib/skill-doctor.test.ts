/**
 * Skill 医生（doctor）的契约。
 *
 * 医生是「可展示的诊断」，不是加载门禁：坏清单要 error 级诊断但仍然可被读取路径回退；
 * 描述写得不好、依赖当前不可用只算 warning/info，绝不能让用户自带技能加载不了。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEffectiveAgentPresetPolicy, type AgentPreset } from '@profer/shared'
import { diagnoseSkill, diagnoseSkillRoot, doctorSkill, formatSkillDoctorReport, SKILL_BODY_WARN_BYTES, type SkillDoctorCode } from './skill-doctor'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const DESCRIPTION = '会话内可视化手册：用户要图表、流程图或可调参的解释时用；不要用 markdown 表格替代。'

function makeSkill(name: string, options: { description?: string; manifest?: unknown | string; body?: string; version?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-skill-doctor-'))
  roots.push(root)
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const description = options.description ?? DESCRIPTION
  const version = options.version ? `version: ${options.version}\n` : ''
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${version}---\n${options.body ?? '正文'}\n`)
  if (options.manifest !== undefined) writeFileSync(join(dir, 'SKILL.json'), typeof options.manifest === 'string' ? options.manifest : JSON.stringify(options.manifest))
  return dir
}

function codes(dir: string, options: Parameters<typeof diagnoseSkill>[0] extends infer _ ? Partial<Parameters<typeof diagnoseSkill>[0]> : never = {}): SkillDoctorCode[] {
  return diagnoseSkill({ dir, ...options }).map(issue => issue.code)
}

const policy = (overrides: Partial<AgentPreset> = {}) => createEffectiveAgentPresetPolicy(
  { id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, ...overrides },
  { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' },
  { runtimeSupportsSubagents: true, loadedMcpServerNames: [] },
)

describe('Skill 医生：清单与元数据', () => {
  test('清单齐全、场景描述与依赖都写好时没有 error / warning', () => {
    const dir = makeSkill('demo', {
      manifest: {
        schemaVersion: 1,
        version: '1.0.0',
        triggers: { keywords: ['柱状图', '流程图'] },
        dependencies: { toolGroups: ['preview'], tools: ['present_visualization'] },
        requires: { hostClasses: ['.table', '.viz-badge'] },
      },
    })
    const report = doctorSkill({ dir, slug: 'demo' })
    expect(report.counts).toEqual({ error: 0, warning: 0, info: 1 })
    // 词表只有路由代码读得到，模型读不到：医生要提醒把词也写进描述。
    expect(report.issues.map(issue => issue.code)).toEqual(['triggers-in-manifest'])
  })

  test('缺清单只报 info；坏清单报 error 但描述仍能回退 frontmatter', () => {
    expect(codes(makeSkill('demo'))).toContain('manifest-missing')
    const broken = codes(makeSkill('demo', { manifest: '{ 坏清单' }))
    expect(broken).toContain('manifest-invalid')
    expect(broken).not.toContain('description-missing')
  })

  test('清单与 frontmatter / 目录名不一致分别报出', () => {
    const withVersion = makeSkill('demo', { version: '1.0.0', manifest: { schemaVersion: 1, name: '另一个名字', version: '2.0.0' } })
    const both = codes(withVersion)
    expect(both.filter(code => code === 'manifest-frontmatter-mismatch')).toHaveLength(2)

    const slugOnly = makeSkill('demo', { version: '1.0.0', manifest: { schemaVersion: 1, name: 'demo', version: '1.0.0', slug: 'other' } })
    expect(codes(slugOnly).filter(code => code.startsWith('manifest-'))).toEqual(['manifest-slug-mismatch'])
  })

  test('清单与侧车同时声明路由字段时提示重复来源', () => {
    const withTriggers = makeSkill('demo', { manifest: { schemaVersion: 1, triggers: { keywords: ['柱状图'] } } })
    expect(codes(withTriggers, { sidecar: { keywords: ['图表'] } })).toContain('routing-duplicated')
    const manifestOnly = makeSkill('demo', { manifest: { schemaVersion: 1, triggers: { keywords: ['柱状图'] } } })
    expect(codes(manifestOnly, { sidecar: { requiredTools: ['x'] } })).not.toContain('routing-duplicated')
  })
})

describe('Skill 医生：描述与触发词质量', () => {
  test('描述缺失是 error；太短或没有使用场景是 warning', () => {
    const noDescription = makeSkill('demo', { description: '' })
    expect(codes(noDescription)).toContain('description-missing')

    const short = makeSkill('demo', { description: '画图的' })
    expect(codes(short)).toContain('description-too-short')

    const noMarker = makeSkill('demo', { description: '这是一个非常详细的会话内可视化能力说明文档，包含了很多细节。' })
    expect(codes(noMarker)).toContain('description-no-usage-marker')
  })

  test('描述里没有使用场景就提醒，哪怕卡片里写了词表', () => {
    const dir = makeSkill('demo', { description: '这是一个非常详细的会话内可视化能力说明文档，包含了很多细节。', manifest: { schemaVersion: 1, triggers: { keywords: ['柱状图'] } } })
    const found = codes(dir)
    expect(found).toContain('description-no-usage-marker')
    expect(found).toContain('triggers-in-manifest')
  })

  test('没有触发词只提示 info；触发词全部包含在描述里提示无额外信息', () => {
    const noKeywords = makeSkill('demo', { manifest: { schemaVersion: 1 } })
    expect(codes(noKeywords)).toContain('keywords-missing')

    const redundant = makeSkill('demo', { manifest: { schemaVersion: 1, triggers: { keywords: ['图表', '流程图'] } } })
    expect(codes(redundant)).toContain('keywords-redundant')

    const implicitOff = makeSkill('demo', { manifest: { schemaVersion: 1, policy: { implicit: false } } })
    expect(codes(implicitOff)).not.toContain('keywords-missing')
  })
})

describe('Skill 医生：依赖与宿主契约', () => {
  test('依赖的工具当前不可用 / 能力组被关闭时报出', () => {
    const dir = makeSkill('demo', { manifest: { schemaVersion: 1, dependencies: { tools: ['present_visualization'], toolGroups: ['preview'] } } })
    expect(codes(dir, { toolNames: [] })).toContain('dependency-tool-unavailable')
    expect(codes(dir, { toolNames: ['mcp__visualization__present_visualization'] })).not.toContain('dependency-tool-unavailable')
    expect(codes(dir, { policy: policy({ disabledToolGroups: ['preview'] }) })).toContain('dependency-group-disabled')
  })

  test('宿主语义类不存在时提示；存在的类不提示', () => {
    const ok = makeSkill('demo', { manifest: { schemaVersion: 1, requires: { hostClasses: ['.table', '[data-profer-columns]'] } } })
    expect(codes(ok)).not.toContain('host-class-missing')
    const missing = makeSkill('demo', { manifest: { schemaVersion: 1, requires: { hostClasses: ['.不存在的类'] } } })
    expect(codes(missing)).toContain('host-class-missing')
  })

  test('正文超过建议体积时提示拆分', () => {
    const dir = makeSkill('demo', { body: 'x'.repeat(SKILL_BODY_WARN_BYTES + 1) })
    expect(codes(dir)).toContain('body-oversize')
  })
})

describe('Skill 医生：目录级报告', () => {
  test('扫描根目录、跳过非 Skill 目录并汇总', () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-skill-doctor-root-'))
    roots.push(root)
    makeSkillIn(root, 'alpha', { keywords: ['柱状图'] })
    makeSkillIn(root, 'beta', {})
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })
    writeFileSync(join(root, 'README.md'), 'x')

    const reports = diagnoseSkillRoot(root)
    expect(reports.map(report => report.slug)).toEqual(['alpha', 'beta'])
    const text = formatSkillDoctorReport(reports)
    expect(text).toContain('alpha：')
    expect(text).toContain('共 2 个 Skill')

    function makeSkillIn(parent: string, name: string, options: { keywords?: string[] }): void {
      const dir = join(parent, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 用于${name}场景的说明文字。\n---\n正文\n`)
      if (options.keywords) writeFileSync(join(dir, 'SKILL.json'), JSON.stringify({ schemaVersion: 1, triggers: { keywords: options.keywords } }))
    }
  })
})
