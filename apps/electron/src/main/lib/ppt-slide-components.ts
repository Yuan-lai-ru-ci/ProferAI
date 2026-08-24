import type { DeckSlideSpec, DeckVisualRole } from '@profer/shared'
import type PptxGenJS from 'pptxgenjs'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { PptStylePackDefinition } from './ppt-style-pack-service'
import type { PptLayoutPlan, PptRect } from './ppt-layout-engine'

export interface SlideComponentContext {
  pptx: PptxGenJS
  slide: PptxGenJS.Slide
  deckId: string
  projectDir: string
  spec: DeckSlideSpec
  pack: PptStylePackDefinition
  plan: PptLayoutPlan
}

type ShapeName = string

function noHash(value: string): string {
  return value.replace(/^#/, '')
}

function color(pack: PptStylePackDefinition, name: string, fallback: string): string {
  return noHash(pack.tokens.colors[name] ?? fallback)
}

function objectName(ctx: SlideComponentContext, objectId: string): string {
  return `${ctx.deckId}/${ctx.spec.slideId}/${objectId}`
}

function isInside(root: string, target: string): boolean {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const rootKey = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath
  const targetKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
  return targetKey === rootKey || targetKey.startsWith(rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`)
}

function resolveEvidenceImage(ctx: SlideComponentContext): string | undefined {
  const assetRef = ctx.spec.assetRefs?.[0] ?? (typeof ctx.spec.content.assetRef === 'string' ? ctx.spec.content.assetRef : undefined)
  if (!assetRef || assetRef.trim().length === 0) return undefined
  const assetRoot = resolve(ctx.projectDir, 'assets')
  const target = resolve(assetRoot, assetRef)
  if (!isInside(assetRoot, target) || !existsSync(target)) throw new Error(`页面 ${ctx.spec.slideId} 的 assetRef 越界或不存在: ${assetRef}`)
  return target
}

function readImageSize(path: string): { width: number; height: number } | undefined {
  const data = readFileSync(path)
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue }
      const marker = data[offset + 1]
      if (marker === undefined || marker === 0xd8 || marker === 0xd9) { offset += 2; continue }
      const length = data.readUInt16BE(offset + 2)
      if (length < 2 || offset + length + 2 > data.length) break
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) }
      }
      offset += length + 2
    }
  }
  return undefined
}

function containImage(size: { width: number; height: number } | undefined, rect: PptRect): PptRect {
  if (!size || size.width <= 0 || size.height <= 0) return rect
  const scale = Math.min(rect.w / size.width, rect.h / size.height)
  const w = size.width * scale
  const h = size.height * scale
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h }
}

function addText(ctx: SlideComponentContext, text: string, options: PptxGenJS.TextPropsOptions & { objectName?: string }): void {
  ctx.slide.addText(text, {
    margin: 0,
    fontFace: ctx.pack.tokens.typography.fontFallback[0] ?? 'Aptos',
    color: color(ctx.pack, 'ink', '#17191C'),
    breakLine: false,
    fit: 'shrink',
    ...options,
  })
}

function addShape(ctx: SlideComponentContext, shape: ShapeName, options: PptxGenJS.ShapeProps & { objectName?: string }): void {
  ctx.slide.addShape(shape as PptxGenJS.ShapeType, options)
}

function addFooter(ctx: SlideComponentContext): void {
  const footer = ctx.plan.footer
  // Scientific Editorial uses one quiet baseline only; never draw a free-floating diagonal motif.
  ctx.slide.addShape(ctx.pptx.ShapeType.line, {
    x: footer.x, y: footer.y, w: footer.w, h: 0,
    line: { color: color(ctx.pack, 'rule', '#B7B4AE'), width: 0.6 },
    objectName: objectName(ctx, 'footer-rule'),
  })
  addText(ctx, `${ctx.spec.slideId}`, {
    x: footer.x, y: footer.y + 0.05, w: footer.w, h: 0.12,
    fontSize: ctx.pack.tokens.typography.pageNumberPt,
    color: color(ctx.pack, 'mutedInk', '#5D6268'),
    align: 'right',
    objectName: objectName(ctx, 'page-number'),
  })
}

const SCIENTIFIC_ROLE_LABELS: Record<DeckVisualRole, string> = {
  title: '研究主题',
  section: '研究结构',
  assertion_evidence: '结果与证据',
  chart: '量化结果',
  mechanism_diagram: '方法与机制',
  comparison: '比较分析',
  image_with_annotation: '原图证据',
  limitations: '适用边界',
  conclusion: '结论',
  references: '参考文献',
}

function addHeader(ctx: SlideComponentContext): void {
  // Cover/section slides render their own editorial title block; repeating the claim above it
  // produces the exact duplicate-title rhythm seen in the legacy student deck.
  if (ctx.spec.visualRole === 'title' || ctx.spec.visualRole === 'section') return
  const header = ctx.plan.header
  addText(ctx, ctx.spec.claim, {
    x: header.x, y: header.y, w: header.w * 0.76, h: header.h,
    fontSize: ctx.pack.tokens.typography.titlePt,
    bold: true,
    valign: 'middle',
    objectName: objectName(ctx, 'claim'),
  })
  addText(ctx, SCIENTIFIC_ROLE_LABELS[ctx.spec.visualRole], {
    x: header.x + header.w * 0.78, y: header.y + 0.1, w: header.w * 0.22, h: 0.2,
    fontSize: ctx.pack.tokens.typography.captionPt,
    color: color(ctx.pack, 'clay', color(ctx.pack, 'accent', '#A20D18')),
    align: 'right',
    charSpacing: 1.5,
    objectName: objectName(ctx, 'role-label'),
  })
}

function addCoverKicker(ctx: SlideComponentContext): void {
  const label = typeof ctx.spec.content.kicker === 'string'
    ? ctx.spec.content.kicker
    : ctx.spec.visualRole === 'section' ? '研究结构 / 证据链' : '科研汇报 / 结果与适用边界'
  addText(ctx, label, {
    x: ctx.plan.content.x, y: ctx.plan.content.y - 0.38, w: 5.6, h: 0.22,
    fontSize: ctx.pack.tokens.typography.captionPt,
    bold: true,
    color: color(ctx.pack, 'accent', '#A20D18'),
    objectName: objectName(ctx, 'scientific-kicker'),
  })
}

function addAcademicAccent(ctx: SlideComponentContext, y: number): void {
  addShape(ctx, 'rect', {
    x: ctx.plan.slide.x, y, w: 0.18, h: 0.18,
    fill: { color: color(ctx.pack, 'accent', '#A20D18') }, line: { color: color(ctx.pack, 'accent', '#A20D18'), transparency: 100 },
    objectName: objectName(ctx, `accent-${y.toFixed(2)}`),
  })
}

function addCloudMotifs(ctx: SlideComponentContext, role: DeckVisualRole): void {
  const motifs = ctx.pack.id === 'profer-cloud-dancer'
  if (!motifs) return
  const base = color(ctx.pack, 'cloud', '#EAE8E1')
  const shadow = color(ctx.pack, 'shadow', '#D8D5CE')
  if (role === 'title' || role === 'section' || role === 'conclusion') {
    addShape(ctx, 'cloud', { x: 10.55, y: 0.65, w: 1.25, h: 0.52, fill: { color: base }, line: { color: base, transparency: 100 }, objectName: objectName(ctx, 'cloud-top') })
    addShape(ctx, 'cloud', { x: 11.35, y: 1.02, w: 0.72, h: 0.34, fill: { color: shadow, transparency: 15 }, line: { color: shadow, transparency: 100 }, objectName: objectName(ctx, 'cloud-shadow') })
  } else {
    addShape(ctx, 'cloud', { x: 11.4, y: 6.05, w: 0.74, h: 0.32, fill: { color: base, transparency: 20 }, line: { color: base, transparency: 100 }, objectName: objectName(ctx, 'cloud-local') })
  }
}

function addCrescent(ctx: SlideComponentContext): void {
  if (ctx.pack.id !== 'profer-cloud-dancer') return
  const clay = color(ctx.pack, 'clay', '#846557')
  addShape(ctx, 'moon', { x: 10.7, y: 2.0, w: 0.8, h: 0.8, fill: { color: clay, transparency: 12 }, line: { color: clay, transparency: 100 }, objectName: objectName(ctx, 'crescent') })
  addShape(ctx, 'arc', { x: 10.83, y: 2.0, w: 0.62, h: 0.8, line: { color: color(ctx.pack, 'canvas', '#F0EFEC'), width: 6 }, fill: { color: color(ctx.pack, 'canvas', '#F0EFEC'), transparency: 100 }, objectName: objectName(ctx, 'crescent-cutout') })
}

function renderTitle(ctx: SlideComponentContext): void {
  const content = ctx.plan.content
  addCoverKicker(ctx)
  addAcademicAccent(ctx, 1.44)
  addText(ctx, String(ctx.spec.content.headline ?? ctx.spec.claim), {
    x: content.x, y: content.y, w: content.w, h: 1.6,
    fontSize: 38, bold: true, breakLine: false,
    objectName: objectName(ctx, 'headline'),
  })
  addText(ctx, String(ctx.spec.content.subhead ?? '方法、结果、验证与适用边界'), {
    x: content.x, y: content.y + 1.82, w: content.w * 0.7, h: 0.48,
    fontSize: ctx.pack.tokens.typography.sectionPt,
    color: color(ctx.pack, 'mutedInk', '#5D6268'),
    objectName: objectName(ctx, 'subhead'),
  })
  if (ctx.pack.id === 'profer-cloud-dancer') {
    addShape(ctx, 'arc', { x: 9.65, y: 2.05, w: 1.55, h: 2.5, rotate: 16, line: { color: color(ctx.pack, 'clay', '#846557'), width: 2.2, transparency: 12 }, fill: { color: color(ctx.pack, 'canvas', '#F0EFEC'), transparency: 100 }, objectName: objectName(ctx, 'dancer-motion') })
    addShape(ctx, 'ellipse', { x: 10.2, y: 1.68, w: 0.35, h: 0.35, fill: { color: color(ctx.pack, 'clay', '#846557'), transparency: 10 }, line: { color: color(ctx.pack, 'clay', '#846557'), transparency: 100 }, objectName: objectName(ctx, 'dancer-head') })
  }
}

function renderAssertion(ctx: SlideComponentContext): void {
  const content = ctx.plan.content
  const observation = String(ctx.spec.content.observation ?? ctx.spec.content.body ?? ctx.spec.claim)
  const interpretation = typeof ctx.spec.content.interpretation === 'string' ? ctx.spec.content.interpretation : ''
  const boundary = typeof ctx.spec.content.boundary === 'string' ? ctx.spec.content.boundary : ''
  addShape(ctx, 'rect', { x: content.x, y: content.y, w: 0.17, h: 0.17, fill: { color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')) }, line: { color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')), transparency: 100 }, objectName: objectName(ctx, 'evidence-marker') })
  addText(ctx, String(ctx.spec.content.headline ?? ctx.spec.claim), { x: content.x + 0.32, y: content.y - 0.03, w: content.w - 0.32, h: 0.8, fontSize: 27, bold: true, objectName: objectName(ctx, 'headline') })
  addText(ctx, '观察结果', { x: content.x, y: content.y + 1.12, w: 1.2, h: 0.22, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'accent', '#A20D18'), objectName: objectName(ctx, 'observation-label') })
  addText(ctx, observation, { x: content.x, y: content.y + 1.42, w: content.w - 0.18, h: 0.82, fontSize: ctx.pack.tokens.typography.bodyPt, color: color(ctx.pack, 'ink', '#17191C'), breakLine: true, objectName: objectName(ctx, 'observation') })
  if (interpretation) {
    addText(ctx, '解释', { x: content.x, y: content.y + 2.52, w: 1.2, h: 0.22, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'interpretation-label') })
    addText(ctx, interpretation, { x: content.x, y: content.y + 2.82, w: content.w - 0.18, h: 0.8, fontSize: ctx.pack.tokens.typography.bodyPt, color: color(ctx.pack, 'mutedInk', '#5D6268'), breakLine: true, objectName: objectName(ctx, 'interpretation') })
  }
  addShape(ctx, 'line', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 0.1, w: 0, h: ctx.plan.sidebar.h - 0.32, line: { color: color(ctx.pack, 'rule', '#B7B4AE'), width: 0.8 }, objectName: objectName(ctx, 'split-rule') })
  addText(ctx, '证据与边界', { x: ctx.plan.sidebar.x + 0.22, y: ctx.plan.sidebar.y + 0.18, w: ctx.plan.sidebar.w - 0.22, h: 0.25, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'accent', '#A20D18'), objectName: objectName(ctx, 'evidence-label') })
  addText(ctx, ctx.spec.citations[0] ?? '来源定位见 Speaker Notes', { x: ctx.plan.sidebar.x + 0.22, y: ctx.plan.sidebar.y + 0.58, w: ctx.plan.sidebar.w - 0.22, h: 0.7, fontSize: ctx.pack.tokens.typography.captionPt, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'citation-short') })
  if (boundary) addText(ctx, boundary, { x: ctx.plan.sidebar.x + 0.22, y: ctx.plan.sidebar.y + 1.6, w: ctx.plan.sidebar.w - 0.22, h: 1.35, fontSize: ctx.pack.tokens.typography.bodyPt - 1, color: color(ctx.pack, 'ink', '#17191C'), breakLine: true, objectName: objectName(ctx, 'boundary') })
}

function niceAxis(values: number[]): { min: number; max: number; major: number } {
  const positiveMax = Math.max(...values.map((value) => Math.abs(value)), 1)
  const roughStep = positiveMax * 1.15 / 5
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const normalized = roughStep / magnitude
  const stepFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  const major = stepFactor * magnitude
  return { min: 0, max: Math.ceil(positiveMax * 1.15 / major) * major, major }
}

function renderChart(ctx: SlideComponentContext): void {
  const content = ctx.plan.content
  // 绝不使用默认数字填充图表。缺数据时仍生成可预览的“待补数据”页面，
  // 让 Agent 能继续工作；交付审计会把它标记为 P0，阻止误称为最终成品。
  const rawLabels = Array.isArray(ctx.spec.content.labels) ? ctx.spec.content.labels : []
  const rawValues = Array.isArray(ctx.spec.content.values) ? ctx.spec.content.values : []
  const labels = rawLabels.filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
  const values = rawValues.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (labels.length === 0 || values.length === 0 || labels.length !== values.length) {
    addShape(ctx, 'roundRect', {
      x: content.x, y: content.y + 0.5, w: content.w, h: 2.6,
      fill: { color: color(ctx.pack, 'panel', '#F6F5F2') },
      line: { color: color(ctx.pack, 'rule', '#B7B4AE'), width: 0.8 },
      objectName: objectName(ctx, 'missing-data-panel'),
    })
    addText(ctx, '待补充真实数据', {
      x: content.x + 0.35, y: content.y + 1.05, w: content.w - 0.7, h: 0.5,
      fontSize: 24, bold: true, align: 'center',
      color: color(ctx.pack, 'mutedInk', '#5D6268'),
      objectName: objectName(ctx, 'missing-data-title'),
    })
    addText(ctx, '当前页面未生成图表，避免用占位数字替代实验结果。', {
      x: content.x + 0.35, y: content.y + 1.72, w: content.w - 0.7, h: 0.35,
      fontSize: ctx.pack.tokens.typography.bodyPt, align: 'center',
      color: color(ctx.pack, 'mutedInk', '#5D6268'),
      objectName: objectName(ctx, 'missing-data-explanation'),
    })
    return
  }
  const automaticAxis = niceAxis(values)
  const axisMin = typeof ctx.spec.content.axisMin === 'number' ? ctx.spec.content.axisMin : automaticAxis.min
  const axisMax = typeof ctx.spec.content.axisMax === 'number' ? ctx.spec.content.axisMax : automaticAxis.max
  const axisMajor = typeof ctx.spec.content.axisMajorUnit === 'number' ? ctx.spec.content.axisMajorUnit : automaticAxis.major
  const chartType = ctx.spec.content.chartType === 'line' ? ctx.pptx.ChartType.line : ctx.pptx.ChartType.bar
  ctx.slide.addChart(chartType, [{ name: '结果', labels, values }], {
    x: content.x, y: content.y, w: content.w, h: content.h - 0.38,
    catAxisLabelFontFace: ctx.pack.tokens.typography.fontFallback[0] ?? 'Aptos',
    catAxisLabelFontSize: ctx.pack.chartLanguage.labelPt,
    valAxisLabelFontSize: ctx.pack.chartLanguage.labelPt,
    valAxisMinVal: axisMin,
    valAxisMaxVal: axisMax,
    valAxisMajorUnit: axisMajor,
    barDir: 'col',
    showLegend: false,
    showTitle: false,
    showValue: true,
    chartColors: ctx.pack.chartLanguage.seriesColors.map(noHash),
    showValAxisTitle: false,
    showCatAxisTitle: false,
    objectName: objectName(ctx, 'native-chart'),
    altText: `${ctx.spec.claim}，原生可编辑柱状图`,
  })
  addText(ctx, String(ctx.spec.content.annotation ?? ctx.spec.claim), { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y, w: ctx.plan.sidebar.w, h: 0.85, fontSize: 25, bold: true, color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')), objectName: objectName(ctx, 'annotation') })
  addText(ctx, String(ctx.spec.content.metricDefinition ?? '统计口径见来源与 Speaker Notes'), { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 1.05, w: ctx.plan.sidebar.w, h: 1.0, fontSize: ctx.pack.tokens.typography.bodyPt - 1, color: color(ctx.pack, 'ink', '#17191C'), breakLine: true, objectName: objectName(ctx, 'metric-definition') })
  addText(ctx, ctx.spec.citations[0] ?? '来源定位见 Speaker Notes', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 2.35, w: ctx.plan.sidebar.w, h: 0.65, fontSize: ctx.pack.tokens.typography.captionPt, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'citation-short') })
}

function renderImageEvidence(ctx: SlideComponentContext): void {
  const imagePath = resolveEvidenceImage(ctx)
  const frame = { ...ctx.plan.content, y: ctx.plan.content.y + 0.12, h: ctx.plan.content.h - 0.62 }
  if (imagePath) {
    const imageRect = containImage(readImageSize(imagePath), frame)
    ctx.slide.addImage({
      path: imagePath,
      ...imageRect,
      objectName: objectName(ctx, 'evidence-image'),
      altText: String(ctx.spec.content.altText ?? `${ctx.spec.claim}，来源见图注与 Speaker Notes`),
    })
  } else {
    // Draft may be compiled before assets are available. Keep the slide editable and visibly mark the slot.
    ctx.slide.addShape('rect', { ...frame, fill: { color: 'E8E5DE', transparency: 10 }, line: { color: 'B8B1A5' }, objectName: objectName(ctx, 'evidence-image-placeholder') })
    addText(ctx, '待补充图片素材', { x: frame.x, y: frame.y + frame.h / 2 - 0.2, w: frame.w, h: 0.4, align: 'center', color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'evidence-image-placeholder-label') })
  }
  addText(ctx, String(ctx.spec.content.figureCaption ?? ctx.spec.citations[0] ?? '论文原图，完整来源见 Speaker Notes'), {
    x: ctx.plan.content.x, y: ctx.plan.content.y + ctx.plan.content.h - 0.34, w: ctx.plan.content.w, h: 0.28,
    fontSize: ctx.pack.tokens.typography.captionPt,
    color: color(ctx.pack, 'mutedInk', '#5D6268'),
    align: 'center',
    objectName: objectName(ctx, 'figure-caption'),
  })
  addText(ctx, '观察结果', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 0.08, w: 1.2, h: 0.22, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'accent', '#A20D18'), objectName: objectName(ctx, 'observation-label') })
  addText(ctx, String(ctx.spec.content.observation ?? ctx.spec.claim), { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 0.42, w: ctx.plan.sidebar.w, h: 1.15, fontSize: ctx.pack.tokens.typography.bodyPt, breakLine: true, objectName: objectName(ctx, 'observation') })
  if (typeof ctx.spec.content.interpretation === 'string') {
    addText(ctx, '解释', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 1.86, w: 1.2, h: 0.22, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'interpretation-label') })
    addText(ctx, ctx.spec.content.interpretation, { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 2.18, w: ctx.plan.sidebar.w, h: 1.05, fontSize: ctx.pack.tokens.typography.bodyPt - 1, color: color(ctx.pack, 'mutedInk', '#5D6268'), breakLine: true, objectName: objectName(ctx, 'interpretation') })
  }
  if (typeof ctx.spec.content.boundary === 'string') {
    addText(ctx, '适用边界', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 3.55, w: 1.2, h: 0.22, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'accent', '#A20D18'), objectName: objectName(ctx, 'boundary-label') })
    addText(ctx, ctx.spec.content.boundary, { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 3.86, w: ctx.plan.sidebar.w, h: 0.72, fontSize: ctx.pack.tokens.typography.bodyPt - 1, breakLine: true, objectName: objectName(ctx, 'boundary') })
  }
}

function renderMechanism(ctx: SlideComponentContext): void {
  const steps = Array.isArray(ctx.spec.content.steps) ? ctx.spec.content.steps.filter((step): step is string => typeof step === 'string') : ['输入', '处理', '输出']
  const y = ctx.plan.content.y + 1.6
  const gap = ctx.plan.content.w / Math.max(steps.length, 1)
  steps.forEach((step, index) => {
    const x = ctx.plan.content.x + gap * index + 0.18
    addShape(ctx, 'ellipse', { x, y, w: 1.15, h: 1.15, fill: { color: color(ctx.pack, 'panel', color(ctx.pack, 'cloud', '#EAE8E1')) }, line: { color: color(ctx.pack, 'clay', color(ctx.pack, 'accent', '#A20D18')), width: 1.1 }, objectName: objectName(ctx, `step-${index + 1}`) })
    addText(ctx, `${String(index + 1).padStart(2, '0')}\n${step}`, { x: x + 0.12, y: y + 0.22, w: 0.91, h: 0.68, fontSize: 15, align: 'center', valign: 'middle', objectName: objectName(ctx, `step-label-${index + 1}`) })
    if (index < steps.length - 1) addShape(ctx, 'line', { x: x + 1.2, y: y + 0.57, w: gap - 1.3, h: 0, line: { color: color(ctx.pack, 'clay', color(ctx.pack, 'accent', '#A20D18')), width: 1.3, beginArrowType: 'none', endArrowType: 'triangle' }, objectName: objectName(ctx, `connector-${index + 1}`) })
  })
  addText(ctx, String(ctx.spec.content.caption ?? '每一步都保持原生形状和连接符，可在 PowerPoint 中继续编辑。'), { x: ctx.plan.content.x, y: y + 1.65, w: ctx.plan.content.w, h: 0.55, fontSize: ctx.pack.tokens.typography.captionPt, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'diagram-caption') })
}

function renderComparison(ctx: SlideComponentContext): void {
  const headers = Array.isArray(ctx.spec.content.headers)
    ? ctx.spec.content.headers.filter((value): value is string => typeof value === 'string')
    : ['方案', '误差', '特点']
  const rows = Array.isArray(ctx.spec.content.rows)
    ? ctx.spec.content.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.map((cell) => String(cell)))
    : [['基线', '100%', '单阶段'], ['双阶段', '63%', '噪声更低']]
  const tableRows: PptxGenJS.TableRow[] = [headers, ...rows].map((row) => row.map((text) => ({ text })))
  ctx.slide.addTable(tableRows, {
    x: ctx.plan.content.x,
    y: ctx.plan.content.y + 0.35,
    w: ctx.plan.content.w,
    h: 3.25,
    border: { pt: 0.7, color: color(ctx.pack, 'rule', '#B7B4AE') },
    fill: { color: color(ctx.pack, 'panel', '#F6F5F2') },
    color: color(ctx.pack, 'ink', '#17191C'),
    fontFace: ctx.pack.tokens.typography.fontFallback[0] ?? 'Aptos',
    fontSize: ctx.pack.tokens.typography.bodyPt,
    margin: 0.08,
    rowH: 0.64,
    colW: headers.map(() => ctx.plan.content.w / Math.max(headers.length, 1)),
    objectName: objectName(ctx, 'native-table'),
  })
  addText(ctx, ctx.spec.citations[0] ?? '来源定位见 Speaker Notes', {
    x: ctx.plan.content.x,
    y: ctx.plan.content.y + 3.9,
    w: ctx.plan.content.w,
    h: 0.35,
    fontSize: ctx.pack.tokens.typography.captionPt,
    color: color(ctx.pack, 'mutedInk', '#5D6268'),
    objectName: objectName(ctx, 'comparison-citation'),
  })
}

function renderConclusion(ctx: SlideComponentContext): void {
  const content = ctx.plan.content
  addText(ctx, '核心结论', { x: content.x, y: content.y, w: 2.1, h: 0.25, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')), objectName: objectName(ctx, 'conclusion-label') })
  addText(ctx, String(ctx.spec.content.headline ?? ctx.spec.claim), { x: content.x, y: content.y + 0.45, w: content.w - 0.25, h: 0.75, fontSize: 32, bold: true, objectName: objectName(ctx, 'conclusion-headline') })
  addText(ctx, String(ctx.spec.content.conclusion ?? '在当前样本和研究区范围内，结果支持该方法用于区域性初步筛查。'), { x: content.x, y: content.y + 1.55, w: content.w - 0.25, h: 0.9, fontSize: 22, breakLine: true, objectName: objectName(ctx, 'conclusion-text') })
  addText(ctx, '适用边界 / 局限', { x: content.x, y: content.y + 2.75, w: 2.1, h: 0.25, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'boundary-label') })
  addText(ctx, String(ctx.spec.content.boundary ?? ctx.spec.content.limitation ?? '当前结果不等同于实时发生概率或事件时刻预测。'), { x: content.x, y: content.y + 3.08, w: content.w - 0.25, h: 0.75, fontSize: ctx.pack.tokens.typography.bodyPt, color: color(ctx.pack, 'ink', '#17191C'), breakLine: true, objectName: objectName(ctx, 'boundary') })
  addText(ctx, '下一步', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 0.15, w: 1.3, h: 0.25, fontSize: ctx.pack.tokens.typography.captionPt, bold: true, color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')), objectName: objectName(ctx, 'next-step-label') })
  addText(ctx, String(ctx.spec.content.nextStep ?? '扩大独立样本，并纳入动态气象与雪层变量。'), { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 0.55, w: ctx.plan.sidebar.w, h: 1.5, fontSize: ctx.pack.tokens.typography.bodyPt, breakLine: true, objectName: objectName(ctx, 'next-step') })
  addCrescent(ctx)
}

function renderReferences(ctx: SlideComponentContext): void {
  const refs = ctx.spec.citations.length > 0 ? ctx.spec.citations : ['来源定位见 Speaker Notes']
  addText(ctx, refs.map((ref, index) => `${index + 1}. ${ref}`).join('\n'), { x: ctx.plan.content.x, y: ctx.plan.content.y, w: ctx.plan.content.w, h: ctx.plan.content.h, fontSize: ctx.pack.tokens.typography.bodyPt, breakLine: true, objectName: objectName(ctx, 'references') })
}

export function renderSlideComponent(ctx: SlideComponentContext): void {
  ctx.slide.background = { color: color(ctx.pack, 'canvas', '#F7F5F0') }
  addHeader(ctx)
  addCloudMotifs(ctx, ctx.spec.visualRole)
  switch (ctx.spec.visualRole) {
    case 'title': renderTitle(ctx); break
    case 'chart': renderChart(ctx); break
    case 'mechanism_diagram': renderMechanism(ctx); break
    case 'conclusion': renderConclusion(ctx); break
    case 'references': renderReferences(ctx); break
    case 'comparison': renderComparison(ctx); break
    case 'section': renderTitle(ctx); break
    case 'image_with_annotation': renderImageEvidence(ctx); break
    case 'assertion_evidence':
    case 'limitations':
    default: renderAssertion(ctx); break
  }
  addFooter(ctx)
}

export function buildSpeakerNotes(spec: DeckSlideSpec): string {
  return [
    `页内短引：${spec.claim}`,
    `完整引用：${spec.citations.join('；') || '见来源谱系与 evidenceRefs'}`,
    '讲述要点：',
    ...spec.speakerNotes.map((note) => `- ${note}`),
    `证据绑定：${spec.evidenceRefs.join('；')}`,
    '转场：按照本页讲述要点自然过渡到下一页。',
    '建议时长：根据 Deck Brief 预估时长分配。',
    '潜在追问：准备解释数据来源、限制与下一步验证。',
  ].join('\n')
}
