/**
 * 用户渠道获取路由 — 登录后拉取服务端统一管理的渠道（含解密后的 API Key）
 */
import { Hono } from 'hono'
import { createDecipheriv } from 'crypto'
import { listActiveChannels } from '../../db.js'
import { CHANNEL_ENCRYPTION_KEY, COMMERCIAL_MODE } from '../../config.js'

export const accountChannels = new Hono()

function decryptApiKey(ciphertext) {
  const { iv, data, tag } = JSON.parse(ciphertext)
  const key = Buffer.from(CHANNEL_ENCRYPTION_KEY, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8')
}

// GET /v1/account/channels — 获取解密后的活跃渠道列表
accountChannels.get('/', (c) => {
  if (!COMMERCIAL_MODE) {
    return c.json({ commercialMode: false, channels: [] })
  }
  if (!CHANNEL_ENCRYPTION_KEY) {
    return c.json({ error: '服务端渠道加密未配置' }, 500)
  }

  const channels = listActiveChannels()
  const decrypted = channels.map(ch => {
    const models = JSON.parse(ch.models_json || '[]')
    return {
      id: ch.id,
      name: ch.name,
      provider: ch.provider,
      apiKey: decryptApiKey(ch.api_key_encrypted),
      baseUrl: ch.base_url,
      models,
    }
  })

  return c.json({ commercialMode: true, channels: decrypted })
})
