/**
 * 代理路由 — 转发到 New API 中继站
 *
 * 计费：单一真源 = New API 实扣 quota。转发后用 New API 回传的 request_id
 * （响应头 x-oneapi-request-id）查 New API 日志拿真实 quota，换算成本地账本
 * 扣减额度（quota × markup），扣当前用户的 credits。不在本地复现计费公式。
 * 扣费在响应结束后异步进行（不阻塞用户；New API 自己已按共享池 quota 兜底拦截）。
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { RELAY_BASE_URL, RELAY_API_KEY, PER_USER_NEWAPI_KEY } from '../../config.js'
import { db, getBillingConfig } from '../../db.js'
import { createStreamUsageTracker, extractModel, extractUsage, withOpenAIStreamUsage } from '../../proxy-usage-utils.js'
import { extractNewApiRequestId, reconcileRequestCost } from '../../newapi-client.js'

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

/** 记录一次请求日志（含计费 quota cost 和 New API request_id）。 */
async function logUsage({ requestId, userId, model, usage, durationMs, stream, success, errorMessage = '', costCredits = 0, newApiRequestId = '', actualQuota = null, billingMarkup = null }) {
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
      costCredits,
      durationMs,
      success: success ? 1 : 0,
      stream: stream ? 1 : 0,
      errorMessage: errorMessage.slice(0, 200),
      newApiRequestId,
      actualQuota,
      billingMarkup,
    })
  } catch (e) {
    console.warn('[proxy] 用量日志记录失败:', e.message)
  }
}

/**
 * 对账并扣费：用 New API request_id 查真实 quota，扣当前用户本地账本，并把
 * 真实 cost 写回请求日志。失败不抛（计费链不能因对账失败崩；漏扣记日志告警）。
 * @returns {Promise<number>} 实际扣减的 credits（quota 单位）
 */
async function reconcileAndBill({ newApiRequestId, requestId, userId, billing }) {
  if (!userId || !newApiRequestId) return 0
  try {
    const rec = await reconcileRequestCost(newApiRequestId, billing)
    if (!rec.found) {
      console.warn(`[proxy] ⚠️ 对账未命中 New API 日志 (req=${newApiRequestId}, user=${userId}, reason=${rec.reason}) — 本次未扣费`)
      return 0
    }
    if (rec.billedCredits <= 0) return 0
    const { deductCredits } = await import('../../db.js')
    // force: true — 事后对账必须记账，即使余额不足也透支扣费（余额门禁 creditGateMiddleware 已在转发前拦截）
    deductCredits(userId, rec.billedCredits, {
      description: `API 调用（New API quota ${rec.quota}）`,
      referenceType: 'api_call',
      referenceId: requestId,
      force: true,
    })
    // 回写扣费额度到请求日志，避免被后台扣费循环重复处理
    const { updateRequestLogCost } = await import('../../db.js')
    updateRequestLogCost(requestId, rec.billedCredits, { actualQuota: rec.quota, billingMarkup: billing.markup })
    return rec
  } catch (e) {
    console.warn('[proxy] 对账扣费异常:', e.message)
    return 0
  }
}

/** 开放 API：请求成功后累加该 pk_ key 的用量（request_count / last_used / quota_used）。 */
async function touchApiKey(apiKeyId, costCredits) {
  if (!apiKeyId) return
  try {
    const { touchApiKeyUsage } = await import('../../db.js')
    touchApiKeyUsage(apiKeyId, costCredits)
  } catch (e) {
    console.warn(`[proxy] ⚠️ API Key 用量累加失败 (key=${apiKeyId}): ${e.message}`)
  }
}

// __APPEND_STREAM_AND_FORWARD__

/** 流式转发：边转发边累计 token 用量，结束时对账扣费 + 记日志。 */
function createUsageTrackingStream({ resp, requestId, userId, requestModel, startTime, newApiRequestId, apiKeyId, billing }) {
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
    // 成功才对账扣费（失败/中断不扣 New API 也通常不计费）
    const reconciliation = success
      ? await reconcileAndBill({ newApiRequestId, requestId, userId, billing })
      : null
    const costCredits = reconciliation?.billedCredits || 0
    if (success) await touchApiKey(apiKeyId, costCredits)
    await logUsage({
      requestId, userId, model: tracked.model || requestModel,
      usage: tracked.usage, durationMs: Date.now() - startTime,
      stream: true, success, errorMessage, costCredits, newApiRequestId,
      actualQuota: reconciliation?.quota ?? null,
      billingMarkup: billing.markup,
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
  const apiKeyId = c.get('apiKeyId') || null
  const requestModel = body.model || 'unknown'
  const requestId = uuidv4()
  const startTime = Date.now()
  // 价格在请求进入时冻结；流式结算和后台补扫必须复用该倍率。
  const billing = getBillingConfig()

  // 每用户独立 New API Key（灰度）：查用户自己的 Key，无则 fallback 全局 RELAY_API_KEY
  let apiKey = RELAY_API_KEY
  if (PER_USER_NEWAPI_KEY && userId) {
    const userRow = db.prepare('SELECT new_api_key_encrypted FROM users WHERE id = ?').get(userId)
    if (userRow?.new_api_key_encrypted) {
      apiKey = userRow.new_api_key_encrypted
    }
  }

  try {
    const resp = await fetch(`${RELAY_BASE_URL}${relayPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })

    const durationMs = Date.now() - startTime
    const contentType = resp.headers.get('content-type') || ''
    const newApiRequestId = extractNewApiRequestId(resp)

    if (!resp.ok) {
      let parsed = null
      try { parsed = JSON.parse(await resp.text()) } catch { /* 非 JSON */ }
      const { payload, isQuota } = parsed
        ? translateUpstreamError(parsed, resp.status)
        : { payload: { error: `服务暂时不可用 (${resp.status})` }, isQuota: false }

      if (isQuota) {
        console.warn(`[proxy] ⚠️ New API 额度不足/预扣失败 (status=${resp.status}, user=${userId}): ${JSON.stringify(parsed).slice(0, 200)}`)
      }
      await logUsage({ requestId, userId, model: requestModel, usage: null, durationMs, stream: false, success: false, errorMessage: JSON.stringify(payload), newApiRequestId })
      return c.json(payload, resp.status)
    }

    if (contentType.includes('text/event-stream')) {
      const streamBody = userId && resp.body
        ? createUsageTrackingStream({ resp, requestId, userId, requestModel, startTime, newApiRequestId, apiKeyId, billing })
        : resp.body
      return new Response(streamBody, {
        status: resp.status,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      })
    }

    // 非流式：对账扣费 + 记 token 用量日志
    const data = await resp.json()
    const usage = extractUsage(data)
    const reconciliation = await reconcileAndBill({ newApiRequestId, requestId, userId, billing })
    const costCredits = reconciliation?.billedCredits || 0
    await touchApiKey(apiKeyId, costCredits)
    await logUsage({ requestId, userId, model: extractModel(data, requestModel), usage, durationMs, stream: false, success: true, costCredits, newApiRequestId, actualQuota: reconciliation?.quota ?? null, billingMarkup: billing.markup })
    return c.json(data, resp.status)
  } catch (err) {
    await logUsage({ requestId, userId, model: requestModel, usage: null, durationMs: Date.now() - startTime, stream: false, success: false, errorMessage: err.message, newApiRequestId })
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

