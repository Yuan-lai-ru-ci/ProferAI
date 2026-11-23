import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RemotePairingSettings, RemotePairingView, pairingSecondsRemaining, revokePairingDevice } from './RemotePairingSettings'
import { PocketModeSettings, PocketServiceSummary, pocketServiceLabel } from './PocketModeSettings'
import type { PocketModeStatus } from '../../../types'

const props = { qr: null, remaining: 0, bindings: null, busy: true, error: '', devicesError: '', onRefresh: () => {}, onRetryDevices: () => {}, onRevoke: () => {} }
const status: PocketModeStatus = { enabled: false, running: false, port: 7788, defaultPort: 7788, localUrl: null, lanUrl: null, token: null, publicEndpoint: null, error: null, notice: null }

describe('移动端连接与配对', () => {
  test('首次渲染是加载态，不错误显示已过期或设备空态', () => {
    const html = renderToStaticMarkup(<RemotePairingSettings refreshKey="lan" large />)
    expect(html).toContain('正在生成配对码')
    expect(html).toContain('正在读取配对设备')
    expect(html).not.toContain('二维码已过期')
    expect(html).not.toContain('还没有配对设备')
    const loading = renderToStaticMarkup(<PocketModeSettings />)
    expect(loading).toContain('正在加载移动模式')
    expect(loading).toContain('本机服务 · Pocket 配对')
    expect(loading).toContain('aria-busy="true"')
  })
  test('有效码、过期、失败均有明确操作，large 保留尺寸兼容', () => {
    const qr = { dataUrl: 'data:image/png;base64,real-api-value', expiresAt: 2000 }
    const ready = renderToStaticMarkup(<RemotePairingView {...props} qr={qr} remaining={2} bindings={[]} busy={false} large />)
    expect(ready).toContain('alt="Pocket 一次性配对二维码"')
    expect(ready).toContain('w-80')
    expect(ready).toContain('aria-label="配对码托盘"')
    expect(ready).not.toContain('aria-label="配对步骤"')
    expect(ready).toContain('bg-white')
    expect(ready).toContain('aspect-square')
    expect(ready).toContain('2 秒后过期')
    expect(ready).toContain('暂无配对设备')
    const expired = renderToStaticMarkup(<RemotePairingView {...props} qr={qr} busy={false} />)
    expect(expired).toContain('二维码已过期')
    expect(expired).not.toContain('<img')
    const failed = renderToStaticMarkup(<RemotePairingView {...props} busy={false} error="网络不可用" devicesError="读取失败" />)
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('重试生成配对码')
    expect(failed).toContain('重新读取设备')
  })
  test('设备行不暗示在线，busy 禁止刷新和撤销', () => {
    const html = renderToStaticMarkup(<RemotePairingView {...props} bindings={[{ id: 'a', name: '我的手机', createdAt: 0 }]} />)
    expect(html).not.toContain('当前在线')
    expect(html).toContain('撤销 我的手机 的配对')
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2)
  })
  test('过期时间向上取秒且不出现负值', () => {
    expect(pairingSecondsRemaining(2001, 1000)).toBe(2)
    expect(pairingSecondsRemaining(1000, 1000)).toBe(0)
    expect(pairingSecondsRemaining(999, 1000)).toBe(0)
  })
  test('撤销先调用真实 API 再刷新列表，失败交给界面恢复', async () => {
    const api = { getRemotePairingQr: mock(async () => ({ dataUrl: '', expiresAt: 0 })), getRemoteBindings: mock(async () => []), revokeRemoteBinding: mock(async (_id: string) => {}) }
    expect(await revokePairingDevice(api, 'a')).toEqual([])
    expect(api.revokeRemoteBinding).toHaveBeenCalledWith('a')
    expect(api.getRemoteBindings).toHaveBeenCalledTimes(1)
    api.revokeRemoteBinding.mockRejectedValueOnce(new Error('无法撤销'))
    await expect(revokePairingDevice(api, 'a')).rejects.toThrow('无法撤销')
    expect(api.getRemoteBindings).toHaveBeenCalledTimes(1)
  })
  test('服务摘要区分关闭、启动、就绪与启动失败', () => {
    expect(pocketServiceLabel(status)).toBe('未开启')
    expect(pocketServiceLabel({ ...status, enabled: true })).toBe('正在启动')
    expect(pocketServiceLabel({ ...status, enabled: true, running: true })).toBe('可供移动端连接')
    expect(pocketServiceLabel({ ...status, enabled: true }, true)).toBe('服务未就绪')
    const html = renderToStaticMarkup(<PocketServiceSummary status={{ ...status, enabled: true, error: '端口冲突' }} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('检查端口或重试启动')
    expect(html).toContain('移动连接服务')
    expect(html).toContain('bg-destructive/10')
    const ready = renderToStaticMarkup(<PocketServiceSummary status={{ ...status, enabled: true, running: true }} />)
    expect(ready).toContain('可供移动端连接')
    expect(ready).toContain('bg-primary/10')
    const off = renderToStaticMarkup(<PocketServiceSummary status={status} />)
    expect(off).toContain('未开启')
    expect(off).not.toContain('bg-primary/10')
  })
})
