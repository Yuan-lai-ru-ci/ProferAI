import { describe, expect, test } from 'bun:test'
import { exceedsOverdraftLimit } from './credit-gate.js'

describe('credit gate 动态透支边界', () => {
  test('Given 动态透支为 50 When 余额恰好在边界 Then 仍允许', () => {
    expect(exceedsOverdraftLimit(-50, 50)).toBe(false)
  })

  test('Given 动态透支为 50 When 余额低于边界 Then 拒绝', () => {
    expect(exceedsOverdraftLimit(-51, 50)).toBe(true)
  })
})
