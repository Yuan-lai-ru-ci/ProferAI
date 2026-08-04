import { describe, expect, test } from 'bun:test'
import { createGamepadNavigationState, readGamepadActions, type GamepadLike } from './gamepad-navigation'
import { createNavigationController, type NavigationController } from './navigation-controller'

/**
 * 无物理手柄时的“模拟手柄切换”集成验证。
 *
 * 走真实链路：伪造标准手柄快照 → readGamepadActions 纯映射 → 注入真实
 * navigationController 派发 → 模拟 TabBar / LeftSidebar 的实用 consumer 消费。
 * 证明 LB/RB 切 Tab、D-pad 上下移动、A 确认、B 返回等“切换”在派发层真实可达。
 */

function fakePad(state: { buttons?: number[]; axes?: [number, number] } = {}): GamepadLike {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false }))
  for (const i of state.buttons ?? []) buttons[i] = { pressed: true }
  return { connected: true, buttons, axes: state.axes ?? [0, 0] }
}

/** 模拟 TabBar 的 previousTab/nextTab consumer（仅肩键）。 */
function registerTabBar(controller: NavigationController, tabs: string[], getActive: () => number, setActive: (i: number) => void): void {
  controller.register((action) => {
    if (action !== 'previousTab' && action !== 'nextTab') return false
    if (tabs.length === 0) return false
    const delta = action === 'nextTab' ? 1 : -1
    const next = (getActive() + delta + tabs.length) % tabs.length
    setActive(next)
    return true
  }, 10)
}

/** 模拟 LeftSidebar 的纵向主链 + confirm consumer（priority 20，要求焦点在 left-bar item）。 */
function registerLeftBar(controller: NavigationController, items: string[], activeRef: { activeIndex: number }): void {
  controller.register((action) => {
    if (action === 'previous' || action === 'next') {
      const delta = action === 'next' ? 1 : -1
      const next = activeRef.activeIndex + delta
      // 与真实现一致：越过边界返回 false（让外层兜底/退出，不在这里做假切换）。
      if (next < 0 || next >= items.length) return false
      activeRef.activeIndex = next
      return true
    }
    if (action === 'confirm') {
      // 模拟点击当前项（激活会话）。
      return true
    }
    return false
  }, 20)
}

describe('simulated gamepad switching (dispatch chain)', () => {
  test('LB/RB switches tabs through the real controller', () => {
    const controller = createNavigationController()
    const tabs = ['chat', 'agent', 'preview']
    let active = 1
    registerTabBar(controller, tabs, () => active, (i) => { active = i })
    // LeftSidebar consumer 存在但不会被肩键触发（其优先级在 dispatch 时先行但返回 false）。
    registerLeftBar(controller, ['planning', 'skills'], { activeIndex: 0 })

    // RB (button 5) → nextTab
    let state = createGamepadNavigationState()
    let pad = fakePad({ buttons: [5] })
    const rb = readGamepadActions([pad], state, 0)
    state = rb.state
    expect(rb.actions).toContain('nextTab')
    for (const action of rb.actions) controller.dispatch(action)
    expect(active).toBe(2)

    // LB (button 4) → previousTab
    pad = fakePad({ buttons: [4] })
    const lb = readGamepadActions([pad], state, 16)
    state = lb.state
    expect(lb.actions).toContain('previousTab')
    for (const action of lb.actions) controller.dispatch(action)
    expect(active).toBe(1)
  })

  test('D-pad down/up moves the left-bar selection, A confirms', () => {
    const controller = createNavigationController()
    const activeRef = { activeIndex: 0 }
    let confirmed = false
    controller.register((action) => {
      if (action === 'previous' || action === 'next') {
        const delta = action === 'next' ? 1 : -1
        const next = activeRef.activeIndex + delta
        if (next < 0 || next >= 3) return false
        activeRef.activeIndex = next
        return true
      }
      if (action === 'confirm') { confirmed = true; return true }
      return false
    }, 20)

    // D-pad down (button 13)
    let state = createGamepadNavigationState()
    let pad = fakePad({ buttons: [13] })
    const down = readGamepadActions([pad], state, 0)
    state = down.state
    expect(down.actions).toContain('next')
    for (const action of down.actions) controller.dispatch(action)
    expect(activeRef.activeIndex).toBe(1)

    // A (button 0) confirms
    pad = fakePad({ buttons: [0] })
    const a = readGamepadActions([pad], state, 16)
    state = a.state
    expect(a.actions).toContain('confirm')
    for (const action of a.actions) controller.dispatch(action)
    expect(confirmed).toBe(true)
  })

  test('D-pad precedence over left stick; repeat is throttled in the dispatch chain', () => {
    const controller = createNavigationController()
    const activeRef = { activeIndex: 0 }
    controller.register((action) => {
      if (action === 'next') { activeRef.activeIndex += 1; return true }
      return false
    }, 20)

    // Hold D-pad down + stick pointing down → only one direction, no double consumption.
    let state = createGamepadNavigationState()
    const pad = fakePad({ buttons: [13], axes: [0, 0.9] })
    const first = readGamepadActions([pad], state, 0)
    state = first.state
    expect(first.actions.filter((a) => a === 'next').length).toBe(1)
    for (const action of first.actions) controller.dispatch(action)
    expect(activeRef.activeIndex).toBe(1)

    // Held but before initial-repeat delay (280ms) → no extra fire.
    const early = readGamepadActions([pad], state, 200)
    state = early.state
    expect(early.actions).not.toContain('next')
    const after = readGamepadActions([pad], state, 280)
    expect(after.actions).toContain('next')
  })
})
