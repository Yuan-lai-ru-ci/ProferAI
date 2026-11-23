import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CoreConnectionView, CoreInvitationContent, CoreTunnelInput, copyCoreInvitation, coreInvitationRemaining, authorizationExpiryLabel, performCoreConnectionAction, pollCoreConnectionState, coreConnectionError, coreEndpointLabel, isCoreInvitationExpired } from './CoreConnectionSettings'
import type { CoreConnectionState } from '@/types/core-connection'

const state: CoreConnectionState = { local: { status: 'running' }, sharing: false, endpoints: [], bindings: [] }
function fixture() {
  return {
    getCoreConnectionState: mock(async () => state),
    retryLocalCore: mock(async () => ({ status: 'running' as const })),
    setCoreSharing: mock(async (sharing: boolean) => ({ ...state, sharing })),
    createCoreInvitation: mock(async (_ttl?: number, _bindingTtl?: number) => ({ url: 'profer://invite/secret', expiresAt: 1000 })),
    pairAndSelectCoreInvitation: mock(async (_invitation: string, _tunnelUrl?: string) => ({ currentId: 'local', generation: 0, targets: [] })),
    revokeCoreBinding: mock(async (_id: string) => state),
  }
}
describe('Core 连接设置', () => {
  test('本机只提供故障重试，分享和撤销刷新设备连接状态', async () => {
    const api = fixture()
    expect((await performCoreConnectionAction(api, state, { kind: 'retry' })).state?.local.status).toBe('running')
    expect(api.retryLocalCore).toHaveBeenCalledTimes(1)
    expect((await performCoreConnectionAction(api, state, { kind: 'share', enabled: true })).state?.sharing).toBe(true)
    await performCoreConnectionAction(api, state, { kind: 'revoke', id: 'device-1' })
    expect(api.revokeCoreBinding).toHaveBeenCalledWith('device-1')
  })
  test('生成邀请传递时长，导入邀请直接配对并选择对应目标', async () => {
    const api = fixture()
    expect((await performCoreConnectionAction(api, state, { kind: 'invite', bindingTtlSeconds: 1800 })).invitation?.url).toBe('profer://invite/secret')
    expect((await performCoreConnectionAction(api, state, { kind: 'pair', invitation: '  invitation  ' })).message).toContain('已连接并使用')
    expect(api.pairAndSelectCoreInvitation).toHaveBeenCalledWith('invitation')
    expect(api.createCoreInvitation).toHaveBeenCalledWith(1800, 1800)
    await performCoreConnectionAction(api, state, { kind: 'pair', invitation: ' token ', tunnelUrl: ' https://127.0.0.1:17788 ' })
    expect(api.pairAndSelectCoreInvitation).toHaveBeenCalledWith('token', 'https://127.0.0.1:17788')
  })
  test('错误抛给界面，失败后可重试且不丢失导入文本', async () => {
    const api = fixture()
    api.pairAndSelectCoreInvitation.mockRejectedValueOnce(new Error('邀请已过期'))
    await expect(performCoreConnectionAction(api, state, { kind: 'pair', invitation: 'original' })).rejects.toThrow('邀请已过期')
    await performCoreConnectionAction(api, state, { kind: 'pair', invitation: 'original' })
    expect(api.pairAndSelectCoreInvitation).toHaveBeenCalledTimes(2)
  })
  test('紧凑本机与Token入口，反馈仅驻留所属区域', () => {
    const props = { state: { ...state, sharing: true }, busy: false, invitationText: 'draft', onInvitationTextChange: () => {}, onAction: () => {}, onRetry: () => {} }
    const html = renderToStaticMarkup(<CoreConnectionView {...props} error="邀请错误" feedbackScope="pair" />)
    expect(html).toContain('允许连接')
    expect(html).toContain('生成邀请')
    expect(html).toContain('输入邀请 Token')
    expect(html).toContain('Token 不提供公网中继')
    expect(html).toContain('通过隧道连接')
    expect(html.match(/邀请错误/g)).toHaveLength(1)
    expect(html).not.toContain('<textarea')
  })
})

test('隧道输入默认收起，展开显示保留TLS的HTTPS地址', () => {
  const props = { id: 'tunnel', enabled: false, value: 'https://127.0.0.1:17788', busy: false, onEnabledChange: () => {}, onChange: () => {} }
  expect(renderToStaticMarkup(<CoreTunnelInput {...props} />)).not.toContain('type="url"')
  const expanded = renderToStaticMarkup(<CoreTunnelInput {...props} enabled />)
  expect(expanded).toContain('https://127.0.0.1:17788')
  expect(expanded).toContain('保留 Core 原始 TLS 证书')
})

test('启动轮询到终态停止，达到上限报错，卸载后不再更新', async () => {
  const starting: CoreConnectionState = { ...state, local: { ...state.local, status: 'starting' } }
  const running: CoreConnectionState = { ...state, local: { ...state.local, status: 'running' } }
  const read = mock(async () => running)
  const update = mock(() => {})
  const fail = mock(() => {})
  const stop = pollCoreConnectionState(read, update, fail, 1, 2)
  await Bun.sleep(15)
  expect(read).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith(running)
  stop()
  const pending = mock(async () => starting)
  const cancel = pollCoreConnectionState(pending, update, fail, 1, 2)
  await Bun.sleep(15)
  expect(pending).toHaveBeenCalledTimes(2)
  expect(fail).toHaveBeenCalledTimes(1)
  cancel()
  const cancelledRead = mock(async () => running)
  pollCoreConnectionState(cancelledRead, update, fail, 1, 2)()
  await Bun.sleep(10)
  expect(cancelledRead).not.toHaveBeenCalled()
})
test('安全的 API 短原因原样展示', () => {
  for (const message of ['邀请已过期', 'Core 身份不匹配', '安全存储不可用']) {
    expect(coreConnectionError(new Error(message))).toBe(message)
  }
})


test('连接地址只展示 origin，隐藏认证、路径和查询凭据', () => {
  expect(coreEndpointLabel('https://user:password@192.168.1.2:443/path?token=secret#secret')).toBe('https://192.168.1.2')
  expect(coreEndpointLabel('profer://secret')).toBeUndefined()
  expect(coreEndpointLabel('invalid')).toBeUndefined()
})

test('邀请过期和授权截止保留权威含义', () => {
  expect(isCoreInvitationExpired({ url: 'secret', expiresAt: 100 }, 100)).toBe(true)
  expect(authorizationExpiryLabel(undefined)).toBe('无期限')
  expect(authorizationExpiryLabel(100, 100)).toContain('已到期')
  expect(authorizationExpiryLabel(100, 99)).toContain('截止')
})
test('较长邀请用天或小时展示，不堆积分钟数', () => {
  expect(coreInvitationRemaining(86400000, 0)).toBe('1 天')
  expect(coreInvitationRemaining(3600000, 0)).toBe('1 小时')
  expect(coreInvitationRemaining(60000, 0)).toBe('1 分钟')
})

test('Token复制原值，拒绝过期且失败不回显凭据', async () => {
  const invitation = { url: 'profer://core-pair#synthetic-invitation', expiresAt: 1000 }
  const writeText = mock(async (_text: string) => {})
  await copyCoreInvitation(invitation, { writeText }, 999)
  expect(writeText).toHaveBeenCalledWith(invitation.url)
  await expect(copyCoreInvitation(invitation, { writeText }, 1000)).rejects.toThrow('已过期')
  expect(writeText).toHaveBeenCalledTimes(1)
  const rejected = mock(async (_text: string) => { throw new Error('synthetic denied') })
  await expect(copyCoreInvitation(invitation, { writeText: rejected }, 999)).rejects.toThrow('synthetic denied')
})

test('授权时长范围、快捷值与单行只读Token', () => {
  const props = { invitationId: 'invite', ttlSeconds: 86400, setTtlSeconds: () => {}, busy: false, canShare: true, sharing: true, onAction: () => {}, now: 1000, expired: false, invitation: { url: 'test-token', expiresAt: 61000 } }
  const html = renderToStaticMarkup(<CoreInvitationContent {...props} />)
  for (const text of ['局域网直连', '跨网络需先通过 VPN 或隧道互通', '1小时', '1天', '7天', 'readonly=""', '邀请剩余 1 分钟', '重新生成', '复制邀请 Token', '>复制</button>']) expect(html).toContain(text)
  expect(html).not.toContain('手动复制')
  expect(html).not.toContain('<textarea')
  for (const ttlSeconds of [59, 2592001, 60.5, NaN]) expect(renderToStaticMarkup(<CoreInvitationContent {...props} ttlSeconds={ttlSeconds} />)).toContain('请输入1分钟至30天')
  for (const ttlSeconds of [60, 900, 2592000]) expect(renderToStaticMarkup(<CoreInvitationContent {...props} ttlSeconds={ttlSeconds} />)).not.toContain('请输入1分钟至30天')
  const expired = renderToStaticMarkup(<CoreInvitationContent {...props} expired />)
  expect(expired).toContain('邀请已过期')
  expect(expired).not.toContain('test-token')
  expect(expired).not.toContain('复制邀请 Token')
  expect(renderToStaticMarkup(<CoreInvitationContent {...props} sharing={false} />)).not.toContain('复制邀请 Token')
  expect(renderToStaticMarkup(<CoreInvitationContent {...props} canShare={false} />)).not.toContain('复制邀请 Token')
})
