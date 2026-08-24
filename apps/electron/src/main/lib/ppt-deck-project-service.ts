import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { DeckBrief, DeckProjectManifest, DeckProjectState, DeckSpec } from '@profer/shared'
import { parseDeckBrief } from './ppt-deck-schema'

const DECK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONFIRMATION_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/
const PROJECT_DIR_NAME = 'deck-projects'
const REQUIRED_JSON_FILES = [
  'brief.json',
  'context-manifest.json',
  'source-lineage.json',
  'deck-spec.json',
  'style-pack.json',
  'sources.json',
] as const
const REQUIRED_DIRECTORIES = ['assets', 'src', 'renders', 'qa', 'output'] as const

const pendingConfirmationTokens = new Map<string, { hash: string; issuedAt: number }>()

export type DeckProjectErrorCode =
  | 'DECK_PROJECT_INVALID_INPUT'
  | 'DECK_PROJECT_PATH_FORBIDDEN'
  | 'DECK_PROJECT_EXISTS'
  | 'DECK_PROJECT_MISSING_FILE'
  | 'DECK_PROJECT_INVALID_JSON'
  | 'DECK_PROJECT_CONFIRMATION_REQUIRED'
  | 'DECK_PROJECT_CONFIRMATION_TOKEN_INVALID'
  | 'DECK_PROJECT_CONFIRMATION_TOKEN_UNAVAILABLE'
  | 'DECK_PROJECT_BRIEF_CHANGED'

export class DeckProjectError extends Error {
  readonly code: DeckProjectErrorCode
  readonly projectDir?: string
  readonly file?: string

  constructor(code: DeckProjectErrorCode, message: string, details: { projectDir?: string; file?: string } = {}) {
    super(message)
    this.name = 'DeckProjectError'
    this.code = code
    this.projectDir = details.projectDir
    this.file = details.file
  }
}

export interface CreateDeckProjectInput {
  agentCwd: string
  brief: DeckBrief
}

export interface DeckProjectSnapshot {
  manifest: DeckProjectManifest & { confirmationTokenHash?: string; generatedAt?: string }
  brief: DeckBrief
  contextManifest: Record<string, unknown>
  sourceLineage: Record<string, unknown>
  deckSpec: unknown
  stylePack: Record<string, unknown>
  sources: unknown
}

export interface RecordDeckBriefConfirmationInput {
  projectDir: string
  confirmationToken: string
  requestId: string
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested
    return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  })
}

function normalizeBriefForConfirmation(input: DeckBrief): DeckBrief {
  const { confirmedAt: _confirmedAt, confirmationHash: _confirmationHash, confirmedByRequestId: _requestId, ...rest } = input
  return { ...rest, state: 'awaiting_confirmation' }
}

function briefConfirmationHash(input: DeckBrief): string {
  return hashText(stableJson(normalizeBriefForConfirmation(input)))
}

function validateDeckId(deckId: string): void {
  if (!DECK_ID_RE.test(deckId)) throw new DeckProjectError('DECK_PROJECT_INVALID_INPUT', `deckId 非法: ${deckId}`)
}

function validateRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new DeckProjectError('DECK_PROJECT_INVALID_INPUT', 'requestId 必须是非空字符串')
  }
}

function normalizeExistingDirectory(path: string, label: string): string {
  try {
    const resolved = realpathSync(resolve(path))
    if (!statSync(resolved).isDirectory()) throw new Error('not directory')
    return resolved
  } catch {
    throw new DeckProjectError('DECK_PROJECT_INVALID_INPUT', `${label} 不存在或不是目录`)
  }
}

function pathKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isInside(root: string, target: string, allowRoot = false): boolean {
  const rootKey = pathKey(root)
  const targetKey = pathKey(target)
  if (rootKey === targetKey) return allowRoot
  const prefix = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`
  return targetKey.startsWith(prefix)
}

function projectDirectoryFor(agentCwd: string, deckId: string): string {
  return join(agentCwd, '.context', PROJECT_DIR_NAME, deckId)
}

function validateProjectPath(projectDir: string): string {
  const requested = resolve(projectDir)
  const deckId = basename(requested)
  const projectsDir = basename(dirname(requested))
  const contextDir = basename(dirname(dirname(requested)))
  if (!DECK_ID_RE.test(deckId) || projectsDir !== PROJECT_DIR_NAME || contextDir !== '.context') {
    throw new DeckProjectError('DECK_PROJECT_PATH_FORBIDDEN', 'projectDir 必须位于 <agentCwd>/.context/deck-projects/<deckId>', { projectDir })
  }

  let realProject: string
  try {
    realProject = realpathSync(requested)
    if (!statSync(realProject).isDirectory()) throw new Error('not directory')
  } catch {
    throw new DeckProjectError('DECK_PROJECT_MISSING_FILE', 'Deck Project 目录不存在', { projectDir })
  }

  // projectDir 自身不能通过 symlink 逃逸；同时确保其父级仍是约定的 deck-projects 目录。
  const realProjectsDir = realpathSync(dirname(requested))
  if (!isInside(realProjectsDir, realProject) || basename(realProject) !== deckId || basename(realProjectsDir) !== PROJECT_DIR_NAME) {
    throw new DeckProjectError('DECK_PROJECT_PATH_FORBIDDEN', 'Deck Project 路径越界或不是受管项目目录', { projectDir })
  }
  return realProject
}

function requiredPath(projectDir: string, file: string): string {
  const target = join(projectDir, file)
  if (!isInside(projectDir, target)) {
    throw new DeckProjectError('DECK_PROJECT_PATH_FORBIDDEN', `项目文件路径越界: ${file}`, { projectDir, file })
  }
  return target
}

function ensureRequiredFiles(projectDir: string): void {
  for (const file of REQUIRED_JSON_FILES) {
    const target = requiredPath(projectDir, file)
    if (!existsSync(target)) throw new DeckProjectError('DECK_PROJECT_MISSING_FILE', `Deck Project 缺少 ${file}`, { projectDir, file })
    try {
      if (!lstatSync(target).isFile()) throw new Error('not file')
    } catch {
      throw new DeckProjectError('DECK_PROJECT_MISSING_FILE', `Deck Project 缺少 ${file}`, { projectDir, file })
    }
  }
  for (const directory of REQUIRED_DIRECTORIES) {
    const target = requiredPath(projectDir, directory)
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      throw new DeckProjectError('DECK_PROJECT_MISSING_FILE', `Deck Project 缺少目录 ${directory}`, { projectDir, file: directory })
    }
  }
}

function readJson(projectDir: string, file: string): Record<string, unknown> {
  const target = requiredPath(projectDir, file)
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new DeckProjectError(
      'DECK_PROJECT_INVALID_JSON',
      `${file} 不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`,
      { projectDir, file },
    )
  }
}

function writeJsonAtomic(projectDir: string, file: string, value: unknown): void {
  const target = requiredPath(projectDir, file)
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(temp, target)
  } catch (error) {
    // Windows 无法直接覆盖既有文件时，退回同目录替换；临时文件仍保证不会留下半写 JSON。
    try {
      rmSync(target, { force: true })
      renameSync(temp, target)
    } catch {
      rmSync(temp, { force: true })
      throw error
    }
  }
}

function resourceStylePack(brief: DeckBrief): Record<string, unknown> {
  const candidates = [
    join(__dirname, 'resources', 'ppt-style-packs', brief.styleId, 'pack.json'),
    join(__dirname, '../../../resources', 'ppt-style-packs', brief.styleId, 'pack.json'),
    process.resourcesPath ? join(process.resourcesPath, 'ppt-style-packs', brief.styleId, 'pack.json') : '',
  ].filter(Boolean)
  const source = candidates.find((path) => existsSync(path))
  if (!source) throw new DeckProjectError('DECK_PROJECT_INVALID_INPUT', `找不到内置 Style Pack: ${brief.styleId}`)
  try {
    return JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new DeckProjectError('DECK_PROJECT_INVALID_INPUT', `Style Pack 无法解析: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildManifest(projectDir: string, brief: DeckBrief, state: DeckProjectState): DeckProjectManifest {
  return {
    schemaVersion: 1,
    deckId: brief.deckId,
    state,
    projectDir,
    briefPath: join(projectDir, 'brief.json'),
    contextManifestPath: join(projectDir, 'context-manifest.json'),
    sourceLineagePath: join(projectDir, 'source-lineage.json'),
    deckSpecPath: join(projectDir, 'deck-spec.json'),
    stylePackPath: join(projectDir, 'style-pack.json'),
    outputDir: join(projectDir, 'output'),
  }
}

/** Create a session-local Deck Project and force it into awaiting_confirmation. */
export async function createDeckProject(input: CreateDeckProjectInput): Promise<DeckProjectManifest> {
  const agentCwd = normalizeExistingDirectory(input.agentCwd, 'agentCwd')
  const parsed = parseDeckBrief(input.brief)
  validateDeckId(parsed.deckId)
  const projectDir = projectDirectoryFor(agentCwd, parsed.deckId)
  if (existsSync(projectDir)) throw new DeckProjectError('DECK_PROJECT_EXISTS', `Deck Project 已存在: ${parsed.deckId}`, { projectDir })

  const awaitingBrief: DeckBrief = {
    ...parsed,
    state: 'awaiting_confirmation',
    confirmedAt: undefined,
    confirmationHash: undefined,
    confirmedByRequestId: undefined,
  }
  // 删除 undefined 字段，避免把伪造确认字段落盘。
  const cleanBrief = JSON.parse(JSON.stringify(awaitingBrief)) as DeckBrief
  mkdirSync(projectDir, { recursive: true })
  for (const directory of REQUIRED_DIRECTORIES) mkdirSync(join(projectDir, directory), { recursive: true })

  const manifest = buildManifest(projectDir, cleanBrief, 'awaiting_confirmation')
  const contextManifest = {
    schemaVersion: 1,
    deckId: cleanBrief.deckId,
    state: 'awaiting_confirmation',
    generatedAt: new Date().toISOString(),
  }
  const sourceLineage = { schemaVersion: 1, sources: [], conflicts: [], gaps: [] }
  const deckSpec = {
    schemaVersion: 1,
    deckId: cleanBrief.deckId,
    title: cleanBrief.goal,
    styleId: cleanBrief.styleId,
    slides: [],
    sourceHashes: {},
  }
  const sources = { schemaVersion: 1, sources: [] }
  try {
    writeJsonAtomic(projectDir, 'brief.json', cleanBrief)
    writeJsonAtomic(projectDir, 'context-manifest.json', contextManifest)
    writeJsonAtomic(projectDir, 'source-lineage.json', sourceLineage)
    writeJsonAtomic(projectDir, 'deck-spec.json', deckSpec)
    writeJsonAtomic(projectDir, 'style-pack.json', resourceStylePack(cleanBrief))
    writeJsonAtomic(projectDir, 'sources.json', sources)
  } catch (error) {
    rmSync(projectDir, { recursive: true, force: true })
    throw error
  }
  return manifest
}

export async function readDeckProject(projectDir: string): Promise<DeckProjectSnapshot> {
  const safeProjectDir = validateProjectPath(projectDir)
  ensureRequiredFiles(safeProjectDir)
  const rawBrief = readJson(safeProjectDir, 'brief.json')
  let parsedBrief: DeckBrief
  try {
    parsedBrief = parseDeckBrief(rawBrief)
  } catch (error) {
    throw new DeckProjectError('DECK_PROJECT_INVALID_JSON', error instanceof Error ? error.message : String(error), { projectDir: safeProjectDir, file: 'brief.json' })
  }
  const contextManifest = readJson(safeProjectDir, 'context-manifest.json')
  const sourceLineage = readJson(safeProjectDir, 'source-lineage.json')
  const deckSpec = readJson(safeProjectDir, 'deck-spec.json')
  const stylePack = readJson(safeProjectDir, 'style-pack.json')
  const sources = readJson(safeProjectDir, 'sources.json')
  const manifest = {
    ...buildManifest(safeProjectDir, parsedBrief, parsedBrief.state),
    ...(contextManifest.confirmationTokenHash ? { confirmationTokenHash: String(contextManifest.confirmationTokenHash) } : {}),
    ...(contextManifest.generatedAt ? { generatedAt: String(contextManifest.generatedAt) } : {}),
  }
  return { manifest, brief: parsedBrief, contextManifest, sourceLineage, deckSpec, stylePack, sources }
}

export async function writeDeckSpec(projectDir: string, spec: DeckSpec): Promise<void> {
  const safeProjectDir = validateProjectPath(projectDir)
  ensureRequiredFiles(safeProjectDir)
  const current = readJson(safeProjectDir, 'brief.json')
  const deckId = typeof current.deckId === 'string' ? current.deckId : undefined
  if (spec.deckId !== deckId) throw new DeckProjectError('DECK_PROJECT_INVALID_INPUT', 'Deck Spec deckId 与项目不一致', { projectDir: safeProjectDir, file: 'deck-spec.json' })
  writeJsonAtomic(safeProjectDir, 'deck-spec.json', spec)
}

/** Issue a one-time high entropy token; only its SHA-256 is persisted. */
export async function getDeckBriefConfirmationToken(projectDir: string): Promise<string> {
  const snapshot = await readDeckProject(projectDir)
  if (snapshot.brief.state !== 'awaiting_confirmation') {
    throw new DeckProjectError('DECK_PROJECT_CONFIRMATION_TOKEN_UNAVAILABLE', '当前 Brief 不在待确认状态', { projectDir })
  }
  const safeProjectDir = snapshot.manifest.projectDir
  const existing = pendingConfirmationTokens.get(safeProjectDir)
  if (existing) throw new DeckProjectError('DECK_PROJECT_CONFIRMATION_TOKEN_UNAVAILABLE', '确认 token 已签发，不能重复获取', { projectDir })

  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashText(token)
  const contextManifest = { ...snapshot.contextManifest, confirmationTokenHash: tokenHash, state: 'awaiting_confirmation' }
  writeJsonAtomic(safeProjectDir, 'context-manifest.json', contextManifest)
  pendingConfirmationTokens.set(safeProjectDir, { hash: tokenHash, issuedAt: Date.now() })
  return token
}

export async function recordDeckBriefConfirmation(input: RecordDeckBriefConfirmationInput): Promise<void> {
  if (!CONFIRMATION_TOKEN_RE.test(input.confirmationToken)) {
    throw new DeckProjectError('DECK_PROJECT_CONFIRMATION_TOKEN_INVALID', 'confirmation token 格式无效', { projectDir: input.projectDir })
  }
  validateRequestId(input.requestId)
  const snapshot = await readDeckProject(input.projectDir)
  const safeProjectDir = snapshot.manifest.projectDir
  const expected = pendingConfirmationTokens.get(safeProjectDir)
  const actualHash = hashText(input.confirmationToken)
  const storedHash = typeof snapshot.contextManifest.confirmationTokenHash === 'string' ? snapshot.contextManifest.confirmationTokenHash : ''
  if (!expected || expected.hash !== actualHash || storedHash !== actualHash) {
    throw new DeckProjectError('DECK_PROJECT_CONFIRMATION_TOKEN_INVALID', 'confirmation token 不匹配或已失效', { projectDir: safeProjectDir })
  }

  const confirmationHash = briefConfirmationHash(snapshot.brief)
  const confirmedBrief: DeckBrief = {
    ...snapshot.brief,
    state: 'confirmed',
    confirmedAt: new Date().toISOString(),
    confirmationHash,
    confirmedByRequestId: input.requestId,
  }
  writeJsonAtomic(safeProjectDir, 'brief.json', confirmedBrief)
  writeJsonAtomic(safeProjectDir, 'context-manifest.json', {
    ...snapshot.contextManifest,
    state: 'confirmed',
    confirmationTokenHash: storedHash,
  })
  pendingConfirmationTokens.delete(safeProjectDir)
}

/** Confirmation is a separate hard gate; Deck Spec completeness is checked by the compiler. */
export async function assertDeckCompilable(projectDir: string): Promise<DeckProjectSnapshot> {
  const safeProjectDir = resolve(projectDir)
  // 先检查结构文件存在，再解析 Brief；这样损坏 Brief 不会掩盖更直接的缺文件错误。
  const validatedDir = validateProjectPath(safeProjectDir)
  ensureRequiredFiles(validatedDir)
  const snapshot = await readDeckProject(validatedDir)
  if (snapshot.brief.state !== 'confirmed' && snapshot.brief.state !== 'compiled') {
    throw new DeckProjectError('DECK_PROJECT_CONFIRMATION_REQUIRED', 'Deck Brief 尚未获得用户确认，禁止编译', { projectDir: validatedDir })
  }
  if (!snapshot.brief.confirmedAt || !snapshot.brief.confirmationHash || !snapshot.brief.confirmedByRequestId) {
    throw new DeckProjectError('DECK_PROJECT_CONFIRMATION_REQUIRED', 'Deck Brief 缺少完整确认收据，禁止编译', { projectDir: validatedDir })
  }
  const expectedBriefHash = briefConfirmationHash(snapshot.brief)
  if (expectedBriefHash !== snapshot.brief.confirmationHash) {
    throw new DeckProjectError('DECK_PROJECT_BRIEF_CHANGED', 'Deck Brief 已被修改，旧确认收据失效，必须重新确认', { projectDir: validatedDir, file: 'brief.json' })
  }
  return snapshot
}
