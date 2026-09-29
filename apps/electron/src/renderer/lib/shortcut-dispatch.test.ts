import { afterEach, expect, test } from 'bun:test'
import { initShortcutRegistry, registerShortcut } from './shortcut-registry'

/**
 * 分发层的 handler 执行次数。
 *
 * 这个文件必须能观察到真实的 dispatchShortcut，而 resolveShortcutDispatch 的纯函数
 * 用例（shortcut-registry.test.ts）看不到「注册了几个 handler、执行了几次」。
 * 这里用 query 打破模块缓存，避免与同进程内其它用例共享 registry 状态。
 */

type Listener = (e: unknown) => void

function makeWindow(): { window: unknown; keydown: () => Listener | null } {
  let listener: Listener | null = null
  const window = {
    addEventListener: (type: string, fn: Listener): void => {
      if (type === 'keydown') listener = fn
    },
  }
  return { window, keydown: () => listener }
}

/** 一次按键事件里 preventDefault / stopPropagation 的调用次数 */
interface PressResult {
  prevented: number
  stopped: number
}

interface PressOptions {
  /** 按键名，默认 F2 */
  key?: string
  /** 事件目标（焦点所在元素），用于验证可编辑元素内的放行 */
  target?: unknown
}

/** 模拟一次 keydown；默认无修饰键、非组合态、无事件目标 */
function pressKey(listener: Listener | null, options: PressOptions = {}): PressResult {
  const result: PressResult = { prevented: 0, stopped: 0 }
  const key = options.key ?? 'F2'
  listener?.({
    key,
    code: key,
    target: options.target,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    preventDefault: () => { result.prevented++ },
    stopPropagation: () => { result.stopped++ },
  })
  return result
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

/**
 * 每个用例用独立模块实例，避免 registry 的模块级 handlers/initialized 串味。
 */
async function freshRegistry(): Promise<{
  register: (id: string, cb: () => void, options?: { exclusive?: boolean }) => () => void
  press: (options?: PressOptions) => PressResult
}> {
  const { window, keydown } = makeWindow()
  ;(globalThis as unknown as { window: unknown }).window = window
  const mod = await import(`./shortcut-registry.ts?probe=${Date.now()}-${Math.random()}`) as {
    initShortcutRegistry: typeof initShortcutRegistry
    registerShortcut: typeof registerShortcut
  }
  mod.initShortcutRegistry()
  return {
    register: (id, cb, options) => mod.registerShortcut(id, cb, options ?? {}),
    press: (options) => pressKey(keydown(), options),
  }
}

test('Given 同一快捷键注册多个 handler When 均未声明 exclusive Then 全部执行', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('rename-item', () => { hits++ }))
  cleanup.push(reg.register('rename-item', () => { hits++ }))
  reg.press()
  // 这正是「活跃会话同时渲染在顶部当前会话区与项目列表区」时的原始缺陷形态
  expect(hits).toBe(2)
})

test('Given 同一快捷键注册多个 handler When 均声明 exclusive Then 只执行最后注册的一个', async () => {
  const reg = await freshRegistry()
  const order: number[] = []
  cleanup.push(reg.register('rename-item', () => order.push(1), { exclusive: true }))
  cleanup.push(reg.register('rename-item', () => order.push(2), { exclusive: true }))
  reg.press()
  expect(order).toEqual([2])
})

test('Given 单个 exclusive handler When 触发 Then 正常执行一次', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('rename-item', () => { hits++ }, { exclusive: true }))
  reg.press()
  expect(hits).toBe(1)
})

test('Given 有 exclusive 也有非 exclusive When 触发 Then 只跑 exclusive', async () => {
  const reg = await freshRegistry()
  const order: string[] = []
  cleanup.push(reg.register('rename-item', () => order.push('plain')))
  cleanup.push(reg.register('rename-item', () => order.push('exclusive'), { exclusive: true }))
  reg.press()
  expect(order).toEqual(['exclusive'])
})

test('Given 注销后仅剩一个 handler When 触发 Then 不再重复执行', async () => {
  const reg = await freshRegistry()
  let hits = 0
  const off1 = reg.register('rename-item', () => { hits++ }, { exclusive: true })
  cleanup.push(reg.register('rename-item', () => { hits++ }, { exclusive: true }))
  off1()
  reg.press()
  expect(hits).toBe(1)
})

/**
 * skipInEditable 守卫：裸 Delete 在输入框里属于原生输入语义。分发是先吞键再执行
 * handler，因此必须在命中处就放行，否则输入框收不到 keydown、删字符彻底失效。
 */
test('Given 焦点在输入框 When 按 Delete Then 不触发删除且不吞键', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const result = reg.press({ key: 'Delete', target: { tagName: 'INPUT' } })
  expect(hits).toBe(0)
  expect(result.prevented).toBe(0)
})

test('Given 焦点在富文本编辑器 When 按 Delete Then 不触发删除且不吞键', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const result = reg.press({
    key: 'Delete',
    target: {
      tagName: 'DIV',
      closest: (selector: string) => selector.includes('.ProseMirror') ? {} : null,
    },
  })
  expect(hits).toBe(0)
  expect(result.prevented).toBe(0)
})

test('Given 焦点不在可编辑元素 When 按 Delete Then 触发删除并吞键', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const result = reg.press({ key: 'Delete', target: { tagName: 'BUTTON', closest: () => null } })
  expect(hits).toBe(1)
  expect(result.prevented).toBe(1)
})

test('Given 焦点在输入框 When 按 F2 Then 照常重命名（守卫只作用于声明过的定义）', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('rename-item', () => { hits++ }))
  reg.press({ target: { tagName: 'INPUT' } })
  expect(hits).toBe(1)
})
