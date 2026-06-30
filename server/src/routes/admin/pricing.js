/**
 * Admin 定价管理路由
 */
import { Hono } from 'hono'
import { listPricing, upsertPricing, deletePricing, listActiveChannels } from '../../db.js'
import { logAudit } from '../../audit.js'

export const adminPricing = new Hono()

// GET /v1/admin/pricing — 仅定价表
adminPricing.get('/', (c) => {
  return c.json(listPricing())
})

// GET /v1/admin/pricing/models — 所有渠道模型 + 定价状态
adminPricing.get('/models', (c) => {
  const channels = listActiveChannels()
  const pricing = listPricing()
  const priceMap = {}
  for (const p of pricing) priceMap[p.model] = p

  const result = []
  const seen = new Set()
  for (const ch of channels) {
    const models = JSON.parse(ch.models_json || '[]')
    for (const m of models) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      const price = priceMap[m.id]
      result.push({
        model: m.id,
        name: m.name || m.id,
        provider: ch.provider,
        channel: ch.name,
        priced: !!price,
        inputRate: price?.input_rate ?? 0,
        outputRate: price?.output_rate ?? 0,
        cacheReadRatio: price?.cache_read_ratio ?? 0.1,
        updatedAt: price?.updated_at ?? null,
      })
    }
  }
  return c.json(result)
})

// PUT /v1/admin/pricing/:model
adminPricing.put('/:model', async (c) => {
  const model = c.req.param('model')
  const { inputRate, outputRate, cacheReadRatio } = await c.req.json()
  if (inputRate == null || outputRate == null) return c.json({ error: 'inputRate 和 outputRate 必填' }, 400)
  upsertPricing(model, inputRate, outputRate, cacheReadRatio ?? 0.1)
  logAudit({ action: 'admin.update_pricing', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'pricing', entityId: model, detail: `input=${inputRate} output=${outputRate} cache=${cacheReadRatio ?? 0.1}` })
  return c.json({ success: true })
})

// DELETE /v1/admin/pricing/:model
adminPricing.delete('/:model', (c) => {
  const model = c.req.param('model')
  deletePricing(model)
  logAudit({ action: 'admin.delete_pricing', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'pricing', entityId: model })
  return c.json({ success: true })
})
