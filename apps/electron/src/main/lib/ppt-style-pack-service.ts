import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { registerProferFilePath } from './local-file-protocol'

const STYLE_PACK_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PREVIEW_ASSET_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:webp|png|jpe?g)$/i
const EXPECTED_PACK_IDS = ['academic-editorial', 'profer-cloud-dancer'] as const

export type PptStylePackId = typeof EXPECTED_PACK_IDS[number]

type UnknownRecord = Record<string, unknown>
type DensityBudget = 'low' | 'medium' | 'high'
type PptStylePackLayout = Record<DensityBudget, string[]>
type PptStylePackLayoutGrammar = Record<string, PptStylePackLayout> & {
  assertion_evidence: PptStylePackLayout
}

export interface PptStylePackTokens {
  canvas: { width: number; height: number; background: string }
  colors: Record<string, string>
  typography: {
    fontFallback: string[]
    titlePt: number
    sectionPt: number
    bodyPt: number
    captionPt: number
    pageNumberPt: number
    lineHeight: number
  }
  grid: { columns: number; gutter: number; marginX: number; marginY: number; safeArea: number }
  spacing: Record<string, number>
  lineWidthPt: Record<string, number>
  cornerRadius: number
}

export interface PptStylePackMotif {
  id: string
  kind: string
  editable: boolean
  maxPerSlide: number
  allowedRoles: string[]
}

export interface PptStylePackDefinition {
  schemaVersion: 1
  id: PptStylePackId
  name: string
  description: string
  tokens: PptStylePackTokens
  layoutGrammar: PptStylePackLayoutGrammar
  motifs: PptStylePackMotif[]
  chartLanguage: {
    seriesColors: string[]
    axisColor: string
    gridColor: string
    labelPt: number
    annotationStyle: string
    maxSeries: number
    minContrastRatio: number
  }
  imageDirection: {
    preferred: string[]
    aspectRatios: string[]
    treatment: string
    avoid: string[]
  }
  narrativeRhythm: {
    sequence: string[]
    densitySwing: string
    chapterBreatherEvery: number
    avoidRepeatingLayoutMoreThan: number
  }
  qaProfile: {
    minBodyPt: number
    minCaptionPt: number
    maxContentMotifs: number
    maxTextRatio: number
    forbidden: string[]
    required: string[]
  }
  editorialPolicy: {
    mode: 'scientific-editorial' | 'general-editorial'
    headlineStyle: 'evidence-statement' | 'narrative'
    requireMetricDefinition: boolean
    requireNativeQuantitativeVisual: boolean
    requireConclusionBoundary: boolean
    forbiddenHeadlinePatterns: string[]
    narrativeRoles: string[]
  }
  preview: { asset: string; alt: string }
}

export interface PptStylePack {
  id: PptStylePackId
  name: string
  description: string
  definition: PptStylePackDefinition
  preview: string
  previewUrl: string
}

export interface PptStylePackServiceOptions {
  resourceRoot?: string
  registerPreviewPath?: (path: string) => string
}

function getBuiltinStylePackRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'ppt-style-packs')
    : join(__dirname, 'resources', 'ppt-style-packs')
}

function isPathInside(root: string, target: string): boolean {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const rootKey = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath
  const targetKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
  return targetKey === rootKey || targetKey.startsWith(rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} 必须是非空字符串`)
  return value
}

function requireRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} 必须是对象`)
  return value as UnknownRecord
}

function validateDefinition(raw: unknown, expectedId?: string): PptStylePackDefinition {
  const value = requireRecord(raw, 'pack.json')
  if (value.schemaVersion !== 1) throw new Error('pack.json schemaVersion 必须为 1')
  const id = requireString(value.id, 'pack.json.id')
  if (!STYLE_PACK_ID_RE.test(id)) throw new Error('pack.json.id 格式无效')
  if (expectedId && id !== expectedId) throw new Error(`pack.json.id 与目录不一致: ${expectedId}`)
  if (!EXPECTED_PACK_IDS.includes(id as PptStylePackId)) throw new Error(`未知 Style Pack: ${id}`)

  const definition: PptStylePackDefinition = {
    schemaVersion: 1,
    id: id as PptStylePackId,
    name: requireString(value.name, 'pack.json.name'),
    description: requireString(value.description, 'pack.json.description'),
    tokens: requireRecord(value.tokens, 'pack.json.tokens') as unknown as PptStylePackTokens,
    layoutGrammar: requireRecord(value.layoutGrammar, 'pack.json.layoutGrammar') as PptStylePackLayoutGrammar,
    motifs: Array.isArray(value.motifs) ? value.motifs.map((motif, index) => requireRecord(motif, `pack.json.motifs[${index}]`) as unknown as PptStylePackMotif) : (() => { throw new Error('pack.json.motifs 必须是数组') })(),
    chartLanguage: requireRecord(value.chartLanguage, 'pack.json.chartLanguage') as PptStylePackDefinition['chartLanguage'],
    imageDirection: requireRecord(value.imageDirection, 'pack.json.imageDirection') as PptStylePackDefinition['imageDirection'],
    narrativeRhythm: requireRecord(value.narrativeRhythm, 'pack.json.narrativeRhythm') as PptStylePackDefinition['narrativeRhythm'],
    qaProfile: requireRecord(value.qaProfile, 'pack.json.qaProfile') as PptStylePackDefinition['qaProfile'],
    editorialPolicy: (() => {
      const policy = requireRecord(value.editorialPolicy, 'pack.json.editorialPolicy')
      const mode = requireString(policy.mode, 'pack.json.editorialPolicy.mode')
      if (mode !== 'scientific-editorial' && mode !== 'general-editorial') throw new Error('pack.json.editorialPolicy.mode 无效')
      const headlineStyle = requireString(policy.headlineStyle, 'pack.json.editorialPolicy.headlineStyle')
      if (headlineStyle !== 'evidence-statement' && headlineStyle !== 'narrative') throw new Error('pack.json.editorialPolicy.headlineStyle 无效')
      return {
        mode,
        headlineStyle,
        requireMetricDefinition: policy.requireMetricDefinition === true,
        requireNativeQuantitativeVisual: policy.requireNativeQuantitativeVisual === true,
        requireConclusionBoundary: policy.requireConclusionBoundary === true,
        forbiddenHeadlinePatterns: Array.isArray(policy.forbiddenHeadlinePatterns) ? policy.forbiddenHeadlinePatterns.map((value) => requireString(value, 'pack.json.editorialPolicy.forbiddenHeadlinePatterns')) : [],
        narrativeRoles: Array.isArray(policy.narrativeRoles) ? policy.narrativeRoles.map((value) => requireString(value, 'pack.json.editorialPolicy.narrativeRoles')) : [],
      } satisfies PptStylePackDefinition['editorialPolicy']
    })(),
    preview: (() => {
      const preview = requireRecord(value.preview, 'pack.json.preview')
      return {
        asset: requireString(preview.asset, 'pack.json.preview.asset'),
        alt: requireString(preview.alt, 'pack.json.preview.alt'),
      }
    })(),
  }

  if (!PREVIEW_ASSET_RE.test(definition.preview.asset) || isAbsolute(definition.preview.asset) || definition.preview.asset.includes('..')) {
    throw new Error('pack.json.preview.asset 只能是包目录内的受控图片文件名')
  }
  return definition
}

function readDefinition(packDir: string, expectedId: string): PptStylePackDefinition {
  const packPath = join(packDir, 'pack.json')
  if (!existsSync(packPath)) throw new Error(`Style Pack 缺少 pack.json: ${expectedId}`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(packPath, 'utf8'))
  } catch (error) {
    throw new Error(`Style Pack pack.json 无法解析: ${expectedId} (${error instanceof Error ? error.message : String(error)})`)
  }
  return validateDefinition(raw, expectedId)
}

function buildPack(packDir: string, expectedId: string, options: PptStylePackServiceOptions): PptStylePack {
  const definition = readDefinition(packDir, expectedId)
  const previewPath = resolve(packDir, definition.preview.asset)
  if (!isPathInside(packDir, previewPath)) throw new Error('preview.asset 越界')
  if (!existsSync(previewPath) || !statSync(previewPath).isFile()) throw new Error(`Style Pack 预览资源不存在: ${expectedId}`)

  const register = options.registerPreviewPath ?? registerProferFilePath
  const previewUrl = register(previewPath)
  if (!/^profer-file:\/\/[^/]+$/.test(previewUrl)) throw new Error('Style Pack 预览注册必须返回 opaque profer-file URL')

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    definition,
    previewUrl,
    preview: `![${definition.preview.alt}](${previewUrl})`,
  }
}

export function listPptStylePacks(options: PptStylePackServiceOptions = {}): PptStylePack[] {
  const resourceRoot = resolve(options.resourceRoot ?? getBuiltinStylePackRoot())
  if (!existsSync(resourceRoot) || !statSync(resourceRoot).isDirectory()) throw new Error(`PPT Style Pack 资源目录不存在: ${resourceRoot}`)

  // 只按内置白名单读取，避免资源目录中新增任意目录后被 Agent 自动暴露。
  return EXPECTED_PACK_IDS.map((id) => buildPack(join(resourceRoot, id), id, options))
}

export function getPptStylePack(id: string, options: PptStylePackServiceOptions = {}): PptStylePack {
  if (!EXPECTED_PACK_IDS.includes(id as PptStylePackId)) throw new Error(`未知 Style Pack: ${id}`)
  const resourceRoot = resolve(options.resourceRoot ?? getBuiltinStylePackRoot())
  return buildPack(join(resourceRoot, id), id, options)
}

/** 编译器只读取受控设计契约，不注册 preview URL，也不会接触用户自定义路径。 */
export function getPptStylePackDefinition(id: string, options: Pick<PptStylePackServiceOptions, 'resourceRoot'> = {}): PptStylePackDefinition {
  if (!EXPECTED_PACK_IDS.includes(id as PptStylePackId)) throw new Error(`未知 Style Pack: ${id}`)
  const resourceRoot = resolve(options.resourceRoot ?? getBuiltinStylePackRoot())
  const packDir = join(resourceRoot, id)
  const definition = readDefinition(packDir, id)
  const previewPath = resolve(packDir, definition.preview.asset)
  if (!isPathInside(packDir, previewPath) || !existsSync(previewPath) || !statSync(previewPath).isFile()) {
    throw new Error(`Style Pack 预览资源不存在或越界: ${id}`)
  }
  return definition
}

/** 仅用于诊断和测试：返回当前 Style Pack 资源的相对 preview 路径，不暴露给 Agent。 */
export function getPptStylePackPreviewAssetPath(id: string, options: PptStylePackServiceOptions = {}): string {
  const pack = getPptStylePack(id, { ...options, registerPreviewPath: (path) => path })
  const resourceRoot = resolve(options.resourceRoot ?? getBuiltinStylePackRoot())
  const packDir = join(resourceRoot, id)
  return relative(packDir, resolve(packDir, pack.definition.preview.asset)).replace(/\\/g, '/')
}
