/**
 * 令牌加密模块 — 应用层 AES-256-GCM 加密
 *
 * 三级降级链路：
 *   1. Electron safeStorage（OS 级，需代码签名）
 *   2. AES-256-GCM（deviceId 派生密钥，当前生产生效）
 *   3. 明文（向后兼容旧文件，仅解密路径）
 *
 * 格式约定：
 *   safeStorage 输出 → base64 编码存储
 *   AES-GCM 输出    → "proferv1:" + base64(iv + tag + ciphertext)
 *   明文（旧格式）  → 直接返回解密时作为兜底
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

/** 密钥缓存：deviceId 不变则派生密钥不变，避免每次加解密都跑 PBKDF2 */
let _cachedDeviceId: string | null = null
let _cachedKey: Buffer | null = null

function deriveKey(): Buffer {
  const deviceId = getOrCreateDeviceIdentity().deviceId
  if (deviceId === _cachedDeviceId && _cachedKey) return _cachedKey
  _cachedKey = crypto.pbkdf2Sync(deviceId, KEY_SALT, KEY_ITERATIONS, KEY_LENGTH, 'sha512')
  _cachedDeviceId = deviceId
  return _cachedKey
}

/**
 * 加密明文令牌。
 *
 * safeStorage 可用 → base64(safeStorage(plaintext))
 * safeStorage 不可用 → "proferv1:" + base64(AES-256-GCM(plaintext))
 * 都失败 → 明文（不抛——不能因为加密失败阻断登录）
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) return ''

  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.encryptString(plaintext).toString('base64')
    } catch (err) {
      console.warn('[token-crypto] safeStorage 加密失败，降级为 AES-GCM:', (err as Error).message)
    }
  }

  try {
    const key = deriveKey()
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGO, key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return AES_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64')
  } catch (err) {
    console.warn('[token-crypto] AES-GCM 加密失败，降级为明文:', (err as Error).message)
    return plaintext
  }
}

/**
 * 解密密文令牌。自动识别格式：
 *   "proferv1:" 前缀  → AES-GCM 解密
 *   safeStorage 可用  → 尝试 base64 → safeStorage
 *   safeStorage 不可用 → 直接返回（旧明文回退）
 */
export function decryptToken(ciphertext: string): string {
  if (!ciphertext) return ''

  // AES-GCM 格式
  if (ciphertext.startsWith(AES_PREFIX)) {
    try {
      const key = deriveKey()
      const buf = Buffer.from(ciphertext.slice(AES_PREFIX.length), 'base64')
      const iv = buf.subarray(0, 16)
      const tag = buf.subarray(16, 32)
      const encrypted = buf.subarray(32)
      const decipher = crypto.createDecipheriv(ALGO, key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    } catch (err) {
      console.error('[token-crypto] AES-GCM 解密失败:', (err as Error).message)
      throw new Error('解密令牌失败')
    }
  }

  // safeStorage 格式（base64 编码的 safeStorage 输出）
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    } catch {
      // 可能是旧明文或损坏数据，走回退
    }
  }

  // 明文回退：旧版本遗留下来的未加密数据
  return ciphertext
}
