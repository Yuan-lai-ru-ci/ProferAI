import { describe, expect, test } from 'bun:test'
import {
  INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE,
  DEVELOPER_MODE_UNLOCK_MAX_GAP_MS,
  advanceDeveloperModeUnlockClick,
} from './plugin-unlock'

describe('advanceDeveloperModeUnlockClick 开发者模式解锁', () => {
  test('Given 版本号连续点击五次 When 每次间隔未超时 Then 仅第五次解锁', () => {
    let state = INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE

    for (let click = 1; click <= 5; click += 1) {
      const result = advanceDeveloperModeUnlockClick(state, click * 100)
      expect(result.unlocked).toBe(click === 5)
      state = result.state
    }

    expect(state).toEqual(INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE)
  })

  test('Given 点击序列中断 When 下一次点击超过最大间隔 Then 从第一次重新计数', () => {
    const first = advanceDeveloperModeUnlockClick(INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE, 100)
    const second = advanceDeveloperModeUnlockClick(first.state, 200)
    const restarted = advanceDeveloperModeUnlockClick(second.state, 200 + DEVELOPER_MODE_UNLOCK_MAX_GAP_MS + 1)

    expect(restarted.unlocked).toBe(false)
    expect(restarted.state.count).toBe(1)
  })

  test('Given 系统时间回拨 When 再次点击 Then 不沿用旧序列', () => {
    const first = advanceDeveloperModeUnlockClick(INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE, 1_000)
    const restarted = advanceDeveloperModeUnlockClick(first.state, 900)

    expect(restarted.unlocked).toBe(false)
    expect(restarted.state).toEqual({ count: 1, lastClickedAt: 900 })
  })
})
