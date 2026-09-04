import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'

export type PptHeroVisual = 'real_image' | 'chart' | 'diagram' | 'data_typography'

export interface PptVisualPlanSlide {
  slideNumber: number
  slidePurpose: string
  heroVisual: PptHeroVisual
  materialQuery?: string
  fallbackReason?: string
}

export interface PptVisualPlan {
  deckIntent: string
  slides: PptVisualPlanSlide[]
}

export interface PptDeliveryAuditSlide {
  slideNumber: number
  imageCount: number
  chartCount: number
  shapeCount: number
  textCount: number
  heroVisual?: PptHeroVisual
  issues: string[]
}

export interface PptDeliveryAudit {
  filePath: string
  slideCount: number
  mediaCount: number
  chartCount: number
  embeddedCount: number
  needsRevision: boolean
  reasons: string[]
  slides: PptDeliveryAuditSlide[]
}

const HERO_VISUALS: PptHeroVisual[] = ['real_image', 'chart', 'diagram', 'data_typography']

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0
}

function getSlideEntries(zip: AdmZip): string[] {
  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
}

export function planPptVisuals(deckIntent: string, slides: Array<{ slideNumber?: number; title: string; purpose?: string }>): PptVisualPlan {
  if (!deckIntent.trim()) throw new Error('deckIntent 必填')
  if (slides.length === 0) throw new Error('至少需要一页大纲')

  return {
    deckIntent: deckIntent.trim(),
    slides: slides.map((slide, index) => {
      const purpose = (slide.purpose || slide.title).trim()
      const lower = purpose.toLowerCase()
      const heroVisual: PptHeroVisual = /趋势|增长|下降|比例|数据|指标|metric|trend|growth/.test(lower)
        ? 'chart'
        : /流程|路径|架构|机制|roadmap|process|architecture/.test(lower)
          ? 'diagram'
          : /案例|场景|客户|产品|工厂|团队|人物|地点|case|customer|product/.test(lower)
            ? 'real_image'
            : 'data_typography'
      return {
        slideNumber: slide.slideNumber ?? index + 1,
        slidePurpose: purpose,
        heroVisual,
        ...(heroVisual === 'real_image' ? { materialQuery: `${deckIntent} ${purpose}`.slice(0, 200) } : { fallbackReason: '本页以内容结构或量化信息作为主视觉，避免使用无关库存图。' }),
      }
    }),
  }
}

export function auditPptDelivery(filePath: string, visualPlan?: PptVisualPlan): PptDeliveryAudit {
  const resolved = resolve(filePath)
  if (extname(resolved).toLowerCase() !== '.pptx') throw new Error('仅支持审计 .pptx 文件')
  if (!existsSync(resolved)) throw new Error(`PPT 文件不存在: ${resolved}`)

  const zip = new AdmZip(resolved)
  const entries = zip.getEntries()
  const names = entries.map((entry) => entry.entryName)
  const mediaCount = names.filter((name) => /^ppt\/media\/[^/]+$/.test(name)).length
  const chartCount = names.filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)).length
  const embeddedCount = names.filter((name) => /^ppt\/embeddings\/[^/]+$/.test(name)).length
  const planBySlide = new Map(visualPlan?.slides.map((slide) => [slide.slideNumber, slide]) ?? [])
  const slides = getSlideEntries(zip).map((entryName, index) => {
    const xml = zip.readAsText(entryName)
    const slideNumber = index + 1
    const plan = planBySlide.get(slideNumber)
    const imageCount = countMatches(xml, /<a:blip\b/g)
    const slideChartCount = countMatches(xml, /<c:chart\b/g)
    const shapeCount = countMatches(xml, /<p:sp\b/g)
    const textCount = countMatches(xml, /<a:t>/g)
    const issues: string[] = []
    if (plan?.heroVisual === 'real_image' && imageCount === 0) issues.push('视觉计划要求真实图片，但该页未嵌入图片')
    if (plan?.heroVisual === 'chart' && slideChartCount === 0 && textCount < 3) issues.push('视觉计划要求图表，但该页未发现图表或足够的数据主视觉')
    if (imageCount === 0 && slideChartCount === 0 && shapeCount > 0 && textCount > 4) issues.push('该页主要由文本与几何形状构成，缺少可验证主视觉')
    return { slideNumber, imageCount, chartCount: slideChartCount, shapeCount, textCount, heroVisual: plan?.heroVisual, issues }
  })

  const reasons: string[] = []
  if (slides.length === 0) reasons.push('PPTX 中没有可审计的幻灯片')
  if (mediaCount === 0 && chartCount === 0) reasons.push('整套 PPT 没有嵌入图片或原生图表，属于模板化形状输出')
  if (visualPlan && visualPlan.slides.length !== slides.length) reasons.push('视觉计划页数与实际 PPT 页数不一致')
  for (const slide of slides) reasons.push(...slide.issues.map((issue) => `第 ${slide.slideNumber} 页：${issue}`))
  return { filePath: resolved, slideCount: slides.length, mediaCount, chartCount, embeddedCount, needsRevision: reasons.length > 0, reasons, slides }
}

export function assertPptDeliveryAccepted(audit: PptDeliveryAudit): void {
  if (audit.needsRevision) throw new Error(`PPT 未通过视觉交付验收：${audit.reasons.join('；')}`)
}
