import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VoiceDictationSettings, PocketModeStatus } from '../../../types'

// 所有 IPC、凭据、二维码、端口和权限都是内存 fixture，不连接任何真实服务。
const store = createStore()
type AtomTarget = Parameters<typeof store.get>[0]
type WritableTarget = Parameters<typeof store.set>[0]
const setters = new Map<WritableTarget, (value: unknown) => void>()
const setterFor = (target: WritableTarget) => {
  let setter = setters.get(target)
  if (!setter) { setter = (value: unknown) => { store.set(target, value) }; setters.set(target, setter) }
  return setter
}
mock.module('jotai', () => ({ atom, getDefaultStore: () => store, useAtom: (target: WritableTarget) => [store.get(target), setterFor(target)], useAtomValue: (target: AtomTarget) => store.get(target), useSetAtom: setterFor, useStore: () => store }))
const errors: string[] = []
mock.module('sonner', () => ({ toast: { error: (message: string) => errors.push(message), success() {}, warning() {}, info() {} } }))
mock.module('../../hooks/useCreateSession', () => ({ useCreateSession: () => ({ createAgent: async () => 'fixture-session' }) }))
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mac fixture', clipboard: { writeText: async () => {} } } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { getPlatformInfo: () => ({ platform: 'darwin' }) } } })
const { FeishuSettings } = await import('./FeishuSettings')
const { DingTalkSettings } = await import('./DingTalkSettings')
const { WeChatSettings } = await import('./WeChatSettings')
const { PocketModeSettings } = await import('./PocketModeSettings')
const { VoiceInputSettings } = await import('./VoiceInputSettings')
const { wechatBridgeStateAtom } = await import('../../atoms/wechat-atoms')
const { feishuBindingsAtom, feishuBotStatesAtom } = await import('../../atoms/feishu-atoms')
const { dingtalkBotStatesAtom } = await import('../../atoms/dingtalk-atoms')
const { voiceDictationSettingsAtom } = await import('../../atoms/voice-dictation-atoms')
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

const tick = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve() }
const fail = async () => { throw new Error('fixture failure') }
const timers = new Map<number, () => void>()
let nextTimer = 1
function api(overrides: Props = {}) {
  const timer = (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: timer, clearTimeout: (id: number) => timers.delete(id), setInterval: timer, clearInterval: (id: number) => timers.delete(id),
    electronAPI: {
      getPlatformInfo: () => ({ platform: 'darwin' }),
      getWeChatConfig: async () => ({ credentials: null }), getWeChatStatus: async () => ({ status: 'disconnected' }), onWeChatStatusChanged: () => () => {},
      startWeChatLogin: async () => {}, stopWeChatBridge: async () => {}, startWeChatBridge: async () => {}, logoutWeChat: async () => {},
      getDingTalkMultiConfig: async () => ({ bots: [] }), getFeishuMultiConfig: async () => ({ bots: [] }), getDingTalkConfig: fail, getFeishuConfig: fail, getFeishuMultiStatus: async () => ({ bots: {} }),
      getDecryptedDingTalkBotSecret: async () => 'fixture-secret', getDecryptedFeishuBotSecret: async () => 'fixture-secret',
      getSettings: async () => ({ feishuSessionMirror: { mode: 'off' } }), updateSettings: async () => {}, listFeishuBindings: async () => [],
      getVoiceDictationSettings: async () => voice, checkMicrophonePermission: async () => ({ status: 'granted', platform: 'darwin' }), reregisterGlobalShortcuts: async () => {},
      getPocketModeStatus: async () => pocket, getProferApkQr: async () => ({ url: 'https://fixture.invalid/download.apk', dataUrl: 'data:image/png;base64,fixture', fileName: 'fixture.apk' }),
      getLarkMcpStatus: async () => ({ configured: false, enabledWorkspaces: [] }), onLarkMcpLoginEvent: () => () => {},
      refreshLarkCliStatus: async () => ({ cli: { available: false }, node: { available: true }, npm: { available: true }, npx: { available: true }, auth: { state: 'logged_out' } }), onLarkLoginEvent: () => () => {},
      onFeishuRegisterQrcode: () => () => {}, onFeishuRegisterStatus: () => () => {}, cancelFeishuRegistration: async () => {},
      ...overrides,
    },
  } })
}
const voice: VoiceDictationSettings = { provider: 'doubao', enabled: false, appId: 'fixture-app', accessToken: 'fixture-token', resourceId: 'fixture-resource', endpointMode: 'async', language: '', customHotwords: '', outputMode: 'auto' }
const pocket: PocketModeStatus = { enabled: false, running: false, port: 7788, defaultPort: 7788, localUrl: null, lanUrl: null, token: null, error: null }
const click = (props: Props) => (props.onClick as (event: { preventDefault: () => void }) => unknown)({ preventDefault() {} })
const feedback = (host: ReturnType<typeof mount>, contains: string) => host.elements().find((item) => typeof item.props.message === 'string' && item.props.message.includes(contains))!.props
function child(host: ReturnType<typeof mount>, name: string, props?: Props) {
  const element = host.elements().find((item) => typeof item.type === 'function' && item.type.name === name)!
  if (!element) throw new Error(`missing child ${name}`)
  return mount(() => (element.type as (props: Props) => React.ReactElement)(props ?? element.props))
}
function feishuConfig() { return child(mount(FeishuSettings), 'FeishuConfigTab') }
afterEach(() => {
  hosts.splice(0).forEach((host) => host.dispose())
  timers.clear(); errors.length = 0
  store.set(wechatBridgeStateAtom, { status: 'disconnected' }); store.set(feishuBotStatesAtom, {}); store.set(dingtalkBotStatesAtom, {}); store.set(feishuBindingsAtom, [])
})

describe('集成页加载失败与重试', () => {
  for (const [name, component, getter] of [
    ['钉钉', DingTalkSettings, 'getDingTalkMultiConfig'], ['微信', WeChatSettings, 'getWeChatConfig'], ['移动', PocketModeSettings, 'getPocketModeStatus'], ['语音', VoiceInputSettings, 'getVoiceDictationSettings'],
  ] as const) {
    test(`${name} 读取失败不假造默认，重试恢复`, async () => {
      let reads = 0
      api({ [getter]: async () => { if (++reads === 1) throw new Error('fixture'); return getter === 'getDingTalkMultiConfig' ? { bots: [] } : getter === 'getWeChatConfig' ? { credentials: null } : getter === 'getPocketModeStatus' ? pocket : voice } })
      const host = mount(component); await tick(); host.render()
      expect(host.elements().some((item) => item.props.message && !item.props.loading)).toBe(true)
      expect(host.elements().some((item) => item.props.label === '启用语音输入' || item.props.label === '启用移动端连接')).toBe(false)
      const error = host.elements().find((item) => item.props.onRetry)!
      ;(error.props.onRetry as () => void)(); await tick(); host.render()
      expect(reads).toBe(2)
      expect(host.elements().some((item) => item.props.message && !item.props.loading)).toBe(false)
    })
  }
  test('飞书多 Bot 与 legacy 均失败时保留重试入口', async () => {
    let reads = 0; let legacy = 0
    api({ getFeishuMultiConfig: async () => { if (++reads === 1) throw new Error('fixture'); return { bots: [] } }, getFeishuConfig: async () => { legacy += 1; throw new Error('legacy fixture failure') } })
    const host = feishuConfig(); await tick(); host.render()
    expect(legacy).toBe(1)
    expect(host.elements().find((item) => item.props.disabled !== undefined && item.props.onRegister)!.props.disabled).toBe(true)
    ;(feedback(host, '无法读取').onRetry as () => void)(); await tick(); host.render()
    expect(reads).toBe(2)
  })
})

describe('语音草稿、保存与权限', () => {
  test('连续编辑不逐键写入；失败保留草稿和已保存 atom，重试成功再同步', async () => {
    let saves = 0; let tested: unknown
    api({ updateVoiceDictationSettings: async (input: VoiceDictationSettings) => { if (++saves === 1) throw new Error('fixture'); return input }, testVoiceDictationConnection: async (input: unknown) => { tested = input; return { success: true, message: 'fixture' } } })
    const host = mount(VoiceInputSettings); await tick(); host.render()
    ;(host.field('豆包 APP ID').onChange as (value: string) => void)('new-app'); host.render()
    ;(host.field('自定义热词').onChange as (value: string) => void)('NewWord'); host.render()
    expect(saves).toBe(0)
    click(host.button('保存设置')); await tick(); host.render()
    expect(host.field('豆包 APP ID').value).toBe('new-app')
    expect(store.get(voiceDictationSettingsAtom)?.appId).toBe('fixture-app')
    expect(feedback(host, '输入已保留')).toBeTruthy()
    click(host.button('测试连接')); await tick(); host.render()
    expect(tested).toMatchObject({ appId: 'new-app', customHotwords: 'NewWord' })
    click(host.button('保存设置')); await tick(); host.render()
    expect(saves).toBe(2)
    expect(store.get(voiceDictationSettingsAtom)?.appId).toBe('new-app')
    expect(host.button('保存设置').disabled).toBe(true)
  })
  test('在途保存去重；晚到响应不覆盖新草稿，撤销回到成功快照', async () => {
    let saves = 0; let resolve!: (value: VoiceDictationSettings) => void
    api({ updateVoiceDictationSettings: (input: VoiceDictationSettings) => { saves += 1; return new Promise<VoiceDictationSettings>((yes) => { resolve = () => yes(input) }) } })
    const host = mount(VoiceInputSettings); await tick(); host.render()
    ;(host.field('豆包 APP ID').onChange as (value: string) => void)('first'); host.render()
    click(host.button('保存设置')); click(host.button('保存设置'))
    ;(host.field('豆包 APP ID').onChange as (value: string) => void)('second'); host.render()
    resolve(voice); await tick(); host.render()
    expect(saves).toBe(1)
    expect(host.field('豆包 APP ID').value).toBe('second')
    expect(store.get(voiceDictationSettingsAtom)?.appId).toBe('first')
    click(host.button('撤销修改')); host.render()
    expect(host.field('豆包 APP ID').value).toBe('first')
  })
  test('麦克风预检失败有重试；授权失败只提示不伪造已授权', async () => {
    let checks = 0
    api({ checkMicrophonePermission: async () => { if (++checks === 1) throw new Error('fixture'); return { status: 'denied', platform: 'darwin' } }, requestMicrophonePermission: fail })
    const host = mount(VoiceInputSettings); await tick(); host.render()
    ;(feedback(host, '无法检查').onRetry as () => void)(); await tick(); host.render()
    click(host.button('重新请求权限')); await tick(); host.render()
    expect(errors.at(-1)).toContain('请求麦克风权限失败')
    expect(host.button('重新请求权限').disabled).toBe(false)
  })
})

describe('移动模式', () => {
  test('端口错误阻止写入，失败保留草稿；重试成功更新已保存端口', async () => {
    let writes = 0
    api({ setPocketModePort: async (port: number) => { if (++writes === 1) throw new Error('fixture'); return { ...pocket, port } } })
    const host = mount(PocketModeSettings); await tick(); host.render()
    const port = () => host.elements().find((item) => item.props['aria-label'] === '移动模式服务端口')!.props
    ;(port().onChange as (event: unknown) => void)({ target: { value: '1' } }); host.render()
    expect(port()['aria-invalid']).toBe(true); expect(host.button('保存').disabled).toBe(true)
    ;(port().onChange as (event: unknown) => void)({ target: { value: '8899' } }); host.render()
    click(host.button('保存')); await tick(); host.render()
    expect(port().value).toBe('8899'); expect(feedback(host, '草稿已保留')).toBeTruthy()
    click(host.button('保存')); await tick(); host.render()
    expect(writes).toBe(2); expect(host.button('保存').disabled).toBe(true)
  })
  test('关闭开关只打开确认；写失败仍保持开启并允许重试', async () => {
    let writes = 0
    api({ getPocketModeStatus: async () => ({ ...pocket, enabled: true, running: true }), setPocketModeEnabled: async (enabled: boolean) => { if (++writes === 1) throw new Error('fixture'); return { ...pocket, enabled } } })
    const host = mount(PocketModeSettings); await tick(); host.render()
    ;(host.field('启用移动端连接').onCheckedChange as (value: boolean) => void)(false); host.render()
    expect(writes).toBe(0)
    click(host.button('关闭连接')); await tick(); host.render()
    expect(host.field('启用移动端连接').checked).toBe(true)
    click(host.button('关闭连接')); await tick(); host.render()
    expect(host.field('启用移动端连接').checked).toBe(false)
  })
  test('APK 读取错误不永久转圈，可重试；服务等待超时可重新启动', async () => {
    let qr = 0; let starts = 0
    api({ getPocketModeStatus: async () => ({ ...pocket, enabled: true }), getProferApkQr: async () => { if (++qr === 1) throw new Error('fixture'); return null }, setPocketModeEnabled: async () => { starts += 1; return { ...pocket, enabled: true } } })
    const host = mount(PocketModeSettings); await tick(); host.render()
    ;(feedback(host, '下载信息加载失败').onRetry as () => void)(); host.render(); await tick(); host.render()
    expect(qr).toBe(2); expect(feedback(host, '暂未提供')).toBeTruthy()
    for (const callback of [...timers.values()]) callback()
    host.render(); (feedback(host, '等待已超时').onRetry as () => void)(); await tick(); host.render()
    expect(starts).toBe(1)
  })
})

describe('微信连接与扫码', () => {
  test('登录 IPC 持续等待时仍可刷新/取消；取消后的旧失败不污染状态', async () => {
    let reject!: (reason: Error) => void; let stops = 0
    api({ startWeChatLogin: () => new Promise((_resolve, no) => { reject = no }), stopWeChatBridge: async () => { stops += 1 } })
    const host = mount(WeChatSettings); await tick(); host.render()
    click(host.button('扫码登录')); await tick(); host.render()
    expect(host.button('取消扫码').disabled).toBe(false)
    expect(host.button('刷新二维码').disabled).toBe(false)
    click(host.button('取消扫码')); await tick(); host.render()
    reject(new Error('late fixture error')); await tick(); host.render()
    expect(stops).toBe(1); expect(store.get(wechatBridgeStateAtom).status).toBe('disconnected')
    expect(host.elements().some((item) => String(item.props.message).includes('late fixture'))).toBe(false)
  })
  test('登出只在确认后调用；失败保凭据、成功重试才清除', async () => {
    let calls = 0
    api({ getWeChatConfig: async () => ({ credentials: { botToken: 'fixture-only' } }), getWeChatStatus: async () => ({ status: 'connected' }), logoutWeChat: async () => { if (++calls === 1) throw new Error('fixture') } })
    const host = mount(WeChatSettings); await tick(); host.render()
    expect(calls).toBe(0)
    click(host.button('确认登出')); await tick(); host.render()
    expect(store.get(wechatBridgeStateAtom).status).toBe('connected')
    expect(feedback(host, '凭证未清除')).toBeTruthy()
    click(host.button('确认登出')); await tick(); host.render()
    expect(store.get(wechatBridgeStateAtom).status).toBe('disconnected')
    expect(host.elements().some((item) => text(item) === '登出' && item.props.onClick)).toBe(false)
  })
  test('状态推送显示二维码、手机确认与过期错误；错误可重新扫码', async () => {
    let push!: (state: { status: string; qrCodeData?: string; errorMessage?: string }) => void
    api({ onWeChatStatusChanged: (listener: typeof push) => { push = listener; return () => {} } })
    const host = mount(WeChatSettings); await tick(); host.render()
    push({ status: 'waiting_scan', qrCodeData: 'data:image/png;base64,fixture' }); host.render()
    expect(host.elements().find((item) => item.type === 'img')!.props.alt).toBe('微信登录二维码')
    push({ status: 'scanned', qrCodeData: 'data:image/png;base64,fixture' }); host.render()
    expect(host.elements().some((item) => text(item).includes('请在手机上确认登录'))).toBe(true)
    push({ status: 'error', errorMessage: '二维码已过期' }); host.render()
    expect(host.elements().some((item) => item.type === 'img')).toBe(false)
    expect(host.button('重新扫码登录').disabled).toBe(false)
  })
})

for (const kind of ['DingTalk', 'Feishu'] as const) {
  describe(`${kind} Bot 配置`, () => {
    const bot = kind === 'DingTalk' ? { id: 'fixture-bot', name: 'Fixture bot', enabled: true, clientId: 'fixture-app', clientSecret: 'encrypted', defaultWorkspaceId: 'w', defaultChannelId: 'c', defaultModelId: 'm' } : { id: 'fixture-bot', name: 'Fixture bot', enabled: true, appId: 'fixture-app', appSecret: 'encrypted', defaultWorkspaceId: 'w', defaultChannelId: 'c', defaultModelId: 'm' }
    test('保存失败保草稿、重复在途写去重、成功保存保默认工作区/渠道/模型', async () => {
      let calls = 0; let written: unknown
      api({ [`get${kind}MultiConfig`]: async () => ({ bots: [bot] }), [`save${kind}BotConfig`]: async (input: unknown) => { written = input; if (++calls === 1) throw new Error('fixture'); return bot } })
      const parent = kind === 'DingTalk' ? mount(DingTalkSettings) : feishuConfig(); await tick(); parent.render()
      const card = child(parent, 'BotConfigCard'); await tick(); card.render()
      click(card.elements().find((item) => item.props['aria-expanded'] !== undefined)!.props); card.render()
      ;(card.field('Bot 名称').onChange as (value: string) => void)('New bot'); card.render()
      click(card.button('保存配置')); click(card.button('保存配置')); await tick(); card.render()
      expect(calls).toBe(1); expect(card.field('Bot 名称').value).toBe('New bot'); expect(feedback(card, '输入已保留')).toBeTruthy()
      click(card.button('保存配置')); await tick(); card.render()
      expect(written).toMatchObject({ name: 'New bot', defaultWorkspaceId: 'w', defaultChannelId: 'c', defaultModelId: 'm' })
    })
    test('Secret 读取失败不回退其他 Bot 的 Secret；删除 false 当作失败', async () => {
      let legacy = 0; let removes = 0
      api({ [`get${kind}MultiConfig`]: async () => ({ bots: [bot] }), [`getDecrypted${kind}BotSecret`]: fail, [`getDecrypted${kind}Secret`]: async () => { legacy += 1; return 'wrong' }, [`remove${kind}Bot`]: async () => { removes += 1; return false } })
      const parent = kind === 'DingTalk' ? mount(DingTalkSettings) : feishuConfig(); await tick(); parent.render()
      const card = child(parent, 'BotConfigCard'); await tick(); card.render()
      click(card.elements().find((item) => item.props['aria-expanded'] !== undefined)!.props); card.render()
      expect(legacy).toBe(0); expect(feedback(card, '无法读取此 Bot')).toBeTruthy()
      const confirmation = card.elements().find((item) => item.props.onClick && item.type !== 'button' && text(item) === '删除' && String(item.props.onClick).includes('preventDefault'))!
      click(confirmation.props); await tick(); card.render()
      expect(removes).toBe(1); expect(feedback(card, 'Bot 已保留')).toBeTruthy()
    })
    test('SSR 没有嵌套按钮且状态有文字，折叠面板键盘属性明确', async () => {
      api({ [`get${kind}MultiConfig`]: async () => ({ bots: [bot] }) })
      const parent = kind === 'DingTalk' ? mount(DingTalkSettings) : feishuConfig(); await tick(); parent.render()
      const element = parent.elements().find((item) => typeof item.type === 'function' && item.type.name === 'BotConfigCard')!
      const html = renderToStaticMarkup(element)
      expect(html).toContain('aria-expanded="false"'); expect(html).toContain('aria-controls='); expect(html).toContain('未连接')
      expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/)
    })
  })
}

describe('飞书镜像、绑定、CLI/MCP、注册', () => {
  test('镜像读取失败不显示关闭默认；写失败保持保存值并可重新选择', async () => {
    let reads = 0; let writes = 0
    api({ getSettings: async () => { if (++reads === 1) throw new Error('fixture'); return { feishuSessionMirror: { mode: 'stream', botId: 'b' } } }, updateSettings: async () => { if (++writes === 1) throw new Error('fixture') } })
    const parent = feishuConfig(); await tick(); parent.render()
    const host = child(parent, 'SessionMirrorSection'); await tick(); host.render()
    expect(host.elements().some((item) => item.props.onValueChange)).toBe(false)
    ;(feedback(host, '无法读取 Session').onRetry as () => void)(); await tick(); host.render()
    const select = () => host.elements().find((item) => item.props.onValueChange && item.props.value === 'stream')!.props
    ;(select().onValueChange as (value: string) => void)('off'); await tick(); host.render()
    expect(select().value).toBe('stream'); expect(feedback(host, '保留已保存值')).toBeTruthy()
    ;(select().onValueChange as (value: string) => void)('off'); await tick(); host.render()
    expect(host.elements().some((item) => item.props.onValueChange && item.props.value === 'off')).toBe(true)
  })
  test('绑定 false 更新/删除不会显示成功，也不删除本地记录', async () => {
    const binding = { chatId: 'chat', botId: 'b', userId: 'u', workspaceId: 'w', sessionId: 's', channelId: 'c', createdAt: 1 }
    api({ listFeishuBindings: async () => [binding], updateFeishuBinding: async () => null, removeFeishuBinding: async () => false })
    const host = child(mount(FeishuSettings), 'FeishuBindingsTab'); await tick(); host.render()
    const card = host.elements().find((item) => item.props.binding)!
    await (card.props.onUpdate as (id: string, patch: unknown) => Promise<void>)('chat', { workspaceId: 'new' }); await tick(); host.render()
    await (card.props.onRemove as (id: string) => Promise<void>)('chat'); await tick(); host.render()
    expect(store.get(feishuBindingsAtom)).toHaveLength(1); expect(errors.join(' ')).toContain('绑定已保留')
  })
  test('CLI 检测失败禁安装，隐藏的 MCP 不挂载、不读取凭据状态', async () => {
    let mcpReads = 0
    api({ refreshLarkCliStatus: fail, getLarkMcpStatus: async () => { mcpReads++; throw new Error('fixture') } })
    const parent = feishuConfig(); await tick(); parent.render()
    const cli = child(parent, 'LarkCloudCapabilitiesSection'); await tick(); cli.render()
    expect(feedback(cli, '无法检测')).toBeTruthy(); expect(cli.button('安装官方 CLI').disabled).toBe(true)
    expect(parent.elements().some((item) => typeof item.type === 'function' && item.type.name === 'LarkMcpSection')).toBe(false)
    expect(mcpReads).toBe(0)
  })
  test('注册持久化失败保留一次性凭据，重试保存而非重新扫码；过期可重新获取', async () => {
    let registered = 0; let saved = 0; let qr!: (value: { url: string; dataUrl: string; expireIn: number }) => void
    api({ registerFeishuApp: async () => { registered += 1; return { appId: 'fixture-app', appSecret: 'fixture-only-secret' } }, onFeishuRegisterQrcode: (listener: typeof qr) => { qr = listener; return () => {} } })
    const parent = feishuConfig(); await tick(); parent.render()
    const host = child(parent, 'RegisterFeishuDialog', { open: true, onOpenChange() {}, onSuccess: async () => { if (++saved === 1) throw new Error('fixture') } })
    await tick(); host.render()
    expect(host.button('重试保存')).toBeTruthy()
    click(host.button('重试保存')); await tick(); host.render()
    expect(saved).toBe(2); expect(registered).toBe(1)
    api({ registerFeishuApp: () => new Promise(() => {}), onFeishuRegisterQrcode: (listener: typeof qr) => { qr = listener; return () => {} } })
    const expired = child(parent, 'RegisterFeishuDialog', { open: true, onOpenChange() {}, onSuccess: async () => {} })
    qr({ url: 'https://fixture.invalid/qr', dataUrl: 'data:image/png;base64,fixture', expireIn: 1 }); expired.render()
    for (const callback of [...timers.values()]) callback()
    expired.render()
    expect(expired.button('重新获取二维码')).toBeTruthy()
    expect(expired.elements().some((item) => item.type === 'img')).toBe(false)
  })
})

for (const kind of ['DingTalk', 'Feishu'] as const) {
  test(`${kind} legacy 读取与解密兼容保留，解密期间新输入不被覆盖`, async () => {
    let legacy = 0; let resolve!: (secret: string) => void
    const config = kind === 'DingTalk' ? { enabled: true, clientId: 'legacy-app', clientSecret: 'encrypted' } : { enabled: true, appId: 'legacy-app', appSecret: 'encrypted' }
    api({ [`get${kind}MultiConfig`]: fail, [`get${kind}Config`]: async () => config, [`getDecrypted${kind}BotSecret`]: fail, [`getDecrypted${kind}Secret`]: () => { legacy += 1; return new Promise<string>((yes) => { resolve = yes }) } })
    const parent = kind === 'DingTalk' ? mount(DingTalkSettings) : feishuConfig(); await tick(); parent.render()
    const card = child(parent, 'BotConfigCard'); await tick(); card.render()
    click(card.elements().find((item) => item.props['aria-expanded'] !== undefined)!.props); card.render()
    const field = kind === 'DingTalk' ? 'Client Secret (AppSecret)' : 'App Secret'
    ;(card.field(field).onChange as (value: string) => void)('new-secret'); card.render()
    resolve('late-legacy-secret'); await tick(); card.render()
    expect(legacy).toBe(1); expect(card.field(field).value).toBe('new-secret')
  })
}

test('钉钉等待连接请求未返回时仍保留停止入口，飞书连接定时器随卸载清理', async () => {
  const bot = { id: 'fixture-bot', name: 'Fixture', enabled: true, clientId: 'fixture-app', clientSecret: 'encrypted' }
  let starts = 0
  api({ getDingTalkMultiConfig: async () => ({ bots: [bot] }), startDingTalkBot: () => { starts += 1; return new Promise(() => {}) } })
  const parent = mount(DingTalkSettings); await tick(); parent.render()
  const card = child(parent, 'BotConfigCard'); await tick(); card.render()
  click(card.button('启动')); await tick(); parent.render()
  const nextCard = child(parent, 'BotConfigCard'); await tick(); nextCard.render()
  expect(starts).toBe(1); expect(nextCard.button('停止').disabled).toBe(false)
  nextCard.dispose()
  const fbot = { id: 'f', name: 'Fixture', enabled: true, appId: 'app', appSecret: 'encrypted' }
  const state = { botId: 'f', botName: 'Fixture', status: 'connecting', activeBindings: 0 }
  api({ getFeishuMultiConfig: async () => ({ bots: [fbot] }) })
  const config = feishuConfig(); await tick(); config.render()
  // 临时 Bot props 的桥接状态只来自 mock，不会实际启动。
  const fb = child(config, 'BotConfigCard', { bot: fbot, state, onSaved() {}, onRemoved() {} })
  expect(timers.size).toBeGreaterThan(0)
  fb.dispose()
  expect(timers.size).toBe(0)
})
