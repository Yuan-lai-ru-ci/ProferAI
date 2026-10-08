import { afterEach, expect, mock, test } from 'bun:test'
import { createLoadedHost, nodeText } from '../../../../scripts/settings-loaded-visual-host'
import type { RechargeConfig } from '../../domains/credits/credits-types'

// 真组件、内存订单和假支付页；不触发真实支付或网络。
const config: RechargeConfig = { enabled: true, manualFallback: true, rate: 100, presetsRmb: [10, 50], customMinRmb: 1, customMaxRmb: 500, currency: 'rmb', adminWechat: 'fixture' }
let readConfig: () => Promise<RechargeConfig | null> = async () => config
let createOrder: () => Promise<unknown> = async () => ({ kind: 'failed', message: 'fixture' })
let readStatus: () => Promise<{ status: string; amountRmb?: number }> = async () => ({ status: 'paid', amountRmb: 1000 })
let orders = 0
let reloads = 0
mock.module('sonner', () => ({ toast: { error() {}, success() {}, info() {} } }))
mock.module('../../hooks/useCreditsLoader', () => ({ useCreditsLoader: () => ({ reload: async () => { reloads++ } }) }))
mock.module('../../domains/credits/credits-api', () => ({
  requestRechargeConfig: () => readConfig(), createRechargeOrder: () => { orders++; return createOrder() },
  createRechargeStatusReader: async () => readStatus, openCreditsPaymentPage: async () => {},
}))
const { RechargeSection } = await import('./RechargeSection')
const hosts: Array<ReturnType<typeof createLoadedHost>> = []
const mount = () => { const host = createLoadedHost(RechargeSection, new Set()); hosts.push(host); return host }
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); orders = 0; reloads = 0 })

test('配置读取失败或空配置不显示默认充值表单，重试成功才允许选择', async () => {
  readConfig = async () => null
  const host = mount(); await host.settle()
  expect(nodeText(host.tree())).toContain('充值配置读取失败')
  expect(host.elements().some((item) => nodeText(item).startsWith('立即充值'))).toBe(false)
  readConfig = async () => config
  await host.click('重试读取充值配置')
  expect(nodeText(host.tree())).toContain('1 元 = 100 积分')
})

test('重复旧闭包提交只创建一单，失败释放同步锁可重试', async () => {
  readConfig = async () => config
  let resolve!: (value: unknown) => void
  createOrder = () => new Promise((yes) => { resolve = yes })
  const host = mount(); await host.settle(); await host.click('¥10')
  const button = host.elements().find((item) => nodeText(item) === '立即充值 ¥10')!
  const submit = button.props.onClick as () => Promise<void>
  const first = submit(); const second = submit()
  expect(orders).toBe(1)
  resolve({ kind: 'failed', message: 'fixture' }); await Promise.all([first, second]); await host.settle()
  createOrder = async () => ({ kind: 'failed', message: 'retry fixture' })
  await host.click('立即充值 ¥10')
  expect(orders).toBe(2)
})

test('在线订单查询失败保留订单不允许重下单，重试付款确认后刷新额度', async () => {
  readConfig = async () => config
  createOrder = async () => ({ kind: 'success', data: { orderId: 'fixture-order', payInfo: { method: 'online', payUrl: '' } } })
  readStatus = async () => { throw new Error('fixture query') }
  const host = mount(); await host.settle(); await host.click('¥10'); await host.click('立即充值 ¥10')
  expect(nodeText(host.tree())).toContain('订单查询失败')
  const button = host.elements().find((item) => nodeText(item) === '立即充值 ¥10')!
  expect(button.props.disabled).toBe(true)
  await (button.props.onClick as () => Promise<void>)()
  expect(orders).toBe(1)
  readStatus = async () => ({ status: 'paid', amountRmb: 1000 })
  await host.click('重试查询订单')
  expect(reloads).toBe(1)
  expect(nodeText(host.tree())).toContain('充值已到账')
})

test('不把非法自定义金额截断后下单；卸载后迟到订单不启动查询', async () => {
  readConfig = async () => config
  let resolve!: (value: unknown) => void
  createOrder = () => new Promise((yes) => { resolve = yes })
  const host = mount(); await host.settle()
  const amount = host.elements().find((item) => item.props.type === 'number')!
  ;(amount.props.onChange as (event: unknown) => void)({ target: { value: '1.5' } }); await host.settle()
  const invalid = host.elements().find((item) => nodeText(item) === '立即充值 ¥1.5')!
  await (invalid.props.onClick as () => Promise<void>)()
  expect(orders).toBe(0)
  await host.click('¥10')
  const submit = host.elements().find((item) => nodeText(item) === '立即充值 ¥10')!.props.onClick as () => Promise<void>
  const pending = submit(); host.dispose()
  resolve({ kind: 'success', data: { orderId: 'fixture-order', payInfo: { method: 'online' } } }); await pending
  expect(reloads).toBe(0)
})
