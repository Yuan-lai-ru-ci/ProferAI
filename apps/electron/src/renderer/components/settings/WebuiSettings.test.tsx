import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import type { WebuiConfigPatch, WebuiStatus } from '../../../types'

// 所有 IPC 都是内存 fixture：不启动服务、不读写 ~/.profer。
const store = createStore()
const sessionsAtom = atom<AgentSessionMeta[]>([])
const workspacesAtom = atom<AgentWorkspace[]>([])
mock.module('jotai', () => ({
  atom,
  createStore: () => createStore(),
  getDefaultStore: () => store,
  useAtomValue: (target: Parameters<typeof store.get>[0]) => store.get(target),
}))
mock.module('../../atoms/agent-atoms', () => ({ agentSessionsAtom: sessionsAtom, agentWorkspacesAtom: workspacesAtom }))
const errors: string[] = []
mock.module('sonner', () => ({ toast: { error: (message: string) => errors.push(message), success() {}, warning() {}, info() {} } }))
const { WebuiSettings } = await import('./WebuiSettings')

const workspace: AgentWorkspace = { id: 'fixture-workspace', name: 'Fixture project', slug: 'fixture-project', createdAt: 1, updatedAt: 1 }
const session: AgentSessionMeta = { id: 'fixture-session', title: 'Fixture session', workspaceId: workspace.id, createdAt: 1, updatedAt: 2 }

function statusOf(overrides: Partial<WebuiStatus> = {}): WebuiStatus {
  return {
    enabled: true,
    running: true,
    port: 7800,
    configuredPort: 7800,
    defaultPort: 7800,
    bindHost: '0.0.0.0',
    interfaces: [{ name: 'Wi-Fi', address: '192.168.1.10', internal: false, kind: 'lan' }],
    publishedSessionIds: [session.id],
    token: 'fixture-token',
    urls: [{ sessionId: session.id, url: 'http://192.168.1.10:7800/s/fixture-session?token=fixture-token' }],
    accessibleHost: '192.168.1.10',
    accessibleHosts: ['192.168.1.10'],
    platform: 'win32',
    assetDir: 'fixture-assets',
    assetReady: true,
    error: null,
    ...overrides,
  }
}

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

/**
 * 与 ChannelSettings / integration-settings 测试同一套手写 dispatcher：
 * 不装 DOM，内层组件不执行，只拿元素 props 断言行为。
 */
function mount(options: { write?: (patch: WebuiConfigPatch, current: WebuiStatus) => WebuiStatus } = {}) {
  const writes: WebuiConfigPatch[] = []
  let current = statusOf()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    electronAPI: {
      getWebuiStatus: async () => current,
      openWebuiSession: async () => {},
      setWebuiConfig: async (patch: WebuiConfigPatch) => {
        writes.push(patch)
        current = options.write ? options.write(patch, current) : { ...current, ...patch }
        return current
      },
    },
  } })
  store.set(sessionsAtom, [session])
  store.set(workspacesAtom, [workspace])

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
  const useEffect = (effect: () => void | (() => void), deps?: readonly unknown[]): void => {
    const slot = slots[index++] ?? (slots[index - 1] = {})
    if (!same(slot.deps, deps)) {
      slot.deps = deps
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined })
    }
  }
  const dispatcher = {
    useState<T>(initial: T | (() => T)) {
      const position = index++
      const slot = slots[position] ?? (slots[position] = { value: typeof initial === 'function' ? (initial as () => T)() : initial })
      return [slot.value, (next: T | ((previous: T) => T)) => {
        const value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next
        if (!Object.is(value, slot.value)) { slot.value = value; changed = true }
      }]
    },
    useRef<T>(value: T) { return useMemo(() => ({ current: value }), []) },
    useMemo,
    useCallback<T>(callback: T, deps: readonly unknown[]) { return useMemo(() => callback, deps) },
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
      try { tree = WebuiSettings() } finally { internals.ReactCurrentDispatcher.current = previous }
      const pending = effects
      effects = []
      pending.forEach((effect) => effect())
    } while (changed)
  }
  render()
  const host = {
    render,
    writes,
    elements: () => elements(tree),
    button: (label: string) => elements(tree).find((item) => item.props.onClick && (text(item) === label || item.props['aria-label'] === label))!.props,
    dialog: () => elements(tree).find((item) => item.props.title === '停止发布这个网页？')!.props,
    dispose: () => slots.forEach((slot) => slot.cleanup?.()),
  }
  hosts.push(host)
  return host
}

const tick = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve() }
const click = (props: Props) => (props.onClick as (event: { preventDefault: () => void }) => unknown)({ preventDefault() {} })

afterEach(() => {
  hosts.splice(0).forEach((host) => host.dispose())
  errors.length = 0
})

describe('Web 会话停止发布', () => {
  test('Given 已发布会话 When 点击停止发布 Then 只打开确认框，不写配置', async () => {
    const host = mount()
    await tick()
    host.render()
    click(host.button(`停止发布 ${session.title}`))
    host.render()
    expect(host.writes).toHaveLength(0)
    expect(host.dialog().open).toBe(true)
    expect(String(host.dialog().description)).toContain(session.title)
    expect(String(host.dialog().description)).toContain('404')
  })

  test('Given 确认框打开 When 取消 Then 不写配置且网页保持发布', async () => {
    const host = mount()
    await tick()
    host.render()
    click(host.button(`停止发布 ${session.title}`))
    host.render()
    ;(host.dialog().onOpenChange as (open: boolean) => void)(false)
    host.render()
    expect(host.writes).toHaveLength(0)
    expect(host.dialog().open).toBe(false)
    expect(host.elements().some((item) => item.props['aria-label'] === `停止发布 ${session.title}`)).toBe(true)
  })

  test('Given 确认停止发布 When 写入成功 Then 从白名单移除并关闭确认框', async () => {
    const host = mount()
    await tick()
    host.render()
    click(host.button(`停止发布 ${session.title}`))
    host.render()
    ;(host.dialog().onConfirm as () => void)()
    await tick()
    host.render()
    expect(host.writes).toEqual([{ publishedSessionIds: [] }])
    expect(host.dialog().open).toBe(false)
    expect(host.elements().some((item) => item.props['aria-label'] === `停止发布 ${session.title}`)).toBe(false)
    expect(host.elements().some((item) => text(item) === '当前 0 个网页。发布会话并启用后，可从浏览器访问。')).toBe(true)
  })

  test('Given 写入失败 When 确认停止发布 Then 保持发布、确认框不关闭，重试成功才移除', async () => {
    let attempts = 0
    const host = mount({
      write: (patch, current) => {
        if (++attempts === 1) throw new Error('fixture write failure')
        return { ...current, publishedSessionIds: patch.publishedSessionIds ?? [] }
      },
    })
    await tick()
    host.render()
    click(host.button(`停止发布 ${session.title}`))
    host.render()
    ;(host.dialog().onConfirm as () => void)()
    await tick()
    host.render()
    expect(host.writes).toHaveLength(1)
    expect(host.dialog().open).toBe(true)
    expect(host.elements().some((item) => item.props['aria-label'] === `停止发布 ${session.title}`)).toBe(true)
    expect(host.elements().some((item) => String(item.props.message ?? '').includes('fixture write failure'))).toBe(true)

    ;(host.dialog().onConfirm as () => void)()
    await tick()
    host.render()
    expect(host.writes).toHaveLength(2)
    expect(host.dialog().open).toBe(false)
    expect(host.elements().some((item) => item.props['aria-label'] === `停止发布 ${session.title}`)).toBe(false)
  })
})
