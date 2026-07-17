/**
 * 模型等级门控中间件 — 拦截 Free/Standard 用户对国际模型的请求。
 *
 * 在 proxyAuthMiddleware 之后、creditGateMiddleware 之前挂载。
 *
 * 门控规则：
 *   Free / Standard → 仅国内模型（DeepSeek、通义千问等）
 *   Plus / Pro       → 全模型（含 Claude、GPT、Gemini 等国际模型）
 *   Pro              → 额外允许自配 API
 *
 * 自配 API 权限由 membership_tier 决定（plus/pro 可自配），
 * tier-gate 从 c.get('jwtPayload') 取 membership_tier 即可判断。
 */
/**
 * 模型等级门控中间件 — 拦截 Free/Standard 用户对国际模型的请求。
 *
 * 在 proxyAuthMiddleware 之后、creditGateMiddleware 之前挂载。
 *
 * 门控规则：
 *   Free / Standard → 仅国内模型（DeepSeek、通义千问等）
 *   Plus / Pro       → 全模型（含 Claude、GPT、Gemini 等国际模型）
 *
 * membership_tier 由 proxyAuthMiddleware 注入到 jwtPayload，无需额外 DB 查询。
 */

/** 国际模型判定模式：前缀匹配命中任一即为国际模型 */
const INTERNATIONAL_PATTERNS = [/^gpt/i, /^claude/i, /^o1/i, /^o3/i, /^o4/i, /^gemini/i]

/** 可用国际模型的套餐等级 */
const INTERNATIONAL_TIERS = new Set(['plus', 'pro'])

function isInternationalModel(model) {
  if (!model) return false
  for (const p of INTERNATIONAL_PATTERNS) {
    if (p.test(model)) return true
  }
  return false
}

export async function tierGateMiddleware(c, next) {
  const payload = c.get('jwtPayload')
  if (!payload?.sub) return next()

  const tier = payload.membership_tier || 'free'

  // 解析请求体模型名（clone 避免消费原始流）
  let body = {}
  try {
    body = await c.req.raw.clone().json()
  } catch {
    return next() // 无法解析则放行
  }

  const model = body.model || ''

  if (isInternationalModel(model) && !INTERNATIONAL_TIERS.has(tier)) {
    return c.json({
      error: '国际模型仅 Plus 及以上套餐可用',
      code: 'tier_restricted',
      currentTier: tier,
      requiredTier: 'plus',
      message: `当前套餐等级（${tier}）不支持 ${model}，请升级至 Plus 或 Pro 套餐`,
    }, 403)
  }

  await next()
}
