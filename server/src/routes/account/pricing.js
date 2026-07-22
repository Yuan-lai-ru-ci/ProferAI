import { Hono } from 'hono'
import { db, listActiveChannels } from '../../db.js'
import { createPricingContext } from '../../billing/pricing-context.js'
import { getModelMultipliers, getVipConfig } from '../../db/config-store.js'

export const accountPricing = new Hono()

/** Returns only the authenticated user's effective display multipliers. */
accountPricing.get('/', (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未认证' }, 401)

  const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
  const multipliers = getModelMultipliers()
  const modelIds = new Set()
  for (const channel of listActiveChannels()) {
    try {
      for (const model of JSON.parse(channel.models_json || '[]')) {
        if (model?.enabled !== false && model?.id) modelIds.add(model.id)
      }
    } catch { /* Invalid legacy channel data is ignored here. */ }
  }

  const models = [...modelIds].sort().map((id) => {
    const context = createPricingContext(user, id, { modelMultipliers: multipliers, vipConfig: getVipConfig() })
    return {
      id,
      displayMultiplier: context.effectiveMultiplier,
      baseMultiplier: context.modelMultiplier,
      groupMultiplier: context.groupMultiplier,
      available: context.audience !== 'vip' || !!context.modelMultiplier,
    }
  })
  const context = createPricingContext(user, '', { modelMultipliers: multipliers, vipConfig: getVipConfig() })
  return c.json({
    audience: context.audience,
    pricingVersion: context.pricingVersion,
    models,
  })
})
