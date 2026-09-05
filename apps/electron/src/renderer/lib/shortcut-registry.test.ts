import { expect, test } from 'bun:test'
import { isMacFunctionKeyEvent } from './shortcut-registry'

test('识别 macOS 的 F1–F12 功能键', () => {
  expect(isMacFunctionKeyEvent({ key: 'F1', code: 'F1' }, true)).toBe(true)
  expect(isMacFunctionKeyEvent({ key: 'Unidentified', code: 'F12' }, true)).toBe(true)
})

test('不把普通键、F13 或非 macOS 按键当成功能键', () => {
  expect(isMacFunctionKeyEvent({ key: 'a', code: 'KeyA' }, true)).toBe(false)
  expect(isMacFunctionKeyEvent({ key: 'F13', code: 'F13' }, true)).toBe(false)
  expect(isMacFunctionKeyEvent({ key: 'F1', code: 'F1' }, false)).toBe(false)
})
