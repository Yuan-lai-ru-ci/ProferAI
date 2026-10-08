import * as React from 'react'

type Props = Record<string, unknown>
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

/** 沿用 settings tests 的隔离 hook 宿主；只展开注册的真实 settings 组件，原 primitives 由 SSR 渲染。 */
export function createLoadedHost(root: () => React.ReactElement, componentNames: Set<string>) {
  const instances = new Map<string, { type: unknown; slots: Slot[] }>()
  let tree: React.ReactNode = null
  let dirty = true
  let effects: Array<() => void> = []
  let visited = new Set<string>()
  let revision = 0
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  function invoke(component: (props: Props) => React.ReactNode, props: Props, path: string): React.ReactNode {
    visited.add(path)
    let instance = instances.get(path)
    if (instance?.type !== component) {
      instance?.slots.forEach((slot) => slot.cleanup?.())
      instance = { type: component, slots: [] }
      instances.set(path, instance)
    }
    const slots = instance.slots
    let index = 0
    const useMemo = <T,>(factory: () => T, deps: readonly unknown[]): T => {
      const position = index++
      const slot = slots[position] ?? (slots[position] = {})
      if (!same(slot.deps, deps)) { slot.value = factory(); slot.deps = deps }
      return slot.value as T
    }
    const useEffect = (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const position = index++
      const slot = slots[position] ?? (slots[position] = {})
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
          if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; revision += 1 }
        }]
      },
      useRef<T>(value: T) { return useMemo(() => ({ current: value }), []) },
      useMemo,
      useCallback<T>(callback: T, deps: readonly unknown[]) { return useMemo(() => callback, deps) },
      useId() { return useMemo(() => `loaded-${path.replace(/[^a-z0-9]/gi, '-')}-${index}`, []) },
      useEffect, useLayoutEffect: useEffect,
    }
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = dispatcher
    try { return component(props) } finally { internals.ReactCurrentDispatcher.current = previous }
  }
  function expand(node: React.ReactNode, path: string): React.ReactNode {
    if (Array.isArray(node)) return node.map((child, i) => {
      const key = React.isValidElement(child) ? child.key ?? i : i
      const expanded = expand(child, `${path}.${key}`)
      return React.isValidElement(expanded) ? React.cloneElement(expanded, { key }) : expanded
    })
    if (!React.isValidElement<Props>(node)) return node
    if (typeof node.type === 'function' && componentNames.has(node.type.name)) {
      return expand(invoke(node.type as (props: Props) => React.ReactNode, node.props, path), `${path}.${node.type.name}`)
    }
    // 原 primitives 保持类型；先展开其 children / action 中的业务组件。
    const props: Props = {}
    for (const [name, value] of Object.entries(node.props)) {
      if (React.isValidElement(value) || Array.isArray(value)) props[name] = expand(value as React.ReactNode, `${path}.${name}`)
    }
    return React.cloneElement(node, props)
  }
  function render() {
    for (let rounds = 0; rounds < 50; rounds += 1) {
      dirty = false; visited = new Set()
      tree = expand(invoke(root, {}, 'root'), 'root.output')
      for (const [path, instance] of instances) {
        if (!visited.has(path)) { instance.slots.forEach((slot) => slot.cleanup?.()); instances.delete(path) }
      }
      const pending = effects; effects = []; pending.forEach((effect) => effect())
      if (!dirty) return
    }
    throw new Error('loaded fixture render 未稳定（50 轮）')
  }
  async function settle() {
    let stable = 0
    for (let rounds = 0; rounds < 50; rounds += 1) {
      const before = revision
      render()
      for (let tick = 0; tick < 40; tick += 1) await Promise.resolve()
      if (!dirty && before === revision) { if (++stable === 3) return }
      else stable = 0
    }
    throw new Error('loaded fixture async effects 未稳定（50 轮）')
  }
  function elements() {
    const result: React.ReactElement<Props>[] = []
    const visit = (node: React.ReactNode) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Props>(node)) return
      result.push(node)
      for (const value of Object.values(node.props)) if (React.isValidElement(value) || Array.isArray(value)) visit(value as React.ReactNode)
    }
    visit(tree); return result
  }
  return {
    settle, tree: () => tree, elements,
    async click(label: string) {
      const node = elements().find((element) => element.props.onClick && (element.props['aria-label'] === label || nodeText(element) === label))
      if (!node) throw new Error(`真实事件入口未找到：${label}`)
      await (node.props.onClick as (event: unknown) => unknown)({ preventDefault() {}, stopPropagation() {} })
      await settle()
    },
    dispose() { instances.forEach((instance) => instance.slots.forEach((slot) => slot.cleanup?.())); instances.clear() },
  }
}

export function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  return React.isValidElement<Props>(node) ? nodeText(node.props.children as React.ReactNode) : ''
}
