import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Button } from '@profer/ui/primitives/button'
import type { KnowledgeItem, KnowledgeLibrarySnapshot } from '@profer/shared'
import { KnowledgeReferencePicker } from './KnowledgeReferencePicker'

// 运行真实组件、effect 与 handler；不展开 Dialog portal 或模拟浏览器布局。
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const items: KnowledgeItem[] = Array.from({ length: 11 }, (_, i) => ({
  id: `item-${i}`, title: `资料 ${i}`, kind: 'text', origin: 'local',
  fileSize: 1, importedAt: 1, updatedAt: 1, tags: [], syncState: 'local-only',
}))
const restorers: (() => void)[] = []
afterEach(() => { restorers.splice(0).reverse().forEach((restore) => restore()) })

function mount() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: ReturnType<typeof deferred<KnowledgeLibrarySnapshot>>[] = []
  const imports: { ids: string[]; response: ReturnType<typeof deferred<void>> }[] = []
  const closed: boolean[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { knowledge: {
    getLibrarySnapshot: () => { const request = deferred<KnowledgeLibrarySnapshot>(); requests.push(request); return request.promise },
  } } } })
  restorers.push(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window') })
  const slots: Slot[] = []
  let index = 0
  let changed = false
  let effects: (() => void)[] = []
  let tree!: React.ReactElement
  const dispatcher = {
    useState<T>(initial: T | (() => T)) {
      const position = index++
      const slot = slots[position] ?? (slots[position] = { value: typeof initial === 'function' ? (initial as () => T)() : initial })
      return [slot.value, (next: T | ((previous: T) => T)) => {
        const value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next
        if (!Object.is(value, slot.value)) { slot.value = value; changed = true }
      }]
    },
    useEffect(fn: () => void | (() => void), deps: readonly unknown[]) {
      const slot = slots[index++] ?? (slots[index - 1] = {})
      if (!slot.deps || deps.some((value, i) => !Object.is(value, slot.deps![i]))) {
        slot.deps = deps
        effects.push(() => { slot.cleanup?.(); slot.cleanup = fn() || undefined })
      }
    },
  }
  const render = () => {
    let rounds = 0
    do {
      if (++rounds > 20) throw new Error('fixture hook update loop')
      changed = false; index = 0
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try {
        tree = KnowledgeReferencePicker({ open: true, onOpenChange: (open) => closed.push(open), onConfirm: (ids) => {
          const response = deferred<void>(); imports.push({ ids, response }); return response.promise
        } })
      } finally { internals.ReactCurrentDispatcher.current = previous }
      const queued = effects; effects = []; queued.forEach((effect) => effect())
    } while (changed)
  }
  const elements = () => {
    const found: React.ReactElement<Record<string, unknown>>[] = []
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      found.push(node); visit(node.props.children)
    }
    visit(tree); return found
  }
  const text = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(text).join('')
    if (React.isValidElement<{ children?: unknown }>(node)) return text(node.props.children)
    return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
  }
  const button = (label: string) => elements().find((el) => el.type === Button && text(el) === label)!
  const click = (el: React.ReactElement<Record<string, unknown>>) => {
    expect(el).toBeDefined(); expect(el.props.disabled).not.toBe(true)
    const handler = el.props.onClick as () => void
    handler(); render()
  }
  const rows = () => elements().filter((el) => el.type === 'button' && el.props['aria-pressed'] !== undefined)
  const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render() } }
  restorers.push(() => slots.forEach((slot) => slot.cleanup?.()))
  render()
  return { requests, imports, closed, flush, button, click, rows,
    text: () => text(tree), alerts: () => elements().filter((el) => el.props.role === 'alert'),
    select: (i: number) => click(rows()[i]!),
    load: async () => { requests.at(-1)!.resolve({ items, totalItems: items.length }); await flush() },
  }
}

describe('资料选择器真实 handler 与 fixture IPC', () => {
  test('读取失败显示 alert 而非空库，重新读取成功恢复列表', async () => {
    const scope = mount()
    scope.requests[0]!.reject(new Error('fixture read failure')); await scope.flush()
    expect(scope.alerts()).toHaveLength(1)
    expect(scope.text()).toContain('读取资料失败，请重试')
    expect(scope.text()).not.toContain('资料库中还没有可导入的资料')
    expect(scope.button('导入  份资料').props.disabled).toBe(true)
    scope.click(scope.button('重新读取'))
    expect(scope.requests).toHaveLength(2)
    await scope.load()
    expect(scope.alerts()).toHaveLength(0)
    expect(scope.rows()).toHaveLength(11)
  })

  test('最多选择10份，取消一项后可选择第11份，提交传递实际选择', async () => {
    const scope = mount(); await scope.load()
    for (let i = 0; i < 11; i++) scope.select(i)
    expect(scope.rows().filter((row) => row.props['aria-pressed'])).toHaveLength(10)
    expect(scope.rows()[10]!.props['aria-pressed']).toBe(false)
    scope.select(0); scope.select(10)
    scope.click(scope.button('导入 10 份资料'))
    expect(scope.imports[0]!.ids).toEqual(items.slice(1).map((item) => item.id))
    expect(scope.button('导入中…').props.disabled).toBe(true)
    expect(scope.rows().every((row) => row.props.disabled === true)).toBe(true)
    scope.imports[0]!.response.resolve(); await scope.flush()
    expect(scope.closed).toEqual([false])
  })

  test('导入失败恢复 saving 且不关闭，保留选中项并可重试成功关闭', async () => {
    const scope = mount(); await scope.load(); scope.select(0)
    scope.click(scope.button('导入 1 份资料'))
    scope.imports[0]!.response.reject(new Error('fixture import failure')); await scope.flush()
    expect(scope.closed).toEqual([])
    expect(scope.alerts()).toHaveLength(1)
    expect(scope.text()).toContain('fixture import failure')
    expect(scope.button('导入 1 份资料').props.disabled).toBe(false)
    expect(scope.rows()[0]!.props['aria-pressed']).toBe(true)
    expect(scope.rows()[0]!.props.disabled).toBe(false)
    scope.click(scope.button('导入 1 份资料'))
    expect(scope.alerts()).toHaveLength(0)
    expect(scope.imports[1]!.ids).toEqual(['item-0'])
    scope.imports[1]!.response.resolve(); await scope.flush()
    expect(scope.closed).toEqual([false])
  })

  test('真实空库显示空态，取消直接关闭且不导入', async () => {
    const scope = mount()
    scope.requests[0]!.resolve({ items: [], totalItems: 0 }); await scope.flush()
    expect(scope.alerts()).toHaveLength(0)
    expect(scope.text()).toContain('资料库中还没有可导入的资料')
    scope.click(scope.button('取消'))
    expect(scope.closed).toEqual([false])
    expect(scope.imports).toHaveLength(0)
  })
})
