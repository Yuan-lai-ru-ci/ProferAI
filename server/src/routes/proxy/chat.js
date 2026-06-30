/**
 * 代理路由 — 转发到 New API 中继站
 *
 * 计费已收敛到 New API 单一计费方：本代理不再预扣/扣费/退款，
 * 只做三件事：
 *   1. 用固定 RELAY_API_KEY 转发请求到 New API
 *   2. 记录请求日志（token 用量，供用量可见性，不涉及计费）
 *   3. 翻译 New API 的额度/配置类报错为中文友好提示，不透传美元文案
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { RELAY_BASE_URL, RELAY_API_KEY } from '../../config.js'
import { createStreamUsageTracker, extractModel, extractUsage, withOpenAIStreamUsage } from '../../proxy-usage-utils.js'

export const proxyRoutes = new Hono()

/**
 * 翻译 New API 上游报错。
 * 额度/计费类（含美元文案）统一转中文，避免用户误以为是自己 credits 不够，
 * 并记运维告警（共享额度池耗尽是运维级问题）。
 * 返回 { payload, isQuota }。
 */
function translateUpstreamError(parsed, status) {
  const rawMsg = (parsed?.error?.message || parsed?.message || (typeof parsed?.error === 'string' ? parsed.error : '') || '').toString()
  const lower = rawMsg.toLowerCase()

  // 额度/预扣类（New API 美元计费报错）
  const isQuota =
    rawMsg.includes('预扣费') || rawMsg.includes('额度') || rawMsg.includes('余额') ||
    lower.includes('insufficient') || lower.includes('quota') || lower.includes('balance') ||
    rawMsg.includes('＄') || rawMsg.includes('$') || status === 402
  if (isQuota) {
    return { payload: { error: '平台额度暂时不足，请联系管理员充值', code: 'insufficient_credits' }, isQuota: true }
  }

  // 定价/模型未配置 → 不暴露运维细节
  if (lower.includes('price not configured') || rawMsg.includes('价格未配置') || lower.includes('model not found') || rawMsg.includes('模型不存在')) {
    return { payload: { error: '所选模型暂不可用，请联系管理员' }, isQuota: false }
  }

  // 其他上游错误：透传精简消息
  if (parsed?.error?.message || parsed?.error || parsed?.message) {
    return { payload: { error: rawMsg || JSON.stringify(parsed).slice(0, 200) }, isQuota: false }
  }
  return { payload: parsed, isQuota: false }
}

/** 记录一次请求日志（仅 token 用量，不计费；cost 恒 0）。 */
async function logUsage({ requestId, userId, model, usage, durationMs, stream, success, errorMessage = '' }) {
  if (!userId) return
  try {
    const { logRequest } = await import('../../db.js')
    logRequest({
      id: requestId, userId, model, provider: '',
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      cacheCreationTokens: usage?.cacheCreationTokens || 0,
      cacheReadTokens: usage?.cacheReadTokens || 0,
      costCredits: 0,
      durationMs,
      success: success ? 1 : 0,
      stream: stream ? 1 : 0,
      errorMessage: errorMessage.slice(0, 200),
    })
  } catch (e) {
    console.warn('[proxy] 用量日志记录失败:', e.message)
  }
}

// __APPEND_STREAM_AND_FORWARD__

/** 流式转发：边转发边累计 token 用量，结束时记日志（不计费）。 */
function createUsageTrackingStream({ resp, requestId, userId, requestModel, startTime }) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  const tracker = createStreamUsageTracker(requestModel)
  let settled = false

  async function settle({ success, errorMessage = '' }) {
    if (settled) return
    settled = true
    const tail = decoder.decode()
    if (tail) tracker.ingest(tail)
    const tracked = tracker.finish()
    await logUsage({
      requestId, userId, model: tracked.model || requestModel,
      usage: tracked.usage, durationMs: Date.now() - startTime,
      stream: true, success, errorMessage,
    })
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          await settle({ success: true })
          controller.close()
          return
        }
        if (value) {
          tracker.ingest(decoder.decode(value, { stream: true }))
          controller.enqueue(value)
        }
      } catch (err) {
        await settle({ success: false, errorMessage: err instanceof Error ? err.message : String(err) })
        controller.error(err)
      }
    },
    async cancel(reason) {
      await settle({ success: false, errorMessage: `流式请求被客户端中断: ${reason || ''}` })
      await reader.cancel(reason).catch(() => {})
    },
  })
}

async function forwardToRelay(c, relayPath) {
  let body = c.get('proxyBody')
  if (!body) {
    try { body = await c.req.json() } catch { return c.json({ error: '请求体为空' }, 400) }
  }
  body = withOpenAIStreamUsage(body, relayPath)

  const userId = c.get('jwtPayload')?.sub
  const requestModel = body.model || 'unknown'
  const requestId = uuidv4()
  const startTime = Date.now()

  try {
    const resp = await fetch(`${RELAY_BASE_URL}${relayPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })

    const durationMs = Date.now() - startTime
    const contentType = resp.headers.get('content-type') || ''

    if (!resp.ok) {
      let parsed = null
      try { parsed = JSON.parse(await resp.text()) } catch { /* 非 JSON */ }
      const { payload, isQuota } = parsed
        ? translateUpstreamError(parsed, resp.status)
        : { payload: { error: `服务暂时不可用 (${resp.status})` }, isQuota: false }

      if (isQuota) {
        console.warn(`[proxy] ⚠️ New API 额度不足/预扣失败 (status=${resp.status}, user=${userId}): ${JSON.stringify(parsed).slice(0, 200)}`)
      }
      await logUsage({ requestId, userId, model: requestModel, usage: null, durationMs, stream: false, success: false, errorMessage: JSON.stringify(payload) })
      return c.json(payload, resp.status)
    }

    if (contentType.includes('text/event-stream')) {
      const streamBody = userId && resp.body
        ? createUsageTrackingStream({ resp, requestId, userId, requestModel, startTime })
        : resp.body
      return new Response(streamBody, {
        status: resp.status,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      })
    }

    // 非流式：记 token 用量日志（不计费）
    const data = await resp.json()
    const usage = extractUsage(data)
    await logUsage({ requestId, userId, model: extractModel(data, requestModel), usage, durationMs, stream: false, success: true })
    return c.json(data, resp.status)
  } catch (err) {
    await logUsage({ requestId, userId, model: requestModel, usage: null, durationMs: Date.now() - startTime, stream: false, success: false, errorMessage: err.message })
    return c.json({ error: `代理请求失败: ${err.message}` }, 502)
  }
}

// POST /v1/proxy/chat — OpenAI Chat Completions 格式（简短路径）
proxyRoutes.post('/chat', (c) => forwardToRelay(c, '/v1/chat/completions'))
// 兼容标准 OpenAI SDK 路径
proxyRoutes.post('/v1/chat/completions', (c) => forwardToRelay(c, '/v1/chat/completions'))
proxyRoutes.post('/chat/completions', (c) => forwardToRelay(c, '/v1/chat/completions'))
// POST /v1/proxy/messages — Anthropic Messages 格式
proxyRoutes.post('/messages', (c) => forwardToRelay(c, '/v1/messages'))
// Agent SDK 会在 ANTHROPIC_BASE_URL 后自动拼接 /v1/messages
proxyRoutes.post('/v1/messages', (c) => forwardToRelay(c, '/v1/messages'))

