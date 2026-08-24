import { afterEach, describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeckSourceLineage, DeckSpec } from '@profer/shared'
import { auditPptOoxml } from './ppt-oo-xml-audit'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function minimalSpec(role: 'chart' | 'image_with_annotation' = 'chart'): DeckSpec {
  return {
    schemaVersion: 1,
    deckId: 'audit-deck',
    title: 'Audit deck',
    styleId: 'academic-editorial',
    slides: [{
      slideId: 'result-01',
      claim: '误差下降 37%',
      evidenceRefs: ['src-1#result.md#L1-L4'],
      visualRole: role,
      layoutIntent: role === 'chart' ? 'chart-large-with-caption' : 'image-caption-margin',
      densityBudget: 'medium',
      editableObjects: role === 'chart' ? ['text', 'chart', 'citation'] : ['text', 'image', 'citation'],
      content: { headline: '37%' },
      speakerNotes: ['解释实验结果'],
      citations: ['result.md，L1-L4'],
    }],
    sourceHashes: { 'src-1': 'a'.repeat(64) },
  }
}

function minimalLineage(status: 'current' | 'conflicted' = 'current', hash = 'a'.repeat(64)): DeckSourceLineage {
  return {
    schemaVersion: 1,
    sources: [{
      id: 'src-1', absolutePath: 'C:/fixture/result.md', relativePath: 'result.md', kind: 'text',
      size: 10, mtimeMs: 10, contentHash: hash, status, locator: 'result.md#L1-L4',
    }],
  }
}

interface DeckFixtureOptions {
  objectName?: string
  picture?: { target: string; x?: number; y?: number; cx?: number; cy?: number }
  chart?: boolean
  shapeBounds?: { x: number; y: number; cx: number; cy: number }
  notes?: string
}

function createDeck(options: DeckFixtureOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-ooxml-audit-'))
  roots.push(root)
  const zip = new AdmZip()
  zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:a="a"><p:sldSz cx="12191695" cy="6858000"/></p:presentation>'))
  const parts: string[] = []
  if (options.shapeBounds) {
    const b = options.shapeBounds
    parts.push(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="${options.objectName ?? 'Text 1'}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.cx}" cy="${b.cy}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>误差下降 37%</a:t></a:r></a:p></p:txBody></p:sp>`)
  }
  if (options.picture) {
    const p = options.picture
    parts.push(`<p:pic><p:nvPicPr><p:cNvPr id="3" name="${options.objectName ?? 'Picture 1'}" descr="fixture image"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1" xmlns:r="r"/></p:blipFill><p:spPr><a:xfrm><a:off x="${p.x ?? 0}" y="${p.y ?? 0}"/><a:ext cx="${p.cx ?? 12191695}" cy="${p.cy ?? 6858000}"/></a:xfrm></p:spPr></p:pic>`)
    zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(`<Relationships><Relationship Id="rId1" Target="../media/${p.target}"/></Relationships>`))
    zip.addFile(`ppt/media/${p.target}`, Buffer.from('image'))
  }
  if (options.chart) {
    parts.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="audit-deck/result-01/native-chart" descr="native chart"/></p:nvGraphicFramePr><p:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="5000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData><c:chart xmlns:c="c" r:id="rId2" xmlns:r="r"/></a:graphicData></a:graphic></p:graphicFrame>`)
    zip.addFile('ppt/charts/chart1.xml', Buffer.from('<c:chartSpace xmlns:c="c"/>'))
  }
  zip.addFile('ppt/slides/slide1.xml', Buffer.from(`<p:sld xmlns:p="p" xmlns:a="a" xmlns:c="c"><p:cSld><p:spTree>${parts.join('')}</p:spTree></p:cSld></p:sld>`))
  if (options.notes) zip.addFile('ppt/notesSlides/notesSlide1.xml', Buffer.from(`<p:notes xmlns:p="p" xmlns:a="a"><a:t>${options.notes}</a:t></p:notes>`))
  const path = join(root, 'fixture.pptx')
  zip.writeZip(path)
  return path
}

describe('ppt ooxml audit', () => {
  test('报告越界、语义名缺失、图表图片替代、Notes 缺失和来源 hash 冲突', () => {
    const path = createDeck({
      objectName: 'Picture 1',
      picture: { target: 'chart.png' },
      shapeBounds: { x: 12_000_000, y: 6_000_000, cx: 2_000_000, cy: 1_000_000 },
    })
    const audit = auditPptOoxml(path, {
      deckSpec: minimalSpec('chart'),
      sourceLineage: minimalLineage('conflicted', 'b'.repeat(64)),
    })
    const codes = audit.issues.map((issue) => issue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'SLIDE_BOUNDS_OVERFLOW',
      'SEMANTIC_NAME_MISSING',
      'NATIVE_CHART_MISSING',
      'NOTES_MISSING',
      'SOURCE_HASH_MISMATCH',
      'NON_CURRENT_SOURCE',
      'FULL_SLIDE_RASTERIZED_CONTENT',
      'EDITABILITY_COVERAGE_LOW',
    ]))
    expect(audit.needsRevision).toBe(true)
  })

  test('Cloud Dancer 满页 preview 图片是 P0，不能作为内容背景', () => {
    const spec = { ...minimalSpec('image_with_annotation'), styleId: 'profer-cloud-dancer' }
    const path = createDeck({
      objectName: 'audit-deck/result-01/hero-image',
      picture: { target: 'preview.webp' },
      notes: '完整引用：result.md；讲述要点：解释结果；建议时长：2 分钟；潜在追问：样本量？',
    })
    const audit = auditPptOoxml(path, { deckSpec: spec, sourceLineage: minimalLineage() })
    expect(audit.issues).toContainEqual(expect.objectContaining({ code: 'CLOUD_DANCER_PREVIEW_BACKGROUND', severity: 'P0' }))
  })

  test('合法图片页有语义名、非满页裁切和完整 Notes 时，不误报不可编辑内容', () => {
    const spec = minimalSpec('image_with_annotation')
    const path = createDeck({
      objectName: 'audit-deck/result-01/hero-image',
      picture: { target: 'experiment.png', x: 1_000_000, y: 1_300_000, cx: 5_000_000, cy: 3_000_000 },
      shapeBounds: { x: 6_400_000, y: 1_300_000, cx: 3_500_000, cy: 2_000_000 },
      notes: '完整引用：result.md，L1-L4；讲述要点：解释实验结果；建议时长：2 分钟；潜在追问：样本量？',
    })
    const audit = auditPptOoxml(path, { deckSpec: spec, sourceLineage: minimalLineage() })
    expect(audit.issues.map((issue) => issue.code)).not.toContain('FULL_SLIDE_RASTERIZED_CONTENT')
    expect(audit.issues.map((issue) => issue.code)).not.toContain('EDITABILITY_COVERAGE_LOW')
  })
})
