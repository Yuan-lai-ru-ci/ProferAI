import { getGptImageCredentials } from './chat-tool-config'
import { getTeamAuthWithRefresh, recoverCommercialProxyAuth } from './auth-service'

const DEFAULT_BASE_URL = 'https://api.openai.com'
// 线上网关可能在应用层 120 秒上游超时前先断开。本轮恢复覆盖网关返回后的 72 秒，
// 让仍在运行的同一幂等操作有足够时间完成，而不重新提交生图请求。
const DEFAULT_OFFICIAL_IMAGE_RECOVERY_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 20_000, 20_000] as const
let officialImageRecoveryDelaysMs: readonly number[] = DEFAULT_OFFICIAL_IMAGE_RECOVERY_DELAYS_MS
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

/** 仅供测试：避免网关恢复回归测试产生真实等待。 */
export function __setOfficialImageRecoveryDelaysForTest(delays: readonly number[] | undefined): void {
  officialImageRecoveryDelaysMs = delays ?? DEFAULT_OFFICIAL_IMAGE_RECOVERY_DELAYS_MS
}

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
  if (status === 504) return '图片服务处理超时（504）。系统已尝试恢复本次请求；若仍未完成，本次不会扣积分。'
  return `图片生成失败 (${status})：${message || text.slice(0, 200) || `HTTP ${status}`}`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
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

async function callOfficial(
  request: Pick<GptImageRequest, 'prompt' | 'idempotencyKey' | 'signal'> & { size: GptImageSize; quality: GptImageQuality; references: GptImageReference[] },
): Promise<Response | undefined> {
  let auth = await getTeamAuthWithRefresh()
  if (!auth) return undefined

  const endpoint = request.references.length ? '/v1/proxy/images/edits' : '/v1/proxy/images/generations'
  const operationType = request.references.length ? 'edit' : 'generation'
  const send = async (current: NonNullable<typeof auth>): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${current.proxyToken || current.token}`,
      'Idempotency-Key': request.idempotencyKey,
    }
    if (!request.references.length) {
      headers['Content-Type'] = 'application/json'
      return fetch(`${current.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
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
    return fetch(`${current.baseUrl.replace(/\/+$/, '')}${endpoint}`, { method: 'POST', headers, body: form, signal: request.signal })
  }

  const recoverCompletedOperation = async (current: NonNullable<typeof auth>): Promise<Response | undefined> => {
    // 504 可能由最外层 Nginx 先返回，而 Team Server 仍在完成上游请求。不能重新
    // POST：相同幂等键只会得到 processing/缓存结果；轮询同一 operation 才能恢复交付。
    const operationPath = `/v1/proxy/images/operations/by-idempotency/${encodeURIComponent(operationType)}/${encodeURIComponent(request.idempotencyKey)}`
    for (const delay of officialImageRecoveryDelaysMs) {
      await sleep(delay, request.signal)
      const result = await fetch(`${current.baseUrl.replace(/\/+$/, '')}${operationPath}`, {
        headers: { Authorization: `Bearer ${current.proxyToken || current.token}` },
        signal: request.signal,
      })
      // 404 说明客户端已升级而服务端尚未发布恢复接口，立即保留原始 504，
      // 不额外制造长等待。409 的 processing 才继续轮询；其他终态错误应原样交给调用方。
      if (result.status === 404) return undefined
      if (result.status === 409) {
        const body = await result.clone().json().catch((): undefined => undefined)
        if (body && typeof body === 'object' && 'code' in body && body.code === 'IMAGE_OPERATION_PROCESSING') continue
      }
      return result
    }
    return undefined
  }

  let response = await send(auth)
  if (response.status === 504 && !request.signal?.aborted) {
    try {
      const recovered = await recoverCompletedOperation(auth)
      if (recovered) response = recovered
    } catch (error) {
      if (request.signal?.aborted) throw error
      console.warn('[GPT Image] 504 recovery check failed:', error)
    }
  }
  if (response.status !== 401 || request.signal?.aborted) return response

  // 服务端重启后会轮换内存中无法恢复的 relay 明文；用 refresh token 获取新 relay，
  // 并复用同一个幂等键只重试一次，避免放宽服务端鉴权或重复扣费。
  const recovered = await recoverCommercialProxyAuth()
  if (!recovered) return response
  auth = recovered
  response = await send(auth)
  return response
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
