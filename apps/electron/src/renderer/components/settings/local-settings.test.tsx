import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

// 隔离 hook 宿主运行真实页面事件；API 全为内存 fixture，不访问用户配置或服务。
const store = createStore()
type AtomTarget = Parameters<typeof store.get>[0]
type WritableTarget = Parameters<typeof store.set>[0]
const setters = new Map<WritableTarget, (value: unknown) => void>()
const setterFor = (target: WritableTarget) => {
  let setter = setters.get(target)
  if (!setter) {
    setter = (value: unknown) => { store.set(target, value) }
    setters.set(target, setter)
  }
  return setter
}
mock.module('jotai', () => ({
  atom,
  useAtom: (target: WritableTarget) => [store.get(target), setterFor(target)],
  useAtomValue: (target: AtomTarget) => store.get(target),
  useSetAtom: setterFor,
  useStore: () => store,
}))
const errors: string[] = []
mock.module('sonner', () => ({ toast: { error: (message: string) => errors.push(message), success() {}, warning() {} } }))
const promptAutosaveFixture = Object.assign(() => {}, {
  flush: async () => {},
  remove: async (id: string) => {
    await window.electronAPI.deleteSystemPrompt(id)
    store.set(promptConfigAtom, (previous) => ({
      ...previous,
      prompts: previous.prompts.filter((prompt) => prompt.id !== id),
      defaultPromptId: previous.defaultPromptId === id ? 'builtin-default' : previous.defaultPromptId,
    }))
    if (store.get(selectedPromptIdAtom) === id) store.set(selectedPromptIdAtom, 'builtin-default')
  },
})
mock.module('../../hooks/useSystemPromptAutosave', () => ({
  promptSaveStateAtom: atom('saved'),
  promptDeletingIdsAtom: atom<readonly string[]>([]),
  useSystemPromptAutosave: () => promptAutosaveFixture,
}))
mock.module('../auth/LoginDialog', () => ({ LoginDialog: () => null }))
mock.module('./DevicesSettings', () => ({ DevicesSettings: () => null }))
mock.module('./VoiceInputSettings', () => ({ VoiceInputSettings: () => null }))
mock.module('@emoji-mart/react', () => ({ default: () => null }))

const { AccountSettings } = await import('./AccountSettings')
const { PromptSettings } = await import('./PromptSettings')
const { ToolSettings } = await import('./ToolSettings')
const { UsageSettings } = await import('./UsageSettings')
const { userProfileAtom } = await import('../../atoms/user-profile')
const { authStatusAtom } = await import('../../atoms/identity-atoms')
const { promptConfigAtom, selectedPromptIdAtom } = await import('../../atoms/system-prompt-atoms')
const { composerCompactModeAtom } = await import('../../atoms/ui-preferences')
const { customNotificationSoundsAtom, notificationSoundsAtom } = await import('../../atoms/notifications')
const { chatToolsAtom } = await import('../../atoms/chat-tool-atoms')

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
function api(overrides: Props = {}) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    innerHeight: 800, addEventListener() {}, removeEventListener() {},
    electronAPI: {
      getSettings: async () => ({ archiveAfterDays: 7, inputCompactViewportHeight: 700, inputCompactMinHeight: 60, inputCompactMaxHeight: 140 }),
      getSystemPromptConfig: async () => store.get(promptConfigAtom),
      getChatTools: async () => [], getChatToolCredentials: async () => ({}),
      updateChatToolCredentials: async () => {}, updateChatToolState: async () => {}, updateSettings: async () => {},
      testChatTool: async () => ({ success: true, message: 'fixture test' }),
      ...overrides,
    },
  } })
}
function toolComponent(name: string): () => React.ReactElement | null {
  return elements(ToolSettings()).find((item) => typeof item.type === 'function' && item.type.name === name)!.type as () => React.ReactElement | null
}
function input(host: ReturnType<typeof mount>, id?: string): Props {
  return host.elements().find((item) => item.props.onChange && (id ? item.props.id === id : item.type === 'input' && item.props.type === 'text'))!.props
}
const click = (props: Props) => (props.onClick as (event: { preventDefault: () => void }) => unknown)({ preventDefault() {} })
afterEach(() => {
  hosts.splice(0).forEach((host) => host.dispose())
  errors.length = 0
})

describe('AccountSettings 真实事件（mock IPC）', () => {
test('账户刷新失效清除旧显示；退出失败以重新读取的状态为准', async () => {
  store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'fixture-account', teamEmail: 'fixture@invalid' })
  api({ auth: { getAuthStatus: async () => ({ isLoggedIn: false }) } })
  const first = mount(AccountSettings)
  click(first.button('刷新')); await tick(); first.render()
  expect(store.get(authStatusAtom).isLoggedIn).toBe(false)
  first.dispose()
  store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'fixture-account' })
  let logouts = 0
  let reject!: (reason: Error) => void
  api({ auth: {
    logout: () => { logouts++; return new Promise((_resolve, no) => { reject = no }) },
    getAuthStatus: async () => ({ isLoggedIn: true, teamAccountId: 'fixture-account' }),
  } })
  const second = mount(AccountSettings)
  click(second.button('退出登录')); click(second.button('退出登录'))
  expect(logouts).toBe(1)
  reject(new Error('fixture failure')); await tick(); second.render()
  expect(store.get(authStatusAtom).isLoggedIn).toBe(true)
  expect(errors.some((message) => message.includes('退出登录未能完成'))).toBe(true)
})

test('不支持格式或超过5MB的头像在文件读取前被拒绝', () => {
  api()
  const host = mount(AccountSettings)
  const upload = host.elements().find((item) => item.props.type === 'file')!.props.onChange as (event: unknown) => void
  upload({ target: { files: [{ type: 'image/svg+xml', size: 10 }], value: 'fixture' } })
  expect(errors.at(-1)).toContain('PNG')
  upload({ target: { files: [{ type: 'image/png', size: 6 * 1024 * 1024 }], value: 'fixture' } })
  expect(errors.at(-1)).toContain('5MB')
})
  test('用户名失败保留原资料与草稿，Enter 可重试；Enter/blur 不重复在途保存', async () => {
    store.set(userProfileAtom, { userName: 'Fixture', avatar: 'F' })
    store.set(authStatusAtom, { isLoggedIn: false })
    let calls = 0
    let reject!: (reason: Error) => void
    api({ updateUserProfile: async (patch: { userName: string }) => {
      calls += 1
      if (calls === 1) return new Promise((_resolve, no) => { reject = no })
      return { userName: patch.userName, avatar: 'F' }
    } })
    const host = mount(AccountSettings)
    click(host.button('Fixture')); host.render()
    ;(input(host).onChange as (event: unknown) => void)({ target: { value: 'Retry name' } }); host.render()
    ;(input(host).onKeyDown as (event: unknown) => void)({ key: 'Enter' })
    ;(input(host).onBlur as () => void)()
    expect(calls).toBe(1)
    reject(new Error('fixture failure')); await tick(); host.render()
    expect(store.get(userProfileAtom).userName).toBe('Fixture')
    expect(input(host).value).toBe('Retry name')
    expect(errors.at(-1)).toContain('输入已保留')
    ;(input(host).onKeyDown as (event: unknown) => void)({ key: 'Enter' })
    await tick(); host.render()
    expect(store.get(userProfileAtom).userName).toBe('Retry name')
    expect(host.elements().some((item) => item.type === 'input' && item.props.type === 'text')).toBe(false)
  })
  test('头像失败保持原头像与选择器，给出 toast；空用户名不提交', async () => {
    store.set(userProfileAtom, { userName: 'Fixture', avatar: 'F' })
    api({ updateUserProfile: fail })
    const host = mount(AccountSettings)
    const picker = host.elements().find((item) => item.props.onEmojiSelect)!
    ;(picker.props.onEmojiSelect as (emoji: unknown) => void)({ native: 'N' })
    await tick(); host.render()
    expect(store.get(userProfileAtom).avatar).toBe('F')
    expect(errors.at(-1)).toContain('头像保存失败')
    click(host.button('Fixture')); host.render()
    ;(input(host).onChange as (event: unknown) => void)({ target: { value: ' ' } }); host.render()
    ;(input(host).onBlur as () => void)(); await tick()
    expect(errors.at(-1)).toContain('不能为空')
    const label = host.elements().find((item) => item.type === 'label')!
    expect(label.props.htmlFor).toBe(input(host).id)
  })
})

describe('PromptSettings 删除确认', () => {
  test('请求删除只开确认，失败保留列表/默认/选择，重试成功才删除', async () => {
    const prompt = { id: 'fixture-prompt', name: 'Fixture prompt', content: 'fixture', isBuiltin: false, createdAt: 1, updatedAt: 1 }
    store.set(promptConfigAtom, { prompts: [prompt], defaultPromptId: prompt.id, appendDateTimeAndUserName: true })
    store.set(selectedPromptIdAtom, prompt.id)
    let deletes = 0
    api({ deleteSystemPrompt: async () => { deletes += 1; if (deletes === 1) throw new Error('fixture failure') } })
    const host = mount(PromptSettings); await tick(); host.render()
    const row = host.elements().find((item) => item.props.prompt === prompt)!
    ;(row.props.onDelete as (id: string) => void)(prompt.id); host.render()
    expect(deletes).toBe(0)
    click(host.button('删除提示词')); await tick(); host.render()
    expect(store.get(promptConfigAtom).prompts).toHaveLength(1)
    expect(store.get(selectedPromptIdAtom)).toBe(prompt.id)
    expect(errors.at(-1)).toContain('内容已保留')
    click(host.button('删除提示词')); await tick(); host.render()
    expect(deletes).toBe(2)
    expect(store.get(promptConfigAtom).prompts).toHaveLength(0)
    expect(store.get(promptConfigAtom).defaultPromptId).toBe('builtin-default')
    expect(store.get(selectedPromptIdAtom)).toBe('builtin-default')
  })
  test('提示词名称和内容标签各自绑定实际编辑框', async () => {
    const prompt = { id: 'fixture-prompt', name: 'Fixture', content: '', isBuiltin: false, createdAt: 1, updatedAt: 1 }
    store.set(promptConfigAtom, { prompts: [prompt], defaultPromptId: prompt.id, appendDateTimeAndUserName: true })
    store.set(selectedPromptIdAtom, prompt.id); api()
    const host = mount(PromptSettings)
    for (const label of host.elements().filter((item) => item.type === 'label')) {
      expect(host.elements().some((item) => item.props.id === label.props.htmlFor && item.props.onChange)).toBe(true)
    }
  })
})

describe('ToolSettings 保存失败停止测试', () => {
  for (const name of ['WebSearchSettings', 'GptImageSettings']) {
    test(`${name} 加载失败不显示假默认凭据，成功重试才恢复表单`, async () => {
      let attempts = 0
      api({ getChatToolCredentials: async () => {
        if (++attempts === 1) throw new Error('fixture read failure')
        return { mode: 'byok', apiKey: 'fixture-only-key' }
      } })
      const host = mount(toolComponent(name)); await tick(); host.render()
      expect(host.elements().some((item) => item.props.type === 'password')).toBe(false)
      expect(host.elements().some((item) => item.props.role === 'alert')).toBe(true)
      click(host.button('重试加载')); host.render(); await tick(); host.render()
      expect(host.elements().some((item) => item.props.type === 'password')).toBe(true)
      expect(attempts).toBe(2)
    })
  }
  for (const name of ['WebSearchSettings', 'GptImageSettings']) {
    test(`${name} 保存失败不测试旧凭据，草稿保留并可重试`, async () => {
      let tests = 0
      let saves = 0
      api({ getChatToolCredentials: async () => ({ mode: 'byok' }), updateChatToolCredentials: async () => { saves += 1; if (saves === 1) throw new Error('fixture failure') }, testChatTool: async () => { tests += 1; return { success: true, message: 'fixture' } } })
      const host = mount(toolComponent(name)); await tick(); host.render()
      const key = host.elements().find((item) => item.props.type === 'password')!
      ;(key.props.onChange as (event: unknown) => void)({ target: { value: 'fixture-only-key' } }); host.render()
      await click(host.button('测试连接')); await tick(); host.render()
      expect(tests).toBe(0)
      expect(errors.length).toBeGreaterThan(0)
      expect(host.elements().find((item) => item.props.type === 'password')!.props.value).toBe('fixture-only-key')
      await click(host.button('测试连接')); await tick(); host.render()
      expect(tests).toBe(1)
    })
  }
  for (const name of ['WebSearchSettings', 'GptImageSettings']) {
    for (const succeeds of [false, true]) {
      test(`${name} blur 与测试共享在途保存（${succeeds ? '成功后才测试' : '失败停止测试'}）`, async () => {
        let saves = 0
        let tests = 0
        let resolve!: () => void
        let reject!: (reason: Error) => void
        api({
          getChatToolCredentials: async () => ({ mode: 'byok' }),
          updateChatToolCredentials: async () => {
            saves += 1
            await new Promise<void>((yes, no) => { resolve = yes; reject = no })
          },
          testChatTool: async () => { tests += 1; return { success: true, message: 'fixture' } },
        })
        const host = mount(toolComponent(name)); await tick(); host.render()
        const key = () => host.elements().find((item) => item.props.type === 'password')!.props
        ;(key().onChange as (event: unknown) => void)({ target: { value: 'fixture-only-key' } }); host.render()
        ;(key().onBlur as () => void)()
        click(host.button('测试连接'))
        expect(saves).toBe(1)
        expect(tests).toBe(0)
        if (succeeds) resolve()
        else reject(new Error('fixture failure'))
        await tick(); host.render()
        expect(saves).toBe(1)
        expect(tests).toBe(succeeds ? 1 : 0)
        expect(host.button('测试连接').disabled).toBe(false)
      })
    }
  }
  test('图片 BYOK 每个可见标签绑定对应输入或 provider 触发器', async () => {
    api({ getChatToolCredentials: async () => ({ mode: 'byok' }) })
    const host = mount(toolComponent('GptImageSettings')); await tick(); host.render()
    const labels = host.elements().filter((item) => item.type === 'label')
    expect(labels).toHaveLength(4)
    for (const label of labels) expect(host.elements().some((item) => item.props.id === label.props.htmlFor)).toBe(true)
    expect(host.elements().find((item) => item.props.onClick && text(item).startsWith('自带 API Key'))!.props['aria-pressed']).toBe(true)
    expect(host.elements().find((item) => item.props.onClick && text(item).startsWith('Profer 官方生图'))!.props['aria-pressed']).toBe(false)
  })
  test('图片模式写失败不改变显示模式；工具开关失败保持原状态', async () => {
    api({ updateChatToolCredentials: fail, updateChatToolState: fail })
    const host = mount(toolComponent('GptImageSettings')); await tick(); host.render()
    const button = host.elements().find((item) => item.props.onClick && text(item).startsWith('自带 API Key'))!
    click(button.props); await tick(); host.render()
    expect(host.elements().some((item) => item.props.type === 'password')).toBe(false)
    const toggle = host.elements().find((item) => item.props.onCheckedChange)!
    await (toggle.props.onCheckedChange as (value: boolean) => Promise<void>)(true); host.render()
    expect(host.elements().find((item) => item.props.onCheckedChange)!.props.checked).toBe(false)
  })
  test('自定义工具删除只在确认后写入，失败保留列表并可重试', async () => {
    const tool = { meta: { id: 'fixture-tool', name: 'Fixture tool', description: '', category: 'custom' as const, params: [], executorType: 'http' as const }, enabled: true, available: true }
    store.set(chatToolsAtom, [tool])
    let deletes = 0
    api({
      deleteCustomChatTool: async () => { deletes += 1; if (deletes === 1) throw new Error('fixture failure') },
      getChatTools: async () => [],
    })
    const host = mount(toolComponent('CustomToolsSection'))
    click(host.button('删除工具Fixture tool')); host.render()
    expect(deletes).toBe(0)
    click(host.button('删除工具')); await tick(); host.render()
    expect(store.get(chatToolsAtom)).toHaveLength(1)
    expect(errors.at(-1)).toContain('删除工具失败')
    click(host.button('删除工具')); await tick(); host.render()
    expect(store.get(chatToolsAtom)).toHaveLength(0)
  })
})

describe('UsageSettings 低风险持久化与删除', () => {
  test('高度保存失败不更改 atom，保留草稿与字段错误，重试成功更新', async () => {
    store.set(composerCompactModeAtom, { viewportHeight: 700, minHeight: 60, maxHeight: 140 })
    let calls = 0
    api({ updateSettings: async () => { calls += 1; if (calls === 1) throw new Error('fixture failure') } })
    const host = mount(UsageSettings); await tick(); host.render()
    ;(host.field('矮窗口压缩输入框').onChange as (value: string) => void)('900'); host.render()
    await (host.field('矮窗口压缩输入框').onBlur as () => Promise<void>)(); host.render()
    expect(host.field('矮窗口压缩输入框').value).toBe('900')
    expect(host.field('矮窗口压缩输入框').error).toContain('保存失败')
    expect(store.get(composerCompactModeAtom).viewportHeight).toBe(700)
    await (host.field('矮窗口压缩输入框').onBlur as () => Promise<void>)(); host.render()
    expect(store.get(composerCompactModeAtom).viewportHeight).toBe(900)
    expect(host.field('矮窗口压缩输入框').error).toBeUndefined()
  })
  test('加载失败禁用高度/归档与允许重试，不写默认配置', async () => {
    let reads = 0
    let writes = 0
    api({ getSettings: async () => { reads += 1; if (reads === 1) throw new Error('fixture failure'); return {} }, updateSettings: async () => { writes += 1 } })
    const host = mount(UsageSettings); await tick(); host.render()
    expect(host.field('矮窗口压缩输入框').disabled).toBe(true)
    await (host.field('矮窗口压缩输入框').onBlur as () => Promise<void>)()
    expect(writes).toBe(0)
    click(host.button('重试加载')); await tick(); host.render()
    expect(host.field('矮窗口压缩输入框').disabled).toBe(false)
  })
  test('自动归档写失败保持已保存值，重试成功才显示新天数', async () => {
    let calls = 0
    api({ updateSettings: async () => { calls += 1; if (calls === 1) throw new Error('fixture failure') } })
    const host = mount(UsageSettings); await tick(); host.render()
    const select = () => elements(host.field('自动归档').children).find((item) => item.props.onValueChange)!.props
    await (select().onValueChange as (value: string) => Promise<void>)('14'); host.render()
    expect(select().value).toBe('7')
    expect(errors.at(-1)).toContain('自动归档设置保存失败')
    await (select().onValueChange as (value: string) => Promise<void>)('14'); host.render()
    expect(select().value).toBe('14')
  })
  test('三个高度字段保留既有空值默认、范围归一化与零关闭语义', async () => {
    const patches: unknown[] = []
    api({ updateSettings: async (patch: unknown) => { patches.push(patch) } })
    const host = mount(UsageSettings); await tick(); host.render()
    for (const [label, draft, normalized] of [
      ['矮窗口压缩输入框', '0', '0'],
      ['紧凑档输入框高度', '', '60'],
      ['紧凑档输入框上限', '999', '200'],
    ]) {
      ;(host.field(label!).onChange as (value: string) => void)(draft!); host.render()
      await (host.field(label!).onBlur as () => Promise<void>)(); host.render()
      expect(host.field(label!).value).toBe(normalized)
    }
    expect(patches).toEqual([{ inputCompactViewportHeight: 0 }, { inputCompactMinHeight: 60 }, { inputCompactMaxHeight: 200 }])
  })
  test('音效删除只在确认后写入，失败可重试', async () => {
    const sound = { id: 'custom-fixture', label: 'Fixture sound', fileName: 'fixture.mp3', addedAt: 1 }
    store.set(customNotificationSoundsAtom, [sound])
    store.set(notificationSoundsAtom, { taskComplete: 'none', permissionRequest: 'none', exitPlanMode: 'none' })
    let deletes = 0
    api({ removeCustomNotificationSound: async () => { deletes += 1; if (deletes === 1) throw new Error('fixture failure'); return [] } })
    const host = mount(UsageSettings); await tick(); host.render()
    const picker = host.elements().find((item) => item.props.onRemoveSound)!
    ;(picker.props.onRemoveSound as (id: string) => void)(sound.id); host.render()
    expect(deletes).toBe(0)
    click(host.button('删除音效')); await tick(); host.render()
    expect(store.get(customNotificationSoundsAtom)).toHaveLength(1)
    expect(errors.at(-1)).toContain('删除失败')
    click(host.button('删除音效')); await tick(); host.render()
    expect(store.get(customNotificationSoundsAtom)).toHaveLength(0)
  })
})

test('真实 React SSR：头像触发器为按钮、提示词编辑标签关联、初始 Usage 高度禁用', () => {
  store.set(userProfileAtom, { userName: 'Fixture', avatar: 'F' })
  store.set(authStatusAtom, { isLoggedIn: false })
  const account = renderToStaticMarkup(<AccountSettings />)
  expect(account).toMatch(/<button[^>]*aria-label="更换头像"/)
  const prompt = { id: 'fixture-prompt', name: 'Fixture', content: '', isBuiltin: false, createdAt: 1, updatedAt: 1 }
  store.set(promptConfigAtom, { prompts: [prompt], defaultPromptId: prompt.id, appendDateTimeAndUserName: true })
  store.set(selectedPromptIdAtom, prompt.id)
  const html = renderToStaticMarkup(<PromptSettings />)
  for (const tag of html.match(/<label[^>]*>/g) ?? []) {
    const id = tag.match(/ for="([^"]*)"/)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`id="${id}"`)
  }
  expect(html).toContain('aria-pressed="true"')
  const usage = renderToStaticMarkup(<UsageSettings />)
  expect(usage.match(/<input[^>]*type="number"[^>]*disabled=""/g)).toHaveLength(3)
})

test('四页源码不再保留裸 label，工具显隐按钮可命名且可 Tab 聚焦', () => {
  for (const name of ['AccountSettings', 'PromptSettings', 'ToolSettings', 'UsageSettings']) {
    const source = readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8')
    for (const tag of source.match(/<(?:label|Label)\b[^>]*>/g) ?? []) expect(tag).toContain('htmlFor=')
  }
  const tool = readFileSync(new URL('./ToolSettings.tsx', import.meta.url), 'utf8')
  expect(tool).not.toContain('tabIndex={-1}')
  expect(tool).toContain('隐藏联网搜索 API Key')
  expect(tool).toContain('隐藏图片生成 API Key')
})
