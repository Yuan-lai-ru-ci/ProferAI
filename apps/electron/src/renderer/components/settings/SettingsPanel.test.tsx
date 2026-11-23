import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import { createLoadedHost } from '../../../../scripts/settings-loaded-visual-host'
import type { SettingsTab } from '@/atoms/settings-tab'
import { SettingsNavigation, type SettingsTabItem } from './SettingsNavigation'

// 只运行面板导航与离开协议；业务页隔离，不读用户配置、不发 IPC。
const store = createStore()
type ReadTarget = Parameters<typeof store.get>[0]
type WriteTarget = Parameters<typeof store.set>[0]
const setters = new Map<WriteTarget, (value: unknown) => void>()
const setterFor = (target: WriteTarget) => {
  let setter = setters.get(target)
  if (!setter) { setter = (value) => { store.set(target, value) }; setters.set(target, setter) }
  return setter
}
mock.module('jotai', () => ({ atom, getDefaultStore: () => store, useAtom: (target: WriteTarget) => [store.get(target), setterFor(target)], useAtomValue: (target: ReadTarget) => store.get(target), useSetAtom: setterFor }))
for (const name of ['GeneralSettings', 'UsageSettings', 'ChannelSettings', 'AccountSettings', 'AppearanceSettings', 'AboutSettings', 'AgentSettings', 'PromptSettings', 'ToolSettings', 'BotHubSettings', 'ShortcutSettings', 'DataManagementSettings', 'CreditsSettings', 'SubscriptionSettings', 'OpenApiSettings', 'ProxySettings', 'PluginSettings', 'DeveloperSettings', 'DevicesSettings', 'ComposerToolbarSettings']) {
  mock.module(`./${name}`, () => ({ [name]: () => null }))
}
const { SettingsPanel } = await import('./SettingsPanel')
const { settingsTabAtom, channelFormDirtyAtom, channelFormControllerAtom, settingsCloseRequestedAtom, settingsOpenAtom } = await import('../../atoms/settings-tab')
const { appModeAtom } = await import('../../atoms/app-mode')
const { authStatusAtom } = await import('../../atoms/identity-atoms')
const { developerModeEnabledAtom } = await import('../../atoms/developer-mode')
const { tabsAtom, activeTabIdAtom, TUTORIAL_TAB_ID } = await import('../../atoms/tab-atoms')
const { AlertDialog, AlertDialogAction } = await import('@profer/ui/primitives/alert-dialog')
const hosts: Array<{ dispose: () => void }> = []
function mount(tabsOverride?: SettingsTabItem[]) {
  let closes = 0
  const host = createLoadedHost(() => <SettingsPanel tabsOverride={tabsOverride} onClose={() => { closes += 1 }} />, new Set(['SettingsPanel']))
  hosts.push(host)
  const nav = () => host.elements().find((node) => node.type === SettingsNavigation)!
  const changeTab = async (tab: SettingsTab) => { (nav().props.onTabChange as (tab: SettingsTab) => void)(tab); await host.settle() }
  const dialogOpen = () => host.elements().find((node) => node.type === AlertDialog)?.props.open
  const ids = () => (nav().props.groups as Array<{ items: SettingsTabItem[] }>).flatMap((group) => group.items.map((item) => item.id))
  return { host, nav, changeTab, dialogOpen, ids, closes: () => closes }
}
function reset() {
  store.set(settingsTabAtom, 'general')
  store.set(channelFormDirtyAtom, false)
  store.set(channelFormControllerAtom, null)
  store.set(settingsCloseRequestedAtom, false)
  store.set(settingsOpenAtom, true)
  store.set(tabsAtom, [])
  store.set(activeTabIdAtom, null)
  store.set(appModeAtom, 'agent')
  store.set(authStatusAtom, { isLoggedIn: false })
  store.set(developerModeEnabledAtom, false)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); delete (globalThis as { __PROFER_BUILD_TARGET__?: string }).__PROFER_BUILD_TARGET__ })

describe('设置面板可见集合与导航协议', () => {
  test('Given OSS 脏登录态 When 显示 Then 不暴露商业页，模式和开发者门禁继续生效', async () => {
    reset(); store.set(authStatusAtom, { isLoggedIn: true })
    const fixture = mount(); await fixture.host.settle()
    expect(fixture.ids()).not.toContain('account')
    expect(fixture.ids()).not.toContain('credits')
    expect(fixture.ids()).not.toContain('subscription')
    expect(fixture.ids()).toContain('agent')
    expect(fixture.ids()).not.toContain('developer')
    store.set(appModeAtom, 'chat'); store.set(developerModeEnabledAtom, true)
    await fixture.host.settle()
    expect(fixture.ids()).not.toContain('agent')
    expect(fixture.ids()).toContain('developer')
    expect(fixture.ids()).toContain('plugins')
  })

  test('Given 商业版登录态变化 When 退出登录 Then 隐藏额度订阅并回落可见页', async () => {
    reset(); (globalThis as { __PROFER_BUILD_TARGET__?: string }).__PROFER_BUILD_TARGET__ = 'commercial'
    store.set(authStatusAtom, { isLoggedIn: true }); store.set(settingsTabAtom, 'credits')
    const fixture = mount(); await fixture.host.settle()
    expect(fixture.ids()).toContain('credits')
    store.set(authStatusAtom, { isLoggedIn: false }); await fixture.host.settle()
    expect(fixture.ids()).toContain('account')
    expect(fixture.ids()).not.toContain('credits')
    expect(fixture.nav().props.activeTab).toBe('general')
  })

  test('Given 白名单 When 默认门禁不同 Then 保留白名单顺序且空列表不回落通用页', async () => {
    reset(); store.set(appModeAtom, 'chat')
    const fixture = mount([{ id: 'plugins', label: '扩展配置', icon: null }, { id: 'agent', label: '执行配置', icon: null }, { id: 'account', label: '账户', icon: null }])
    await fixture.host.settle()
    expect(fixture.ids()).toEqual(['plugins', 'agent'])
    expect(fixture.nav().props.activeTab).toBe('plugins')
    const empty = mount([]); await empty.host.settle()
    expect(empty.host.elements().some((node) => node.type === SettingsNavigation)).toBe(false)
    await empty.host.click('关闭设置')
    expect(empty.closes()).toBe(1)
  })

  test('Given 渠道草稿 When 搜索及点击当前页 Then 不导航也不弹出离开框', async () => {
    reset(); store.set(settingsTabAtom, 'channels'); store.set(channelFormDirtyAtom, true)
    const fixture = mount(); await fixture.host.settle()
    ;(fixture.nav().props.onQueryChange as (value: string) => void)('不存在的设置')
    await fixture.host.settle(); await fixture.changeTab('channels')
    expect(fixture.nav().props.activeTab).toBe('channels')
    expect(store.get(settingsTabAtom)).toBe('channels')
    expect(fixture.dialogOpen()).toBe(false)
  })

  test('Given 渠道保存失败 When 保存并离开 Then 保留页面与弹窗，重试成功才切换', async () => {
    reset(); store.set(settingsTabAtom, 'channels'); store.set(channelFormDirtyAtom, true)
    const pending = deferred<boolean>(); let writes = 0
    store.set(channelFormControllerAtom, { busy: false, flush: async () => ++writes === 1 ? pending.promise : true, discard: async () => {} })
    const fixture = mount(); await fixture.host.settle(); await fixture.changeTab('appearance')
    expect(fixture.dialogOpen()).toBe(true)
    const action = fixture.host.elements().find((node) => node.type === AlertDialogAction)!.props.onClick as (event: unknown) => void
    action({ preventDefault() {} }); await fixture.host.settle()
    expect(fixture.nav().props.activeTab).toBe('channels')
    pending.resolve(false); await fixture.host.settle()
    expect(fixture.dialogOpen()).toBe(true)
    await fixture.host.click('保存并离开')
    expect(fixture.nav().props.activeTab).toBe('appearance')
    expect(fixture.dialogOpen()).toBe(false)
    expect(writes).toBe(2)
  })

  test('Given 外部关闭请求 When 放弃并离开 Then 等待 discard 完成才关闭', async () => {
    reset(); store.set(settingsTabAtom, 'channels'); store.set(channelFormDirtyAtom, true)
    const pending = deferred<void>(); let discards = 0
    store.set(channelFormControllerAtom, { busy: false, flush: async () => true, discard: async () => { discards += 1; await pending.promise } })
    const fixture = mount(); await fixture.host.settle()
    store.set(settingsCloseRequestedAtom, true); await fixture.host.settle()
    expect(fixture.dialogOpen()).toBe(true)
    const leaving = fixture.host.click('放弃并离开')
    await fixture.host.settle()
    expect(discards).toBe(1); expect(fixture.closes()).toBe(0)
    pending.resolve(); await leaving; await fixture.host.settle()
    expect(fixture.closes()).toBe(1)
    expect(store.get(settingsCloseRequestedAtom)).toBe(false)
  })

  test('Given 渠道草稿 When 打开教程 Then 先经过离开保护再打开主区单例 Tab', async () => {
    reset(); store.set(settingsTabAtom, 'channels'); store.set(channelFormDirtyAtom, true)
    store.set(channelFormControllerAtom, { busy: false, flush: async () => true, discard: async () => {} })
    const fixture = mount(); await fixture.host.settle(); await fixture.changeTab('tutorial')
    expect(store.get(tabsAtom)).toHaveLength(0)
    await fixture.host.click('保存并离开')
    expect(store.get(tabsAtom).map((tab) => tab.sessionId)).toEqual([TUTORIAL_TAB_ID])
    expect(store.get(activeTabIdAtom)).toBe(store.get(tabsAtom)[0]!.id)
    expect(store.get(settingsOpenAtom)).toBe(false)
    expect(store.get(settingsTabAtom)).toBe('channels')
  })
})
