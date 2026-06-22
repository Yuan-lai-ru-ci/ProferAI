/**
 * 信用代理路由 — 扣额度后转发到 New API 中继站
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { RELAY_BASE_URL, RELAY_API_KEY, COMMERCIAL_MODE } from '../../config.js'

export const proxyRoutes = new Hono()

async function forwardToRelay(c, relayPath) {
  let body = c.get('proxyBody')
  if (!body) {
    try { body = await c.req.json() } catch { return c.json({ error: '请求体为空' }, 400) }
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RELAY_API_KEY}`,
    }

    const resp = await fetch(`${RELAY_BASE_URL}${relayPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })

    const contentType = resp.headers.get('content-type') || ''

    if (contentType.includes('text/event-stream')) {
      // 流式响应：直接透传
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    const data = await resp.json()
    return c.json(data, resp.status)
  } catch (err) {
    // 代理失败，返还已扣额度
    const userId = c.get('jwtPayload')?.sub
    const deducted = c.get('creditDeducted')
    if (userId && deducted) {
      try {
        // 退款并回滚 lifetime_consumed
        const { db } = await import('../../db.js')
        db.prepare('UPDATE credits SET balance = balance + ?, lifetime_consumed = lifetime_consumed - ?, updated_at = ? WHERE user_id = ?')
          .run(deducted, deducted, Date.now(), userId)
        db.prepare("INSERT INTO credit_transactions (id, user_id, amount, type, description, created_at) VALUES (?, ?, ?, 'refund', ?, ?)")
          .run(uuidv4(), userId, deducted, '代理失败自动退款', Date.now())
        console.log(`[proxy] 退款 ${deducted} credits to ${userId}`)
      } catch (refundErr) {
        console.warn('[proxy] 退款失败:', refundErr.message)
      }
    }
    return c.json({ error: `代理请求失败: ${err.message}` }, 502)
  }
}

// POST /v1/proxy/chat — OpenAI Chat Completions 格式
proxyRoutes.post('/chat', async (c) => {
  return forwardToRelay(c, '/v1/chat/completions')
})

// POST /v1/proxy/messages — Anthropic Messages 格式
proxyRoutes.post('/messages', async (c) => {
  return forwardToRelay(c, '/v1/messages')
})
