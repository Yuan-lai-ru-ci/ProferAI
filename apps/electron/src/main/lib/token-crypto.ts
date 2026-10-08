/**
 * 令牌加密模块 — 应用层 AES-256-GCM 加密
 *
 * 加密链路（失败拒绝保存，不落明文）：
 *   1. Electron safeStorage（OS 级，需代码签名）
 *   2. AES-256-GCM（deviceId 派生密钥，当前生产生效）
 *
 * 格式约定：
 *   safeStorage 输出 → "proferss1:" + base64
 *   AES-GCM 输出    → "proferv1:" + base64(iv + tag + ciphertext)
 *   旧无前缀 base64 → 必须成功解密；不能把损坏密文当作明文
 *   旧明文         → 仅结构明确的 API Key / JWT / JSON 兼容返回
 *
 * 密钥来源：OS 级持久化的 deviceId（注册表/Keychain），PBKDF2 派生 AES-256 密钥。
 * 攻击者拿不到 deviceId 就无法解密，而 deviceId 存在注册表(HKCU)/Keychain，
 * 只对当前用户可读，不会跟备份文件一起泄露。
 */

import crypto from 'node:crypto'
import { safeStorage } from 'electron'
import { getOrCreateDeviceIdentity } from './identity-service'

const ALGO = 'aes-256-gcm'
const KEY_SALT = 'profer-token-v1'
const KEY_ITERATIONS = 100000
const KEY_LENGTH = 32 // 256 bits
const AES_PREFIX = 'proferv1:'
const SAFE_STORAGE_PREFIX = 'proferss1:'

/** 密钥缓存：deviceId 不变则派生密钥不变，避免每次加解密都跑 PBKDF2 */
let _cachedDeviceId: string | null = null
let _cachedKey: Buffer | null = null

function deriveKey(): Buffer {
  const deviceId = getOrCreateDeviceIdentity().deviceId
  if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error('设备身份无效')
  if (deviceId === _cachedDeviceId && _cachedKey) return _cachedKey
  _cachedKey = crypto.pbkdf2Sync(deviceId, KEY_SALT, KEY_ITERATIONS, KEY_LENGTH, 'sha512')
  _cachedDeviceId = deviceId
  return _cachedKey
}

function decodeBase64(value: string): Buffer {
  const buffer = Buffer.from(value, 'base64')
  if (!value || buffer.toString('base64') !== value) throw new Error('密文编码无效')
  return buffer
}

function isLegacyBase64(value: string): boolean {
  // 无前缀格式无法无损区分 base64 密文和同形明文，宁可要求替换凭据。
  return /^[A-Za-z0-9+/=\s]+$/.test(value)
}

function isRecognizableLegacyPlaintext(value: string): boolean {
  if (/^(?:sk-|xai-)[A-Za-z0-9_-]+$/.test(value)) return true
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true
  if (/^\s*[\[{]/.test(value)) {
    try { return typeof JSON.parse(value) === 'object' } catch { return false }
  }
  return false
}

/**
 * 加密明文令牌。
 *
 * safeStorage 可用 → "proferss1:" + base64(safeStorage(plaintext))
 * safeStorage 不可用 → "proferv1:" + base64(AES-256-GCM(plaintext))
 * 都失败 → 抛错，调用方不得保存明文
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) return ''

  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(plaintext)
      if (encrypted.length === 0) throw new Error('safeStorage 密文为空')
      return SAFE_STORAGE_PREFIX + encrypted.toString('base64')
    }
  } catch {
    console.warn('[token-crypto] safeStorage 加密失败，降级为 AES-GCM')
  }

  try {
    const key = deriveKey()
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGO, key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return AES_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64')
  } catch {
    throw new Error('加密令牌失败，已中止保存')
  }
}

/**
 * 解密密文令牌。自动识别格式：
 *   "proferv1:" 前缀  → AES-GCM 解密
 *   "proferss1:" 或旧 base64 → safeStorage 解密，失败不回退明文
 */
export function decryptToken(ciphertext: string): string {
  if (!ciphertext) return ''

  // AES-GCM 格式
  if (ciphertext.startsWith(AES_PREFIX)) {
    try {
      const buf = decodeBase64(ciphertext.slice(AES_PREFIX.length))
      if (buf.length <= 32) throw new Error('密文长度无效')
      const key = deriveKey()
      const iv = buf.subarray(0, 16)
      const tag = buf.subarray(16, 32)
      const encrypted = buf.subarray(32)
      const decipher = crypto.createDecipheriv(ALGO, key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('解密令牌失败')
    }
  }

  if (ciphertext.startsWith(SAFE_STORAGE_PREFIX) || isLegacyBase64(ciphertext)) {
    try {
      const payload = ciphertext.startsWith(SAFE_STORAGE_PREFIX)
        ? ciphertext.slice(SAFE_STORAGE_PREFIX.length)
        : ciphertext
      const buffer = decodeBase64(payload)
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage 不可用')
      return safeStorage.decryptString(buffer)
    } catch {
      throw new Error('解密令牌失败，请在原设备恢复或替换凭据')
    }
  }

  // 保留格式的未知版本或损坏前缀不能被二次加密成“正常凭据”。
  if (/^profer(?:v|ss)/.test(ciphertext)) throw new Error('不支持的令牌密文格式')
  if (isRecognizableLegacyPlaintext(ciphertext)) return ciphertext
  throw new Error('无法识别令牌存储格式，请替换凭据')
}
