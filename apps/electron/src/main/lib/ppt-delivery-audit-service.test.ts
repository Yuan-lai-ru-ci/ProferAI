import AdmZip from 'adm-zip'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { auditPptDelivery, planPptVisuals } from './ppt-delivery-audit-service'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createDeck(slides: string[], extras: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'profer-ppt-audit-'))
  dirs.push(dir)
  const zip = new AdmZip()
  slides.forEach((slide, index) => zip.addFile(`ppt/slides/slide${index + 1}.xml`, Buffer.from(slide)))
  for (const [name, body] of Object.entries(extras)) zip.addFile(name, Buffer.from(body))
  const path = join(dir, 'deck.pptx')
  zip.writeZip(path)
  return path
}

describe('ppt delivery audit', () => {
  test('Given a shapes-only deck When audited Then it requires revision', () => {
    const path = createDeck(['<p:sld><p:sp/><a:t>标题</a:t><a:t>正文</a:t><a:t>更多正文</a:t><a:t>说明</a:t><a:t>结论</a:t></p:sld>'])
    const audit = auditPptDelivery(path)
    expect(audit).toMatchObject({ slideCount: 1, mediaCount: 0, chartCount: 0, needsRevision: true })
    expect(audit.reasons.join(' ')).toContain('没有嵌入图片或原生图表')
  })

  test('Given a visual plan requiring a real image When the slide has no image Then it requires revision', () => {
    const path = createDeck(['<p:sld><p:sp/><a:t>案例</a:t></p:sld>'])
    const plan = { deckIntent: '客户案例', slides: [{ slideNumber: 1, slidePurpose: '客户案例', heroVisual: 'real_image' as const, materialQuery: 'customer team' }] }
    const audit = auditPptDelivery(path, plan)
    expect(audit.needsRevision).toBe(true)
    expect(audit.reasons.join(' ')).toContain('要求真实图片')
  })

  test('Given an image-bearing deck with a diagram plan When audited Then it passes the asset gate', () => {
    const path = createDeck(['<p:sld><p:pic><a:blip r:embed="rId1"/></p:pic><p:sp/><a:t>架构</a:t></p:sld>'], { 'ppt/media/image1.jpg': 'image' })
    const plan = { deckIntent: '系统架构', slides: [{ slideNumber: 1, slidePurpose: '系统架构', heroVisual: 'diagram' as const, fallbackReason: '图解为主视觉' }] }
    const audit = auditPptDelivery(path, plan)
    expect(audit).toMatchObject({ mediaCount: 1, needsRevision: false })
  })

  test('Given a deck outline When planned Then every slide receives a hero visual', () => {
    const plan = planPptVisuals('AI Agent 管理层简报', [{ title: '增长趋势' }, { title: '系统架构' }, { title: '客户案例' }])
    expect(plan.slides.map((slide) => slide.heroVisual)).toEqual(['chart', 'diagram', 'real_image'])
    expect(plan.slides.at(2)?.materialQuery).toContain('客户案例')
  })
})
