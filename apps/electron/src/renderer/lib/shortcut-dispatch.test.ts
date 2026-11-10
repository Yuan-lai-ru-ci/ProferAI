import { afterEach, expect, test } from 'bun:test'
import { initShortcutRegistry, registerShortcut, suppressShortcutDispatch, updateShortcutOverrides, getRegisteredShortcutBindings, invokeRegisteredShortcut } from './shortcut-registry'
import type { ShortcutOverrides } from './shortcut-defaults'

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
  /** 键盘按键，默认 F2 */
  key?: string
  /** Ctrl 修饰键 */
  ctrlKey?: boolean
  /** Meta/Cmd 修饰键 */
  metaKey?: boolean
  /** 事件目标（焦点所在元素），用于验证可编辑元素内的放行 */
  target?: unknown
  /** 键盘按住时的自动重复事件，默认 false */
  repeat?: boolean
}

/** 模拟一次 keydown；默认无修饰键、非组合态、无事件目标、非自动重复 */
function pressKey(listener: Listener | null, options: PressOptions = {}): PressResult {
  const result: PressResult = { prevented: 0, stopped: 0 }
  const key = options.key ?? 'F2'
  listener?.({
    key,
    code: key,
    target: options.target,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    repeat: options.repeat ?? false,
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
  suppress: () => () => void
  override: (overrides: ShortcutOverrides) => void
  bindings: typeof getRegisteredShortcutBindings
  invoke: typeof invokeRegisteredShortcut
}> {
  const { window, keydown } = makeWindow()
  ;(globalThis as unknown as { window: unknown }).window = window
  const mod = await import(`./shortcut-registry.ts?probe=${Date.now()}-${Math.random()}`) as {
    initShortcutRegistry: typeof initShortcutRegistry
    registerShortcut: typeof registerShortcut
    suppressShortcutDispatch: typeof suppressShortcutDispatch
    updateShortcutOverrides: typeof updateShortcutOverrides
    getRegisteredShortcutBindings: typeof getRegisteredShortcutBindings
    invokeRegisteredShortcut: typeof invokeRegisteredShortcut
  }
  mod.initShortcutRegistry()
  // 用跨平台组合键覆盖宿主默认值，确保 macOS 本地也能验证 Windows/Linux 的 Ctrl+Delete 分发。
  mod.updateShortcutOverrides({ 'delete-item': { mac: 'Ctrl+Delete', win: 'Ctrl+Delete' } })
  return {
    register: (id, cb, options) => mod.registerShortcut(id, cb, options ?? {}),
    press: (options) => pressKey(keydown(), options),
    suppress: () => mod.suppressShortcutDispatch(),
    override: (overrides) => mod.updateShortcutOverrides(overrides),
    bindings: () => mod.getRegisteredShortcutBindings(),
    invoke: (id) => mod.invokeRegisteredShortcut(id),
  }
}

test('guest绑定镜像保留改绑和抑制，不转发编辑键、删除类守卫或菜单W', async () => {
  const reg = await freshRegistry()
  const noOp = (): void => undefined
  for (const id of ['file-find', 'focus-input', 'delete-item', 'close-tab', 'browser-stop']) cleanup.push(reg.register(id, noOp))
  reg.override({ 'file-find': { mac: 'Ctrl+Q', win: 'Ctrl+Q' }, 'focus-input': { mac: 'Ctrl+C', win: 'Ctrl+C' } })
  expect(reg.bindings().map(binding => binding.id)).toEqual(['file-find', 'browser-stop'])
  expect(reg.bindings()[0]).toMatchObject({ key: 'q', control: true, meta: false })
  const resume = reg.suppress()
  expect(reg.bindings()).toEqual([])
  expect(reg.invoke('file-find')).toBe(false)
  resume()
  expect(reg.bindings()).toHaveLength(2)
  reg.override({ 'file-find': { mac: null, win: null } })
  expect(reg.bindings().some(binding => binding.id === 'file-find')).toBe(false)
})

test('按ID桥接复用最后注册的exclusive handler，不生成第二次键盘事件', async () => {
  const reg = await freshRegistry()
  const calls: string[] = []
  cleanup.push(reg.register('file-find', () => calls.push('plain')))
  cleanup.push(reg.register('file-find', () => calls.push('active'), { exclusive: true }))
  expect(reg.invoke('file-find')).toBe(true)
  expect(calls).toEqual(['active'])
  expect(reg.invoke('unknown-command')).toBe(false)
})

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
 * skipInEditable 守卫：Ctrl+Delete（Windows/Linux）或 Cmd+Backspace（macOS）
 * 在输入框里属于原生输入语义。分发是先吞键再执行 handler，因此必须在命中处就放行，
 * 否则输入框收不到 keydown、删除行为彻底失效。
 */
test('Given 焦点在输入框 When 按 Ctrl+Delete Then 不触发删除且不吞键', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const result = reg.press({ key: 'Delete', ctrlKey: true, target: { tagName: 'INPUT' } })
  expect(hits).toBe(0)
  expect(result.prevented).toBe(0)
})

test('Given 焦点在富文本编辑器 When 按 Ctrl+Delete Then 不触发删除且不吞键', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const result = reg.press({
    key: 'Delete',
    ctrlKey: true,
    target: {
      tagName: 'DIV',
      closest: (selector: string) => selector.includes('.ProseMirror') ? {} : null,
    },
  })
  expect(hits).toBe(0)
  expect(result.prevented).toBe(0)
})

test('Given 焦点不在可编辑元素 When 按 Ctrl+Delete Then 触发删除并吞键', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const result = reg.press({ key: 'Delete', ctrlKey: true, target: { tagName: 'BUTTON', closest: () => null } })
  expect(hits).toBe(1)
  expect(result.prevented).toBe(1)
})

test('Given 焦点不在可编辑元素 When 按裸 Delete Then 不触发会话删除', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const result = reg.press({ key: 'Delete', target: { tagName: 'BUTTON', closest: () => null } })
  expect(hits).toBe(0)
  expect(result.prevented).toBe(0)
})

test('Given 焦点在输入框 When 按 F2 Then 照常重命名（守卫只作用于声明过的定义）', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('rename-item', () => { hits++ }))
  reg.press({ target: { tagName: 'INPUT' } })
  expect(hits).toBe(1)
})

/**
 * 自动重复守卫：按住键盘时系统每秒重发几十次 keydown，toggle 类快捷键
 *（删除确认框、侧边栏、面板）会因此高频闪烁，松手后停在哪一态是随机的。
 * 重复事件不重复执行 handler，但吞键判定照常（macOS 按住 F 键不能漏给 Chromium）。
 */
test('Given 按住 Ctrl+Delete 自动重复 When repeat 事件到达 Then 不重复执行 handler', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  reg.press({ key: 'Delete', ctrlKey: true })
  reg.press({ key: 'Delete', ctrlKey: true, repeat: true })
  reg.press({ key: 'Delete', ctrlKey: true, repeat: true })
  expect(hits).toBe(1)
})

test('Given 录制抑制已挂起 When 按已绑定的 Ctrl+Delete Then 不触发且不吞键，解除后恢复', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const release = reg.suppress()
  const suppressed = reg.press({ key: 'Delete', ctrlKey: true })
  expect(hits).toBe(0)
  expect(suppressed.prevented).toBe(0)
  release()
  reg.press({ key: 'Delete', ctrlKey: true })
  expect(hits).toBe(1)
})

test('Given 两层抑制挂起 When 只解除一层 Then 分发仍挂起（计数式语义）', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('delete-item', () => { hits++ }))
  const releaseA = reg.suppress()
  const releaseB = reg.suppress()
  releaseA()
  reg.press({ key: 'Delete', ctrlKey: true })
  expect(hits).toBe(0)
  releaseB()
  reg.press({ key: 'Delete', ctrlKey: true })
  expect(hits).toBe(1)
})

/**
 * 同键多绑定：命中 skipInEditable 时只跳过该条定义，不应连带终止整轮匹配。
 *
 * 否则「输入框里这个键是否失效」会取决于 parsedCache 的迭代顺序 —— 默认配置下
 * 不触发（F2 与 Delete 不重叠），但用户把某个绑定改到同一个键后，会表现为
 * 输入框内该键静默失效，且没有任何报错提示。
 */
test('Given 同一按键既有 skipInEditable 也有普通绑定 When 焦点在输入框 Then 只跳过前者', async () => {
  const reg = await freshRegistry()
  let deleteHits = 0
  let renameHits = 0
  cleanup.push(reg.register('delete-item', () => { deleteHits++ }))
  cleanup.push(reg.register('rename-item', () => { renameHits++ }))
  // 把重命名改绑到与删除相同的键，构造同键多定义
  reg.override({ 'rename-item': { mac: 'Ctrl+Delete', win: 'Ctrl+Delete' } })

  const result = reg.press({ key: 'Delete', ctrlKey: true, target: { tagName: 'INPUT' } })

  expect(deleteHits).toBe(0)
  expect(renameHits).toBe(1)
  expect(result.prevented).toBe(1)
})
