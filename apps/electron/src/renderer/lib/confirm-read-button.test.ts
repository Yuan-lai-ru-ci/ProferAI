import { describe, expect, test } from 'bun:test'
import { shouldShowConfirmReadButton } from './confirm-read-button'

/**
 * 「确认已读」按钮可见性真值表（`design.md` §6.1 / §10 单测第 5 组）。
 *
 * 三条硬条件：开关开启 ∧ 最新一轮 assistant 回复 ∧ 该会话有未读。
 * 全条件 fail-closed —— 关闭态恒为 false（不渲染、不注册任何新入口）。
 */

const visible = { manualReadConfirmEnabled: true, isLatestAssistantTurn: true, sessionUnread: true }

describe('开启态下的三分支', () => {
  test('Given 开关开启 + 最新一轮 + 有未读 When 判定 Then 渲染', () => {
    expect(shouldShowConfirmReadButton(visible)).toBe(true)
  })

  test('Given 开关开启但该轮不是最新一轮 When 判定 Then 不渲染', () => {
    expect(shouldShowConfirmReadButton({ ...visible, isLatestAssistantTurn: false })).toBe(false)
  })

  test('Given 开关开启 + 最新一轮但会话没有未读 When 判定 Then 不渲染（点击后按钮消失的另一半）', () => {
    expect(shouldShowConfirmReadButton({ ...visible, sessionUnread: false })).toBe(false)
  })
})

describe('关闭态恒不可见', () => {
  test('Given 开关关闭 When 判定 Then 无论轮次与未读都恒为 false', () => {
    for (const isLatestAssistantTurn of [true, false]) {
      for (const sessionUnread of [true, false]) {
        expect(shouldShowConfirmReadButton({
          manualReadConfirmEnabled: false,
          isLatestAssistantTurn,
          sessionUnread,
        })).toBe(false)
      }
    }
  })
})

describe('组合穷举', () => {
  test('Given 三个布尔条件全部组合 When 判定 Then 只有三真才为真', () => {
    const truthy: string[] = []
    for (const manualReadConfirmEnabled of [false, true]) {
      for (const isLatestAssistantTurn of [false, true]) {
        for (const sessionUnread of [false, true]) {
          const shown = shouldShowConfirmReadButton({
            manualReadConfirmEnabled,
            isLatestAssistantTurn,
            sessionUnread,
          })
          if (shown) truthy.push(`${manualReadConfirmEnabled}/${isLatestAssistantTurn}/${sessionUnread}`)
        }
      }
    }
    expect(truthy).toEqual(['true/true/true'])
  })
})
