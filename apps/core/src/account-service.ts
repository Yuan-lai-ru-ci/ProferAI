import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import { join } from 'node:path'
import type { CoreChannelConfig } from './config'
import { readCoreChannelStore, writeCoreChannelStore } from './channel-store'

export const CORE_ACCOUNT_OPERATIONS = ['login', 'register', 'logout', 'status', 'teamAuth', 'serverInfo', 'registrationOptions', 'sendRegistrationOtp', 'verifyRegistrationOtp', 'listDevices', 'revokeDevice', 'refresh'] as const
export type CoreAccountOperation = typeof CORE_ACCOUNT_OPERATIONS[number]
interface AccountStore { baseUrl: string; session: Session; defaultChannelId?: string; defaultModelId?: string }
interface Session {
  accessToken: string; refreshToken: string; relayToken?: string; expiresAt: number
  userId: string; email: string; displayName?: string; membershipTier?: string
  commercialMode?: boolean; isAdmin?: boolean; joinedWorkspace?: string
}

/** 独立Core的私有账号目录；不读取任何桌面身份或渠道文件。 */
export class CoreAccountService {
  readonly deviceId: string
  readonly ready: Promise<void>
  channels: CoreChannelConfig[] = []
  defaultChannelId?: string
  defaultModelId?: string
  private session?: Session
  private generation = 0
  private timer?: ReturnType<typeof setTimeout>
  private refreshing?: { generation: number; promise: Promise<boolean> }
  private disposed = false
  private readonly directory: string
  private readonly baseUrl: string
  constructor(configDir: string, baseUrl = 'https://profer.cn/profer', private readonly changed: () => void = () => {}, private readonly reservedIds: () => Set<string> = () => new Set()) {
    const url = new URL(baseUrl)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error('账号服务器必须使用 HTTPS 或回环 HTTP')
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.directory = join(configDir, 'account')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    chmodSync(this.directory, 0o700)
    const devicePath = join(this.directory, 'device-id')
    if (!existsSync(devicePath)) writeFileSync(devicePath, randomUUID(), { flag: 'wx', mode: 0o600 })
    this.deviceId = readFileSync(devicePath, 'utf8').trim()
    // 复用渠道存储的 AES-GCM 信封和原子写入；只在独立 account 子目录使用。
    const stored = readCoreChannelStore(this.directory) as unknown as AccountStore[]
    const value = stored[0]
    if (value?.baseUrl === this.baseUrl) { this.session = value.session; this.defaultChannelId = value.defaultChannelId; this.defaultModelId = value.defaultModelId }
    this.ready = this.restore()
  }
  private device() { return { deviceId: this.deviceId, deviceName: `${hostname()} (Core)`, platform: platform(), appVersion: 'core' } }
  private save() {
    writeCoreChannelStore(this.directory, (this.session ? [{ baseUrl: this.baseUrl, session: this.session, defaultChannelId: this.defaultChannelId, defaultModelId: this.defaultModelId }] : []) as unknown as CoreChannelConfig[])
    this.changed()
  }
  private async request(path: string, body?: unknown, token?: string, method?: string) {
    return fetch(`${this.baseUrl}/v1${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) })
  }
  private schedule(delay?: number) {
    clearTimeout(this.timer)
    if (!this.session || this.disposed) return
    this.timer = setTimeout(() => { void this.refresh().then(ok => { if (!ok) this.schedule(60000) }).catch(() => this.schedule(60000)) }, delay ?? Math.max(30000, this.session.expiresAt - Date.now() - 300000))
    this.timer.unref?.()
  }
  private async restore() {
    if (!this.session) return
    if (this.session.expiresAt <= Date.now()) {
      const generation = this.generation
      if (!await this.refresh() && generation === this.generation) this.schedule(60000)
      return
    }
    try { await this.catalog(this.generation) } catch { /* 官方目录不缓存落盘；网络恢复后refresh重新拉取。 */ }
    this.schedule()
  }
  private async catalog(generation: number, persist = true, candidate?: Session) {
    const session = candidate ?? this.session
    if (!session) return
    const response = await this.request('/account/channels', undefined, session.accessToken)
    if (!response.ok) throw new Error(`官方渠道同步失败 (${response.status})`)
    const data = await response.json() as { commercialMode?: boolean; channels?: Array<CoreChannelConfig & { directDataPlane?: boolean }> }
    if (generation !== this.generation || this.disposed) return
    if (!Array.isArray(data.channels)) throw new Error('官方渠道响应无效')
    const ids = this.reservedIds()
    this.channels = data.channels.map(channel => {
      let id = channel.id
      while (ids.has(id)) id = `account:${id}`
      ids.add(id)
      return ({ ...channel, id, serverManaged: true, forceBearerAuth: channel.directDataPlane !== true, baseUrl: channel.baseUrl || `${this.baseUrl}/v1/proxy`, apiKey: channel.directDataPlane ? channel.apiKey : (session.relayToken || session.accessToken) }) })
    if (!this.channels.some(channel => channel.id === this.defaultChannelId && channel.models?.some(model => model.id === this.defaultModelId && model.enabled))) {
      const first = this.channels.find(channel => channel.enabled !== false && channel.models?.some(model => model.enabled))
      this.defaultChannelId = first?.id
      this.defaultModelId = first?.models?.find(model => model.enabled)?.id
    }
    if (persist) this.save()
  }
  refresh(): Promise<boolean> {
    const generation = this.generation
    if (this.refreshing?.generation === generation) return this.refreshing.promise
    const session = this.session
    if (!session || this.disposed) return Promise.resolve(false)
    const promise = (async () => {
      try {
        const response = await this.request('/auth/refresh', { refreshToken: session.refreshToken, ...this.device() })
        if (generation !== this.generation || this.disposed) return false
        if (!response.ok) {
          if (response.status === 401) { this.session = undefined; this.channels = []; this.save(); clearTimeout(this.timer) }
          return false
        }
        const data = await response.json() as Partial<Session>
        if (generation !== this.generation || this.disposed) return false
        if (!data.accessToken || !Number.isFinite(data.expiresAt)) throw new Error('续期响应无效')
        this.session = { ...session, ...data }
        this.save()
        await this.catalog(generation)
        this.schedule()
        return true
      } catch { return false }
    })().finally(() => { if (this.refreshing?.promise === promise) this.refreshing = undefined })
    this.refreshing = { generation, promise }
    return promise
  }
  private async validSession() {
    if (this.session && this.session.expiresAt <= Date.now()) await this.refresh()
    return this.session && this.session.expiresAt > Date.now() ? this.session : undefined
  }
  async operation(operation: string, args: unknown[] = []): Promise<unknown> {
    if (!(CORE_ACCOUNT_OPERATIONS as readonly string[]).includes(operation)) throw new Error('非法账号操作')
    if (!Array.isArray(args) || args.some(value => value !== undefined && value !== null && typeof value !== 'string')) throw new Error('账号操作参数无效')
    try { return await this.execute(operation, args as string[]) } catch {
      if (operation === 'registrationOptions') return { openRegistration: false }
      if (operation === 'listDevices' || operation === 'revokeDevice') return { ok: false, error: '无法连接团队服务器', ...(operation === 'listDevices' ? { currentDeviceId: this.deviceId } : {}) }
      if (operation === 'sendRegistrationOtp' || operation === 'verifyRegistrationOtp') return { success: false, error: '无法连接到团队服务器' }
      throw new Error('账号操作失败')
    }
  }
  private async execute(operation: string, strings: string[]): Promise<unknown> {
    if (operation === 'login' || operation === 'register') {
      const names = operation === 'login' ? ['email', 'password', 'revokeSlotId'] : ['email', 'password', 'displayName', 'inviteCode', 'activationCode', 'invitationToken', 'otpToken', 'emailOtp']
      if (!strings[0] || !strings[1]) return { success: false, error: '邮箱与密码不能为空' }
      const generation = ++this.generation
      clearTimeout(this.timer)
      const previous = { session: this.session, channels: this.channels, defaultChannelId: this.defaultChannelId, defaultModelId: this.defaultModelId }
      try {
        const response = await this.request(`/auth/${operation}`, { ...Object.fromEntries(names.map((key, index) => [key, strings[index]])), ...this.device() })
        const data = await response.json() as Session & { error?: string; code?: string; maxDevices?: number; devices?: unknown[] }
        if (generation !== this.generation || this.disposed) return { success: false, error: '账号会话已变化' }
        if (!response.ok) { this.schedule(); return { success: false, error: data.error || `服务器错误 (${response.status})`, ...(data.code === 'device_limit' ? { deviceLimit: { maxDevices: data.maxDevices ?? 0, devices: data.devices ?? [] } } : {}) } }
        if (!data.accessToken || !data.refreshToken || !data.userId || !Number.isFinite(data.expiresAt)) { this.schedule(); return { success: false, error: '登录响应无效' } }
        let catalogError: unknown
        try { await this.catalog(generation, false, data) } catch (error) { catalogError = error }
        if (generation !== this.generation || this.disposed) return { success: false, error: '账号会话已变化' }
        if (catalogError) {
          this.session = previous.session; this.channels = previous.channels; this.defaultChannelId = previous.defaultChannelId; this.defaultModelId = previous.defaultModelId
          this.schedule()
          return { success: false, error: '官方渠道同步失败，未切换账号' }
        }
        this.session = data
        try { this.save() } catch {
          this.session = previous.session; this.channels = previous.channels; this.defaultChannelId = previous.defaultChannelId; this.defaultModelId = previous.defaultModelId
          this.changed(); this.schedule()
          return { success: false, error: '账号会话保存失败' }
        }
        this.schedule()
        return { success: true, teamAccountId: data.userId, teamEmail: data.email, displayName: data.displayName, membershipTier: data.membershipTier, commercialMode: data.commercialMode === true, isAdmin: data.isAdmin === true, joinedWorkspace: data.joinedWorkspace }
      } catch {
        if (this.generation === generation) {
          this.session = previous.session; this.channels = previous.channels; this.defaultChannelId = previous.defaultChannelId; this.defaultModelId = previous.defaultModelId
          this.schedule()
        }
        return { success: false, error: '无法完成账号登录' }
      }
    }
    if (operation === 'logout') {
      ++this.generation; clearTimeout(this.timer)
      const session = this.session; const channelsCleared = this.channels.length > 0
      this.session = undefined; this.channels = []; this.save()
      if (session) { try { await this.request('/auth/logout', { deviceId: this.deviceId }, session.accessToken) } catch { /* 本地登出不依赖网络。 */ } }
      return { channelsCleared, channelsBackedUp: false }
    }
    if (operation === 'refresh') return this.refresh()
    if (operation === 'status') {
      const session = await this.validSession()
      return session ? { isLoggedIn: true, teamAccountId: session.userId, teamEmail: session.email, commercialMode: session.commercialMode === true, isAdmin: session.isAdmin === true } : { isLoggedIn: false }
    }
    if (operation === 'serverInfo') return this.session ? [{ baseUrl: this.baseUrl, email: this.session.email, isLoggedIn: this.session.expiresAt > Date.now() }] : []
    if (operation === 'teamAuth') {
      const session = await this.validSession()
      return session ? { baseUrl: this.baseUrl, token: session.accessToken, proxyToken: session.relayToken, membershipTier: session.membershipTier, teamEmail: session.email, teamAccountId: session.userId } : null
    }
    if (operation === 'listDevices' || operation === 'revokeDevice') {
      const session = await this.validSession()
      if (!session) return { ok: false, error: '未登录团队账号', ...(operation === 'listDevices' ? { currentDeviceId: this.deviceId } : {}) }
      let response = await this.request(operation === 'listDevices' ? '/auth/devices' : `/auth/devices/${encodeURIComponent(strings[0] ?? '')}`, undefined, session.accessToken, operation === 'listDevices' ? 'GET' : 'DELETE')
      if (operation === 'listDevices' && response.status === 401 && await this.refresh()) {
        const fresh = await this.validSession()
        if (fresh) response = await this.request('/auth/devices', undefined, fresh.accessToken)
      }
      if (!response.ok) return { ok: false, error: `服务器错误 (${response.status})` }
      return operation === 'listDevices' ? { ok: true, devices: ((await response.json()) as { devices?: unknown[] }).devices ?? [], currentDeviceId: this.deviceId } : { ok: true }
    }
    const path = operation === 'registrationOptions' ? '/registration-options' : operation === 'sendRegistrationOtp' ? '/register-otp/send' : '/register-otp/verify'
    const body = operation === 'registrationOptions' ? undefined : operation === 'sendRegistrationOtp' ? { email: strings[0] } : { email: strings[0], otpToken: strings[1], code: strings[2] }
    const response = await this.request(`/auth${path}`, body)
    const data = await response.json() as { openRegistration?: boolean; otpToken?: string; resendAfterSec?: number; verified?: boolean; error?: string }
    if (operation === 'registrationOptions') return { openRegistration: response.ok && data.openRegistration === true }
    return { success: response.ok && (operation !== 'verifyRegistrationOtp' || data.verified === true), ...(operation === 'sendRegistrationOtp' ? { otpToken: data.otpToken, resendAfterSec: data.resendAfterSec } : {}), ...(!response.ok || (operation === 'verifyRegistrationOtp' && !data.verified) ? { error: data.error || '验证码校验失败' } : {}) }
  }
  dispose() { this.disposed = true; ++this.generation; clearTimeout(this.timer) }
}
