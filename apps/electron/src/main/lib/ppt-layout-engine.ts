import type { DeckDensityBudget, DeckSlideSpec, DeckVisualRole } from '@profer/shared'
import type { PptStylePackDefinition } from './ppt-style-pack-service'

export interface PptRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PptLayoutPlan {
  slide: PptRect
  header: PptRect
  content: PptRect
  sidebar: PptRect
  footer: PptRect
  visualRole: DeckVisualRole
  layoutIntent: string
  densityBudget: DeckDensityBudget
}

export interface PptLayoutIssue {
  code: 'TEXT_OVERFLOW_RISK' | 'DENSITY_OVER_BUDGET' | 'UNKNOWN_LAYOUT'
  message: string
}

const SLIDE_WIDTH = 13.333
const SLIDE_HEIGHT = 7.5

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function estimateTextHeight(text: string, widthInches: number, fontSizePt: number, lineHeight = 1.15): number {
  const charactersPerLine = Math.max(8, Math.floor(widthInches * 11 * (16 / clamp(fontSizePt, 8, 72))))
  const lineCount = text
    .split(/\r?\n/)
    .reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / charactersPerLine)), 0)
  return Math.max(0.22, lineCount * (fontSizePt / 72) * lineHeight + 0.06)
}

function gridColumn(pack: PptStylePackDefinition, column: number, span: number): PptRect {
  const grid = pack.tokens.grid
  const usable = pack.tokens.canvas.width - grid.marginX * 2
  const totalGutter = grid.gutter * (grid.columns - 1)
  const columnWidth = (usable - totalGutter) / grid.columns
  return {
    x: grid.marginX + (column - 1) * (columnWidth + grid.gutter),
    y: grid.marginY,
    w: columnWidth * span + grid.gutter * (span - 1),
    h: pack.tokens.canvas.height - grid.marginY * 2,
  }
}

function planByRole(slide: DeckSlideSpec, pack: PptStylePackDefinition): PptLayoutPlan {
  const grid = pack.tokens.grid
  const full = gridColumn(pack, 1, grid.columns)
  const left = gridColumn(pack, 1, 5)
  const center = gridColumn(pack, 6, 1)
  const right = gridColumn(pack, 7, 6)
  const wideRight = gridColumn(pack, 6, 7)
  const header: PptRect = { x: full.x, y: full.y, w: full.w, h: 0.72 }
  const footer: PptRect = { x: full.x, y: 7.02, w: full.w, h: 0.18 }

  switch (slide.visualRole) {
    case 'title':
      return { slide: full, header, content: { x: full.x, y: 1.48, w: 8.8, h: 4.65 }, sidebar: { x: 10.15, y: 1.2, w: 2.0, h: 4.9 }, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'section':
      return { slide: full, header, content: { x: full.x, y: 1.25, w: 7.4, h: 4.9 }, sidebar: { x: 9.75, y: 1.2, w: 2.4, h: 4.9 }, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'chart':
      return { slide: full, header, content: { x: full.x, y: 1.35, w: 8.15, h: 4.85 }, sidebar: { x: 9.35, y: 1.35, w: 3.36, h: 4.85 }, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'mechanism_diagram':
      return { slide: full, header, content: { x: full.x, y: 1.4, w: full.w, h: 4.95 }, sidebar: right, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'comparison':
      return { slide: full, header, content: { x: full.x, y: 1.35, w: full.w, h: 4.9 }, sidebar: right, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'image_with_annotation':
      return { slide: full, header, content: { x: full.x, y: 1.35, w: 7.35, h: 4.85 }, sidebar: { x: 8.55, y: 1.35, w: 4.16, h: 4.85 }, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'limitations':
      return { slide: full, header, content: { x: full.x, y: 1.4, w: 7.6, h: 4.8 }, sidebar: { x: 9.35, y: 1.4, w: 2.8, h: 4.8 }, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'conclusion':
      return { slide: full, header, content: { x: full.x, y: 1.35, w: 8.2, h: 4.95 }, sidebar: { x: 9.7, y: 1.25, w: 2.45, h: 4.95 }, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'references':
      return { slide: full, header, content: { x: full.x, y: 1.25, w: full.w, h: 5.55 }, sidebar: right, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
    case 'assertion_evidence':
    default:
      return { slide: full, header, content: { x: full.x, y: 1.35, w: 7.25, h: 4.85 }, sidebar: { x: 8.45, y: 1.35, w: 4.26, h: 4.85 }, footer, visualRole: slide.visualRole, layoutIntent: slide.layoutIntent, densityBudget: slide.densityBudget }
  }
}

export function createLayoutPlan(slide: DeckSlideSpec, pack: PptStylePackDefinition): { plan: PptLayoutPlan; issues: PptLayoutIssue[] } {
  const plan = planByRole(slide, pack)
  const issues: PptLayoutIssue[] = []
  const layoutCandidates = pack.layoutGrammar[slide.visualRole]?.[slide.densityBudget]
  if (!layoutCandidates || !layoutCandidates.includes(slide.layoutIntent)) {
    issues.push({ code: 'UNKNOWN_LAYOUT', message: `${slide.visualRole}/${slide.densityBudget} 不支持布局 ${slide.layoutIntent}` })
  }

  const content = slide.content
  const textValues = Object.values(content).filter((value): value is string => typeof value === 'string')
  const bodyText = textValues.join('\n')
  const bodyPt = pack.tokens.typography.bodyPt
  const estimatedHeight = estimateTextHeight(bodyText, plan.content.w, bodyPt, pack.tokens.typography.lineHeight)
  const maxHeight = slide.densityBudget === 'low' ? 2.45 : slide.densityBudget === 'medium' ? 3.85 : 5.0
  if (estimatedHeight > maxHeight) {
    issues.push({ code: 'TEXT_OVERFLOW_RISK', message: `文本估算高度 ${estimatedHeight.toFixed(2)}in 超过 ${slide.densityBudget} 密度预算 ${maxHeight.toFixed(2)}in` })
  }
  const textRatio = bodyText.length / Math.max(1, slide.claim.length + 20)
  if (slide.densityBudget === 'low' && textRatio > 3.5) {
    issues.push({ code: 'DENSITY_OVER_BUDGET', message: '低密度页面包含过多文本，应该改写或拆页' })
  }
  return { plan, issues }
}

export function assertRectInsideSlide(rect: PptRect, pack: PptStylePackDefinition): void {
  const width = pack.tokens.canvas.width || SLIDE_WIDTH
  const height = pack.tokens.canvas.height || SLIDE_HEIGHT
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > width + 0.001 || rect.y + rect.h > height + 0.001) {
    throw new Error(`布局越界: ${JSON.stringify(rect)}`)
  }
}
