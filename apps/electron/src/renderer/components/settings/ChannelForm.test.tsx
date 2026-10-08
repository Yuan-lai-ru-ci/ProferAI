import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import type { Channel, ChannelCreateInput, ChannelUpdateInput, FetchModelsResult } from '@profer/shared'
import { channelFormControllerAtom, channelFormDirtyAtom } from '../../atoms/settings-tab'

mock.module('../../lib/model-logo', () => ({ getProviderLogo: () => '' }))

// 无 DOM 的隔离 hook 宿主：运行真实表单的事件/控制器接线，所有 IPC 都由 fixture 截断。
interface HookSlot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface ReactInternals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: ReactInternals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const store = createStore()
mock.module('jotai', () => ({
  useSetAtom: (target: Parameters<typeof store.set>[0]) => (value: unknown) => store.set(target, value),
  atom,
}))
const { ChannelForm } = await import('./ChannelForm')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const fixture: Channel = {
  id: 'fixture-channel', name: 'Fixture', provider: 'openai', baseUrl: 'https://fixture.invalid/v1',
  apiKey: 'encrypted-fixture', enabled: true, agentRuntimes: ['pi'],
  models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true, source: 'manual' }],
  createdAt: 1, updatedAt: 1,
}

function mount(channel: Channel | null = fixture, overrides: Record<string, unknown> = {}) {
  const updates: ChannelUpdateInput[] = []
  const creates: ChannelCreateInput[] = []
  const saved: Channel[] = []
  const slots: HookSlot[] = []
  let index = 0
  let changed = false
  let effects: Array<() => void> = []
  let tree: React.ReactElement
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
        if (!Object.is(slot.value, value)) { slot.value = value; changed = true }
      }]
    },
    useRef<T>(value: T) { return useMemo(() => ({ current: value }), []) },
    useMemo,
    useCallback<T>(callback: T, deps: readonly unknown[]) { return useMemo(() => callback, deps) },
    useEffect,
    useLayoutEffect: useEffect,
  }
  const api = {
    decryptApiKey: async () => 'fixture-key',
    updateChannel: async (_id: string, patch: ChannelUpdateInput) => { updates.push(patch); return { ...fixture, ...patch } },
    createChannel: async (input: ChannelCreateInput) => { creates.push(input); return { ...fixture, ...input } },
    fetchModels: async () => ({ success: true, message: 'fixture-discovery', models: [] }),
    testChannelDirect: async () => ({ success: true, message: 'fixture-test' }),
    cancelChannelRequest: async () => {},
    listCodexModels: async () => [{ id: 'gpt-6-astra', name: 'Fixture Astra', enabled: false, source: 'fetched' }],
    loginCodexOAuth: async () => ({ ...fixture, provider: 'openai-codex' }),
    cancelCodexOAuthLogin: async () => {},
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: api, addEventListener() {}, removeEventListener() {} } })
  const render = () => {
    let rounds = 0
    do {
      if (++rounds > 30) throw new Error('hook update loop')
      changed = false
      index = 0
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { tree = ChannelForm({ channel, onSaved: (next) => { if (next) saved.push(next); else saved.push(fixture) }, onCancel() {} }) }
      finally { internals.ReactCurrentDispatcher.current = previous }
      const pending = effects
      effects = []
      for (const effect of pending) effect()
    } while (changed)
  }
  const elements = (): React.ReactElement<Record<string, unknown>>[] => {
    const result: React.ReactElement<Record<string, unknown>>[] = []
    const visit = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      result.push(node)
      visit(node.props.children)
      visit(node.props.action)
    }
    visit(tree)
    return result
  }
  const field = (label: string) => elements().find((element) => element.props.label === label)!.props
  const click = (label: string) => {
    const element = elements().find((item) => item.props['aria-label'] === label)
    return (element!.props.onClick as () => Promise<void>)()
  }
  render()
  return { render, elements, field, click, updates, creates, saved, dispose() { slots.forEach((slot) => slot.cleanup?.()) } }
}

const mounted: Array<ReturnType<typeof mount>> = []
const setup = (...args: Parameters<typeof mount>) => { const result = mount(...args); mounted.push(result); return result }
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
afterEach(() => { mounted.splice(0).forEach((form) => form.dispose()); store.set(channelFormDirtyAtom, false); store.set(channelFormControllerAtom, null) })

describe('ChannelForm 真实事件与退出控制器接线（隔离 hook 宿主）', () => {
  function newCodexForm(overrides: Record<string, unknown> = {}) {
    const form = setup(null, overrides)
    ;(form.field('供应商类型').onValueChange as (value: string) => void)('openai-codex')
    form.render()
    return form
  }
  function selectAstra(form: ReturnType<typeof mount>) {
    const row = form.elements().find((element) => element.key === 'gpt-6-astra' && typeof element.props.onClick === 'function')!
    ;(row.props.onClick as () => void)()
    form.render()
  }
  function button(form: ReturnType<typeof mount>, label: string) {
    return form.elements().find((element) => typeof element.props.onClick === 'function' && JSON.stringify(element.props.children)?.includes(label))!
  }

  test('xAI OAuth 新建读取本地目录，取消失败无普通 create，重试与重复点击只创建一次', async () => {
    const pending = deferred<Channel>()
    let attempts = 0
    let cancels = 0
    const inputs: unknown[] = []
    const form = setup(null, {
      listXaiModels: async () => [{ id: 'fixture-grok', name: 'Fixture Grok', enabled: false, source: 'fetched' }],
      loginXaiOAuth: (input: unknown) => {
        inputs.push(input)
        return ++attempts === 1 ? pending.promise : Promise.resolve({ ...fixture, provider: 'xai', credentialMode: 'oauth' })
      },
      cancelXaiOAuthLogin: async () => { cancels += 1; pending.reject(new Error('fixture-xai-cancelled')) },
    })
    ;(form.field('供应商类型').onValueChange as (value: string) => void)('xai')
    form.render()
    ;(form.field('xAI 认证方式').onValueChange as (value: string) => void)('oauth')
    form.render()
    await tick(); form.render()
    const row = form.elements().find((element) => element.key === 'fixture-grok' && typeof element.props.onClick === 'function')!
    ;(row.props.onClick as () => void)()
    ;(form.field('Pi 模式').onCheckedChange as (value: boolean) => void)(true)
    form.render()
    expect(form.field('Claude 模式').disabled).toBe(true)
    expect(form.elements().some((element) => element.props.id === 'channel-api-key')).toBe(false)
    const controller = store.get(channelFormControllerAtom)!
    const first = controller.flush()
    const duplicate = controller.flush()
    form.render()
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ agentRuntimes: ['pi'], agentExperimentalEnabled: true })
    expect(inputs[0]).not.toHaveProperty('apiKey')
    expect(inputs[0]).not.toHaveProperty('provider')
    expect(form.creates).toHaveLength(0)
    await (button(form, '取消授权').props.onClick as () => Promise<void>)()
    expect(await first).toBe(false)
    expect(await duplicate).toBe(false)
    form.render()
    expect(cancels).toBe(1)
    expect(form.elements().some((element) => element.props.role === 'alert' && element.props.children === 'fixture-xai-cancelled')).toBe(true)
    const retryController = store.get(channelFormControllerAtom)!
    expect(await retryController.flush()).toBe(true)
    expect(await retryController.flush()).toBe(true)
    expect(inputs).toHaveLength(2)
    expect(form.creates).toHaveLength(0)
  })

  test('xAI 显式 runtime 优先于旧实验值；Pi 开关落盘同步双字段', async () => {
    const form = setup({ ...fixture, provider: 'xai', credentialMode: 'api-key', agentExperimentalEnabled: false, agentRuntimes: ['pi'] })
    expect(form.field('Pi 模式').checked).toBe(true)
    expect(form.field('Claude 模式').disabled).toBe(true)
    ;(form.field('Pi 模式').onCheckedChange as (value: boolean) => void)(false)
    form.render()
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    expect(form.updates[0]).toMatchObject({ agentRuntimes: [], agentExperimentalEnabled: false })
    ;(form.field('Pi 模式').onCheckedChange as (value: boolean) => void)(true)
    form.render()
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    expect(form.updates[1]).toMatchObject({ agentRuntimes: ['pi'], agentExperimentalEnabled: true })
  })

  test('新建 Codex 读取本地目录、无需 Key/端点；重复保存只发一次授权 IPC', async () => {
    const authorized = deferred<Channel>()
    const inputs: unknown[] = []
    const form = newCodexForm({ loginCodexOAuth: (input: unknown) => { inputs.push(input); return authorized.promise } })
    await tick(); form.render()
    selectAstra(form)
    expect(form.elements().some((element) => element.props.id === 'channel-api-key')).toBe(false)
    expect(button(form, '登录并创建').props.disabled).toBe(false)
    const controller = store.get(channelFormControllerAtom)!
    const first = controller.flush()
    const second = controller.flush()
    form.render()
    expect(store.get(channelFormControllerAtom)!.busy).toBe(true)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ baseUrl: '', name: 'ChatGPT 订阅 (Codex)', models: [{ id: 'gpt-6-astra', enabled: true }] })
    expect(inputs[0]).not.toHaveProperty('apiKey')
    expect(inputs[0]).not.toHaveProperty('provider')
    expect(form.creates).toHaveLength(0)
    authorized.resolve({ ...fixture, provider: 'openai-codex' })
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(await controller.flush()).toBe(true)
    expect(inputs).toHaveLength(1)
  })

  test('新建 Codex 授权失败/取消不调用普通 create；保留表单后可重试', async () => {
    const pending = deferred<Channel>()
    let attempts = 0
    let cancellations = 0
    const form = newCodexForm({
      loginCodexOAuth: () => ++attempts === 1 ? pending.promise : Promise.resolve({ ...fixture, provider: 'openai-codex' }),
      cancelCodexOAuthLogin: async () => { cancellations += 1; pending.reject(new Error('fixture-login-cancelled')) },
    })
    await tick(); form.render(); selectAstra(form)
    const first = store.get(channelFormControllerAtom)!.flush()
    form.render()
    await (button(form, '取消授权').props.onClick as () => Promise<void>)()
    expect(await first).toBe(false)
    form.render()
    expect(cancellations).toBe(1)
    expect(form.creates).toHaveLength(0)
    expect(form.elements().some((element) => element.props.role === 'alert' && element.props.children === 'fixture-login-cancelled')).toBe(true)
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    expect(attempts).toBe(2)
    expect(form.creates).toHaveLength(0)
  })

  test('已有 Codex 重新授权使用渠道 ID，取消后仍可重新授权且不更新普通 Key', async () => {
    const pending = deferred<Channel>()
    const ids: string[] = []
    const form = setup({ ...fixture, provider: 'openai-codex' }, {
      loginCodexOAuth: (id: string) => { ids.push(id); return ids.length === 1 ? pending.promise : Promise.resolve({ ...fixture, provider: 'openai-codex' }) },
      cancelCodexOAuthLogin: async () => { pending.reject(new Error('fixture-reauth-cancelled')) },
    })
    const first = (button(form, '重新授权 ChatGPT').props.onClick as () => Promise<void>)()
    form.render()
    await (button(form, '取消授权').props.onClick as () => Promise<void>)()
    await first; form.render()
    await (button(form, '重新授权 ChatGPT').props.onClick as () => Promise<void>)()
    expect(ids).toEqual([fixture.id, fixture.id])
    expect(form.updates.every((patch) => patch.apiKey === undefined)).toBe(true)
    expect(form.creates).toHaveLength(0)
  })

  test('Codex 目录失败提供显式重试且不清空已有模型', async () => {
    let calls = 0
    const form = setup({ ...fixture, provider: 'openai-codex' }, { listCodexModels: async () => { if (++calls === 1) throw new Error('fixture-catalog-failure'); return [] } })
    await tick(); form.render()
    expect(JSON.stringify(form.elements().map((element) => element.props.children))).toContain('Codex 模型目录读取失败')
    await (button(form, '读取 Codex 目录').props.onClick as () => Promise<void>)()
    form.render()
    expect(calls).toBe(2)
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    expect(form.updates.every((patch) => !patch.models || patch.models.some((model) => model.id === 'fixture-model'))).toBe(true)
  })

  for (const oldFirst of [true, false]) {
    test(`配置 A/B 发现${oldFirst ? '旧先回' : '新先回'}时只保存新配置的模型`, async () => {
      const old = deferred<FetchModelsResult>()
      const current = deferred<FetchModelsResult>()
      const form = setup(fixture, { fetchModels: (input: { baseUrl: string }) => input.baseUrl === fixture.baseUrl ? old.promise : current.promise })
      await tick(); form.render()
      const fetchButton = () => form.elements().find((element) => typeof element.props.onClick === 'function' && JSON.stringify(element.props.children)?.includes('从供应商获取'))!
      ;(fetchButton().props.onClick as () => void)()
      ;(form.field('OpenAI 端点').onChange as (value: string) => void)('https://new-fixture.invalid/v1')
      form.render()
      ;(fetchButton().props.onClick as () => void)()
      const stale: FetchModelsResult = { success: true, message: 'stale-discovery', models: [{ id: 'stale-model', name: 'Stale', enabled: true }] }
      const fresh: FetchModelsResult = { success: true, message: 'current-discovery', models: [{ id: 'current-model', name: 'Current', enabled: true }] }
      if (oldFirst) {
        old.resolve(stale); await tick(); form.render()
        current.resolve(fresh)
      } else {
        current.resolve(fresh); await tick(); form.render()
        old.resolve(stale)
      }
      await tick(); form.render()
      expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
      expect(form.updates[0]?.models?.map((model) => model.id)).toContain('current-model')
      expect(form.updates[0]?.models?.map((model) => model.id)).not.toContain('stale-model')
      expect(form.updates[0]?.baseUrl).toBe('https://new-fixture.invalid/v1')
    })
  }

  test('API Key 切 OAuth 但未授权时保持 dirty，离开保存不伪称成功', async () => {
    const form = setup({ ...fixture, provider: 'xai', credentialMode: 'api-key' })
    await tick(); form.render()
    ;(form.field('xAI 认证方式').onValueChange as (value: string) => void)('oauth')
    form.render()
    expect(store.get(channelFormDirtyAtom)).toBe(true)
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(false)
    expect(form.updates).toHaveLength(0)
  })

  test('600ms 防抖定时自动保存最新草稿，不在挂载/解密时写入', async () => {
    const form = setup()
    await tick(); form.render()
    expect(form.updates).toEqual([])
    ;(form.field('供应商名称').onChange as (value: string) => void)('Debounced')
    form.render()
    await new Promise<void>((resolve) => setTimeout(resolve, 650))
    form.render()
    expect(form.updates).toEqual([{ name: 'Debounced' }])
    expect(store.get(channelFormDirtyAtom)).toBe(false)
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    expect(form.updates).toHaveLength(1)
  })

  test('明确丢弃取消未发送防抖草稿，卸载不会另发保存', async () => {
    const form = setup()
    ;(form.field('供应商名称').onChange as (value: string) => void)('Discard me')
    form.render()
    expect(store.get(channelFormDirtyAtom)).toBe(true)
    await store.get(channelFormControllerAtom)!.discard()
    form.dispose()
    await tick()
    expect(form.updates).toHaveLength(0)
  })

  test('主动替换 Key 后只改名称不再次重传该 Key', async () => {
    const form = setup()
    await tick(); form.render()
    const input = form.elements().find((element) => element.props.id === 'channel-api-key')!
    ;(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'replacement-fixture-key' } })
    form.render()
    await store.get(channelFormControllerAtom)!.flush()
    form.render()
    ;(form.field('供应商名称').onChange as (value: string) => void)('After replacement')
    form.render()
    await store.get(channelFormControllerAtom)!.flush()
    form.render()
    expect(form.updates).toEqual([{ apiKey: 'replacement-fixture-key' }, { name: 'After replacement' }])
  })

  test('防抖到期前立即返回会等待最新草稿 IPC，普通字段不回传未修改 Key', async () => {
    const response = deferred<Channel>()
    const patches: ChannelUpdateInput[] = []
    const form = setup(fixture, { updateChannel: (_id: string, patch: ChannelUpdateInput) => { patches.push(patch); return response.promise } })
    await tick(); form.render()
    ;(form.field('供应商名称').onChange as (value: string) => void)('Latest')
    form.render()
    expect(store.get(channelFormDirtyAtom)).toBe(true)
    const back = form.click('返回渠道列表')
    expect(form.saved).toHaveLength(0)
    expect(patches).toEqual([{ name: 'Latest' }])
    response.resolve({ ...fixture, name: 'Latest' })
    await back; form.render()
    expect(form.saved).toHaveLength(1)
    expect(store.get(channelFormDirtyAtom)).toBe(false)
  })

  test('失败保留 dirty，设置退出控制器可重试并等待成功', async () => {
    let attempts = 0
    const form = setup(fixture, { updateChannel: async (_id: string, patch: ChannelUpdateInput) => { if (++attempts === 1) throw new Error('fixture-save-failure'); return { ...fixture, ...patch } } })
    ;(form.field('供应商名称').onChange as (value: string) => void)('Retry')
    form.render()
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(false)
    form.render()
    expect(store.get(channelFormDirtyAtom)).toBe(true)
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    form.render()
    expect(store.get(channelFormDirtyAtom)).toBe(false)
    expect(attempts).toBe(2)
  })

  test('慢解密不会覆盖新输入；初始化期间普通字段修改也能保存', async () => {
    const key = deferred<string>()
    const form = setup(fixture, { decryptApiKey: () => key.promise })
    const input = form.elements().find((element) => element.props.id === 'channel-api-key')!
    ;(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'new-fixture-key' } })
    ;(form.field('供应商名称').onChange as (value: string) => void)('Before-load')
    form.render()
    key.resolve('old-fixture-key'); await tick(); form.render()
    expect(form.elements().find((element) => element.props.id === 'channel-api-key')!.props.value).toBe('new-fixture-key')
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    expect(form.updates).toEqual([{ name: 'Before-load', apiKey: 'new-fixture-key' }])
  })

  test('Codex OAuth 不解密、不进入普通 Key 框、不随名称更新回传', async () => {
    let decrypts = 0
    const form = setup({ ...fixture, provider: 'openai-codex' }, { decryptApiKey: async () => { decrypts += 1; return 'fixture-oauth-json' } })
    expect(decrypts).toBe(0)
    expect(form.elements().some((element) => element.props.id === 'channel-api-key')).toBe(false)
    ;(form.field('供应商名称').onChange as (value: string) => void)('Rename-oauth')
    form.render()
    await store.get(channelFormControllerAtom)!.flush()
    expect(form.updates).toEqual([{ name: 'Rename-oauth' }])
  })

  test('切供应商清 Key，旧模型发现和测试结果不会污染新配置', async () => {
    const discovery = deferred<FetchModelsResult>()
    const connection = deferred<{ success: boolean; message: string }>()
    const form = setup(fixture, { fetchModels: () => discovery.promise, testChannelDirect: () => connection.promise })
    await tick(); form.render()
    const discoveryButton = form.elements().find((element) => typeof element.props.onClick === 'function' && JSON.stringify(element.props.children)?.includes('从供应商获取'))!
    ;(discoveryButton.props.onClick as () => void)()
    const testButton = form.elements().find((element) => typeof element.props.onClick === 'function' && JSON.stringify(element.props.children)?.includes('测试连接'))!
    const testRequest = (testButton.props.onClick as () => Promise<void>)()
    ;(form.field('供应商类型').onValueChange as (value: string) => void)('google')
    form.render()
    discovery.resolve({ success: true, message: 'stale-discovery', models: [{ id: 'stale-model', name: 'Stale', enabled: true }] })
    connection.resolve({ success: true, message: 'stale-test' })
    await testRequest; await tick(); form.render()
    expect(form.elements().find((element) => element.props.id === 'channel-api-key')!.props.value).toBe('')
    expect(JSON.stringify(form.elements().map((element) => element.props.children))).not.toContain('stale-')
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(false)
    expect(form.updates).toHaveLength(0)
  })

  test('所有创建入口共用模型校验，最后只切内核时 payload 使用当前勾选', async () => {
    const form = setup(null)
    ;(form.field('供应商名称').onChange as (value: string) => void)('Create')
    const keyInput = form.elements().find((element) => element.props.id === 'channel-api-key')!
    ;(keyInput.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'fixture-key' } })
    form.render()
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(false)
    expect(form.creates).toHaveLength(0)
    const modelInput = form.elements().find((element) => String(element.props.placeholder).startsWith('模型 ID'))!
    ;(modelInput.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'fixture-model' } })
    form.render()
    const add = form.elements().find((element) => element.props.disabled === false && element.props.className === 'h-8 w-8 flex-shrink-0')!
    ;(add.props.onClick as () => void)()
    form.render()
    ;(form.field('Claude 模式').onCheckedChange as (value: boolean) => void)(false)
    ;(form.field('Pi 模式').onCheckedChange as (value: boolean) => void)(false)
    form.render()
    expect(await store.get(channelFormControllerAtom)!.flush()).toBe(true)
    expect(form.creates[0]!.agentRuntimes).toEqual([])
  })

  test('F14：双内核独立 ID，主动取消晚到成功不污染，可重试', async () => {
    const pending = deferred<{ success: boolean; message: string }>()
    const requests: Array<{ requestId: string; runtime: string }> = []
    const cancellations: string[] = []
    let retry = false
    const form = setup({ ...fixture, agentRuntimes: ['pi', 'claude'] }, {
      testChannelDirect: (input: { requestId: string; runtime: string }) => {
        requests.push(input)
        return retry ? Promise.resolve({ success: true, message: 'fixture-retry' }) : pending.promise
      },
      cancelChannelRequest: async (id: string) => { cancellations.push(id) },
    })
    await tick(); form.render()
    const first = (button(form, '测试连接').props.onClick as () => Promise<void>)()
    form.render()
    expect(requests.map((request) => request.runtime)).toEqual(['pi', 'claude'])
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(2)
    ;(button(form, '取消测试').props.onClick as () => void)()
    form.render()
    expect(cancellations).toEqual(requests.map((request) => request.requestId))
    pending.resolve({ success: true, message: 'late-fixture' })
    await first; form.render()
    expect(form.elements().some((element) => element.props.children === 'late-fixture')).toBe(false)
    expect(form.elements().some((element) => element.props.children === '测试已取消')).toBe(true)
    retry = true
    await (button(form, '测试连接').props.onClick as () => Promise<void>)()
    form.render()
    expect(requests).toHaveLength(4)
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(4)
  })

  test.each(['endpoint', 'credential', 'model', 'runtime', 'agentEndpoint', 'discard', 'unmount'])('F14：测试挂起时 %s 主动取消', async (change) => {
    const pending = deferred<{ success: boolean; message: string }>()
    const ids: string[] = []
    const cancellations: string[] = []
    const form = setup({ ...fixture, agentRuntimes: ['pi', 'claude'] }, {
      testChannelDirect: (input: { requestId: string }) => { ids.push(input.requestId); return pending.promise },
      cancelChannelRequest: async (id: string) => { cancellations.push(id) },
    })
    await tick(); form.render()
    const first = (button(form, '测试连接').props.onClick as () => Promise<void>)()
    form.render()
    if (change === 'endpoint') (form.field('OpenAI 端点').onChange as (value: string) => void)('https://next.invalid/v1')
    if (change === 'credential') {
      const key = form.elements().find((element) => element.props.id === 'channel-api-key')!
      ;(key.props.onChange as (event: unknown) => void)({ target: { value: 'next-fixture-key' } })
    }
    if (change === 'model') {
      const row = form.elements().find((element) => element.props.title === '取消启用')!
      ;(row.props.onClick as () => void)()
    }
    if (change === 'runtime') (form.field('Pi 模式').onCheckedChange as (value: boolean) => void)(false)
    if (change === 'agentEndpoint') (form.field('Anthropic 端点').onChange as (value: string) => void)('https://next.invalid/anthropic')
    if (change === 'discard') await store.get(channelFormControllerAtom)!.discard()
    if (change === 'unmount') form.dispose()
    else form.render()
    expect(cancellations).toEqual(ids)
    expect(ids).toHaveLength(2)
    pending.resolve({ success: true, message: 'late-fixture' })
    await first
    if (change !== 'unmount') {
      form.render()
      expect(form.elements().some((element) => element.props.children === 'late-fixture')).toBe(false)
    }
  })

  test('F14：发现取消/重试/卸载发送当前 ID，旧响应保留手工模型', async () => {
    const pending = deferred<FetchModelsResult>()
    const requests: string[] = []
    const cancellations: string[] = []
    const form = setup(fixture, {
      fetchModels: (input: { requestId: string }) => { requests.push(input.requestId); return pending.promise },
      cancelChannelRequest: async (id: string) => { cancellations.push(id) },
    })
    await tick(); form.render()
    const first = (button(form, '从供应商获取').props.onClick as () => Promise<void>)()
    form.render()
    ;(button(form, '取消获取').props.onClick as () => void)()
    form.render()
    expect(cancellations).toEqual(requests)
    pending.resolve({ success: true, message: 'late-fixture', models: [{ id: 'late-model', name: 'Late', enabled: true }] })
    await first; form.render()
    expect(form.elements().some((element) => element.key === 'late-model')).toBe(false)
    expect(form.elements().some((element) => element.key === 'fixture-model')).toBe(true)
    const second = (button(form, '从供应商获取').props.onClick as () => Promise<void>)()
    form.render(); form.dispose()
    await second
    expect(requests).toHaveLength(2)
    expect(new Set(requests).size).toBe(2)
    expect(cancellations).toEqual(requests)
  })

  test('F14：一条测试 IPC 异常会取消另一条挂起测试，旧轮清理不影响新轮', async () => {
    const pending = deferred<{ success: boolean; message: string }>()
    const requests: string[] = []
    const cancellations: string[] = []
    const form = setup({ ...fixture, agentRuntimes: ['pi', 'claude'] }, {
      testChannelDirect: (input: { requestId: string; runtime: string }) => {
        requests.push(input.requestId)
        return input.runtime === 'pi' ? Promise.reject(new Error('fixture-ipc-failure')) : pending.promise
      },
      cancelChannelRequest: async (id: string) => { cancellations.push(id) },
    })
    await tick(); form.render()
    await (button(form, '测试连接').props.onClick as () => Promise<void>)()
    form.render()
    expect(cancellations).toEqual(requests)
    expect(form.elements().some((element) => element.props.children === '测试请求失败')).toBe(true)
    pending.resolve({ success: true, message: 'late-fixture' })
    await tick(); form.render()
    expect(form.elements().some((element) => element.props.children === 'late-fixture')).toBe(false)
  })

  test('F20：纯 Chat 配置不把直接 URL 测试伪装成 Pi SDK 测试', async () => {
    const requests: Array<{ runtime?: string; baseUrl: string; requestId: string }> = []
    const form = setup({ ...fixture, agentRuntimes: [], baseUrl: 'https://fixture.invalid/v1?route=fixture' }, {
      testChannelDirect: async (input: { runtime?: string; baseUrl: string; requestId: string }) => { requests.push(input); return { success: true, message: 'fixture-chat' } },
    })
    await tick(); form.render()
    await (button(form, '测试连接').props.onClick as () => Promise<void>)()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.runtime).toBeUndefined()
    expect(requests[0]!.baseUrl).toContain('?route=fixture')
    expect(requests[0]!.requestId).toMatch(/-chat$/)
  })
})
