/** PPT Deck Project 领域合同。领域服务和 Claude/Pi 工具共享这些类型。 */

export type DeckSourceStatus = 'current' | 'superseded' | 'historical' | 'conflicted' | 'unknown'

export type DeckSourceKind = 'document' | 'spreadsheet' | 'presentation' | 'image' | 'text' | 'data' | 'unknown'

export type DeckProjectState = 'draft' | 'awaiting_confirmation' | 'confirmed' | 'compiled' | 'needs_revision'

export type DeckDensityBudget = 'low' | 'medium' | 'high'

export type DeckVisualRole =
  | 'title'
  | 'section'
  | 'assertion_evidence'
  | 'chart'
  | 'mechanism_diagram'
  | 'comparison'
  | 'image_with_annotation'
  | 'limitations'
  | 'conclusion'
  | 'references'

export interface DeckSourceRecord {
  id: string
  absolutePath: string
  relativePath: string
  kind: DeckSourceKind
  size: number
  mtimeMs: number
  contentHash: string
  status: DeckSourceStatus
  locator?: string
  title?: string
  excerpt?: string
  versionSignals?: string[]
}

export interface DeckSourceLineage {
  schemaVersion: 1
  sources: DeckSourceRecord[]
  conflicts?: string[]
  gaps?: string[]
}

export interface DeckBrief {
  schemaVersion: 1
  deckId: string
  goal: string
  audience: string
  occasion: string
  durationMinutes: number
  slideCount: number
  coreClaims: string[]
  includedSourceIds: string[]
  excludedSourceIds?: string[]
  styleId: string
  citationPolicy: 'inline_short_notes_full_references'
  speakerNotesPolicy: 'talking_points_transitions_timing_questions'
  assumptions?: string[]
  state: DeckProjectState
  confirmedAt?: string
  confirmationHash?: string
  confirmedByRequestId?: string
}

export interface DeckSlideSpec {
  slideId: string
  claim: string
  evidenceRefs: string[]
  visualRole: DeckVisualRole
  layoutIntent: string
  densityBudget: DeckDensityBudget
  editableObjects: string[]
  content: Record<string, unknown>
  speakerNotes: string[]
  citations: string[]
  assetRefs?: string[]
}

export interface DeckSpec {
  schemaVersion: 1
  deckId: string
  title: string
  styleId: string
  slides: DeckSlideSpec[]
  sourceHashes: Record<string, string>
  compiledSlideCache?: Record<string, { specHash: string; outputHash?: string }>
}

export interface DeckProjectManifest {
  schemaVersion: 1
  deckId: string
  state: DeckProjectState
  projectDir: string
  briefPath: string
  contextManifestPath: string
  sourceLineagePath: string
  deckSpecPath: string
  stylePackPath: string
  outputDir: string
  previewPath?: string
  confirmationTokenHash?: string
}
