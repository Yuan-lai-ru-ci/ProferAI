import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreConnectionService } from './connection-service'

test('邀请一次消费、两客户端独立撤销、身份和授权跨重启持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-connection-'))
  try {
    const service = await CoreConnectionService.open(dir, 'core-test')
    const a = service.invite(['127.0.0.1'])
    const first = service.pair(a.invitationToken, 'Mac')
    expect(() => service.pair(a.invitationToken, 'again')).toThrow()
    const second = service.pair(service.invite(['127.0.0.1']).invitationToken, 'Windows')
    expect(service.authenticate(first.credential)).toBe(first.bindingId)
    expect(readFileSync(join(dir, 'core-connection.json'), 'utf8')).not.toContain(first.credential)
    service.revoke(first.bindingId)
    expect(service.authenticate(first.credential)).toBeUndefined()
    const restored = await CoreConnectionService.open(dir, 'core-test')
    expect(restored.state().pin).toEqual(service.state().pin)
    expect(restored.authenticate(second.credential)).toBe(second.bindingId)
    expect(() => service.pair('invalid', 'bad')).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('过期邀请拒绝消费，关闭共享使未消费邀请失效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-invite-expiry-'))
  const now = Date.now
  try {
    const service = await CoreConnectionService.open(dir, 'expiry-core')
    const invite = service.invite(['127.0.0.1'])
    Date.now = () => invite.expiresAt + 1
    expect(() => service.pair(invite.invitationToken, 'late')).toThrow()
    Date.now = now
    const next = service.invite(['127.0.0.1'])
    service.setSharing(false)
    expect(() => service.pair(next.invitationToken, 'disabled')).toThrow()
  } finally { Date.now = now; rmSync(dir, { recursive: true, force: true }) }
})

test('邀请时长只接受四种选项，默认五分钟且各时长到期不可消费', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-invite-ttl-'))
  const now = Date.now
  try {
    const service = await CoreConnectionService.open(dir, 'ttl-core')
    const start = now()
    Date.now = () => start
    expect(service.invite(['127.0.0.1']).expiresAt).toBe(start + 300_000)
    for (const ttl of [60, 300, 1800, 3600, 86400, 2592000]) {
      const invitation = service.invite(['127.0.0.1'], 'Custom', ttl)
      expect(invitation.expiresAt).toBe(start + ttl * 1000)
      Date.now = () => invitation.expiresAt
      expect(() => service.pair(invitation.invitationToken, 'expired')).toThrow()
      Date.now = () => start
    }
    for (const ttl of [0, -1, 59, 2592001, 300.5, NaN, Infinity, '300', null]) {
      expect(() => service.invite(undefined, undefined, ttl as number)).toThrow('邀请时长无效')
    }
  } finally { Date.now = now; rmSync(dir, { recursive: true, force: true }) }
})

test('绑定从配对时计时，最长30天，到期拒绝且保留历史；重启兼容旧无期授权', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-binding-ttl-'))
  const now = Date.now
  let service: CoreConnectionService | undefined
  try {
    service = await CoreConnectionService.open(dir, 'binding-core')
    const start = now()
    Date.now = () => start
    for (const invalid of [0, -1, 59, 2592001, NaN, Infinity, '60']) {
      expect(() => service!.invite(undefined, undefined, 300, invalid as number)).toThrow('连接期限无效')
    }
    const invitation = service.invite(['127.0.0.1'], undefined, 300, 60)
    Date.now = () => start + 1000
    const paired = service.pair(invitation.invitationToken, 'minute')
    expect(paired.expiresAt).toBe(start + 61000)
    expect(service.authenticate(paired.credential)).toBe(paired.bindingId)
    Date.now = () => paired.expiresAt!
    expect(service.authenticate(paired.credential)).toBeUndefined()
    expect(service.state().bindings).toContainEqual(expect.objectContaining({ id: paired.bindingId, expiresAt: paired.expiresAt }))
    const month = service.pair(service.invite(['127.0.0.1'], undefined, 300, 2592000).invitationToken, 'month')
    expect(month.expiresAt).toBe(Date.now() + 2592000000)
    service.close()
    service = await CoreConnectionService.open(dir, 'binding-core')
    expect(service.authenticate(paired.credential)).toBeUndefined()
    expect(service.authenticate(month.credential)).toBe(month.bindingId)
    const file = join(dir, 'core-connection.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    delete data.bindings.find((binding: { id: string }) => binding.id === paired.bindingId).expiresAt
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
    service.close()
    service = await CoreConnectionService.open(dir, 'binding-core')
    expect(service.authenticate(paired.credential)).toBe(paired.bindingId)
  } finally { service?.close(); Date.now = now; rmSync(dir, { recursive: true, force: true }) }
})

test('30天计时切片，重启重排计时，close清理；旧邀请可解析', async () => {
  const { parseCoreConnectionInvitation, isCoreConnectionTtl } = await import('@profer/shared')
  const dir = mkdtempSync(join(tmpdir(), 'core-month-timer-'))
  const originalTimeout = globalThis.setTimeout
  const now = Date.now
  let service: CoreConnectionService | undefined
  const scheduled: Array<{ delay: number; tick: () => void; timer: ReturnType<typeof setTimeout> }> = []
  try {
    service = await CoreConnectionService.open(dir, 'month-core')
    const start = now()
    Date.now = () => start
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      const timer = originalTimeout(() => {}, 2 ** 31 - 1)
      scheduled.push({ delay: delay!, tick: callback, timer })
      return timer
    }) as typeof setTimeout
    const invitation = service.invite(['127.0.0.1'], undefined, 2592000, 2592000)
    const legacy = { ...invitation }; delete legacy.bindingTtlSeconds
    expect(parseCoreConnectionInvitation(JSON.stringify(legacy)).bindingTtlSeconds).toBeUndefined()
    expect(() => parseCoreConnectionInvitation(JSON.stringify({ ...legacy, bindingTtlSeconds: 0 }))).toThrow()
    const result = service.pair(invitation.invitationToken, 'month')
    expect(scheduled.at(-1)?.delay).toBe(2 ** 31 - 1)
    Date.now = () => start + 2 ** 31 - 1
    scheduled.at(-1)!.tick()
    expect(scheduled.at(-1)?.delay).toBe(2592000000 - (2 ** 31 - 1))
    service.close()
    service = await CoreConnectionService.open(dir, 'month-core')
    expect(scheduled.at(-1)?.delay).toBe(result.expiresAt! - Date.now())
    let expired: string | undefined
    service.onRevoke(id => { expired = id })
    Date.now = () => result.expiresAt!
    scheduled.at(-1)!.tick()
    expect(expired).toBe(result.bindingId)
    expect(service.authenticate(result.credential)).toBeUndefined()
    for (const value of [60, 900, 2592000]) expect(isCoreConnectionTtl(value)).toBe(true)
    for (const value of [0, -1, NaN, '60', 60.5, 2592001]) expect(isCoreConnectionTtl(value)).toBe(false)
  } finally {
    service?.close(); for (const item of scheduled) clearTimeout(item.timer)
    globalThis.setTimeout = originalTimeout; Date.now = now; rmSync(dir, { recursive: true, force: true })
  }
})
