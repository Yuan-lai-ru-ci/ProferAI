import PptxGenJS from 'pptxgenjs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DeckSourceLineage, DeckSpec } from '@profer/shared'
import { assertDeckCompilable, markDeckProjectCompiled, writeJsonForDeckProject } from './ppt-deck-project-service'
import { parseDeckSpec, parseSourceLineage } from './ppt-deck-schema'
import { getPptStylePackDefinition } from './ppt-style-pack-service'
import { assertRectInsideSlide, createLayoutPlan } from './ppt-layout-engine'
import { buildSpeakerNotes, renderSlideComponent } from './ppt-slide-components'

export interface CompileDeckProjectOptions {
  outputName?: string
  changedSlideIds?: string[]
}

export interface CompileDeckProjectResult {
  outputPath: string
  slideCount: number
  styleId: string
  recompiledSlideIds: string[]
  reusedSlideIds: string[]
  layoutIssues: Array<{ slideId: string; code: string; message: string }>
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stripHash(value: string): string {
  return value.replace(/^#/, '')
}

function stylePackResourceRoot(): string {
  const candidates = [
    join(__dirname, 'resources', 'ppt-style-packs'),
    join(__dirname, '../../../resources', 'ppt-style-packs'),
    process.resourcesPath ? join(process.resourcesPath, 'ppt-style-packs') : '',
  ].filter(Boolean)
  const root = candidates.find((candidate) => existsSync(candidate))
  if (!root) throw new Error('找不到内置 PPT Style Pack 资源目录')
  return root
}

function assertCurrentEvidence(spec: DeckSpec, lineage: DeckSourceLineage): void {
  const byId = new Map(lineage.sources.map((source) => [source.id, source]))
  for (const slide of spec.slides) {
    for (const ref of slide.evidenceRefs) {
      const sourceId = ref.split('#', 1)[0] ?? ''
      const source = byId.get(sourceId)
      if (!source) throw new Error(`页面 ${slide.slideId} 的 evidenceRef 未找到来源: ${ref}`)
      if (source.status !== 'current') throw new Error(`页面 ${slide.slideId} 绑定了非 current 来源 ${source.status}: ${source.relativePath}`)
      const expectedHash = spec.sourceHashes[sourceId]
      if (!expectedHash || expectedHash !== source.contentHash) throw new Error(`页面 ${slide.slideId} 的来源 hash 与谱系不匹配: ${sourceId}`)
    }
  }
}

function safeOutputName(name: string | undefined, deckId: string): string {
  const base = (name ?? `${deckId}.pptx`).trim()
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return safe.toLowerCase().endsWith('.pptx') ? safe : `${safe}.pptx`
}

function updateProjectSpecCache(projectDir: string, spec: DeckSpec, outputHash: string): void {
  const updated: DeckSpec = {
    ...spec,
    compiledSlideCache: Object.fromEntries(spec.slides.map((slide) => [slide.slideId, {
      specHash: hashText(JSON.stringify(slide)),
      outputHash,
    }])),
  }
  writeJsonForDeckProject(projectDir, 'deck-spec.json', updated)
}

export async function compileDeckProject(projectDir: string, options: CompileDeckProjectOptions = {}): Promise<CompileDeckProjectResult> {
  const snapshot = await assertDeckCompilable(projectDir)
  const spec = parseDeckSpec(snapshot.deckSpec)
  const lineage = parseSourceLineage(snapshot.sourceLineage)
  if (spec.deckId !== snapshot.brief.deckId) throw new Error('Deck Spec deckId 与 Brief 不一致')
  if (spec.styleId !== snapshot.brief.styleId) throw new Error('Deck Spec styleId 与 Brief 不一致')
  if (spec.slides.length !== snapshot.brief.slideCount) throw new Error(`Deck Spec 页数 ${spec.slides.length} 与 Brief 预计页数 ${snapshot.brief.slideCount} 不一致`)
  assertCurrentEvidence(spec, lineage)

  const pack = getPptStylePackDefinition(spec.styleId, { resourceRoot: stylePackResourceRoot() })
  const layoutIssues: Array<{ slideId: string; code: string; message: string }> = []
  const plans = spec.slides.map((slide) => {
    const planned = createLayoutPlan(slide, pack)
    for (const issue of planned.issues) layoutIssues.push({ slideId: slide.slideId, code: issue.code, message: issue.message })
    assertRectInsideSlide(planned.plan.slide, pack)
    assertRectInsideSlide(planned.plan.header, pack)
    assertRectInsideSlide(planned.plan.content, pack)
    assertRectInsideSlide(planned.plan.footer, pack)
    return { slide, plan: planned.plan }
  })
  if (layoutIssues.some((issue) => issue.code === 'TEXT_OVERFLOW_RISK' || issue.code === 'DENSITY_OVER_BUDGET')) {
    throw new Error(`布局超过密度预算：${layoutIssues.map((issue) => `${issue.slideId}:${issue.message}`).join('；')}`)
  }

  const outputDir = resolve(snapshot.manifest.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const outputPath = join(outputDir, safeOutputName(options.outputName, spec.deckId))
  const previousCache = spec.compiledSlideCache ?? {}
  const changed = new Set(options.changedSlideIds ?? spec.slides.map((slide) => slide.slideId))
  const reusedSlideIds = spec.slides
    .map((slide) => slide.slideId)
    .filter((slideId) => !changed.has(slideId) && Boolean(previousCache[slideId]))
  const recompiledSlideIds = spec.slides.map((slide) => slide.slideId).filter((slideId) => !reusedSlideIds.includes(slideId))

  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Profer'
  pptx.company = 'Profer'
  pptx.subject = snapshot.brief.goal
  pptx.title = spec.title
  pptx.theme = {
    headFontFace: pack.tokens.typography.fontFallback[0] ?? 'Aptos',
    bodyFontFace: pack.tokens.typography.fontFallback[0] ?? 'Aptos',
  }

  for (const { slide: slideSpec, plan } of plans) {
    const slide = pptx.addSlide()
    renderSlideComponent({ pptx, slide, deckId: spec.deckId, spec: slideSpec, pack, plan })
    slide.addNotes(buildSpeakerNotes(slideSpec))
  }

  await pptx.writeFile({ fileName: outputPath, compression: true })
  if (!existsSync(outputPath)) throw new Error(`PPTX 输出失败: ${outputPath}`)
  const result: CompileDeckProjectResult = {
    outputPath,
    slideCount: spec.slides.length,
    styleId: spec.styleId,
    recompiledSlideIds,
    reusedSlideIds,
    layoutIssues,
  }
  const outputHash = createHash('sha256').update(readFileSync(outputPath)).digest('hex')
  updateProjectSpecCache(projectDir, spec, outputHash)
  await markDeckProjectCompiled(projectDir, {
    outputPath,
    outputHash,
    recompiledSlideIds,
    reusedSlideIds,
  })
  return result
}
