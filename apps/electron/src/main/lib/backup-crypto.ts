/**
 * 个人备份的口令加密（AES-256-GCM）。
 *
 * 备份文件里包含解密后的渠道 API Key，落到网盘/移动硬盘就等于凭据外泄。
 * 这里对**整个归档**加密，而不是挑字段脱敏：只要正文进了备份，就必须整体受保护。
 *
 * 文件布局（按顺序）：
 *   MAGIC(19) | salt(16) | iv(12) | ciphertext | tag(16)
 *
 * - 密钥 = PBKDF2-SHA256(passphrase, salt, 210000, 32)
 * - GCM 认证标签放在文件尾：解密时先读尾部标签，再流式解密，结束时校验完整性
 * - 流式实现避免把 GB 级备份读进内存
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)

/** 识别加密备份的固定前缀。明文 zip 以 PK 开头，不会与之冲突。 */
export const ENCRYPTED_BACKUP_MAGIC = Buffer.from('PROFER-BACKUP-ENC\u0000\u0001', 'utf8')

const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const PBKDF2_ITERATIONS = 210_000
const PBKDF2_DIGEST = 'sha256'

export const ENCRYPTED_HEADER_LENGTH = ENCRYPTED_BACKUP_MAGIC.length + SALT_LENGTH + IV_LENGTH

export const MIN_PASSPHRASE_LENGTH = 8

export class BackupPassphraseError extends Error {
  constructor(message = '口令错误或备份文件已损坏') {
    super(message)
    this.name = 'BackupPassphraseError'
  }
}

export function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`备份口令至少需要 ${MIN_PASSPHRASE_LENGTH} 位`)
  }
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return await pbkdf2Async(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST) as Buffer
}

/** 读取文件头判断是否为加密备份；文件过短或读不到一律按未加密处理。 */
export async function isEncryptedBackup(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    handle = await fsp.open(filePath, 'r')
    const header = Buffer.alloc(ENCRYPTED_BACKUP_MAGIC.length)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead === header.length && header.equals(ENCRYPTED_BACKUP_MAGIC)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * 把明文归档加密到 destPath。
 *
 * 顺序必须是「写头 → 流式加密追加 → 追加标签」。先写 `<目标>.tmp-*` 再原子替换：
 * 失败或用户取消时不会截断/删除目标路径上原有的备份。
 */
export async function encryptBackupFile(
  sourcePath: string,
  destPath: string,
  passphrase: string,
  signal?: AbortSignal,
): Promise<void> {
  assertPassphrase(passphrase)
  signal?.throwIfAborted()

  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const tmpPath = `${destPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`

  await fsp.mkdir(dirname(destPath), { recursive: true })
  try {
    const handle = await fsp.open(tmpPath, 'w', 0o600)
    try {
      await handle.write(Buffer.concat([ENCRYPTED_BACKUP_MAGIC, salt, iv]))
    } finally {
      await handle.close()
    }
    await pipeline(createReadStream(sourcePath), cipher, createWriteStream(tmpPath, { flags: 'a' }), { signal })
    await fsp.appendFile(tmpPath, cipher.getAuthTag())
    await fsp.rename(tmpPath, destPath)
  } catch (error) {
    await fsp.rm(tmpPath, { force: true })
    throw error
  }
}

/** 解密到 destPath；口令错误或密文被篡改时抛 BackupPassphraseError。 */
export async function decryptBackupFile(
  sourcePath: string,
  destPath: string,
  passphrase: string,
): Promise<void> {
  const stat = await fsp.stat(sourcePath)
  if (stat.size < ENCRYPTED_HEADER_LENGTH + TAG_LENGTH) {
    throw new BackupPassphraseError('备份文件不完整')
  }

  const handle = await fsp.open(sourcePath, 'r')
  try {
    const header = Buffer.alloc(ENCRYPTED_HEADER_LENGTH)
    await handle.read(header, 0, ENCRYPTED_HEADER_LENGTH, 0)
    const tag = Buffer.alloc(TAG_LENGTH)
    await handle.read(tag, 0, TAG_LENGTH, stat.size - TAG_LENGTH)

    if (!header.subarray(0, ENCRYPTED_BACKUP_MAGIC.length).equals(ENCRYPTED_BACKUP_MAGIC)) {
      throw new BackupPassphraseError('不是加密的备份文件')
    }

    const saltStart = ENCRYPTED_BACKUP_MAGIC.length
    const salt = header.subarray(saltStart, saltStart + SALT_LENGTH)
    const iv = header.subarray(saltStart + SALT_LENGTH, saltStart + SALT_LENGTH + IV_LENGTH)
    const key = await deriveKey(passphrase, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    await fsp.mkdir(dirname(destPath), { recursive: true })
    try {
      await pipeline(
        createReadStream(sourcePath, {
          start: ENCRYPTED_HEADER_LENGTH,
          end: stat.size - TAG_LENGTH - 1,
        }),
        decipher,
        createWriteStream(destPath),
      )
    } catch {
      // GCM 校验失败与「文件被截断」在 Node 里都是同一类错误，统一提示口令问题。
      await fsp.rm(destPath, { force: true })
      throw new BackupPassphraseError()
    }
  } finally {
    await handle.close().catch(() => {})
  }
}
