import { getGptImageCredentials } from './chat-tool-config'
import { getTeamAuthWithRefresh } from './auth-service'

const DEFAULT_BASE_URL = 'https://api.openai.com'
export const DEFAULT_GPT_IMAGE_MODEL = 'gpt-image-2'
export const GPT_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const
export const GPT_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const
export const MAX_GPT_IMAGE_REFERENCES = 4

export type GptImageSize = (typeof GPT_IMAGE_SIZES)[number]
export type GptImageQuality = (typeof GPT_IMAGE_QUALITIES)[number]
export type GptImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'
export type GptImageMode = 'official' | 'byok'

export interface GptImageReference {
  data: string
  mediaType: string
  filename: string
}

export interface GptImageRequest {
  prompt: string
  size?: string
  quality?: string
  references?: GptImageReference[]
  /** Caller-owned value. Retrying a single tool call must reuse this key. */
  idempotencyKey: string
  signal?: AbortSignal
}

export interface GptImageSuccess {
  ok: true
  bytes: Buffer
  mediaType: GptImageMediaType
  revisedPrompt?: string
  mode: GptImageMode
}

export interface GptImageFailure {
  ok: false
  error: string
}

export type GptImageResult = GptImageSuccess | GptImageFailure

interface GptImageResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  error?: { message?: string; code?: string; type?: string } | string
  code?: string
}

function normalizeBaseUrl(value: string): string {
  return (value.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export function normalizeGptImageSize(value: unknown): GptImageSize {
  return typeof value === 'string' && (GPT_IMAGE_SIZES as readonly string[]).includes(value)
    ? value as GptImageSize
    : 'auto'
}

export function normalizeGptImageQuality(value: unknown): GptImageQuality {
  return typeof value === 'string' && (GPT_IMAGE_QUALITIES as readonly string[]).includes(value)
    ? value as GptImageQuality
    : 'auto'
}

function friendlyError(status: number, data: GptImageResponse | null, text: string): string {
  const error = data?.error
  const message = typeof error === 'object' ? error.message : error
  const code = (typeof error === 'object' ? error.code : undefined) ?? data?.code
  if (code === 'INSUFFICIENT_CREDITS') return '积分不足：官方生图每次成功需要 5 积分，请充值后重试。'
  if (code === 'OFFICIAL_IMAGE_UNAVAILABLE') return '官方图片服务暂不可用，请稍后重试或切换自带 Key。'
  return `图片生成失败 (${status})：${message || text.slice(0, 200) || `HTTP ${status}`}`
}

async function parseResponse(response: Response): Promise<{ data?: GptImageResponse; error?: string }> {
  const text = await response.text()
  let data: GptImageResponse | undefined
  try { data = JSON.parse(text) as GptImageResponse } catch { /* response body becomes diagnostic only */ }
  if (!response.ok) return { error: friendlyError(response.status, data ?? null, text) }
  if (!data?.data?.length) return { error: '图片服务未返回有效图片，本次不会扣积分。' }
  return { data }
}

function detectMediaType(bytes: Buffer, fallback = 'image/png'): GptImageMediaType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp'
  const normalized = fallback.toLowerCase().split(';')[0]?.trim()
  return normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp'
    ? normalized
    : undefined
}

async function resolveImage(
  item: NonNullable<GptImageResponse['data']>[number],
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; mediaType: GptImageMediaType } | undefined> {
  if (item.b64_json) {
    const base64 = item.b64_json.replace(/^data:image\/[-\w+.]+;base64,/, '').trim()
    if (!base64) return undefined
    const bytes = Buffer.from(base64, 'base64')
    const mediaType = detectMediaType(bytes)
    return bytes.length > 0 && mediaType ? { bytes, mediaType } : undefined
  }
  if (!item.url) return undefined
  try {
    const response = await fetch(item.url, {
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      signal,
    })
    if (!response.ok) return undefined
    const bytes = Buffer.from(await response.arrayBuffer())
    const mediaType = detectMediaType(bytes, response.headers.get('content-type') ?? 'image/png')
    return bytes.length > 0 && mediaType ? { bytes, mediaType } : undefined
  } catch {
    return undefined
  }
}

function appendReferences(form: FormData, references: GptImageReference[]): void {
  for (const reference of references.slice(0, MAX_GPT_IMAGE_REFERENCES)) {
    form.append('image[]', new Blob([Buffer.from(reference.data, 'base64')], { type: reference.mediaType }), reference.filename)
  }
}

async function callOfficial(request: Pick<GptImageRequest, 'prompt' | 'idempotencyKey' | 'signal'> & { size: GptImageSize; quality: GptImageQuality; references: GptImageReference[] }): Promise<Response | undefined> {
  const auth = await getTeamAuthWithRefresh()
  if (!auth) return undefined
  const endpoint = request.references.length ? '/v1/proxy/images/edits' : '/v1/proxy/images/generations'
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.proxyToken || auth.token}`,
    'Idempotency-Key': request.idempotencyKey,
  }
  if (!request.references.length) {
    headers['Content-Type'] = 'application/json'
    return fetch(`${auth.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
      method: 'POST', headers, signal: request.signal,
      body: JSON.stringify({ model: DEFAULT_GPT_IMAGE_MODEL, prompt: request.prompt, size: request.size, quality: request.quality, n: 1 }),
    })
  }
  const form = new FormData()
  form.set('model', DEFAULT_GPT_IMAGE_MODEL)
  form.set('prompt', request.prompt)
  form.set('size', request.size)
  form.set('quality', request.quality)
  form.set('n', '1')
  appendReferences(form, request.references)
  return fetch(`${auth.baseUrl.replace(/\/+$/, '')}${endpoint}`, { method: 'POST', headers, body: form, signal: request.signal })
}

async function callByok(request: Pick<GptImageRequest, 'prompt' | 'signal'> & { size: GptImageSize; quality: GptImageQuality; references: GptImageReference[]; apiKey: string; baseUrl: string; model: string }): Promise<Response> {
  const endpoint = request.references.length ? '/v1/images/edits' : '/v1/images/generations'
  if (!request.references.length) {
    return fetch(`${request.baseUrl}${endpoint}`, {
      method: 'POST', signal: request.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.apiKey}` },
      body: JSON.stringify({ model: request.model, prompt: request.prompt, size: request.size, quality: request.quality, n: 1, response_format: 'b64_json' }),
    })
  }
  const form = new FormData()
  form.set('model', request.model)
  form.set('prompt', request.prompt)
  form.set('size', request.size)
  form.set('quality', request.quality)
  form.set('n', '1')
  form.set('response_format', 'b64_json')
  appendReferences(form, request.references)
  return fetch(`${request.baseUrl}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${request.apiKey}` }, body: form, signal: request.signal })
}

/**
 * The sole GPT Image provider boundary for Chat and Agent callers. It does not create
 * Chat attachments or Agent artifacts, and it never exposes credentials in its result.
 */
export async function generateGptImage(request: GptImageRequest): Promise<GptImageResult> {
  const prompt = request.prompt.trim()
  if (!prompt) return { ok: false, error: '参数缺失：prompt' }
  const references = (request.references ?? []).slice(0, MAX_GPT_IMAGE_REFERENCES)
  const size = normalizeGptImageSize(request.size)
  const quality = normalizeGptImageQuality(request.quality)
  const credentials = getGptImageCredentials()
  try {
    const official = credentials.mode === 'official'
    if (!official && !credentials.apiKey) return { ok: false, error: '请先在“自带 OpenAI Key”模式填写 API Key。' }
    const response = official
      ? await callOfficial({ prompt, size, quality, references, idempotencyKey: request.idempotencyKey, signal: request.signal })
      : await callByok({ prompt, size, quality, references, apiKey: credentials.apiKey, baseUrl: normalizeBaseUrl(credentials.baseUrl), model: credentials.model.trim() || DEFAULT_GPT_IMAGE_MODEL, signal: request.signal })
    if (!response) return { ok: false, error: '官方生图需要先登录 Profer 团队账号。' }
    const parsed = await parseResponse(response)
    if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? '图片服务未返回有效图片，本次不会扣积分。' }
    const first = parsed.data.data![0]!
    const image = await resolveImage(first, official ? undefined : credentials.apiKey, request.signal)
    if (!image) return { ok: false, error: '图片生成结果无法读取，本次不会报告为成功。' }
    return { ok: true, ...image, revisedPrompt: first.revised_prompt, mode: official ? 'official' : 'byok' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[GPT Image] provider request failed:', error)
    return { ok: false, error: `图片生成失败：${message}` }
  }
}
