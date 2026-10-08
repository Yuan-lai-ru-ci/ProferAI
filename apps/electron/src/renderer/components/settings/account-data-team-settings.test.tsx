import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { PricingData } from '../../domains/credits/credits-types'

// 隔离 hook 宿主执行真实页面事件；全部 API 为内存 fixture，不读用户配置、不联网。
const store = createStore()
type AtomTarget = Parameters<typeof store.get>[0]
type WritableTarget = Parameters<typeof store.set>[0]
const setters = new Map<WritableTarget, (value: unknown) => void>()
const setterFor = (target: WritableTarget) => {
  let setter = setters.get(target)
  if (!setter) { setter = (value) => store.set(target, value); setters.set(target, setter) }
  return setter
}
mock.module('jotai', () => ({
  atom, useAtom: (target: WritableTarget) => [store.get(target), setterFor(target)],
  useAtomValue: (target: AtomTarget) => store.get(target), useSetAtom: setterFor, useStore: () => store,
}))
const errors: string[] = []
mock.module('sonner', () => ({ toast: { error: (message: string) => errors.push(message), success() {}, info() {} } }))
let reloads = 0
mock.module('../../hooks/useCreditsLoader', () => ({ useCreditsLoader: () => ({ reload: async () => { reloads += 1 } }) }))
mock.module('./RechargeSection', () => ({ RechargeSection: () => <section>Fixture recharge</section> }))
const pricingFixture: PricingData = {
  plans: {
    standard: { id: 'standard', name: 'Standard', monthlyRmb: 2915, yearlyRmb: 30100, welcomeBonus: 73, dailyDrip: 9 },
    plus: { id: 'plus', name: 'Plus', monthlyRmb: 4915, yearlyRmb: 50100, welcomeBonus: 203, dailyDrip: 21 },
    pro: { id: 'pro', name: 'Pro', monthlyRmb: 9915, yearlyRmb: 100100, welcomeBonus: 451, dailyDrip: 41 },
  }, vip: { price: 70015, discount: 0.85, extraDrip: 23 }, adminWechat: 'fixture-contact',
}
let pricingReader: () => Promise<PricingData | null> = async () => pricingFixture
let usageReader: () => Promise<{ logs?: []; modelUsage?: [] }> = async () => ({ logs: [], modelUsage: [] })
let purchases = 0
let purchaseReader: () => Promise<unknown> = async () => ({ kind: 'failed', message: 'fixture purchase failure' })
let statusReader: () => Promise<{ status?: string } | null> = async () => ({ status: 'paid' })
let paymentPages = 0
let claims = 0
let claimReader: () => Promise<unknown> = async () => ({ claimed: true, message: 'fixture claim' })
let redeems = 0
mock.module('../../domains/credits/credits-api', () => ({
  requestSubscriptionPricing: () => pricingReader(), requestCreditsUsage: () => usageReader(),
  requestCredits: async () => ({ kind: 'disabled' }),
  createSubscriptionPurchase: async () => { purchases += 1; return purchaseReader() },
  createSubscriptionStatusReader: async () => statusReader,
  openCreditsPaymentPage: async () => { paymentPages += 1 }, redeemCredits: async () => { redeems += 1; return { kind: 'failed' } },
  claimCreditsDrip: async () => { claims += 1; return claimReader() },
}))
const { CreditsSettings } = await import('./CreditsSettings')
const { SubscriptionSettings } = await import('./SubscriptionSettings')
const { DataManagementSettings } = await import('./DataManagementSettings')
const { TeamWorkspaceSettings } = await import('./TeamWorkspaceSettings')
const { creditsBalanceAtom, creditsLoadingAtom, subscriptionAtom } = await import('../../domains/credits/credits-state')
const { teamWorkspacesAtom } = await import('../../atoms/team-atoms')
const { agentWorkspacesAtom, agentSDKMessagesCacheAtom, resolvedBlobMessagesAtom, currentAgentSessionIdAtom, agentMessageRefreshAtom } = await import('../../atoms/agent-atoms')

type Props = Record<string, unknown>
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
function elements(tree: unknown): React.ReactElement<Props>[] {
  const result: React.ReactElement<Props>[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!React.isValidElement<Props>(node)) return
    result.push(node); visit(node.props.children); visit(node.props.action)
  }
  visit(tree); return result
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return React.isValidElement<Props>(node) ? text(node.props.children) : ''
}
const hosts: Array<{ dispose: () => void }> = []
function mount(component: () => React.ReactElement | null) {
  const slots: Slot[] = []
  let index = 0, changed = false
  let effects: Array<() => void> = []
  let tree: React.ReactElement | null = null
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const useMemo = <T,>(factory: () => T, deps: readonly unknown[]): T => {
    const slot = slots[index++] ?? (slots[index - 1] = {})
    if (!same(slot.deps, deps)) { slot.value = factory(); slot.deps = deps }
    return slot.value as T
  }
  const useEffect = (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const slot = slots[index++] ?? (slots[index - 1] = {})
    if (!same(slot.deps, deps)) { slot.deps = deps; effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined }) }
  }
  const dispatcher = {
    useState<T>(initial: T | (() => T)) {
      const current = index++
      const slot = slots[current] ?? (slots[current] = { value: typeof initial === 'function' ? (initial as () => T)() : initial })
      return [slot.value, (next: T | ((previous: T) => T)) => {
        const value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next
        if (!Object.is(value, slot.value)) { slot.value = value; changed = true }
      }]
    },
    useRef<T>(value: T) { return useMemo(() => ({ current: value }), []) },
    useMemo, useCallback<T>(callback: T, deps: readonly unknown[]) { return useMemo(() => callback, deps) },
    useEffect, useLayoutEffect: useEffect,
  }
  const render = () => {
    let rounds = 0
    do {
      if (++rounds > 30) throw new Error('fixture render loop')
      changed = false; index = 0
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { tree = component() } finally { internals.ReactCurrentDispatcher.current = previous }
      const pending = effects; effects = []; pending.forEach((effect) => effect())
    } while (changed)
  }
  render()
  const host = {
    render, text: () => text(tree), elements: () => elements(tree),
    field: (label: string) => elements(tree).find((item) => item.props.label === label || item.props['aria-label'] === label)!.props,
    button: (label: string) => elements(tree).find((item) => item.props.onClick && (text(item) === label || item.props['aria-label'] === label))!.props,
    dispose: () => slots.forEach((slot) => slot.cleanup?.()),
  }
  hosts.push(host); return host
}
const tick = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve() }
const click = (props: Props) => (props.onClick as (event: { preventDefault: () => void; stopPropagation: () => void }) => unknown)({ preventDefault() {}, stopPropagation() {} })
const change = (props: Props, value: string) => (props.onChange as (event: unknown) => void)({ target: { value } })
const fail = async () => { throw new Error('fixture failure') }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve: (value: T) => resolve(value), reject: (reason: Error) => reject(reason) }
}
const workspace = (id: string, role: 'owner' | 'member' = 'owner') => ({ id, name: id, slug: id, type: 'team' as const, role, createdAt: 1, updatedAt: 1 })
const compactFixture = { scannedFiles: 1, rewrittenFiles: 1, rewrittenLines: 2, skippedFiles: 0, failedFiles: 0, charsBefore: 1000, charsAfter: 100, blobRefs: 1, blobCount: 1, blobBytes: 900, errors: [], backupDir: '/fixture/backup' }
function api(overrides: Props = {}, team: Props = {}) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    getSettings: async () => ({}), updateSettings: async () => {},
    getStorageStats: async () => ({ totalBytes: 1024, calculatedAt: 1, categories: [{ key: 'temp-files', label: '临时文件', bytes: 1024, count: 1, orphanBytes: 0, orphanCount: 0, hasOrphans: false }] }),
    cleanupTempStorage: async () => ({ freedBytes: 1024, deletedCount: 1, errors: [] }),
    cleanupStorage: async () => ({ freedBytes: 100, deletedCount: 1, errors: [] }),
    previewSessionCompaction: async () => compactFixture, applySessionCompaction: async () => compactFixture,
    listAgentWorkspaces: async () => [], migrationSaveFileDialog: async () => '/fixture/export.profer-share', migrationExportV2: async () => ({ success: true, filePath: '/fixture/export.profer-share' }),
    auth: { getServerInfo: async () => [] },
    team: { listWorkspaces: async () => [workspace('A'), workspace('B')], getMembers: async () => [], listInvitations: async () => [], getStats: async () => ({ totalSize: 0, fileCount: 0, dirCount: 0, memberCount: 0, onlineCount: 0, pendingInvites: 0 }), removeMember: async () => {}, transferOwnership: async () => {}, deleteWorkspace: async () => {}, leaveWorkspace: async () => {}, createInvitation: async () => ({ token: 'fixture-token' }), ...team },
    ...overrides,
  } } })
}
function childComponent(parent: () => React.ReactElement, name: string) {
  return elements(parent()).find((item) => typeof item.type === 'function' && item.type.name === name)!.type as () => React.ReactElement
}
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); errors.length = 0; reloads = 0; purchases = 0; claims = 0; redeems = 0 })

describe('CreditsSettings 余额与用量互不冒充', () => {
  test('SSR 未加载不展示 0 余额或分桶，不错误断言免费账户', () => {
    store.set(creditsBalanceAtom, null); store.set(creditsLoadingAtom, false); store.set(subscriptionAtom, null)
    const html = renderToStaticMarkup(<CreditsSettings />)
    expect(html).toContain('暂不可用')
    expect(html).toContain('账户状态待同步')
    expect(html).not.toContain('套餐积分')
    expect(html).not.toContain('免费版')
    expect(html).toContain('重试余额')
  })
  test('部分用量失败显示错误且可重试；不覆盖余额的全局 loading', async () => {
    store.set(creditsBalanceAtom, 12); store.set(creditsLoadingAtom, true)
    usageReader = async () => ({ logs: [] })
    const host = mount(CreditsSettings); await tick(); host.render()
    expect(host.text()).toContain('部分用量明细无法获取')
    expect(store.get(creditsLoadingAtom)).toBe(true)
    usageReader = async () => ({ logs: [], modelUsage: [] })
    click(host.button('重试用量')); await tick(); host.render()
    expect(host.text()).toContain('近 30 天暂无用量记录')
    expect(host.text()).not.toContain('部分用量明细无法获取')
  })
  test('领取按钮在途保护，同一事件多次触发仅执行一次', async () => {
    store.set(creditsBalanceAtom, 12); store.set(creditsLoadingAtom, false)
    store.set(subscriptionAtom, { hasSubscription: true, status: 'active', plan: 'plus', dailyDripRate: 20, dripAvailableThisWeek: 50000 })
    const pending = deferred<{ claimed: boolean; message: string }>()
    claimReader = () => pending.promise
    const host = mount(CreditsSettings)
    const button = host.button('领取本周 1 积分')
    click(button); click(button)
    expect(claims).toBe(1)
    pending.resolve({ claimed: true, message: 'fixture' }); await tick(); host.render()
    expect(reloads).toBe(1)
    store.set(subscriptionAtom, null)
  })
})

describe('SubscriptionSettings 只用真实报价', () => {
  test('初始 SSR 不展示硬编码价格；价格失败禁用 VIP 且重试成功使用服务端分值', async () => {
    api(); pricingReader = async () => null
    const html = renderToStaticMarkup(<SubscriptionSettings />)
    expect(html).not.toContain('¥29')
    expect(html).not.toContain('¥698')
    expect(html).toContain('价格暂不可用')
    const host = mount(SubscriptionSettings); await tick(); host.render()
    expect(host.button('购买 VIP').disabled).toBe(true)
    await click(host.button('购买 VIP'))
    expect(purchases).toBe(0)
    expect(host.text()).toContain('价格加载失败')
    pricingReader = async () => pricingFixture
    click(host.button('重试价格')); await tick(); host.render()
    expect(host.text()).toContain('¥29.15')
    expect(host.text()).toContain('首购红包 73 积分')
    expect(host.text()).toContain('8.5 折')
    expect(host.text()).not.toContain('85折')
    expect(host.button('购买 VIP').disabled).toBe(false)
  })
  test('损坏/非有限报价阻断；购买重复事件只创建一单，失败后可重试', async () => {
    api(); pricingReader = async () => ({ ...pricingFixture, vip: { ...pricingFixture.vip, price: Number.NaN } })
    const bad = mount(SubscriptionSettings); await tick(); bad.render()
    expect(bad.button('购买 VIP').disabled).toBe(true)
    pricingReader = async () => pricingFixture
    const pending = deferred<unknown>()
    purchaseReader = () => pending.promise
    const host = mount(SubscriptionSettings); await tick(); host.render()
    const button = host.button('月付 · ¥29.15')
    click(button); click(button); expect(purchases).toBe(1)
    pending.resolve({ kind: 'failed', message: 'fixture failure' }); await tick(); host.render()
    expect(host.button('月付 · ¥29.15').disabled).toBe(false)
    expect(errors).toContain('fixture failure')
  })
  test('兑换失败保留输入，未显示伪成功，真实充值组件入口保持', async () => {
    api()
    const parent = mount(SubscriptionSettings)
    const redeem = parent.elements().find((item) => typeof item.type === 'function' && item.type.name === 'RedeemInput')!
    const component = redeem.type as (props: { onRedeemed: () => Promise<void> }) => React.ReactElement
    const host = mount(() => component({ onRedeemed: async () => { reloads += 1 } }))
    change(host.field('兑换码'), 'fixture-code'); host.render()
    await click(host.button('兑换')); await tick(); host.render()
    expect(redeems).toBe(1)
    expect(host.field('兑换码').value).toBe('fixture-code')
    expect(reloads).toBe(0)
    expect(renderToStaticMarkup(<SubscriptionSettings />)).toContain('Fixture recharge')
  })
  test('在线订单 mock 轮询确认付费才刷新；超时保留订单并可手动重试查询', async () => {
    api(); pricingReader = async () => pricingFixture
    purchaseReader = async () => ({ kind: 'success', data: { orderId: 'fixture-order', payInfo: { method: 'online', payUrl: 'https://fixture.invalid/pay', qrcode: 'data:image/png;base64,fixture' } } })
    statusReader = async () => ({ status: 'paid' }); paymentPages = 0
    const originalTimer = globalThis.setTimeout
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void) => { queueMicrotask(callback); return 1 } })
    try {
      const paid = mount(SubscriptionSettings); await tick(); paid.render()
      const done = click(paid.button('月付 · ¥29.15'))
      await done; paid.render()
      expect(purchases).toBe(1); expect(paymentPages).toBe(1); expect(reloads).toBe(1)
      expect(paid.text()).not.toContain('等待支付：')

      statusReader = async () => null
      const waiting = mount(SubscriptionSettings); await tick(); waiting.render()
      await click(waiting.button('年付 · ¥301')); waiting.render()
      expect(waiting.text()).toContain('等待支付：')
      expect(waiting.button('月付 · ¥29.15').disabled).toBe(true)
      expect(waiting.button('检查支付结果').disabled).toBe(false)
      statusReader = async () => ({ status: 'paid' })
      click(waiting.button('检查支付结果')); await tick(); waiting.render()
      expect(reloads).toBe(2)
      expect(waiting.button('月付 · ¥29.15').disabled).toBe(false)
    } finally { Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: originalTimer }) }
  })
  test('手动订单与取消订单保留既有分支，不伪称开通', async () => {
    api(); pricingReader = async () => pricingFixture
    purchaseReader = async () => ({ kind: 'success', data: { orderId: 'fixture-manual', payInfo: { method: 'manual' } } })
    const manual = mount(SubscriptionSettings); await tick(); manual.render()
    await click(manual.button('购买 VIP')); manual.render()
    expect(reloads).toBe(0)
    expect(manual.button('购买 VIP').disabled).toBe(false)
    purchaseReader = async () => ({ kind: 'success', data: { orderId: 'fixture-cancelled', payInfo: { method: 'online' } } })
    statusReader = async () => ({ status: 'cancelled' })
    const originalTimer = globalThis.setTimeout
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void) => { queueMicrotask(callback); return 1 } })
    try {
      await click(manual.button('购买 VIP')); manual.render()
      expect(reloads).toBe(0)
      expect(manual.text()).not.toContain('等待支付：')
      expect(errors.at(-1)).toBe('订单未完成支付')
    } finally { Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: originalTimer }) }
  })
})

describe('DataManagementSettings 迁移与清理安全', () => {
  test('统计/配置失败可重试，加载失败不写入自动清理默认值；失败保存保留原值', async () => {
    let reads = 0, writes = 0
    api({ getSettings: async () => { if (++reads === 1) throw new Error('fixture failure'); return { autoCleanupTempOnStart: false } }, getStorageStats: fail, updateSettings: async () => { writes += 1; throw new Error('fixture failure') } })
    const host = mount(childComponent(DataManagementSettings, 'StorageSection')); await tick(); host.render()
    expect(host.field('启动时清理临时文件').disabled).toBe(true)
    await (host.field('启动时清理临时文件').onCheckedChange as (value: boolean) => Promise<void>)(false)
    expect(writes).toBe(0)
    expect(host.text()).toContain('存储统计加载失败')
    click(host.button('重试清理配置')); await tick(); host.render()
    expect(host.field('启动时清理临时文件').checked).toBe(false)
    await (host.field('启动时清理临时文件').onCheckedChange as (value: boolean) => Promise<void>)(true); host.render()
    expect(host.field('启动时清理临时文件').checked).toBe(false)
    expect(errors.at(-1)).toContain('保留原设置')
  })
  test('临时文件清理确认前不执行，失败保留确认并可重试成功', async () => {
    let cleanups = 0
    api({ cleanupTempStorage: async () => { if (++cleanups === 1) throw new Error('fixture failure'); return { freedBytes: 1024, deletedCount: 1, errors: [] } } })
    const host = mount(childComponent(DataManagementSettings, 'StorageSection')); await tick(); host.render()
    click(host.button('清理')); host.render(); expect(cleanups).toBe(0)
    click(host.button('确认执行')); await tick(); host.render()
    expect(cleanups).toBe(1)
    expect(host.elements().find((item) => item.props.onOpenChange && item.props.open !== undefined)!.props.open).toBe(true)
    click(host.button('确认执行')); await tick(); host.render()
    expect(cleanups).toBe(2)
    expect(host.text()).toContain('已释放 1.0 KB')
  })
  test('归档清理需确认；检测后整理需二次确认，成功刷新会话缓存', async () => {
    let applies = 0
    const patches: unknown[] = []
    api({ updateSettings: async (patch: unknown) => { patches.push(patch) }, applySessionCompaction: async () => { applies += 1; return compactFixture } })
    store.set(currentAgentSessionIdAtom, 'fixture-session')
    const host = mount(childComponent(DataManagementSettings, 'StorageSection')); await tick(); host.render()
    const select = host.elements().find((item) => item.props.onValueChange)!.props
    ;(select.onValueChange as (value: string) => void)('30'); host.render(); expect(patches).toHaveLength(0)
    click(host.button('确认执行')); await tick(); host.render()
    expect(patches).toEqual([{ autoCleanupArchivedDays: 30 }])
    expect(host.button('立即整理').disabled).toBe(true)
    await click(host.button('检测')); await tick(); host.render()
    click(host.button('立即整理')); host.render(); expect(applies).toBe(0)
    click(host.button('确认执行')); await tick(); host.render()
    expect(applies).toBe(1)
    expect(store.get(agentSDKMessagesCacheAtom).size).toBe(0)
    expect(store.get(resolvedBlobMessagesAtom).size).toBe(0)
    expect(store.get(agentMessageRefreshAtom).get('fixture-session')).toBeGreaterThan(0)
  })
  test('自定义预览失败阻止导出；全取消阻止扩大为全部；export success:false 不报成功', async () => {
    store.set(agentWorkspacesAtom, [workspace('fixture')])
    let reads = 0, dialogs = 0
    api({ migrationGetShareExportPreview: async () => { if (++reads === 1) throw new Error('fixture failure'); return { workspaces: [{ workspace: workspace('fixture'), skills: [{ slug: 'fixture', name: 'Fixture', enabled: true }], mcpServers: [] }], agentSessionCount: 0, chatConversationCount: 0 } }, migrationSaveFileDialog: async () => { dialogs += 1; return '/fixture/backup' }, migrationExportV2: async () => ({ success: false, error: 'fixture export rejection' }) })
    const host = mount(childComponent(DataManagementSettings, 'MigrationSection'))
    click(host.elements().find((item) => item.props.title === '团队分发')!.props); host.render()
    click(host.button('自定义选择手动挑选要导出的项目')); host.render(); await tick(); host.render()
    expect(host.button('自定义选择手动挑选要导出的项目')['aria-pressed']).toBe(true)
    expect(host.button('所有工作区导出全部工作区的 Skills 和 MCP')['aria-pressed']).toBe(false)
    expect(host.button('选择保存位置并导出').disabled).toBe(true)
    click(host.button('重试预览')); await tick(); host.render()
    click(host.button('取消全选')); host.render()
    await click(host.button('选择保存位置并导出')); host.render()
    expect(dialogs).toBe(0)
    expect(host.text()).toContain('空选择不会导出全部工作区')
    click(host.button('全选')); host.render()
    await click(host.button('选择保存位置并导出')); await tick(); host.render()
    expect(host.text()).toContain('fixture export rejection')
    expect(host.text()).not.toContain('已导出至')
  })
  test('分类孤儿与全部孤儿均确认后调用，保留真实清理类别与 orphansOnly 契约', async () => {
    const patches: unknown[] = []
    api({ getStorageStats: async () => ({ totalBytes: 2048, calculatedAt: 1, categories: [{ key: 'agent-sessions', label: '会话', bytes: 2048, count: 2, orphanBytes: 1024, orphanCount: 1, hasOrphans: true }] }), cleanupStorage: async (options: unknown) => { patches.push(options); return { freedBytes: 1024, deletedCount: 1, errors: [] } } })
    const host = mount(childComponent(DataManagementSettings, 'StorageSection')); await tick(); host.render()
    click(host.button('清理孤儿')); host.render(); expect(patches).toHaveLength(0)
    click(host.button('确认执行')); await tick(); host.render()
    expect(patches[0]).toEqual({ categories: ['agent-sessions'], orphansOnly: true, archivedBeforeDays: 0 })
    click(host.button('一键清理')); host.render(); expect(patches).toHaveLength(1)
    click(host.button('确认执行')); await tick(); host.render()
    expect(patches[1]).toEqual({ categories: ['agent-sessions', 'sdk-config', 'workspaces', 'session-blobs'], orphansOnly: true, archivedBeforeDays: 0 })
  })
  test('归档自动清理写失败保留原值与确认，用户可在同一确认重试', async () => {
    let writes = 0
    api({ getSettings: async () => ({ autoCleanupArchivedDays: 0 }), updateSettings: async () => { if (++writes === 1) throw new Error('fixture settings failure') } })
    const host = mount(childComponent(DataManagementSettings, 'StorageSection')); await tick(); host.render()
    const select = () => host.elements().find((item) => item.props.onValueChange)!.props
    ;(select().onValueChange as (value: string) => void)('7'); host.render()
    click(host.button('确认执行')); await tick(); host.render()
    expect(select().value).toBe('0')
    expect(host.elements().find((item) => item.props.onOpenChange && item.props.open !== undefined)!.props.open).toBe(true)
    click(host.button('确认执行')); await tick(); host.render()
    expect(select().value).toBe('7')
  })
})

describe('TeamWorkspaceSettings 工作区隔离', () => {
  test('A/B/A 交错加载丢弃旧成员、邀请、统计，错误可重试；选择清空确认名称', async () => {
    const firstA = deferred<unknown[]>()
    const firstStats = deferred<{ totalSize: number; fileCount: number; dirCount: number; memberCount: number; onlineCount: number; pendingInvites: number } | null>()
    let aReads = 0
    api({}, { getMembers: (id: string) => id === 'A' && ++aReads === 1 ? firstA.promise : Promise.resolve([{ userId: 'new', displayName: 'New member', role: 'member' }]), getStats: (id: string) => id === 'A' && aReads === 1 ? firstStats.promise : Promise.resolve(null), listInvitations: fail })
    const host = mount(TeamWorkspaceSettings); await tick(); host.render()
    change(host.field('选择团队工作区'), 'A'); host.render()
    change(host.field('删除工作区名称确认'), 'A'); host.render()
    change(host.field('选择团队工作区'), 'B'); host.render()
    change(host.field('选择团队工作区'), 'A'); host.render()
    await tick(); host.render()
    firstA.resolve([{ userId: 'old', displayName: 'Old member', role: 'owner' }]); firstStats.resolve({ totalSize: 9999, fileCount: 9999, dirCount: 0, memberCount: 0, onlineCount: 0, pendingInvites: 0 }); await tick(); host.render()
    expect(host.text()).toContain('New member')
    expect(host.text()).not.toContain('Old member')
    expect(host.text()).not.toContain('9999')
    expect(host.field('删除工作区名称确认').value).toBe('')
    expect(host.text()).toContain('加载失败，未将失败当作空数据')
    expect(host.text()).toContain('邀请记录暂不可用')
    click(host.button('重试工作区数据')); await tick(); host.render()
    expect(aReads).toBe(3)
  })
  test('移除、转让、删除明确确认；失败留在确认可重试；转让成功更新角色', async () => {
    let removals = 0, transfers = 0, deletes = 0
    api({}, { getMembers: async () => [{ userId: 'admin', displayName: 'Admin fixture', role: 'admin' }], removeMember: async () => { if (++removals === 1) throw new Error('fixture remove failure') }, transferOwnership: async () => { transfers += 1 }, deleteWorkspace: async () => { deletes += 1 } })
    const host = mount(TeamWorkspaceSettings); await tick(); host.render()
    change(host.field('选择团队工作区'), 'A'); host.render(); await tick(); host.render()
    click(host.button('移除成员Admin fixture')); host.render(); expect(removals).toBe(0)
    click(host.button('确认执行')); await tick(); host.render(); expect(removals).toBe(1)
    click(host.button('确认执行')); await tick(); host.render(); expect(removals).toBe(2)
    change(host.field('选择团队工作区'), 'B'); host.render(); await tick(); host.render()
    change(host.field('删除工作区名称确认'), 'B'); host.render()
    click(host.button('删除')); host.render(); expect(deletes).toBe(0)
    click(host.button('确认执行')); await tick(); host.render(); expect(deletes).toBe(1)
    expect(store.get(teamWorkspacesAtom).some((ws) => ws.id === 'B')).toBe(false)
    change(host.field('选择团队工作区'), 'A'); host.render(); await tick(); host.render()
    click(host.button('转让拥有者给Admin fixture')); host.render(); expect(transfers).toBe(0)
    click(host.button('确认执行')); await tick(); host.render(); expect(transfers).toBe(1)
    expect(store.get(teamWorkspacesAtom).find((ws) => ws.id === 'A')!.role).toBe('admin')
  })
  test('远程空列表不回退为旧团队；列表失败标识本地快照且加入入口仍可用', async () => {
    store.set(teamWorkspacesAtom, [workspace('old')])
    api({}, { listWorkspaces: async () => [] })
    const host = mount(TeamWorkspaceSettings); await tick(); host.render()
    expect(store.get(teamWorkspacesAtom)).toHaveLength(0)
    expect(host.text()).toContain('尚未加入团队工作区')
    expect(host.field('团队工作区邀请码')).toBeDefined()
    api({ listAgentWorkspaces: async () => [workspace('cached')] }, { listWorkspaces: fail })
    click(host.button('刷新工作区')); await tick(); host.render()
    expect(host.text()).toContain('当前显示本地快照')
    expect(host.button('新建').disabled).toBe(true)
  })
  test('生成邀请后的旧刷新响应不能覆盖 A/B/A 返回后的新邀请', async () => {
    const old = deferred<unknown[]>()
    let reads = 0
    api({}, { listInvitations: async (id: string) => {
      reads += 1
      if (reads === 2) return old.promise
      return id === 'A' ? [{ id: 'new', workspaceId: 'A', inviterName: 'New fixture', inviteeEmail: 'new@fixture.invalid', role: 'member', status: 'accepted', token: 'fixture', expiresAt: 1 }] : []
    } })
    const host = mount(TeamWorkspaceSettings); await tick(); host.render()
    change(host.field('选择团队工作区'), 'A'); host.render(); await tick(); host.render()
    click(host.button('生成邀请码')); await tick(); host.render()
    change(host.field('选择团队工作区'), 'B'); host.render()
    change(host.field('选择团队工作区'), 'A'); host.render(); await tick(); host.render()
    old.resolve([{ id: 'old', workspaceId: 'A', inviterName: 'Old fixture', inviteeEmail: 'old@fixture.invalid', role: 'member', status: 'accepted', token: 'old', expiresAt: 1 }]); await tick(); host.render()
    expect(host.text()).toContain('new@fixture.invalid')
    expect(host.text()).not.toContain('old@fixture.invalid')
  })
  test('通知配置加载失败可重试，保存失败保持原值且不写伪默认', async () => {
    let reads = 0, writes = 0
    api({}, { getNotificationSettings: async () => { if (++reads === 1) throw new Error('fixture notification failure'); return { enabled: true, fileUpload: true, fileDelete: true, memberJoin: true, memberLeave: true, invitation: true } }, updateNotificationSettings: async () => { writes += 1; throw new Error('fixture save failure') } })
    const parent = mount(TeamWorkspaceSettings); await tick(); parent.render()
    change(parent.field('选择团队工作区'), 'A'); parent.render(); await tick(); parent.render()
    const node = parent.elements().find((item) => typeof item.type === 'function' && item.type.name === 'NotificationSettingsRow')!
    const host = mount(node.type as () => React.ReactElement); await tick(); host.render()
    expect(host.text()).toContain('通知设置加载失败'); expect(writes).toBe(0)
    click(host.button('重试通知配置')); await tick(); host.render()
    ;(host.field('启用桌面通知').onCheckedChange as (value: boolean) => void)(false); await tick(); host.render()
    expect(host.field('启用桌面通知').checked).toBe(true)
    expect(errors.at(-1)).toContain('保留原设置')
  })
})

test('SSR 分层/响应式结构与团队隐藏入口契约保持', () => {
  api(); store.set(creditsBalanceAtom, null); store.set(subscriptionAtom, null)
  const data = renderToStaticMarkup(<DataManagementSettings />)
  expect(data).toContain('备份与迁移'); expect(data).toContain('磁盘与清理')
  expect(data).toContain('grid-cols-1 sm:grid-cols-2')
  expect(data).toContain('aria-pressed="true"')
  const subscription = renderToStaticMarkup(<SubscriptionSettings />)
  expect(subscription).toContain('minmax(min(100%,180px),1fr)')
  const team = renderToStaticMarkup(<TeamWorkspaceSettings />)
  expect(team).toContain('aria-label="选择团队工作区"')
  const panel = readFileSync(new URL('./SettingsPanel.tsx', import.meta.url), 'utf8')
  expect(panel).toContain('TEAM_WORKSPACE_UI_ENABLED')
  const flags = readFileSync(new URL('../../lib/product-feature-flags.ts', import.meta.url), 'utf8')
  expect(flags).toContain('TEAM_WORKSPACE_UI_ENABLED = false')
})
