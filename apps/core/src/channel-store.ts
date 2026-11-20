import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreChannelConfig } from './config'

const DATA_FILE = 'channels.enc.json'
const KEY_FILE = 'channels.key'

function loadKey(configDir: string): Buffer {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const path = join(configDir, KEY_FILE)
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 })
  chmodSync(path, 0o600)
  const key = readFileSync(path)
  if (key.length !== 32) throw new Error('Core 渠道加密密钥格式无效')
  return key
}

export function readCoreChannelStore(configDir: string, initial: CoreChannelConfig[] = []): CoreChannelConfig[] {
  const path = join(configDir, DATA_FILE)
  if (!existsSync(path)) return initial.map(channel => structuredClone(channel))
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as { iv?: string; tag?: string; data?: string }
  if (!envelope.iv || !envelope.tag || !envelope.data) throw new Error('Core 渠道存储格式无效')
  const decipher = createDecipheriv('aes-256-gcm', loadKey(configDir), Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const value = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')
  const channels: unknown = JSON.parse(value)
  if (!Array.isArray(channels)) throw new Error('Core 渠道存储内容无效')
  return channels as CoreChannelConfig[]
}

export function writeCoreChannelStore(configDir: string, channels: CoreChannelConfig[]): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const key = loadKey(configDir)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(channels)), cipher.final()])
  const path = join(configDir, DATA_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}
