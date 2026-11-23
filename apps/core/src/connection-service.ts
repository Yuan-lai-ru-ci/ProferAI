import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, networkInterfaces } from 'node:os'
import { generate } from 'selfsigned'
import { isCoreConnectionTtl } from '@profer/shared'
import type { CoreConnectionBinding, CoreConnectionInvitation, CoreConnectionState, CorePairingResult } from '@profer/shared'

interface StoredBinding extends CoreConnectionBinding { hash: string }
interface StoredConnection { version: 1; coreId: string; name: string; cert: string; key: string; sharingEnabled: boolean; port: number; bindings: StoredBinding[] }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const secret = (): string => randomBytes(32).toString('base64url')
export class CoreConnectionService {
  private invitations = new Map<string, { expiresAt: number; bindingTtlSeconds: number }>()
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private revocations = new Set<(id: string) => void>()
  private constructor(private file: string, private data: StoredConnection) {}
  static async open(configDir: string, coreId: string): Promise<CoreConnectionService> {
    const file = join(configDir, 'core-connection.json')
    let data: StoredConnection
    if (existsSync(file)) {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Core TLS 身份权限无效')
      data = JSON.parse(readFileSync(file, 'utf8')) as StoredConnection
      const cert = new X509Certificate(data.cert)
      const { createPrivateKey } = await import('node:crypto')
      if (data.version !== 1 || data.coreId !== coreId || !cert.checkPrivateKey(createPrivateKey(data.key)) || Date.parse(cert.validTo) <= Date.now()) throw new Error('Core TLS 身份损坏或过期，不能静默轮换')
    } else {
      const generated = await generate([{ name: 'commonName', value: 'Profer Core' }], {
        keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: new Date(Date.now() - 300_000), notAfterDate: new Date(Date.now() + 10 * 365 * 86400_000),
        extensions: [{ name: 'basicConstraints', cA: false, critical: true }, { name: 'keyUsage', digitalSignature: true, critical: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }] }],
      })
      data = { version: 1, coreId, name: hostname(), cert: generated.cert, key: generated.private, sharingEnabled: false, port: 0, bindings: [] }
      mkdirSync(configDir, { recursive: true, mode: 0o700 })
    }
    const service = new CoreConnectionService(file, data)
    service.save()
    for (const binding of data.bindings) service.scheduleExpiry(binding)
    return service
  }
  private save(): void {
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.data), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.file)
  }
  get tls(): { cert: string; key: string } { return { cert: this.data.cert, key: this.data.key } }
  state(addresses = Object.values(networkInterfaces()).flatMap(list => list ?? []).filter(ip => !ip.internal && ip.family === 'IPv4').map(ip => ip.address)): CoreConnectionState {
    const pin = createHash('sha256').update(new X509Certificate(this.data.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    return { coreId: this.data.coreId, name: this.data.name, sharingEnabled: this.data.sharingEnabled, port: this.data.port,
      endpoints: addresses.map(address => { if (!/^[a-zA-Z0-9.:[\]_-]+$/.test(address)) throw new Error('Core 地址无效'); return `https://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${this.data.port}` }),
      pin: { algorithm: 'spki-sha256', value: `sha256/${pin}` }, bindings: this.data.bindings.map(({ hash: _, ...binding }) => binding) }
  }
  setSharing(enabled: boolean, port = this.data.port): void { this.data.sharingEnabled = enabled; this.data.port = port; if (!enabled) this.invitations.clear(); this.save() }
  invite(addresses?: string[], name?: string, ttlSeconds = 300, bindingTtlSeconds = 86400): CoreConnectionInvitation {
    if (!isCoreConnectionTtl(ttlSeconds)) throw new Error('邀请时长无效')
    if (!isCoreConnectionTtl(bindingTtlSeconds)) throw new Error('连接期限无效')
    const state = this.state(addresses)
    const invitationToken = secret(); const expiresAt = Date.now() + ttlSeconds * 1000
    for (const [key, expiry] of this.invitations) if (expiry.expiresAt <= Date.now()) this.invitations.delete(key)
    if (this.invitations.size >= 32) throw new Error('有效邀请过多')
    this.invitations.set(hash(invitationToken), { expiresAt, bindingTtlSeconds })
    return { version: 1, coreId: state.coreId, name: name?.trim().slice(0, 128) || state.name, endpoints: state.endpoints, pin: state.pin, invitationToken, expiresAt, bindingTtlSeconds }
  }
  pair(token: string, clientName: string): CorePairingResult {
    const digest = hash(token); const expiry = this.invitations.get(digest)
    if (!expiry || expiry.expiresAt <= Date.now()) throw new Error('邀请无效或已消费')
    if (!clientName.trim() || clientName.length > 128) throw new Error('客户端名称无效')
    this.invitations.delete(digest)
    const credential = secret(); const bindingId = randomUUID()
    const createdAt = Date.now()
    const expiresAt = createdAt + expiry.bindingTtlSeconds * 1000
    const binding = { expiresAt, id: bindingId, clientName: clientName.trim(), createdAt, hash: hash(credential) }
    this.data.bindings.push(binding)
    this.save()
    this.scheduleExpiry(binding)
    return { coreId: this.data.coreId, name: this.data.name, bindingId, credential, expiresAt }
  }
  authenticate(credential: string | undefined): string | undefined { return credential ? this.data.bindings.find(binding => binding.hash === hash(credential) && (binding.expiresAt === undefined || binding.expiresAt > Date.now()))?.id : undefined }
  revoke(id: string): boolean {
    if (!this.data.bindings.some(binding => binding.id === id)) return false
    this.data.bindings = this.data.bindings.filter(binding => binding.id !== id); this.save()
    clearTimeout(this.expiryTimers.get(id))
    this.expiryTimers.delete(id)
    for (const listener of this.revocations) listener(id)
    return true
  }
  private scheduleExpiry({ id, expiresAt }: CoreConnectionBinding): void {
    if (expiresAt === undefined || expiresAt <= Date.now()) return
    const tick = () => {
      if (expiresAt > Date.now()) {
        const delay = Math.min(2 ** 31 - 1, expiresAt - Date.now())
        this.expiryTimers.set(id, setTimeout(tick, delay).unref())
        return
      }
      this.expiryTimers.delete(id)
      for (const listener of this.revocations) listener(id)
    }
    tick()
  }
  close(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    this.expiryTimers.clear()
  }
  onRevoke(listener: (id: string) => void): () => void { this.revocations.add(listener); return () => this.revocations.delete(listener) }
}
