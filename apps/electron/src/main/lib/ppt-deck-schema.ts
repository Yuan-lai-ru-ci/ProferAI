import { z } from 'zod'
import type { DeckBrief, DeckSourceLineage, DeckSpec } from '@profer/shared'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, 'contentHash 必须是 64 位 SHA-256 hex')
const nonBlank = z.string().trim().min(1)
const projectId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'deckId 必须使用小写字母、数字和短横线')

const sourceRecord = z.object({
  id: nonBlank,
  absolutePath: nonBlank,
  relativePath: nonBlank,
  kind: z.enum(['document', 'spreadsheet', 'presentation', 'image', 'text', 'data', 'unknown']),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
  contentHash: sha256,
  status: z.enum(['current', 'superseded', 'historical', 'conflicted', 'unknown']),
  locator: nonBlank.optional(),
  title: nonBlank.optional(),
  excerpt: z.string().max(20_000).optional(),
  versionSignals: z.array(nonBlank).max(30).optional(),
}).strict()

const lineage = z.object({
  schemaVersion: z.literal(1).default(1),
  sources: z.array(sourceRecord).min(1),
  conflicts: z.array(nonBlank).optional(),
  gaps: z.array(nonBlank).optional(),
}).strict()

const brief = z.object({
  schemaVersion: z.literal(1).default(1),
  deckId: projectId,
  goal: nonBlank,
  audience: nonBlank,
  occasion: nonBlank,
  durationMinutes: z.number().positive().finite(),
  slideCount: z.number().int().positive().max(100),
  coreClaims: z.array(nonBlank).min(1).max(30),
  includedSourceIds: z.array(nonBlank).min(1),
  excludedSourceIds: z.array(nonBlank).optional(),
  styleId: projectId,
  citationPolicy: z.literal('inline_short_notes_full_references'),
  speakerNotesPolicy: z.literal('talking_points_transitions_timing_questions'),
  assumptions: z.array(nonBlank).optional(),
  state: z.enum(['draft', 'awaiting_confirmation', 'confirmed', 'compiled', 'needs_revision']),
  confirmedAt: z.string().datetime().optional(),
  confirmationHash: sha256.optional(),
  confirmedByRequestId: nonBlank.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === 'confirmed' || value.state === 'compiled') {
    if (!value.confirmedAt || !value.confirmationHash || !value.confirmedByRequestId) {
      ctx.addIssue({ code: 'custom', path: ['state'], message: 'confirmed/compiled Brief 必须包含确认收据' })
    }
  }
})

const slide = z.object({
  slideId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slideId 必须使用小写字母、数字和短横线'),
  claim: nonBlank,
  evidenceRefs: z.array(nonBlank).min(1),
  visualRole: z.enum(['title', 'section', 'assertion_evidence', 'chart', 'mechanism_diagram', 'comparison', 'image_with_annotation', 'limitations', 'conclusion', 'references']),
  layoutIntent: nonBlank,
  densityBudget: z.enum(['low', 'medium', 'high']),
  editableObjects: z.array(nonBlank).min(1),
  content: z.record(z.string(), z.unknown()),
  speakerNotes: z.array(nonBlank).min(1).max(12),
  citations: z.array(nonBlank),
}).strict()

const deckSpec = z.object({
  schemaVersion: z.literal(1).default(1),
  deckId: projectId,
  title: nonBlank,
  styleId: projectId,
  slides: z.array(slide).min(1).max(100),
  sourceHashes: z.record(z.string().min(1), sha256),
  compiledSlideCache: z.record(z.string(), z.object({ specHash: sha256, outputHash: sha256.optional() })).optional(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>()
  for (const item of value.slides) {
    if (ids.has(item.slideId)) ctx.addIssue({ code: 'custom', path: ['slides'], message: `slideId 重复: ${item.slideId}` })
    ids.add(item.slideId)
    for (const ref of item.evidenceRefs) {
      const sourceId = ref.split('#', 1)[0] ?? ''
      if (!value.sourceHashes[sourceId]) {
        ctx.addIssue({ code: 'custom', path: ['slides'], message: `evidenceRef 未绑定 source hash: ${ref}` })
      }
    }
  }
})

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`${label} 校验失败: ${issue?.path.join('.') || 'root'} ${issue?.message || 'invalid value'}`)
  }
  return result.data
}

export function parseDeckBrief(value: unknown): DeckBrief {
  return parse(brief, value, 'Deck Brief')
}

export function parseSourceLineage(value: unknown): DeckSourceLineage {
  return parse(lineage, value, 'Source Lineage')
}

export function parseDeckSpec(value: unknown): DeckSpec {
  return parse(deckSpec, value, 'Deck Spec')
}
