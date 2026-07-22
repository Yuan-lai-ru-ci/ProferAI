export const PRICING_VERSION = 'vip-model-groups-v1'

function normalizeGroup(value, fallback) {
  const group = String(value || '').trim()
  return group || fallback
}

/**
 * Freezes the routing and display pricing for a single request.
 * New API remains the billing authority; these multipliers are an auditable catalog.
 */
export function createPricingContext(user, model, { modelMultipliers = {}, vipConfig = {} } = {}) {
  const isVip = !!user?.is_vip
  const modelMultiplier = Number(modelMultipliers?.[model])
  const groupMultiplier = isVip ? Number(vipConfig.modelDiscount) : 1
  const newApiGroup = isVip ? normalizeGroup(vipConfig.newApiGroup, 'vip') : 'default'

  return Object.freeze({
    audience: isVip ? 'vip' : 'default',
    newApiGroup,
    modelMultiplier: Number.isFinite(modelMultiplier) && modelMultiplier > 0 ? modelMultiplier : null,
    groupMultiplier: Number.isFinite(groupMultiplier) && groupMultiplier > 0 ? groupMultiplier : 1,
    effectiveMultiplier: Number.isFinite(modelMultiplier) && modelMultiplier > 0
      ? modelMultiplier * (Number.isFinite(groupMultiplier) && groupMultiplier > 0 ? groupMultiplier : 1)
      : null,
    pricingVersion: PRICING_VERSION,
  })
}

export function assertVipPricingReady(context, { perUserNewApiKey, hasNewApiKey }) {
  if (context.audience !== 'vip') return
  if (!perUserNewApiKey) throw new Error('VIP_PRICING_REQUIRES_PER_USER_NEWAPI_KEY')
  if (!hasNewApiKey) throw new Error('VIP_NEWAPI_KEY_MISSING')
  if (!context.modelMultiplier) throw new Error('VIP_MODEL_PRICE_MISSING')
  if (!context.newApiGroup || context.newApiGroup === 'default') throw new Error('VIP_GROUP_INVALID')
}
