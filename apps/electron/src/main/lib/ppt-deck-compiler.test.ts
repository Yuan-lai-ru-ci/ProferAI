import { afterEach, describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeckBrief, DeckSourceLineage, DeckSpec } from '@profer/shared'
import { createDeckProject, getDeckBriefConfirmationToken, recordDeckBriefConfirmation, writeDeckSourceLineage, writeDeckSpec } from './ppt-deck-project-service'
import { compileDeckProject } from './ppt-deck-compiler'
import { auditPptOoxml } from './ppt-oo-xml-audit'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-ppt-compiler-'))
  roots.push(root)
  return root
}

function makeBrief(styleId: 'academic-editorial' | 'profer-cloud-dancer' = 'academic-editorial'): DeckBrief {
  return {
    schemaVersion: 1,
    deckId: 'compiler-proof',
    goal: '展示双阶段方法的实验结果',
    audience: '课题组同学',
    occasion: '每周组会',
    durationMinutes: 12,
    slideCount: 5,
    coreClaims: ['双阶段方法降低误差'],
    includedSourceIds: ['src-current'],
    styleId,
    citationPolicy: 'inline_short_notes_full_references',
    speakerNotesPolicy: 'talking_points_transitions_timing_questions',
    state: 'awaiting_confirmation',
  }
}

function makeLineage(status: 'current' | 'superseded' | 'historical' | 'conflicted' | 'unknown' = 'current'): DeckSourceLineage {
  return {
    schemaVersion: 1,
    sources: [{
      id: 'src-current',
      absolutePath: 'C:/fixture/result.md',
      relativePath: 'result.md',
      kind: 'text',
      size: 100,
      mtimeMs: 100,
      contentHash: 'a'.repeat(64),
      status,
      locator: 'result.md#L1-L4',
      title: '实验结果',
      excerpt: '误差下降 37%',
    }],
    conflicts: status === 'conflicted' ? ['same-date conflict'] : [],
    gaps: [],
  }
}

function makeSpec(styleId: 'academic-editorial' | 'profer-cloud-dancer' = 'academic-editorial'): DeckSpec {
  return {
    schemaVersion: 1,
    deckId: 'compiler-proof',
    title: '双阶段方法实验结果',
    styleId,
    slides: [
      {
        slideId: 'title-01', claim: '双阶段方法降低误差', evidenceRefs: ['src-current#result.md#L1-L4'], visualRole: 'title', layoutIntent: 'title-left-air', densityBudget: 'low', editableObjects: ['text', 'shape'], content: { headline: '双阶段方法', subhead: '实验结果与误差分析' }, speakerNotes: ['先说明研究问题', '转场：接着看方法机制', '建议时长：1 分钟', '潜在追问：样本量是多少？'], citations: ['result.md，L1-L4'],
      },
      {
        slideId: 'mechanism-02', claim: '双阶段路径减少检索噪声', evidenceRefs: ['src-current#result.md#L1-L4'], visualRole: 'mechanism_diagram', layoutIntent: 'diagram-open-grid', densityBudget: 'medium', editableObjects: ['text', 'shape', 'connector'], content: { steps: ['粗检索', '候选筛选', '精检索'] }, speakerNotes: ['解释三个步骤', '转场：机制如何影响结果', '建议时长：2 分钟', '潜在追问：筛选阈值如何确定？'], citations: ['result.md，L1-L4'],
      },
      {
        slideId: 'chart-03', claim: '误差下降 37%', evidenceRefs: ['src-current#result.md#L1-L4'], visualRole: 'chart', layoutIntent: 'chart-large-with-caption', densityBudget: 'medium', editableObjects: ['text', 'chart', 'citation'], content: { labels: ['基线', '阶段一', '阶段二'], values: [100, 78, 63], unit: '%', annotation: '误差下降 37%' }, speakerNotes: ['先读图中趋势', '再解释阶段二的贡献', '转场：最后总结限制', '建议时长：3 分钟', '潜在追问：是否有统计显著性？'], citations: ['result.md，L1-L4'],
      },
      {
        slideId: 'comparison-04', claim: '双阶段方法优于单阶段基线', evidenceRefs: ['src-current#result.md#L1-L4'], visualRole: 'comparison', layoutIntent: 'comparison-rule-columns', densityBudget: 'medium', editableObjects: ['text', 'table', 'citation'], content: { headers: ['方案', '误差', '特点'], rows: [['基线', '100%', '单阶段'], ['双阶段', '63%', '噪声更低']] }, speakerNotes: ['比较两种方案', '说明误差与机制对应关系', '建议时长：2 分钟', '潜在追问：比较是否公平？'], citations: ['result.md，L1-L4'],
      },
      {
        slideId: 'conclusion-05', claim: '方法有效但仍需扩大样本验证', evidenceRefs: ['src-current#result.md#L1-L4'], visualRole: 'conclusion', layoutIntent: 'conclusion-number', densityBudget: 'low', editableObjects: ['text', 'shape', 'citation'], content: { headline: '37%', label: '误差下降', conclusion: '下一步扩大样本并验证泛化性' }, speakerNotes: ['重申核心结论', '说明局限与下一步', '建议时长：1 分钟', '潜在追问：下一轮实验何时完成？'], citations: ['result.md，L1-L4'],
      },
    ],
    sourceHashes: { 'src-current': 'a'.repeat(64) },
  }
}

async function prepareProject(styleId: 'academic-editorial' | 'profer-cloud-dancer' = 'academic-editorial', status: 'current' | 'superseded' | 'historical' | 'conflicted' | 'unknown' = 'current') {
  const root = makeRoot()
  const project = await createDeckProject({ agentCwd: root, brief: makeBrief(styleId) })
  await writeDeckSourceLineage(project.projectDir, makeLineage(status))
  await writeDeckSpec(project.projectDir, makeSpec(styleId))
  const token = await getDeckBriefConfirmationToken(project.projectDir)
  await recordDeckBriefConfirmation({ projectDir: project.projectDir, confirmationToken: token, requestId: 'compiler-test-confirm' })
  return { root, project }
}

describe('ppt deck compiler', () => {
  test('生成可解压的 16:9 原生 PPTX、对象语义名和 Speaker Notes', async () => {
    const { project } = await prepareProject()
    const result = await compileDeckProject(project.projectDir)

    expect(result.outputPath).toMatch(/\.pptx$/)
    expect(existsSync(result.outputPath)).toBe(true)
    expect(result.slideCount).toBe(5)
    expect(result.recompiledSlideIds).toEqual(['title-01', 'mechanism-02', 'chart-03', 'comparison-04', 'conclusion-05'])

    const zip = new AdmZip(result.outputPath)
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).toContain('ppt/presentation.xml')
    expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(5)
    expect(names.some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(true)
    expect(names.some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))).toBe(true)

    const allSlides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => zip.readAsText(name)).join('\n')
    expect(allSlides).toContain('compiler-proof/title-01')
    expect(allSlides).toContain('compiler-proof/chart-03')
    expect(allSlides).toContain('compiler-proof/comparison-04/native-table')
    expect(allSlides).toContain('<a:tbl>')
    expect(allSlides).toContain('triangle')
    expect(allSlides).toContain('误差下降 37%')

    const presentationXml = zip.readAsText('ppt/presentation.xml')
    const sizeMatch = presentationXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
    expect(sizeMatch).not.toBeNull()
    expect(Number(sizeMatch?.[1]) / 914400).toBeCloseTo(13.333, 2)
    expect(Number(sizeMatch?.[2]) / 914400).toBeCloseTo(7.5, 2)

    const notes = names.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).map((name) => zip.readAsText(name)).join('\n')
    expect(notes).toContain('result.md')
    expect(notes).toContain('建议时长')
    expect(notes).toContain('潜在追问')

    const structuralAudit = auditPptOoxml(result.outputPath, {
      deckSpec: makeSpec(),
      sourceLineage: makeLineage(),
    })
    expect(structuralAudit.slideCount).toBe(5)
    expect(structuralAudit.slideWidth).toBeCloseTo(13.333, 2)
    expect(structuralAudit.slideHeight).toBeCloseTo(7.5, 2)
    expect(structuralAudit.editabilityCoverage).toBeGreaterThan(0.9)
    expect(structuralAudit.issues.filter((issue) => issue.severity === 'P0')).toEqual([])
  })

  test('Cloud Dancer 使用原生几何母题，不把 preview.webp 铺成内容背景', async () => {
    const { project } = await prepareProject('profer-cloud-dancer')
    const result = await compileDeckProject(project.projectDir)
    const zip = new AdmZip(result.outputPath)
    const slideXml = zip.getEntries().filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).map((entry) => zip.readAsText(entry.entryName)).join('\n')
    expect(slideXml).toContain('cloud')
    expect(slideXml).toContain('crescent')
    expect(zip.getEntries().map((entry) => entry.entryName).some((name) => /ppt\/media\/.*preview/i.test(name))).toBe(false)
  })

  test.each(['superseded', 'historical', 'conflicted', 'unknown'] as const)('拒绝非 current 来源作为当前结论证据：%s', async (status) => {
    const { project } = await prepareProject('academic-editorial', status)
    await expect(compileDeckProject(project.projectDir)).rejects.toThrow(/来源|current|conflict|unknown/i)
  })
})
