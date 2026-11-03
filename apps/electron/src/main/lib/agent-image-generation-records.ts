import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentImageGenerationCard, AgentImageGenerationReference, AgentImageGenerationStatus } from '@profer/shared'
import { normalizeGptImageQuality, normalizeGptImageSize, type GptImageQuality, type GptImageSize } from './gpt-image-service'
import type { AgentImageMediaType } from './agent-image-output-service'

const RECORD_VERSION = 1 as const
const RECORD_FILE = 'image-generations.jsonl'
const MAX_PROMPT_LENGTH = 10_000
const MAX_ERROR_LENGTH = 500
const VALID_STATUSES = new Set<AgentImageGenerationStatus>(['requesting', 'saving', 'succeeded', 'failed'])
const VALID_MEDIA_TYPES = new Set<AgentImageMediaType>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Durable main-process record. Reference paths are deliberately never persisted. */
export interface AgentImageGenerationRecord extends AgentImageGenerationCard {}

export interface AgentImageGenerationRecordContext {
  sessionId: string
  /** 会话工作目录（相对路径基准）；project 下是项目根，**不是**记录落点。 */
  agentCwd: string
  /**
   * 会话私有存储根（`resolveAgentSessionWriteLayout().storageDir`）。
   * jsonl 必须落在这里：project 下它不在项目内；缺省回落到 agentCwd 保持 managed/旧调用方语义。
   */
  storageDir?: string
}

export interface CreateAgentImageGenerationRecordInput {
  sessionId: string
  agentCwd: string
  storageDir?: string
  toolCallId: string
  prompt: string
  size?: GptImageSize
  quality?: GptImageQuality
  reference: AgentImageGenerationReference
  retryOf?: string
}

export interface ImageGenerationTransition {
  status: Exclude<AgentImageGenerationStatus, 'requesting'>
  image?: AgentImageGenerationCard['image']
  revisedPrompt?: string
  mode?: 'official' | 'byok'
  chargedCredits?: 5
  error?: string
  completedAt?: number
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function validReference(value: unknown): AgentImageGenerationReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'none' && kind !== 'paths' && kind !== 'last_generated') return undefined
  const generationId = boundedText(record.generationId, 200)
  return generationId ? { kind, generationId } : { kind }
}

function validImage(value: unknown): AgentImageGenerationCard['image'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const localPath = boundedText(record.localPath, 4096)
  const filename = boundedText(record.filename, 512)
  const mediaType = record.mediaType
  if (!localPath || !filename || typeof mediaType !== 'string' || !VALID_MEDIA_TYPES.has(mediaType as AgentImageMediaType)) return undefined
  return { localPath, filename, mediaType: mediaType as AgentImageMediaType }
}

function parseRecord(value: unknown): AgentImageGenerationRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (raw.version !== RECORD_VERSION || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200) return undefined
  const sessionId = boundedText(raw.sessionId, 200)
  const toolCallId = boundedText(raw.toolCallId, 200)
  const prompt = boundedText(raw.prompt, MAX_PROMPT_LENGTH)
  const reference = validReference(raw.reference)
  const status = raw.status
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined
  if (!sessionId || !toolCallId || !prompt || !reference || !createdAt || !updatedAt || typeof status !== 'string' || !VALID_STATUSES.has(status as AgentImageGenerationStatus)) return undefined
  const image = validImage(raw.image)
  const revisedPrompt = boundedText(raw.revisedPrompt, MAX_PROMPT_LENGTH)
  const error = boundedText(raw.error, MAX_ERROR_LENGTH)
  const mode = raw.mode === 'official' || raw.mode === 'byok' ? raw.mode : undefined
  const completedAt = typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt) ? raw.completedAt : undefined
  const retryOf = boundedText(raw.retryOf, 200)
  if (status === 'succeeded' && !image) return undefined
  return {
    version: RECORD_VERSION, id: raw.id, sessionId, toolCallId, status: status as AgentImageGenerationStatus,
    prompt, size: normalizeGptImageSize(raw.size), quality: normalizeGptImageQuality(raw.quality), reference,
    ...(image ? { image } : {}),
    ...(revisedPrompt ? { revisedPrompt } : {}), ...(mode ? { mode } : {}),
    ...(mode === 'official' && raw.chargedCredits === 5 ? { chargedCredits: 5 as const } : {}),
    ...(error ? { error } : {}), createdAt, updatedAt,
    ...(completedAt ? { completedAt } : {}), ...(retryOf ? { retryOf } : {}),
  }
}

async function normalizedAgentCwd(agentCwd: string): Promise<string> {
  if (!agentCwd.trim()) throw new Error('当前会话没有可写的 Agent 工作目录')
  return realpath(resolve(agentCwd))
}

/** 记录根：project 下在中央 storageDir，managed 下就是 cwd。 */
function recordRoot(context: { agentCwd: string; storageDir?: string }): string {
  return context.storageDir?.trim() ? context.storageDir : context.agentCwd
}

export async function getAgentImageGenerationRecordsPath(agentCwd: string, storageDir?: string): Promise<string> {
  const root = storageDir?.trim() ? storageDir : agentCwd
  return join(await normalizedAgentCwd(root), '.context', RECORD_FILE)
}

async function appendRecord(record: AgentImageGenerationRecord, context: { agentCwd: string; storageDir?: string }): Promise<void> {
  const root = recordRoot(context)
  const path = await getAgentImageGenerationRecordsPath(context.agentCwd, context.storageDir)
  await mkdir(join(await normalizedAgentCwd(root), '.context'), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

function isWithinRoot(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

async function replay(context: AgentImageGenerationRecordContext): Promise<AgentImageGenerationRecord[]> {
  const root = recordRoot(context)
  const storageRoot = await normalizedAgentCwd(root)
  // persisted output paths may use the non-canonical long Windows path while
  // realpath(agentCwd) returns an 8.3 alias; use the lexical session root for
  // containment as well as the canonical cwd to avoid rejecting our own output.
  const outputRoots = [
    resolve(root, '.context', 'agent-output-images'),
    resolve(storageRoot, '.context', 'agent-output-images'),
  ]
  let contents: string
  try { contents = await readFile(await getAgentImageGenerationRecordsPath(context.agentCwd, context.storageDir), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const latest = new Map<string, AgentImageGenerationRecord>()
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = parseRecord(JSON.parse(line))
      if (!record || record.sessionId !== context.sessionId) continue
      // JSONL is session-local but must still be treated as untrusted persisted input: a
      // tampered image path must never turn a card into a renderer file-read capability.
      if (record.image && !outputRoots.some((root) => isWithinRoot(root, resolve(record.image!.localPath)))) continue
      const existing = latest.get(record.id)
      if (!existing || record.updatedAt >= existing.updatedAt) latest.set(record.id, record)
    } catch { console.warn('[图片生成记录] 忽略损坏的会话记录行') }
  }
  return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function toAgentImageGenerationCard(record: AgentImageGenerationRecord): AgentImageGenerationCard {
  return record
}

export async function createImageGenerationRecord(input: CreateAgentImageGenerationRecordInput): Promise<AgentImageGenerationRecord> {
  const prompt = boundedText(input.prompt, MAX_PROMPT_LENGTH)
  const toolCallId = boundedText(input.toolCallId, 200)
  if (!prompt || !toolCallId || !input.sessionId.trim()) throw new Error('图片生成记录参数无效')
  const now = Date.now()
  const record: AgentImageGenerationRecord = {
    version: RECORD_VERSION, id: randomUUID(), sessionId: input.sessionId, toolCallId, status: 'requesting', prompt,
    size: normalizeGptImageSize(input.size), quality: normalizeGptImageQuality(input.quality), reference: input.reference,
    ...(input.retryOf ? { retryOf: input.retryOf } : {}), createdAt: now, updatedAt: now,
  }
  await appendRecord(record, input)
  return record
}

function canTransition(from: AgentImageGenerationStatus, to: ImageGenerationTransition['status']): boolean {
  return (from === 'requesting' && (to === 'saving' || to === 'failed')) || (from === 'saving' && (to === 'succeeded' || to === 'failed'))
}

export async function transitionImageGenerationRecord(
  context: AgentImageGenerationRecordContext,
  id: string,
  transition: ImageGenerationTransition,
): Promise<AgentImageGenerationRecord> {
  const existing = (await replay(context)).find((record) => record.id === id)
  if (!existing) throw new Error('图片生成记录不存在或不属于当前会话')
  if (!canTransition(existing.status, transition.status)) throw new Error('图片生成状态转换无效')
  if (transition.status === 'succeeded' && !transition.image) throw new Error('成功的图片生成记录必须包含图片产物')
  const now = Date.now()
  const record: AgentImageGenerationRecord = {
    ...existing, status: transition.status, updatedAt: now,
    ...(transition.image ? { image: transition.image } : {}),
    ...(transition.revisedPrompt ? { revisedPrompt: transition.revisedPrompt.slice(0, MAX_PROMPT_LENGTH) } : {}),
    ...(transition.mode ? { mode: transition.mode } : {}),
    ...(transition.mode === 'official' && transition.chargedCredits === 5 ? { chargedCredits: 5 as const } : {}),
    ...(transition.error ? { error: transition.error.slice(0, MAX_ERROR_LENGTH) } : {}),
    ...((transition.status === 'succeeded' || transition.status === 'failed') ? { completedAt: transition.completedAt ?? now } : {}),
  }
  await appendRecord(record, context)
  return record
}

export async function listImageGenerationCards(context: AgentImageGenerationRecordContext): Promise<AgentImageGenerationCard[]> {
  return (await replay(context)).map(toAgentImageGenerationCard)
}

export async function getLatestSuccessfulGeneration(context: AgentImageGenerationRecordContext): Promise<AgentImageGenerationRecord | undefined> {
  const records = await replay(context)
  for (let index = records.length - 1; index >= 0; index--) if (records[index]!.status === 'succeeded') return records[index]
  return undefined
}

/** Reads an exact same-session record; callers must still verify its status/purpose. */
export async function getImageGenerationRecord(context: AgentImageGenerationRecordContext, generationId: string): Promise<AgentImageGenerationRecord | undefined> {
  return (await replay(context)).find((record) => record.id === generationId)
}

export async function getImageGenerationRecordForRetry(context: AgentImageGenerationRecordContext, generationId: string): Promise<AgentImageGenerationRecord | undefined> {
  const record = await getImageGenerationRecord(context, generationId)
  return record?.status === 'failed' ? record : undefined
}
