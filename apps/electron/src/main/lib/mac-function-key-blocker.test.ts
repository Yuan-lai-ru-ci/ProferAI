import { expect, test } from 'bun:test'
import { isMacFunctionKey, isReservedFunctionKey } from './mac-function-key-blocker'

test('识别 F1–F12 的 keyDown 事件', () => {
  expect(isMacFunctionKey({ key: 'F1', type: 'keyDown' })).toBe(true)
  expect(isMacFunctionKey({ key: 'f12', type: 'keyDown' })).toBe(true)
})

test('不拦截 F13、普通按键和 keyUp', () => {
  expect(isMacFunctionKey({ key: 'F13', type: 'keyDown' })).toBe(false)
  expect(isMacFunctionKey({ key: 'a', type: 'keyDown' })).toBe(false)
  expect(isMacFunctionKey({ key: 'F1', type: 'keyUp' })).toBe(false)
})

test('放行已被占用为快捷键的功能键（F2 重命名）', () => {
  expect(isReservedFunctionKey({ key: 'F2' })).toBe(true)
  expect(isReservedFunctionKey({ key: 'f2' })).toBe(true)
})

test('未占用的功能键不放行，仍由输入边界吞掉', () => {
  expect(isReservedFunctionKey({ key: 'F1' })).toBe(false)
  expect(isReservedFunctionKey({ key: 'F12' })).toBe(false)
})
