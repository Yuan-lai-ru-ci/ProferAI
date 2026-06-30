/**
 * New API 对账客户端
 *
 * 单一计费真源：不在 Profer 侧复现 New API 的计费公式（实测公式不可靠——
 * 自定义定价/按次计费会让本地估算与 New API 实扣差几十倍）。改为转发后用
 * New API 回传的 request_id（响应头 x-oneapi-request-id）去查 New API 的日志，
 * 读它**实际扣的 quota**，作为唯一计费依据。
 *
 * Profer 对用户扣费 = New API 实扣 quota / QUOTA_PER_UNIT × BILLING_MARKUP。
 * New API 是计量表，Profer 本地账本是其忠实镜像 × 加价，笔笔对应、零漂移。
 */
import {
  RELAY_BASE_URL,
  NEWAPI_ADMIN_TOKEN,
  NEWAPI_ADMIN_USER_ID,
  NEWAPI_QUOTA_PER_UNIT,
  BILLING_MARKUP,
} from './config.js'

/** New API 响应里携带其内部 request_id 的头（用于对账查日志）。 */
export const NEWAPI_REQUEST_ID_HEADER = 'x-oneapi-request-id'

/** 从上游响应头提取 New API request_id；无则返回 null。 */
export function extractNewApiRequestId(resp) {
  try {
    return resp?.headers?.get?.(NEWAPI_REQUEST_ID_HEADER) || null
  } catch {
    return null
  }
}

/** 带系统令牌的管理接口请求。失败返回 { ok:false }，绝不抛（计费链不能因对账失败崩）。 */
async function adminGet(path, { timeoutMs = 8000 } = {}) {
  if (!NEWAPI_ADMIN_TOKEN) return { ok: false, reason: 'no_admin_token' }
  try {
    const resp = await fetch(`${RELAY_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${NEWAPI_ADMIN_TOKEN}`,
        'New-API-User': String(NEWAPI_ADMIN_USER_ID),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await resp.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    // New API 鉴权失败返回 HTTP 200 + {success:false}，必须看 success 字段。
    if (json && json.success === false) {
      return { ok: false, reason: json.message || 'api_error', raw: text.slice(0, 200) }
    }
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}`, raw: text.slice(0, 200) }
    return { ok: true, json }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

/**
 * 按 New API request_id 查它实际扣的 quota。
 *
 * New API 日志是异步写的，转发刚结束时可能还没落库 → 带重试。
 * @returns {Promise<{found:boolean, quota?:number, promptTokens?:number, completionTokens?:number, model?:string}>}
 */
export async function fetchActualQuotaByRequestId(requestId, { retries = 4, retryDelayMs = 400 } = {}) {
  if (!requestId) return { found: false }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await adminGet(`/api/log/?p=0&page_size=1&request_id=${encodeURIComponent(requestId)}`)
    if (r.ok) {
      const item = r.json?.data?.items?.[0]
      if (item) {
        return {
          found: true,
          quota: Number(item.quota) || 0,
          promptTokens: Number(item.prompt_tokens) || 0,
          completionTokens: Number(item.completion_tokens) || 0,
          model: item.model_name || '',
        }
      }
    } else if (r.reason === 'no_admin_token') {
      // 没配系统令牌，重试也没用，直接返回
      return { found: false, reason: 'no_admin_token' }
    }
    if (attempt < retries) await new Promise((res) => setTimeout(res, retryDelayMs))
  }
  return { found: false, reason: 'not_logged_yet' }
}

/** New API quota → Profer 扣费额度（货币单位 × 加价）。 */
export function quotaToBilledCost(quota) {
  if (!quota || quota <= 0) return 0
  const costUnit = quota / NEWAPI_QUOTA_PER_UNIT
  return costUnit * BILLING_MARKUP
}

/**
 * 对账一次请求：按 request_id 拿真实 quota，换算成 Profer 扣费额度。
 * @returns {Promise<{billed:number, quota:number, found:boolean, reason?:string}>}
 */
export async function reconcileRequestCost(newApiRequestId) {
  const r = await fetchActualQuotaByRequestId(newApiRequestId)
  if (!r.found) return { billed: 0, quota: 0, found: false, reason: r.reason }
  return { billed: quotaToBilledCost(r.quota), quota: r.quota, found: true }
}
