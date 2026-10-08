import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import { renderToStaticMarkup } from 'react-dom/server'

// 无 DOM hook 宿主运行真实事件；IPC、网络、资源与凭据全部为内存 fixture。
const store = createStore()
type AtomTarget = Parameters<typeof store.get>[0]
type WritableTarget = Parameters<typeof store.set>[0]
const setters = new Map<WritableTarget, (value: unknown) => void>()
let fixtureUpdaterAvailable = false
const setterFor = (target: WritableTarget) => {
  let setter = setters.get(target)
  if (!setter) { setter = (value: unknown) => { store.set(target, value) }; setters.set(target, setter) }
  return setter
}
mock.module('jotai', () => ({ atom, getDefaultStore: () => store, useAtom: (target: WritableTarget) => [store.get(target), setterFor(target)], useAtomValue: (target: AtomTarget) => target === updaterAvailableAtom ? fixtureUpdaterAvailable : store.get(target), useSetAtom: setterFor, useStore: () => store }))
const errors: string[] = []
const success: string[] = []
mock.module('sonner', () => ({ Toaster: () => null, toast: { error: (value: string) => errors.push(value), success: (value: string) => success.push(value), warning() {} } }))
mock.module('../../hooks/usePluginPage', () => ({ usePluginPage: () => async () => {} }))
mock.module('../plugins/PluginCredentialField', () => ({ PluginCredentialField: () => null }))
mock.module('../../../../resources/skin-template/manifest.json?raw', () => ({ default: '{"fixture":true}' }))
mock.module('../../../../resources/skin-template/skin.css?raw', () => ({ default: ':root { --fixture: 0; }' }))
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mac Electron fixture' } })
Object.defineProperty(globalThis, '__APP_VERSION__', { configurable: true, value: '0.0.0-fixture' })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }), electronAPI: {} } })
const { AppearanceSettings } = await import('./AppearanceSettings')
const { SkinManager } = await import('./SkinManager')
const { ShortcutSettings } = await import('./ShortcutSettings')
const { AboutSettings } = await import('./AboutSettings')
const { DeveloperSettings } = await import('./DeveloperSettings')
const { PluginSettings } = await import('./PluginSettings')
const { themeModeAtom, themeStyleAtom, skinsAtom } = await import('../../atoms/theme')
const { markdownFontSizeAtom } = await import('../../atoms/markdown-font-size')
const { shortcutOverridesAtom } = await import('../../atoms/shortcut-atoms')
const { developerModeEnabledAtom, openEpistemicModeEnabledAtom } = await import('../../atoms/developer-mode')
const { updateStatusAtom, updaterAvailableAtom } = await import('../../atoms/updater')
const { settingsTabAtom } = await import('../../atoms/settings-tab')
const { updateShortcutOverrides, initShortcutRegistry, registerShortcut, getActiveAccelerator } = await import('../../lib/shortcut-registry')
const { DEFAULT_SHORTCUTS } = await import('../../lib/shortcut-defaults')

type Props = Record<string, unknown>
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
function elements(tree: unknown): React.ReactElement<Props>[] {
  const result: React.ReactElement<Props>[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!React.isValidElement<Props>(node)) return
    result.push(node)
    visit(node.props.children)
    visit(node.props.action)
  }
  visit(tree)
  return result
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return React.isValidElement<Props>(node) ? text(node.props.children) : ''
}
const hosts: Array<{ dispose: () => void }> = []
function mount(component: () => React.ReactElement | null) {
  const slots: Slot[] = []
  let index = 0
  let changed = false
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
    if (!same(slot.deps, deps)) {
      slot.deps = deps
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined })
    }
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
    useMemo,
    useCallback<T>(callback: T, deps: readonly unknown[]) { return useMemo(() => callback, deps) },
    useId() { return useMemo(() => `fixture-${index}`, []) },
    useEffect,
    useLayoutEffect: useEffect,
  }
  const render = () => {
    let rounds = 0
    do {
      if (++rounds > 30) throw new Error('fixture render loop')
      changed = false
      index = 0
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { tree = component() }
      finally { internals.ReactCurrentDispatcher.current = previous }
      const pending = effects
      effects = []
      pending.forEach((effect) => effect())
    } while (changed)
  }
  render()
  const host = {
    render,
    elements: () => elements(tree),
    field: (label: string) => elements(tree).find((item) => item.props.label === label)!.props,
    button: (label: string) => elements(tree).find((item) => item.props.onClick && (text(item) === label || item.props['aria-label'] === label))!.props,
    dispose: () => slots.forEach((slot) => slot.cleanup?.()),
  }
  hosts.push(host)
  return host
}
const tick = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
const fail = async () => { throw new Error('fixture failure') }
const listeners = new Map<string, Array<(event: KeyboardEvent) => void>>()
const styles = new Map<string, string>()
const classes = new Set(['dark'])
function api(overrides: Props = {}) {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { classList: { contains: (name: string) => classes.has(name), remove: (name: string) => classes.delete(name), add: (name: string) => classes.add(name), toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name), [Symbol.iterator]: () => classes[Symbol.iterator]() }, style: { setProperty: (key: string, value: string) => styles.set(key, value) } }, getElementById: () => null } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (name: string, handler: (event: KeyboardEvent) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]) },
    removeEventListener: (name: string, handler: (event: KeyboardEvent) => void) => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== handler)),
    electronAPI: {
      getSettings: async () => ({}), updateSettings: async (patch: Props) => patch,
      getSkins: async () => [], refreshSkins: async () => [], getSkinPreview: async () => null,
      getPlatformInfo: () => ({ platform: 'darwin' }), getRuntimeStatus: async () => null,
      listPlugins: async () => [], onPluginsChanged: () => () => {},
      auth: { getTeamAuth: async () => null }, reregisterGlobalShortcuts: async () => ({}),
      ...overrides,
    },
  } })
}
function child(component: () => React.ReactElement | null, name: string) {
  const host = mount(component)
  const node = host.elements().find((item) => typeof item.type === 'function' && item.type.name === name)!
  return node.type as () => React.ReactElement | null
}
function click(props: Props) { return (props.onClick as (event: { preventDefault(): void }) => unknown)({ preventDefault() {} }) }
function dispatch(key: string, extra: Props = {}) {
  const event = { key, code: key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra } as unknown as KeyboardEvent
  for (const handler of [...(listeners.get('keydown') ?? [])]) handler(event)
}
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); errors.length = 0; success.length = 0; store.set(developerModeEnabledAtom, false); fixtureUpdaterAvailable = false; listeners.clear() })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('外观与皮肤真实事件（mock IPC）', () => {
  test('主题/字号写失败保持 atom 与 DOM，重试保存原子写两个主题字段', async () => {
    store.set(themeModeAtom, 'dark'); store.set(themeStyleAtom, 'default'); store.set(markdownFontSizeAtom, 'medium')
    let writes = 0
    const patches: Props[] = []
    api({ updateSettings: async (patch: Props) => { patches.push(patch); if (++writes < 3) throw new Error('fixture-write'); return patch } })
    const host = mount(AppearanceSettings); await tick(); host.render()
    ;(host.field('主题模式').onValueChange as (value: string) => void)('light'); await tick(); host.render()
    expect(store.get(themeModeAtom)).toBe('dark'); expect(classes.has('dark')).toBe(true)
    ;(host.field('Markdown 字号').onValueChange as (value: string) => void)('large'); await tick(); host.render()
    expect(store.get(markdownFontSizeAtom)).toBe('medium'); expect(styles.has('--md-preview-font-size')).toBe(false)
    ;(host.field('主题模式').onValueChange as (value: string) => void)('light'); await tick(); host.render()
    expect(store.get(themeModeAtom)).toBe('light'); expect(classes.has('dark')).toBe(false)
    expect(patches[0]).toEqual({ themeMode: 'light', themeStyle: 'default' })
  })
  test('皮肤加载失败有错误，重试读取成功；删除失败保留确认并可重试', async () => {
    const skin = { id: 'fixture', name: 'Fixture', builtin: false, tone: 'dark' as const, contractVersion: 2 }
    store.set(themeModeAtom, 'dark'); store.set(themeStyleAtom, 'default')
    let reads = 0; let removes = 0
    api({ getSkins: fail, refreshSkins: async () => { reads += 1; return [skin] }, deleteUserSkin: async () => { if (++removes === 1) throw new Error('fixture-remove'); return { ok: true } } })
    const host = mount(AppearanceSettings); await tick(); host.render()
    const manager = () => host.elements().find((item) => item.type === SkinManager)!.props
    expect(manager().error).toContain('读取皮肤库失败')
    await (manager().onRefresh as () => Promise<void>)(); host.render()
    expect(reads).toBeGreaterThan(0); expect(store.get(skinsAtom)).toHaveLength(1)
    ;(manager().onDelete as (value: unknown) => void)(skin); host.render()
    expect(removes).toBe(0)
    click(host.button('删除皮肤')); await tick(); host.render()
    expect(removes).toBe(1); expect(host.elements().filter((item) => item.props.open === true)).toHaveLength(1)
    click(host.button('删除皮肤')); await tick(); host.render(); expect(removes).toBe(2)
  })
  test('皮肤按钮选中/忙碌/图片装饰可访问性，当前用户皮肤不可删', async () => {
    api()
    const skin = { id: 'fixture', name: 'Fixture', builtin: false, tone: 'dark' as const, contractVersion: 2 }
    const component = () => SkinManager({ skins: [skin], themeMode: 'special', themeStyle: 'fixture', busy: false, onSelect() {}, onDelete() {}, onRefresh: async () => {}, onImport: async () => {}, onOpenFolder() {} })
    const group = mount(component).elements().find((item) => typeof item.type === 'function' && item.type.name === 'SkinGroup' && item.props.title === '我的皮肤')!
    const host = mount(() => (group.type as (props: Props) => React.ReactElement)(group.props))
    expect(host.button('使用皮肤 Fixture')['aria-pressed']).toBe(true)
    expect(host.button('删除皮肤 Fixture').disabled).toBe(true)
    const markup = renderToStaticMarkup(React.createElement(component))
    expect(markup).toContain('aria-pressed="true"'); expect(markup).toContain('刷新皮肤库')
  })
})

describe('快捷键草稿与保存保护', () => {
  test('草稿不写绑定，Esc 取消；失败保留 pending，成功重试才改覆盖', async () => {
    store.set(shortcutOverridesAtom, {}); updateShortcutOverrides({})
    let writes = 0
    api({ updateSettings: async (patch: Props) => { if (++writes === 1) throw new Error('fixture-write'); return patch } })
    const parent = mount(ShortcutSettings)
    const row = parent.elements().find((item) => item.props.shortcutId)!
    const host = mount(() => (row.type as (props: Props) => React.ReactElement)(row.props))
    click(host.button(`录制 ${row.props.shortcutId} 的快捷键`)); host.render(); parent.render()
    dispatch('Escape'); host.render(); parent.render()
    expect(writes).toBe(0); expect(store.get(shortcutOverridesAtom)).toEqual({})
    click(host.button(`录制 ${row.props.shortcutId} 的快捷键`)); host.render(); parent.render()
    dispatch('F24'); host.render(); parent.render(); expect(writes).toBe(0)
    click(host.button('保存')); await tick(); host.render(); parent.render()
    expect(writes).toBe(1); expect(store.get(shortcutOverridesAtom)).toEqual({}); expect(host.button('保存').disabled).toBe(false)
    click(host.button('保存')); await tick(); host.render(); parent.render()
    expect(store.get(shortcutOverridesAtom)).toEqual({ [row.props.shortcutId as string]: { mac: 'F24' } })
  })
  test('恢复全部只开确认；录制期间保留注册表缓存及冲突检测', async () => {
    store.set(shortcutOverridesAtom, { 'app-new-session': { mac: 'Cmd+Shift+9' } }); updateShortcutOverrides(store.get(shortcutOverridesAtom))
    let writes = 0
    api({ updateSettings: async (patch: Props) => { writes += 1; return patch } })
    const host = mount(ShortcutSettings)
    click(host.button('恢复全部默认')); host.render()
    expect(writes).toBe(0)
    const row = host.elements().find((item) => item.props.shortcutId)!
    const original = getActiveAccelerator(row.props.shortcutId as string)
    ;(row.props.onActiveChange as (active: boolean) => void)(true); host.render()
    expect(getActiveAccelerator(row.props.shortcutId as string)).toBe(original)
    expect(host.elements().filter((item) => item.props.shortcutId && item.props.shortcutId !== row.props.shortcutId).every((item) => item.props.disabled === true)).toBe(true)
    ;(row.props.onActiveChange as (active: boolean) => void)(false); host.render()
    const buttons = host.elements().filter((item) => text(item) === '恢复全部默认' && item.props.onClick)
    click(buttons.at(-1)!.props); await tick(); host.render(); expect(writes).toBe(1)
  })
})

describe('开发者与插件门禁和危险确认', () => {
  test('门禁关闭不读取插件/凭据，不写开发者配置', async () => {
    let calls = 0; api({ listPlugins: async () => { calls += 1; return [] }, updateSettings: async () => { calls += 1 } })
    store.set(developerModeEnabledAtom, false)
    const plugin = mount(PluginSettings); const developer = mount(DeveloperSettings)
    expect(plugin.elements().some((item) => item.props.onClick)).toBe(false)
    expect(developer.elements().some((item) => item.props.onCheckedChange)).toBe(false)
    await tick(); expect(calls).toBe(0)
  })
  test('实验保存失败保留 atom；退出需确认，失败不隐藏，重试关闭成功', async () => {
    store.set(developerModeEnabledAtom, true); store.set(openEpistemicModeEnabledAtom, true); store.set(settingsTabAtom, 'developer')
    let writes = 0
    api({ updateSettings: async (patch: Props) => { if (++writes < 3) throw new Error('fixture-write'); return patch } })
    const host = mount(DeveloperSettings)
    ;(host.field('开放认识论（关闭「绝对正确」姿态）').onCheckedChange as (value: boolean) => void)(false); await tick(); host.render()
    expect(store.get(openEpistemicModeEnabledAtom)).toBe(true)
    click(host.button('退出开发者模式')); host.render(); expect(writes).toBe(1)
    click(host.button('确认退出')); await tick(); host.render(); expect(store.get(developerModeEnabledAtom)).toBe(true)
    click(host.button('确认退出')); await tick(); host.render(); expect(store.get(developerModeEnabledAtom)).toBe(false); expect(store.get(settingsTabAtom)).toBe('general')
  })
  test('插件列表失败可重试；卸载只在确认后写，失败保留确认', async () => {
    store.set(developerModeEnabledAtom, true)
    const plugin = { manifest: { id: 'fixture.plugin', name: 'Fixture plugin', version: '1.0', contributes: {}, permissions: [] }, installedAt: 1, enabled: false }
    let reads = 0; let removes = 0
    api({ listPlugins: async () => { if (++reads === 1) throw new Error('fixture-list'); return [plugin] }, removePlugin: async () => { if (++removes === 1) throw new Error('fixture-remove'); return { ok: true, message: 'Fixture removed' } } })
    const host = mount(child(PluginSettings, 'PluginSettingsContent')); await tick(); host.render()
    click(host.button('重试')); await tick(); host.render(); expect(reads).toBe(2)
    click(host.button('卸载 Fixture plugin')); host.render(); expect(removes).toBe(0)
    click(host.button('卸载插件')); await tick(); host.render(); expect(removes).toBe(1)
    expect(host.elements().some((item) => item.props.open === true)).toBe(true)
    click(host.button('卸载插件')); await tick(); host.render(); expect(removes).toBe(2)
  })
})

describe('About 分区与真实状态（仅 fixture）', () => {
  test('关于/更新/环境/记录/反馈分区，未解锁不写配置', () => {
    api(); const host = mount(AboutSettings)
    expect(host.elements().filter((item) => item.props.title).map((item) => item.props.title)).toEqual(expect.arrayContaining(['关于 Profer', '软件更新', '运行环境', '版本记录']))
  })
  test('无 updater 展示发布页，检测失败后重试；安装更新需确认', async () => {
    fixtureUpdaterAvailable = false; api()
    const disabled = mount(child(AboutSettings, 'UpdateCard')); expect(disabled.button('官方发布页')).toBeDefined()
    let restarts = 0
    fixtureUpdaterAvailable = true; store.set(updateStatusAtom, { status: 'downloaded', version: 'fixture' })
    api({ updater: { quitAndInstall: async () => { restarts += 1 } } })
    const host = mount(child(AboutSettings, 'UpdateCard'))
    click(host.button('立即重启')); host.render(); expect(restarts).toBe(0)
    click(host.button('重启并安装')); await tick(); host.render(); expect(restarts).toBe(1)
  })
  test('环境缓存读取/检测失败明确错误；无结果不显示永久检测 spinner', async () => {
    api({ getSettings: fail, checkEnvironment: fail })
    const host = mount(child(AboutSettings, 'EnvironmentCard')); await tick(); host.render()
    expect(host.elements().some((item) => item.props.role === 'alert')).toBe(true)
    expect(host.elements().some((item) => text(item).includes('尚无检测结果'))).toBe(true)
    click(host.button('重新检查')); await tick(); host.render()
    expect(host.elements().some((item) => text(item).includes('环境检测失败'))).toBe(true)
  })
  test('反馈失败保留内容；缺服务端只显示错误不请求网络', async () => {
    api()
    let fetches = 0
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { fetches += 1; throw new Error('fixture-fetch') } })
    const host = mount(child(AboutSettings, 'FeedbackSection'))
    const input = () => host.elements().find((item) => item.props.id === 'feedback-content')!.props
    ;(input().onChange as (event: unknown) => void)({ target: { value: 'Fixture feedback' } }); host.render()
    click(host.button('提交反馈')); await tick(); host.render()
    expect(input().value).toBe('Fixture feedback'); expect(fetches).toBe(0)
    expect(host.elements().some((item) => text(item).includes('账户设置'))).toBe(true)
  })
})

describe('在途与冲突边界（只使用 fixture）', () => {
  test('外观双击只发一次保存，响应前不改主题', async () => {
    store.set(themeModeAtom, 'dark'); store.set(themeStyleAtom, 'default')
    const pending = deferred<Props>(); let writes = 0
    api({ updateSettings: () => { writes += 1; return pending.promise } })
    const host = mount(AppearanceSettings); await tick(); host.render()
    const change = host.field('主题模式').onValueChange as (value: string) => void
    change('light'); change('system'); host.render()
    expect(writes).toBe(1); expect(store.get(themeModeAtom)).toBe('dark'); expect(host.field('主题模式').disabled).toBe(true)
    pending.resolve({ themeMode: 'light', themeStyle: 'default' }); await tick(); host.render()
    expect(store.get(themeModeAtom)).toBe('light')
  })
  test('皮肤冲突不替换，确认失败后仍可重试，不再次打开选择器', async () => {
    let selections = 0; const replaces: boolean[] = []
    api({ selectSkinZip: async () => { selections += 1; return 'fixture.zip' }, installSkinZip: async (_path: string, replace: boolean) => {
      replaces.push(replace)
      if (!replace) return { ok: false, status: 'conflict' }
      if (replaces.length === 2) throw new Error('fixture-replace')
      return { ok: true, status: 'replaced' }
    } })
    const host = mount(AppearanceSettings); await tick(); host.render()
    const manager = host.elements().find((item) => item.type === SkinManager)!
    await (manager.props.onImport as (kind: string) => Promise<void>)('zip'); host.render()
    expect(replaces).toEqual([false]); expect(selections).toBe(1)
    click(host.button('替换皮肤')); await tick(); host.render(); expect(host.elements().some((item) => item.props.open === true)).toBe(true)
    click(host.button('替换皮肤')); await tick(); host.render(); expect(replaces).toEqual([false, true, true]); expect(selections).toBe(1)
  })
  test('快捷键冲突草稿不允许保存，不修改注册表；独占暂停在取消后释放', async () => {
    store.set(shortcutOverridesAtom, {}); updateShortcutOverrides({}); api()
    initShortcutRegistry()
    const target = DEFAULT_SHORTCUTS.find((item) => !item.global && !item.readonly && item.defaultMac && item.defaultMac !== 'Cmd+K')!
    let commands = 0
    const release = registerShortcut(target.id, () => { commands += 1 })
    const parent = mount(ShortcutSettings)
    const row = parent.elements().find((item) => item.props.shortcutId === target.id)!
    const recorder = mount(() => (row.type as (props: Props) => React.ReactElement)(row.props))
    click(recorder.button(`录制 ${target.id} 的快捷键`)); recorder.render(); parent.render()
    const accel = DEFAULT_SHORTCUTS.find((item) => !item.global && item.id !== target.id && item.defaultMac.startsWith('Cmd+') && !item.defaultMac.includes('Shift') && !item.defaultMac.includes('Alt'))!
    dispatch(accel.defaultMac.split('+').at(-1)!, { metaKey: true }); recorder.render(); parent.render()
    expect(recorder.button('保存').disabled).toBe(true)
    expect(getActiveAccelerator(target.id)).toBe(target.defaultMac)
    click(recorder.button('取消')); recorder.render(); parent.render()
    const key = target.defaultMac.split('+').at(-1)!
    dispatch(key, { metaKey: target.defaultMac.includes('Cmd'), ctrlKey: target.defaultMac.includes('Ctrl'), shiftKey: target.defaultMac.includes('Shift'), altKey: target.defaultMac.includes('Alt') })
    expect(commands).toBe(1)
    release()
  })
  test('插件替换和撤销只在确认后执行；失败保留弹窗', async () => {
    store.set(developerModeEnabledAtom, true)
    const plugin = { manifest: { id: 'fixture.plugin', name: 'Fixture plugin', version: '1.0', contributes: {}, permissions: [] }, installedAt: 1, enabled: false }
    const replacements: boolean[] = []; let revoked = 0
    api({ listPlugins: async () => [plugin], selectPluginPackage: async () => 'fixture-plugin.zip', installPlugin: async (_path: string, replace = false) => {
      replacements.push(replace); return replace ? { ok: true, status: 'updated', message: 'fixture updated' } : { ok: false, status: 'conflict', message: 'fixture conflict' }
    }, revokePluginPermissions: async () => { revoked += 1 } })
    const host = mount(child(PluginSettings, 'PluginSettingsContent')); await tick(); host.render()
    click(host.button('安装 ZIP')); await tick(); host.render(); expect(replacements).toEqual([false])
    click(host.button('替换插件')); await tick(); host.render(); expect(replacements).toEqual([false, true])
    click(host.button('撤销授权')); host.render(); expect(revoked).toBe(0)
    const revoke = host.elements().filter((item) => item.props.onClick && text(item) === '撤销授权').at(-1)!
    click(revoke.props); await tick(); host.render(); expect(revoked).toBe(1)
  })
  test('更新检查失败可重试，双击不并发检查', async () => {
    fixtureUpdaterAvailable = true; store.set(updateStatusAtom, { status: 'idle' })
    const pending = deferred<void>(); let checks = 0
    api({ updater: { checkForUpdates: () => { checks += 1; return checks === 1 ? pending.promise : Promise.resolve() } } })
    const host = mount(child(AboutSettings, 'UpdateCard'))
    click(host.button('检查更新')); click(host.button('检查更新')); host.render(); expect(checks).toBe(1)
    pending.reject(new Error('fixture-update')); await tick(); host.render(); expect(host.elements().some((item) => item.props.role === 'alert')).toBe(true)
    click(host.button('重试')); await tick(); host.render(); expect(checks).toBe(2)
  })
  test('运行时摘要失败可重读，Bun快照为只读，不重新初始化运行时', async () => {
    let reads = 0; let reinit = 0
    const runtime = { available: true, path: 'fixture/runtime', version: 'fixture-version', error: null }
    api({ getRuntimeStatus: async () => { if (++reads === 1) throw new Error('fixture-runtime'); return { node: runtime, bun: runtime, git: runtime } }, reinitRuntime: async () => { reinit += 1 } })
    const host = mount(child(AboutSettings, 'RuntimeSummaryCard')); await tick(); host.render()
    expect(host.elements().some((item) => item.props.role === 'alert')).toBe(true)
    click(host.button('重新读取')); await tick(); host.render()
    expect(reads).toBe(2); expect(reinit).toBe(0); expect(host.elements().some((item) => text(item) === 'Bun')).toBe(true)
  })
  test('反馈 mock POST 失败保留草稿，重复点击不重复发送；重试成功清空', async () => {
    api({ auth: { getTeamAuth: async () => ({ baseUrl: 'https://fixture.invalid', token: 'fixture-only' }) } })
    const pending = deferred<Response>(); let requests = 0
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => {
      if (++requests === 1) return pending.promise
      return { ok: true }
    } })
    const host = mount(child(AboutSettings, 'FeedbackSection'))
    const input = () => host.elements().find((item) => item.props.id === 'feedback-content')!.props
    ;(input().onChange as (event: unknown) => void)({ target: { value: 'Fixture content' } }); host.render()
    click(host.button('提交反馈')); click(host.button('提交反馈')); await tick(); expect(requests).toBe(1)
    pending.reject(new Error('fixture-post')); await tick(); host.render(); expect(input().value).toBe('Fixture content')
    click(host.button('提交反馈')); await tick(); host.render(); expect(requests).toBe(2)
    expect(host.elements().some((item) => item.props.role === 'status')).toBe(true)
  })
})
