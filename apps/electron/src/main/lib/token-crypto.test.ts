import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { safeStorage } from 'electron'

let identityFails = false
let deviceId = 'fixture-device-a'
mock.module('./identity-service', () => ({
  getOrCreateDeviceIdentity: () => {
    if (identityFails) throw new Error('fixture identity unavailable')
    return { deviceId }
  },
}))
const { encryptToken, decryptToken } = await import('./token-crypto')

beforeEach(() => {
  identityFails = false
  deviceId = 'fixture-device-a'
})
afterEach(() => mock.restore())

describe('令牌加密 fail-closed 和旧格式契约', () => {
  test('Given safeStorage 可用 When 加密 Then 写入带前缀密文并可解密', () => {
    spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    spyOn(safeStorage, 'encryptString').mockImplementation(() => Buffer.from('fixture-opaque-ciphertext'))
    spyOn(safeStorage, 'decryptString').mockImplementation((buffer) => {
      expect(buffer.toString()).toBe('fixture-opaque-ciphertext')
      return 'fixture-secret'
    })
    const encrypted = encryptToken('fixture-secret')
    expect(encrypted).toBe('proferss1:' + Buffer.from('fixture-opaque-ciphertext').toString('base64'))
    expect(decryptToken(encrypted)).toBe('fixture-secret')
  })

  test('Given safeStorage 不可用 When 加密 Then AES-GCM 密文不含明文且可解密', () => {
    const encrypted = encryptToken('fixture-secret')
    expect(encrypted.startsWith('proferv1:')).toBe(true)
    expect(encrypted).not.toContain('fixture-secret')
    expect(decryptToken(encrypted)).toBe('fixture-secret')
  })

  test('Given safeStorage 加密抛错 When AES 可用 Then 使用 AES 而不是明文', () => {
    spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    spyOn(safeStorage, 'encryptString').mockImplementation(() => { throw new Error('fixture failure') })
    const encrypted = encryptToken('fixture-secret')
    expect(encrypted.startsWith('proferv1:')).toBe(true)
    expect(decryptToken(encrypted)).toBe('fixture-secret')
  })

  test('Given safeStorage 输出为空 When 加密 Then 使用 AES 而不是写入无效密文', () => {
    spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    spyOn(safeStorage, 'encryptString').mockReturnValue(Buffer.alloc(0))
    expect(encryptToken('fixture-secret').startsWith('proferv1:')).toBe(true)
  })

  test('Given 设备 ID 为空 When AES 加密 Then fail-closed', () => {
    deviceId = ''
    expect(() => encryptToken('fixture-secret')).toThrow('加密令牌失败')
  })

  test('Given 两级加密都失败 When 保存非空凭据 Then 抛错且绝不返回明文', () => {
    identityFails = true
    expect(() => encryptToken('fixture-secret')).toThrow('加密令牌失败')
    spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    spyOn(safeStorage, 'encryptString').mockImplementation(() => { throw new Error('fixture failure') })
    expect(() => encryptToken('fixture-secret')).toThrow('加密令牌失败')
  })

  test('Given safeStorage 状态查询抛错 When AES 可用 Then 仍可加密', () => {
    spyOn(safeStorage, 'isEncryptionAvailable').mockImplementation(() => { throw new Error('fixture unavailable') })
    expect(decryptToken(encryptToken('fixture-secret'))).toBe('fixture-secret')
  })

  test('Given 旧无前缀 safeStorage 密文 When 解密成功 Then 兼容旧值', () => {
    spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    spyOn(safeStorage, 'decryptString').mockReturnValue('fixture-old-secret')
    expect(decryptToken(Buffer.from('fixture-old-ciphertext').toString('base64'))).toBe('fixture-old-secret')
  })

  test('Given 新旧 safeStorage 密文 When OS 不可用或解密失败 Then 不回退明文', () => {
    const legacy = Buffer.from('fixture-old-ciphertext').toString('base64')
    expect(() => decryptToken(legacy)).toThrow('解密令牌失败')
    expect(() => decryptToken('proferss1:' + legacy)).toThrow('解密令牌失败')
    spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    spyOn(safeStorage, 'decryptString').mockImplementation(() => { throw new Error('fixture wrong device') })
    expect(() => decryptToken(legacy)).toThrow('解密令牌失败')
    expect(() => decryptToken('proferss1:' + legacy)).toThrow('解密令牌失败')
  })

  test('Given AES 密文损坏或设备不同 When 解密 Then 不返回原密文', () => {
    const encrypted = encryptToken('fixture-secret')
    const buffer = Buffer.from(encrypted.slice('proferv1:'.length), 'base64')
    buffer[buffer.length - 1] = buffer[buffer.length - 1]! ^ 1
    expect(() => decryptToken('proferv1:' + buffer.toString('base64'))).toThrow('解密令牌失败')
    deviceId = 'fixture-device-b'
    expect(() => decryptToken(encrypted)).toThrow('解密令牌失败')
  })

  test('Given 畸形编码、截断或未知版本 When 解密 Then 拒绝而不是当明文', () => {
    for (const value of ['proferv1:!!', 'proferv1:AAAA', 'proferss1:', 'proferss1:!!', 'proferv2:AAAA', 'YWJj ZA==', 'YWJjZA===']) {
      expect(() => decryptToken(value)).toThrow()
    }
  })

  test('Given 明确的旧明文 When 解密 Then 兼容 API key、JWT 和 OAuth JSON', () => {
    for (const value of ['sk-fixture-key', 'fixture.jwt.signature', '{"access":"fixture-access","refresh":"fixture-refresh"}']) {
      expect(decryptToken(value)).toBe(value)
      expect(decryptToken(encryptToken(value))).toBe(value)
    }
  })

  test('Given 同形 base64 旧明文 When 无法可靠辨别 Then 要求替换而不是猜测', () => {
    expect(() => decryptToken('YWJjZA==')).toThrow('解密令牌失败')
    expect(() => decryptToken('fixtureOnlyAlphanumeric')).toThrow('解密令牌失败')
    expect(() => decryptToken('YWJjZA!!')).toThrow('无法识别令牌存储格式')
    expect(() => decryptToken('{broken')).toThrow('无法识别令牌存储格式')
  })

  test('Given 空凭据 When 加解密 Then 保留空值且不触碰设备身份', () => {
    identityFails = true
    expect(encryptToken('')).toBe('')
    expect(decryptToken('')).toBe('')
  })
})
