/**
 * 用户渠道获取路由 — 登录后拉取服务端统一管理的渠道
 *
 * 代管模式铁律：批发总 Key 绝不下发给客户端。
 * 这里返回的 apiKey 是【该用户专属的长效 relay 令牌】，客户端拿它打
 * <server>/v1/proxy，由 proxyAuthMiddleware 反查用户、creditCheckMiddleware
 * 扣额度、proxy handler 用服务端持有的 RELAY_API_KEY 转发上游。
 *
 * relay 令牌相比 1h 的 accessToken 的好处：长效，不会在 Agent 长任务
 * 跑到一半时过期导致 401。
 */
import { Hono } from 'hono'
import { listActiveChannels, ensureRelayToken, db } from '../../db.js'
import { COMMERCIAL_MODE } from '../../config.js'
import { DEFAULT_MODELS, normalizeChannelForClient } from '../../shared/channel-utils.js'
import { syncChannelsFromNewApi } from '../../shared/newapi-channel-sync.js'

export const accountChannels = new Hono()

// GET /v1/account/channels — 获取活跃渠道列表
// 每次请求自动对比 New API 渠道：新增的拉下来，模型变化的更新（60s 缓存）
accountChannels.get('/', async (c) => {
  if (!COMMERCIAL_MODE) {
    return c.json({ commercialMode: false, channels: [] })
  }

  const userId = c.get('jwtPayload')?.sub
  if (!userId) {
    return c.json({ error: '未认证' }, 401)
  }

  // 自动从 New API 拉渠道（内部 60s 缓存）
  await syncChannelsFromNewApi(db)
  const channels = listActiveChannels()

  // 所有用户统一：官方渠道 apiKey = relay 令牌 → 走 proxy → New API 扣费
  const relayToken = ensureRelayToken(userId)

  const result = channels.map(ch => {
    let models = JSON.parse(ch.models_json || '[]')
    if (models.length === 0 && DEFAULT_MODELS[ch.provider]) {
      models = DEFAULT_MODELS[ch.provider]
    }
    const urls = normalizeChannelForClient(ch)
    return {
      id: ch.id,
      name: ch.name,
      provider: ch.provider,
      apiKey: relayToken,
      baseUrl: urls.baseUrl,
      agentBaseUrl: urls.agentBaseUrl,
      models,
    }
  })

  return c.json({ commercialMode: true, channels: result })
})
