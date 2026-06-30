/**
 * 渠道工具 — 提供者模型默认值、API Key 加解密、URL 规范化
 *
 * 统一 account/channels 和 admin/channels 中重复的常量与逻辑。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { CHANNEL_ENCRYPTION_KEY } from '../config.js'

const ALGO = 'aes-256-gcm'

// ---- 默认模型（按 provider 分类） ----
export const DEFAULT_MODELS = {
  deepseek: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', enabled: true },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', enabled: true },
  ],
  openai: [
    { id: 'gpt-5', name: 'GPT-5', enabled: true },
    { id: 'gpt-5-mini', name: 'GPT-5 Mini', enabled: true },
  ],
  qwen: [
    { id: 'qwen-plus', name: 'Qwen Plus', enabled: true },
    { id: 'qwen-max', name: 'Qwen Max', enabled: true },
  ],
  'kimi-api': [
    { id: 'kimi-k2', name: 'Kimi K2', enabled: true },
  ],
  zhipu: [
    { id: 'glm-4', name: 'GLM-4', enabled: true },
  ],
  minimax: [
    { id: 'minimax-m1', name: 'MiniMax M1', enabled: true },
  ],
  doubao: [
    { id: 'doubao-1.5-pro', name: '豆包 1.5 Pro', enabled: true },
  ],
}

// ---- API Key 加解密 ----

export function encryptApiKey(plaintext) {
  const key = Buffer.from(CHANNEL_ENCRYPTION_KEY, 'hex')
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex'), tag: tag.toString('hex') })
}

export function decryptApiKey(ciphertext) {
  const { iv, data, tag } = JSON.parse(ciphertext)
  const key = Buffer.from(CHANNEL_ENCRYPTION_KEY, 'hex')
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8')
}

// ---- URL 规范化 ----

/**
 * 规范化渠道的 baseUrl / agentBaseUrl。
 * DeepSeek 有特殊的 Anthropic 兼容端点需要处理。
 */
export function normalizeChannelUrls(provider, baseUrl, agentBaseUrl) {
  if (provider !== 'deepseek') {
    return {
      baseUrl: baseUrl || '',
      agentBaseUrl: agentBaseUrl || '',
    }
  }

  const normalizedBase = (baseUrl || '').trim().replace(/\/+$/, '')
  const chatBaseUrl =
    !normalizedBase ||
    normalizedBase === 'https://api.deepseek.com/v1' ||
    normalizedBase.includes('/anthropic')
      ? 'https://api.deepseek.com'
      : normalizedBase

  return {
    baseUrl: chatBaseUrl,
    agentBaseUrl: (agentBaseUrl || '').trim() || 'https://api.deepseek.com/anthropic',
  }
}

/**
 * 渠道列表返回给客户端时的 URL 规范化（不修改原始渠道数据）
 */
export function normalizeChannelForClient(ch) {
  if (ch.provider !== 'deepseek') {
    return {
      baseUrl: ch.base_url,
      agentBaseUrl: ch.agent_base_url || '',
    }
  }

  const baseUrl = (ch.base_url || '').trim().replace(/\/+$/, '')
  const chatBaseUrl =
    !baseUrl ||
    baseUrl === 'https://api.deepseek.com/v1' ||
    baseUrl.includes('/anthropic')
      ? 'https://api.deepseek.com'
      : baseUrl

  return {
    baseUrl: chatBaseUrl,
    agentBaseUrl: (ch.agent_base_url || '').trim() || 'https://api.deepseek.com/anthropic',
  }
}
