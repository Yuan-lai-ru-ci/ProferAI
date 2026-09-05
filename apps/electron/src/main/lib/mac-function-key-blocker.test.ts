import { expect, test } from 'bun:test'
import { isMacFunctionKey } from './mac-function-key-blocker'

test('识别 F1–F12 的 keyDown 事件', () => {
  expect(isMacFunctionKey({ key: 'F1', type: 'keyDown' })).toBe(true)
  expect(isMacFunctionKey({ key: 'f12', type: 'keyDown' })).toBe(true)
})

test('不拦截 F13、普通按键和 keyUp', () => {
  expect(isMacFunctionKey({ key: 'F13', type: 'keyDown' })).toBe(false)
  expect(isMacFunctionKey({ key: 'a', type: 'keyDown' })).toBe(false)
  expect(isMacFunctionKey({ key: 'F1', type: 'keyUp' })).toBe(false)
})
