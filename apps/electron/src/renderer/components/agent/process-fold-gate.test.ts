import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import {
  computeProcessFoldCount,
  resolveProcessFoldCount,
  useProcessFoldGate,
  type ProcessFoldGate,
} from './process-fold-gate'

const internals = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

/**
 * 受控 render：直接执行生产 hook，只实现它用到的 useState/useRef/useCallback。
 * 每次 render() 等价于 React 的一次提交，状态槽跨 render 保留；
 * setFrozenFold 不自动触发渲染，由测试显式推进下一次 render。
 */
function createGateHarness(limit: number) {
  const slots: unknown[] = []
  let cursor = 0
  const dispatcher = {
    useState<T>(initial: T | (() => T)): [T, (action: T | ((previous: T) => T)) => void] {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [slots[index] as T, (action) => {
        slots[index] = typeof action === 'function'
          ? (action as (previous: T) => T)(slots[index] as T)
          : action
      }]
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index] as { current: T }
    },
    useCallback<T>(callback: T): T { return callback },
  }
  const render = (segmentCount: number): ProcessFoldGate => {
    cursor = 0
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = dispatcher
    try { return useProcessFoldGate(segmentCount, limit) }
    finally { internals.ReactCurrentDispatcher.current = previous }
  }
  return { render }
}

describe('过程折叠边界 · 计算', () => {
  test('Given 段数未超窗 When 计算 Then 不折叠', () => {
    expect(computeProcessFoldCount(20, 20)).toBe(0)
    expect(computeProcessFoldCount(5, 20)).toBe(0)
  })

  test('Given 段数超窗 When 计算 Then 只折叠超出的前导段', () => {
    expect(computeProcessFoldCount(21, 20)).toBe(1)
    expect(computeProcessFoldCount(60, 20)).toBe(40)
  })

  test('Given 非法上限 When 计算 Then 收敛为 0 而非负数', () => {
    expect(computeProcessFoldCount(10, -5)).toBe(10)
  })
})

describe('过程折叠边界 · 可见性策略', () => {
  test('Given 内容可见且段数持续增长 When 解析边界 Then 冻结不再回收已渲染的段', () => {
    // 「一收缩就闪一下」的根因回归：冻结后 0 → 40 段都必须保持 0，
    // 否则每来一段就丢掉最上面一段，已渲染内容会被反复重排。
    let frozen = 0
    for (let count = 5; count <= 40; count++) {
      expect(resolveProcessFoldCount(frozen, count, 20, true)).toBe(0)
    }
    // 冻结值本身不因渲染改变；这里显式模拟「渲染不推进」的语义
    frozen = 0
    expect(resolveProcessFoldCount(frozen, 120, 20, true)).toBe(0)
  })

  test('Given 内容可见但段数回退 When 解析边界 Then 收敛到尾部窗口而非折光整组', () => {
    // 冻结值 40 来自段数 60 时；数据回退到 10 段后，最多只能折掉超出窗口的部分。
    expect(resolveProcessFoldCount(40, 10, 20, true)).toBe(0)
    expect(resolveProcessFoldCount(40, 35, 20, true)).toBe(15)
    expect(resolveProcessFoldCount(10, 45, 20, true)).toBe(10)
  })

  test('Given 内容不可见 When 解析边界 Then 跟随段数推进（展开时长过程不会全量渲染）', () => {
    expect(resolveProcessFoldCount(0, 120, 20, false)).toBe(100)
    expect(resolveProcessFoldCount(30, 120, 20, false)).toBe(100)
    expect(resolveProcessFoldCount(30, 25, 20, false)).toBe(30)
  })
})

describe('过程折叠边界 · hook 接线', () => {
  test('Given 首次渲染已超窗（加载历史轮）When 渲染 Then 当帧就折叠', () => {
    // 挂载时刻的折叠与首帧一起出现，用户看不到重排；窗口成本在挂载时就省下了。
    const gate = createGateHarness(20)
    expect(gate.render(35).foldCount).toBe(15)
  })

  test('Given 内容可见且持续新增段 When 逐段渲染 Then 边界始终冻结', () => {
    const gate = createGateHarness(20)
    gate.render(5).reportContentVisibility(true)
    let current = gate.render(5)
    expect(current.foldCount).toBe(0)
    for (let count = 6; count <= 40; count++) current = gate.render(count)
    expect(current.foldCount).toBe(0)
  })

  test('Given 内容卸载 When 上报不可见 Then 按当时段数推进边界', () => {
    const gate = createGateHarness(20)
    const grown = gate.render(40)
    expect(grown.foldCount).toBe(20) // 首帧即折叠
    grown.reportContentVisibility(true)
    expect(gate.render(40).foldCount).toBe(20)

    gate.render(90).reportContentVisibility(false)
    expect(gate.render(90).foldCount).toBe(70)
  })

  test('Given 收起后段数继续增长再展开 When 上报可见 Then 边界跟随增长而不是回退', () => {
    const gate = createGateHarness(20)
    gate.render(40).reportContentVisibility(false)
    // 收起状态下继续很长：边界跟随段数，展开时不会一次性渲染全部
    expect(gate.render(200).foldCount).toBe(180)
    gate.render(200).reportContentVisibility(true)
    expect(gate.render(200).foldCount).toBe(180)
    // 展开后新增段不再回收
    expect(gate.render(260).foldCount).toBe(180)
  })
})
