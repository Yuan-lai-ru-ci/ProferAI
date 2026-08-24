import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { extname, posix, resolve } from 'node:path'
import type { DeckSourceLineage, DeckSpec } from '@profer/shared'
import { parseDeckSpec, parseSourceLineage } from './ppt-deck-schema'

const EMU_PER_INCH = 914_400
const DEFAULT_SLIDE_WIDTH_EMU = Math.round(13.333 * EMU_PER_INCH)
const DEFAULT_SLIDE_HEIGHT_EMU = Math.round(7.5 * EMU_PER_INCH)

export type PptOoxmlIssueSeverity = 'P0' | 'P1' | 'P2'

export type PptOoxmlIssueCode =
  | 'SLIDE_COUNT_MISMATCH'
  | 'SLIDE_BOUNDS_OVERFLOW'
  | 'SEMANTIC_NAME_MISSING'
  | 'NATIVE_CHART_MISSING'
  | 'NOTES_MISSING'
  | 'NOTES_INCOMPLETE'
  | 'SOURCE_HASH_MISMATCH'
  | 'NON_CURRENT_SOURCE'
  | 'EVIDENCE_SOURCE_MISSING'
  | 'FULL_SLIDE_RASTERIZED_CONTENT'
  | 'CLOUD_DANCER_PREVIEW_BACKGROUND'
  | 'EDITABILITY_COVERAGE_LOW'

export interface PptOoxmlIssue {
  code: PptOoxmlIssueCode
  severity: PptOoxmlIssueSeverity
  message: string
  slideNumber?: number
  slideId?: string
  objectName?: string
}

export interface PptOoxmlSlideAudit {
  slideNumber: number
  slideId?: string
  nativeShapeCount: number
  nativeChartCount: number
  nativeTableCount: number
  connectorCount: number
  imageCount: number
  semanticObjectCount: number
  objectCount: number
  editabilityCoverage: number
  notesPresent: boolean
  issues: PptOoxmlIssue[]
}

export interface PptOoxmlAudit {
  filePath: string
  slideCount: number
  slideWidth: number
  slideHeight: number
  nativeObjectCount: number
  imageCount: number
  editabilityCoverage: number
  needsRevision: boolean
  issues: PptOoxmlIssue[]
  slides: PptOoxmlSlideAudit[]
}

export interface PptOoxmlAuditInput {
  deckSpec: DeckSpec | unknown
  sourceLineage: DeckSourceLineage | unknown
}

interface Bounds {
  x: number
  y: number
  cx: number
  cy: number
}

interface ParsedObject {
  kind: 'shape' | 'picture' | 'graphicFrame' | 'connector'
  name: string
  altText?: string
  bounds?: Bounds
  hasChart: boolean
  hasTable: boolean
  relationshipId?: string
}

function numberAttribute(xml: string, tag: string, attribute: string): number | undefined {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}="(\\d+)"`, 'i'))
  return match ? Number(match[1]) : undefined
}

function extractBounds(xml: string): Bounds | undefined {
  const off = xml.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i)
    ?? xml.match(/<p:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i)
  const ext = xml.match(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i)
    ?? xml.match(/<p:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i)
  if (!off || !ext) return undefined
  return { x: Number(off[1]), y: Number(off[2]), cx: Number(ext[1]), cy: Number(ext[2]) }
}

function xmlBlocks(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi')
  return xml.match(regex) ?? []
}

function objectIdentity(xml: string): { name: string; altText?: string } {
  const node = xml.match(/<(?:p:)?cNvPr\b([^>]*)\/?\s*>/i)
  const attrs = node?.[1] ?? ''
  const name = attrs.match(/\bname="([^"]*)"/i)?.[1] ?? ''
  const altText = attrs.match(/\bdescr="([^"]*)"/i)?.[1]
  return { name, altText }
}

function parseObjects(xml: string): ParsedObject[] {
  const objects: ParsedObject[] = []
  for (const [tag, kind] of [
    ['p:sp', 'shape'],
    ['p:pic', 'picture'],
    ['p:graphicFrame', 'graphicFrame'],
    ['p:cxnSp', 'connector'],
  ] as const) {
    for (const block of xmlBlocks(xml, tag)) {
      const identity = objectIdentity(block)
      objects.push({
        kind,
        name: identity.name,
        altText: identity.altText,
        bounds: extractBounds(block),
        hasChart: /<c:chart\b/i.test(block),
        hasTable: /<a:tbl\b/i.test(block),
        relationshipId: block.match(/<a:blip\b[^>]*(?:r:embed|r:link)="([^"]+)"/i)?.[1],
      })
    }
  }
  return objects
}

function slideEntries(zip: AdmZip): string[] {
  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
}

function resolveSlideMediaTargets(zip: AdmZip, slideNumber: number): Map<string, string> {
  const relPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`
  const entry = zip.getEntry(relPath)
  if (!entry) return new Map()
  const xml = zip.readAsText(entry)
  const output = new Map<string, string>()
  const regex = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/gi
  for (const match of xml.matchAll(regex)) {
    const id = match[1]
    const target = match[2]
    if (!id || !target) continue
    const normalized = posix.normalize(posix.join('ppt/slides', target))
    output.set(id, normalized)
  }
  return output
}

function semanticNameMatches(name: string, deckId: string, slideId: string): boolean {
  return name.startsWith(`${deckId}/${slideId}/`) && name.split('/').length >= 3
}

function overflows(bounds: Bounds, width: number, height: number): boolean {
  // PowerPoint 的水平/垂直线会合法地使用 cy=0 或 cx=0；只有负尺寸或两轴同时为 0 才是无效对象。
  const invalidSize = bounds.cx < 0 || bounds.cy < 0 || bounds.cx === 0 && bounds.cy === 0
  return bounds.x < 0 || bounds.y < 0 || invalidSize || bounds.x + bounds.cx > width || bounds.y + bounds.cy > height
}

function imageAreaRatio(bounds: Bounds | undefined, width: number, height: number): number {
  if (!bounds || width <= 0 || height <= 0) return 0
  const visibleWidth = Math.max(0, Math.min(width, bounds.x + bounds.cx) - Math.max(0, bounds.x))
  const visibleHeight = Math.max(0, Math.min(height, bounds.y + bounds.cy) - Math.max(0, bounds.y))
  return (visibleWidth * visibleHeight) / (width * height)
}

function notesText(zip: AdmZip, slideNumber: number): string {
  const entry = zip.getEntry(`ppt/notesSlides/notesSlide${slideNumber}.xml`)
  if (!entry) return ''
  return zip.readAsText(entry).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function createIssue(issue: PptOoxmlIssue): PptOoxmlIssue {
  return issue
}

function validateSources(spec: DeckSpec, lineage: DeckSourceLineage): PptOoxmlIssue[] {
  const issues: PptOoxmlIssue[] = []
  const byId = new Map(lineage.sources.map((source) => [source.id, source]))
  for (const slide of spec.slides) {
    for (const ref of slide.evidenceRefs) {
      const sourceId = ref.split('#', 1)[0] ?? ''
      const source = byId.get(sourceId)
      if (!source) {
        issues.push(createIssue({ code: 'EVIDENCE_SOURCE_MISSING', severity: 'P0', slideId: slide.slideId, message: `evidenceRef 未找到来源: ${ref}` }))
        continue
      }
      if (source.status !== 'current') {
        issues.push(createIssue({ code: 'NON_CURRENT_SOURCE', severity: 'P0', slideId: slide.slideId, message: `当前论点使用了 ${source.status} 来源: ${source.relativePath}` }))
      }
      if (spec.sourceHashes[sourceId] !== source.contentHash) {
        issues.push(createIssue({ code: 'SOURCE_HASH_MISMATCH', severity: 'P0', slideId: slide.slideId, message: `来源 SHA-256 与 Deck Spec 不一致: ${sourceId}` }))
      }
    }
  }
  return issues
}

export function auditPptOoxml(filePath: string, input: PptOoxmlAuditInput): PptOoxmlAudit {
  const resolved = resolve(filePath)
  if (extname(resolved).toLowerCase() !== '.pptx') throw new Error('仅支持审计 .pptx 文件')
  if (!existsSync(resolved)) throw new Error(`PPTX 不存在: ${resolved}`)
  const spec = parseDeckSpec(input.deckSpec)
  const lineage = parseSourceLineage(input.sourceLineage)
  const zip = new AdmZip(resolved)
  const presentationXml = zip.getEntry('ppt/presentation.xml') ? zip.readAsText('ppt/presentation.xml') : ''
  const width = numberAttribute(presentationXml, 'p:sldSz', 'cx') ?? DEFAULT_SLIDE_WIDTH_EMU
  const height = numberAttribute(presentationXml, 'p:sldSz', 'cy') ?? DEFAULT_SLIDE_HEIGHT_EMU
  const entries = slideEntries(zip)
  const issues: PptOoxmlIssue[] = validateSources(spec, lineage)
  if (entries.length !== spec.slides.length) {
    issues.push(createIssue({ code: 'SLIDE_COUNT_MISMATCH', severity: 'P0', message: `Deck Spec ${spec.slides.length} 页，PPTX 实际 ${entries.length} 页` }))
  }

  const slides: PptOoxmlSlideAudit[] = entries.map((entryName, index) => {
    const slideNumber = index + 1
    const slideSpec = spec.slides[index]
    const slideId = slideSpec?.slideId
    const xml = zip.readAsText(entryName)
    const objects = parseObjects(xml)
    const relationships = resolveSlideMediaTargets(zip, slideNumber)
    const slideIssues: PptOoxmlIssue[] = []
    const nativeShapeCount = objects.filter((object) => object.kind === 'shape').length
    const nativeChartCount = objects.filter((object) => object.hasChart).length
    const nativeTableCount = objects.filter((object) => object.hasTable).length
    const connectorCount = objects.filter((object) => object.kind === 'connector' || object.kind === 'shape' && /connector/i.test(object.name)).length
    const pictures = objects.filter((object) => object.kind === 'picture')
    const nativeObjectCount = nativeShapeCount + nativeChartCount + nativeTableCount + connectorCount
    const objectCount = nativeObjectCount + pictures.length
    const semanticObjectCount = objects.filter((object) => slideId && semanticNameMatches(object.name, spec.deckId, slideId)).length
    const notes = notesText(zip, slideNumber)

    for (const object of objects) {
      if (object.bounds && overflows(object.bounds, width, height)) {
        slideIssues.push(createIssue({ code: 'SLIDE_BOUNDS_OVERFLOW', severity: 'P0', slideNumber, slideId, objectName: object.name, message: `对象越出 13.333×7.5 画布: ${object.name || object.kind}` }))
      }
      if (slideId && !semanticNameMatches(object.name, spec.deckId, slideId)) {
        slideIssues.push(createIssue({ code: 'SEMANTIC_NAME_MISSING', severity: 'P1', slideNumber, slideId, objectName: object.name, message: `对象缺少 deckId/slideId/objectId 语义名: ${object.name || object.kind}` }))
      }
    }

    if (slideSpec?.visualRole === 'chart' && nativeChartCount === 0) {
      slideIssues.push(createIssue({ code: 'NATIVE_CHART_MISSING', severity: 'P1', slideNumber, slideId, message: '图表页没有原生 chart 对象，不能用图片替代可编辑图表' }))
    }
    if (!notes) {
      slideIssues.push(createIssue({ code: 'NOTES_MISSING', severity: 'P1', slideNumber, slideId, message: '缺少 Speaker Notes' }))
    } else if (!['完整引用', '讲述要点', '建议时长', '潜在追问'].every((token) => notes.includes(token))) {
      slideIssues.push(createIssue({ code: 'NOTES_INCOMPLETE', severity: 'P1', slideNumber, slideId, message: 'Speaker Notes 缺少完整引用、讲述要点、建议时长或潜在追问' }))
    }

    const fullSlidePictures = pictures.filter((picture) => imageAreaRatio(picture.bounds, width, height) >= 0.85)
    if (fullSlidePictures.length > 0) {
      slideIssues.push(createIssue({ code: 'FULL_SLIDE_RASTERIZED_CONTENT', severity: 'P1', slideNumber, slideId, message: '检测到覆盖 85% 以上画布的整页图片，疑似以位图伪装可编辑 PPT' }))
    }
    if (spec.styleId === 'profer-cloud-dancer') {
      for (const picture of pictures) {
        const target = picture.relationshipId ? relationships.get(picture.relationshipId) : undefined
        if (target && /(?:^|\/)preview\.(?:webp|png|jpe?g)$/i.test(target) && imageAreaRatio(picture.bounds, width, height) >= 0.75) {
          slideIssues.push(createIssue({ code: 'CLOUD_DANCER_PREVIEW_BACKGROUND', severity: 'P0', slideNumber, slideId, objectName: picture.name, message: 'Cloud Dancer 内容页不能把竖向/固定 preview 作为满页背景' }))
        }
      }
    }

    const editabilityCoverage = objectCount === 0 ? 0 : nativeObjectCount / objectCount
    if (fullSlidePictures.length > 0 || editabilityCoverage < 0.5) {
      slideIssues.push(createIssue({ code: 'EDITABILITY_COVERAGE_LOW', severity: 'P1', slideNumber, slideId, message: `可编辑对象覆盖率过低: ${(editabilityCoverage * 100).toFixed(1)}%` }))
    }
    issues.push(...slideIssues)
    return {
      slideNumber,
      slideId,
      nativeShapeCount,
      nativeChartCount,
      nativeTableCount,
      connectorCount,
      imageCount: pictures.length,
      semanticObjectCount,
      objectCount,
      editabilityCoverage,
      notesPresent: Boolean(notes),
      issues: slideIssues,
    }
  })

  const nativeObjectCount = slides.reduce((sum, slide) => sum + slide.nativeShapeCount + slide.nativeChartCount + slide.nativeTableCount + slide.connectorCount, 0)
  const imageCount = slides.reduce((sum, slide) => sum + slide.imageCount, 0)
  const editabilityCoverage = nativeObjectCount + imageCount === 0 ? 0 : nativeObjectCount / (nativeObjectCount + imageCount)
  return {
    filePath: resolved,
    slideCount: entries.length,
    slideWidth: width / EMU_PER_INCH,
    slideHeight: height / EMU_PER_INCH,
    nativeObjectCount,
    imageCount,
    editabilityCoverage,
    needsRevision: issues.some((issue) => issue.severity === 'P0' || issue.severity === 'P1'),
    issues,
    slides,
  }
}
