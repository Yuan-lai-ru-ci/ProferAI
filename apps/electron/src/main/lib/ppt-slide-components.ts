import type { DeckSlideSpec, DeckVisualRole } from '@profer/shared'
import type PptxGenJS from 'pptxgenjs'
import type { PptStylePackDefinition } from './ppt-style-pack-service'
import type { PptLayoutPlan } from './ppt-layout-engine'

export interface SlideComponentContext {
  pptx: PptxGenJS
  slide: PptxGenJS.Slide
  deckId: string
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

function addHeader(ctx: SlideComponentContext): void {
  const header = ctx.plan.header
  addText(ctx, ctx.spec.claim, {
    x: header.x, y: header.y, w: header.w * 0.76, h: header.h,
    fontSize: ctx.pack.tokens.typography.titlePt,
    bold: true,
    valign: 'middle',
    objectName: objectName(ctx, 'claim'),
  })
  addText(ctx, String(ctx.spec.visualRole).toUpperCase(), {
    x: header.x + header.w * 0.78, y: header.y + 0.1, w: header.w * 0.22, h: 0.2,
    fontSize: ctx.pack.tokens.typography.captionPt,
    color: color(ctx.pack, 'clay', color(ctx.pack, 'accent', '#A20D18')),
    align: 'right',
    charSpacing: 1.5,
    objectName: objectName(ctx, 'role-label'),
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
  addAcademicAccent(ctx, 1.44)
  addText(ctx, String(ctx.spec.content.headline ?? ctx.spec.claim), {
    x: content.x, y: content.y, w: content.w, h: 1.6,
    fontSize: 38, bold: true, breakLine: false,
    objectName: objectName(ctx, 'headline'),
  })
  addText(ctx, String(ctx.spec.content.subhead ?? '研究汇报 · 实验与证据'), {
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
  addShape(ctx, 'rect', { x: content.x, y: content.y, w: 0.17, h: 0.17, fill: { color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')) }, line: { color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')), transparency: 100 }, objectName: objectName(ctx, 'evidence-marker') })
  addText(ctx, String(ctx.spec.content.headline ?? ctx.spec.claim), { x: content.x + 0.32, y: content.y - 0.03, w: content.w - 0.32, h: 0.8, fontSize: 27, bold: true, objectName: objectName(ctx, 'headline') })
  addText(ctx, String(ctx.spec.content.body ?? '该页面绑定当前版本证据，并保留可编辑文本层。'), { x: content.x, y: content.y + 1.18, w: content.w - 0.18, h: 1.25, fontSize: ctx.pack.tokens.typography.bodyPt, color: color(ctx.pack, 'mutedInk', '#5D6268'), breakLine: true, objectName: objectName(ctx, 'body') })
  addShape(ctx, 'line', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 0.1, w: 0, h: ctx.plan.sidebar.h - 0.32, line: { color: color(ctx.pack, 'rule', '#B7B4AE'), width: 0.8 }, objectName: objectName(ctx, 'split-rule') })
  addText(ctx, ctx.spec.citations[0] ?? '当前来源，定位信息见备注', { x: ctx.plan.sidebar.x + 0.22, y: ctx.plan.sidebar.y + 0.18, w: ctx.plan.sidebar.w - 0.22, h: 0.7, fontSize: ctx.pack.tokens.typography.captionPt, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'citation-short') })
}

function renderChart(ctx: SlideComponentContext): void {
  const content = ctx.plan.content
  const rawLabels = Array.isArray(ctx.spec.content.labels) ? ctx.spec.content.labels : ['基线', '阶段一', '阶段二']
  const rawValues = Array.isArray(ctx.spec.content.values) ? ctx.spec.content.values : [100, 78, 63]
  const labels = rawLabels.filter((label): label is string => typeof label === 'string')
  const values = rawValues.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  ctx.slide.addChart(ctx.pptx.ChartType.bar, [{ name: '结果', labels, values }], {
    x: content.x, y: content.y, w: content.w, h: content.h - 0.38,
    catAxisLabelFontFace: ctx.pack.tokens.typography.fontFallback[0] ?? 'Aptos',
    catAxisLabelFontSize: ctx.pack.chartLanguage.labelPt,
    valAxisLabelFontSize: ctx.pack.chartLanguage.labelPt,
    valAxisMinVal: 0,
    valAxisMaxVal: 110,
    valAxisMajorUnit: 20,
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
  addText(ctx, ctx.spec.citations[0] ?? '来源定位见 Speaker Notes', { x: ctx.plan.sidebar.x, y: ctx.plan.sidebar.y + 1.05, w: ctx.plan.sidebar.w, h: 0.65, fontSize: ctx.pack.tokens.typography.captionPt, color: color(ctx.pack, 'mutedInk', '#5D6268'), objectName: objectName(ctx, 'citation-short') })
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
  addText(ctx, String(ctx.spec.content.headline ?? '结论'), { x: content.x, y: content.y, w: 2.6, h: 1.4, fontSize: 60, bold: true, color: color(ctx.pack, 'accent', color(ctx.pack, 'clay', '#846557')), objectName: objectName(ctx, 'big-stat') })
  addText(ctx, String(ctx.spec.content.label ?? ctx.spec.claim), { x: content.x, y: content.y + 1.48, w: 4.5, h: 0.48, fontSize: ctx.pack.tokens.typography.sectionPt, bold: true, objectName: objectName(ctx, 'stat-label') })
  addText(ctx, String(ctx.spec.content.conclusion ?? '下一步继续验证泛化性。'), { x: content.x, y: content.y + 2.42, w: content.w - 0.25, h: 1.35, fontSize: 24, breakLine: true, objectName: objectName(ctx, 'conclusion-text') })
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
    case 'assertion_evidence':
    case 'image_with_annotation':
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
