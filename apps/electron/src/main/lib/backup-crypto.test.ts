import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  BackupPassphraseError,
  decryptBackupFile,
  encryptBackupFile,
  isEncryptedBackup,
} from './backup-crypto'

const root = join(tmpdir(), `profer-backup-crypto-${Date.now()}`)
const passphrase = 'correct horse battery'

beforeAll(() => {
  mkdirSync(root, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('备份口令加密', () => {
  test('Given 明文归档 When 加密再解密 Then 内容一致且文件头可识别', async () => {
    const plain = join(root, 'plain.zip')
    const encrypted = join(root, 'encrypted.profer-backup')
    const decrypted = join(root, 'decrypted.zip')
    const content = randomBytes(2 * 1024 * 1024)
    writeFileSync(plain, content)

    expect(await isEncryptedBackup(plain)).toBe(false)
    await encryptBackupFile(plain, encrypted, passphrase)
    expect(await isEncryptedBackup(encrypted)).toBe(true)

    const cipherText = readFileSync(encrypted)
    expect(cipherText.includes(content.subarray(0, 32))).toBe(false)

    await decryptBackupFile(encrypted, decrypted, passphrase)
    expect(readFileSync(decrypted).equals(content)).toBe(true)
  }, 60_000)

  test('Given 错误口令 When 解密 Then 报口令错误且不留下半成品', async () => {
    const plain = join(root, 'plain2.zip')
    const encrypted = join(root, 'encrypted2.profer-backup')
    const decrypted = join(root, 'decrypted2.zip')
    writeFileSync(plain, 'backup content'.repeat(1000))
    await encryptBackupFile(plain, encrypted, passphrase)

    await expect(decryptBackupFile(encrypted, decrypted, 'wrong passphrase')).rejects.toBeInstanceOf(BackupPassphraseError)
    expect(existsSync(decrypted)).toBe(false)
  }, 60_000)

  test('Given 密文被篡改 When 解密 Then 认证失败而不是静默输出错数据', async () => {
    const plain = join(root, 'plain3.zip')
    const encrypted = join(root, 'encrypted3.profer-backup')
    const decrypted = join(root, 'decrypted3.zip')
    writeFileSync(plain, 'x'.repeat(5000))
    await encryptBackupFile(plain, encrypted, passphrase)

    const bytes = readFileSync(encrypted)
    const dataOffset = 60
    bytes[dataOffset] = bytes[dataOffset]! ^ 0xff
    writeFileSync(encrypted, bytes)

    await expect(decryptBackupFile(encrypted, decrypted, passphrase)).rejects.toBeInstanceOf(BackupPassphraseError)
  }, 60_000)

  test('Given 口令过短 When 加密 Then 明确拒绝', async () => {
    const plain = join(root, 'plain4.zip')
    writeFileSync(plain, 'x')
    await expect(encryptBackupFile(plain, join(root, 'short.profer-backup'), '123')).rejects.toThrow('至少')
  })

  test('Given 目标位置已有备份 When 加密中途失败 Then 原备份不被截断', async () => {
    const dest = join(root, 'existing.profer-backup')
    writeFileSync(dest, 'old-backup')

    await expect(encryptBackupFile(join(root, 'missing.zip'), dest, passphrase)).rejects.toThrow()
    expect(readFileSync(dest, 'utf8')).toBe('old-backup')
  })
})
