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
import { listActiveChannels, ensureRelayToken } from '../../db.js'
import { COMMERCIAL_MODE } from '../../config.js'
import { DEFAULT_MODELS, normalizeChannelForClient } from '../../shared/channel-utils.js'

export const accountChannels = new Hono()

// GET /v1/account/channels — 获取活跃渠道列表（apiKey 为用户专属 relay 令牌）
accountChannels.get('/', (c) => {
  if (!COMMERCIAL_MODE) {
    return c.json({ commercialMode: false, channels: [] })
  }

  const userId = c.get('jwtPayload')?.sub
  if (!userId) {
    return c.json({ error: '未认证' }, 401)
  }

  // 为该用户签发/复用长效 relay 令牌，所有渠道共用同一令牌：
  // 令牌只负责认人，上游路由由请求体里的 model 决定。
  const relayToken = ensureRelayToken(userId)

  const channels = listActiveChannels()
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
