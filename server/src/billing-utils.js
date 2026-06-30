/**
 * 计费工具 — 模型价格匹配、费用估算、实际用量结算
 *
 * token 估算使用 tiktoken（cl100k_base）精确计数 + 3% 安全上浮，
 * 避免粗糙的字符数/2 估算对中文等非英文内容严重低估导致预扣不足。
 */
import { encodingForModel, getEncoding } from 'js-tiktoken'

// ---- 费率常量 ----
const DEFAULT_BILLING_RATE = Object.freeze({ input: 1, output: 3, cacheReadRatio: 0.1 })

/** 预算安全系数：估算总费用上浮 3%，确保不会因 tokenizer 细微差异导致预扣不足 */
const ESTIMATE_SAFETY_FACTOR = 1.03

function toNonNegativeNumber(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

function normalizeRate(rate) {
  if (typeof rate === 'number') {
    return { input: DEFAULT_BILLING_RATE.input, output: rate, cacheReadRatio: DEFAULT_BILLING_RATE.cacheReadRatio }
  }
  if (!rate || typeof rate !== 'object') return DEFAULT_BILLING_RATE
  return {
    input: toNonNegativeNumber(rate.input, DEFAULT_BILLING_RATE.input),
    output: toNonNegativeNumber(rate.output, DEFAULT_BILLING_RATE.output),
    cacheReadRatio: toNonNegativeNumber(rate.cacheReadRatio, DEFAULT_BILLING_RATE.cacheReadRatio),
  }
}

/**
 * 按模型名匹配价格，三层策略（每层内按 key 长度降序，最长优先）：
 *   1. 精确匹配：key === modelName
 *   2. 前缀匹配：modelName startsWith key
 *   3. 子串匹配：modelName includes key（兜底）
 *
 * 分层保证 gpt-5-mini 不会被 gpt-5 的子串匹配抢先命中。
 */
export function findBillingRate(model, pricingMap = {}, fallbackRate = DEFAULT_BILLING_RATE) {
  const normalizedFallback = normalizeRate(fallbackRate)
  const modelName = String(model || '').toLowerCase()
  if (!modelName) return normalizedFallback

  const entries = Object.entries(pricingMap)
    .filter(([key]) => key)
    .map(([key, rate]) => [String(key).toLowerCase(), rate])
  if (!entries.length) return normalizedFallback

  const byLen = (a, b) => b[0].length - a[0].length

  // 第一层：精确匹配
  const exact = entries.find(([key]) => key === modelName)
  if (exact) return normalizeRate(exact[1])

  // 第二层：前缀匹配
  const prefix = entries
    .filter(([key]) => modelName.startsWith(key))
    .sort(byLen)[0]
  if (prefix) return normalizeRate(prefix[1])

  // 第三层：子串匹配（兜底）
  const substr = entries
    .filter(([key]) => modelName.includes(key))
    .sort(byLen)[0]
  if (substr) return normalizeRate(substr[1])

  return normalizedFallback
}

// ---- 从 messages 中提取纯文本（用于 tokenizer 编码） ----

/** 提取 content 中的文本，处理 string / array / null 三种格式 */
function extractText(content) {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (Array.isArray(content)) {
    // 多模态 content blocks: [{type: "text", text: "..."}, {type: "image_url", ...}]
    let text = ''
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        text += block.text
      }
    }
    return text
  }
  // 兜底：JSON 序列化（非标准格式）
  try { return JSON.stringify(content) } catch { return String(content) }
}

/** 从请求体中拼接所有文本内容 */
function collectText(body) {
  const parts = []
  const messages = body?.messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const text = extractText(msg?.content)
      if (text) parts.push(text)
    }
  }
  // system prompt
  if (body?.system != null) {
    parts.push(typeof body.system === 'string' ? body.system : JSON.stringify(body.system))
  }
  // legacy prompt
  if (body?.prompt != null) {
    parts.push(typeof body.prompt === 'string' ? body.prompt : JSON.stringify(body.prompt))
  }
  return parts.join('\n')
}

// ---- Token 估算 ----

/**
 * 解析模型对应的 tiktoken encoding。
 * 已知模型直接用 encodingForModel，未知模型回退到 cl100k_base（覆盖面最广）。
 */
function resolveEncoding(model) {
  try {
    return encodingForModel(String(model || ''))
  } catch {
    return getEncoding('cl100k_base')
  }
}

/**
 * 使用 tiktoken 精确计算 prompt token 数。
 * 多模态 content（array 格式）只计入 text 块，image_url 等不计入。
 */
function estimatePromptTokens(body) {
  const text = collectText(body)
  if (!text) return 100 // 空请求保底 100 tokens

  const enc = resolveEncoding(body?.model)
  const tokens = enc.encode(text).length
  return Math.max(100, tokens)
}

/**
 * 预估代理请求费用，用于请求发出前的余额校验和预扣。
 *
 * 公式:
 *   rawCost = promptTokens/1000 × input_rate + maxTokens/1000 × output_rate
 *   final   = ceil(rawCost × 1.03)   ← +3% 安全上浮
 *   floor   = max(1, final)
 */
export function estimateProxyCost(body = {}, pricingMap = {}) {
  const rate = findBillingRate(body?.model, pricingMap)
  // Agent SDK 不设置 max_tokens（SDK 内部管理 token 预算），默认 4096 会导致预扣严重偏高。
  // 预扣的目的是防止余额不足发不出请求，而非精确计费——实际用量结算后会退还差额。
  // 此处：优先用请求体的 max_tokens，未设置时推定 1024（覆盖大部分常规回复），封顶 4096。
  const specifiedMax = body?.max_tokens ?? body?.max_completion_tokens
  const maxTokens = specifiedMax != null
    ? Math.min(toNonNegativeNumber(specifiedMax, 1024), 4096)
    : 1024
  const promptEstimate = estimatePromptTokens(body)

  // 原始估算
  const rawCost = (promptEstimate / 1000) * rate.input + (maxTokens / 1000) * rate.output

  // +3% 安全上浮，确保不会因 tokenizer 细微差异导致预扣不足
  const safeCost = rawCost * ESTIMATE_SAFETY_FACTOR

  return Math.max(1, Math.ceil(safeCost))
}

/** 根据实际 usage 计算最终费用，缓存读写 token 单独计价。 */
export function calculateUsageCost({ promptTokens = 0, completionTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0 }, rate) {
  const normalizedRate = normalizeRate(rate)
  const prompt = toNonNegativeNumber(promptTokens)
  const completion = toNonNegativeNumber(completionTokens)
  const cacheCreation = toNonNegativeNumber(cacheCreationTokens)
  const cacheRead = toNonNegativeNumber(cacheReadTokens)
  const regularInput = Math.max(0, prompt - cacheCreation - cacheRead)

  const regularCost = (regularInput / 1000) * normalizedRate.input
  const creationCost = (cacheCreation / 1000) * normalizedRate.input
  const readCost = (cacheRead / 1000) * normalizedRate.input * normalizedRate.cacheReadRatio
  const outputCost = (completion / 1000) * normalizedRate.output

  return Math.max(0, Math.ceil(regularCost + creationCost + readCost + outputCost))
}
