import { describe, expect, test } from 'bun:test'
import { CURRENT_SESSION_REORDER_MIME } from './current-session-reorder'
import { FILE_REFERENCE_DRAG_MIME } from './file-reference-drag'
import { isSupportedInputDrop } from './input-drop-payload'
import { SESSION_REFERENCE_DRAG_MIME } from './session-reference-drag'

function dataTransferWithTypes(...types: string[]): DataTransfer {
  return { get types() { return [...types] } } as unknown as DataTransfer
}

describe('isSupportedInputDrop — 输入框只接管自己认识的载荷', () => {
  test('Given 会话引用 / 文件引用 / 系统文件 / 纯文本 When 判定 Then 接管', () => {
    expect(isSupportedInputDrop(dataTransferWithTypes(SESSION_REFERENCE_DRAG_MIME))).toBe(true)
    expect(isSupportedInputDrop(dataTransferWithTypes(FILE_REFERENCE_DRAG_MIME))).toBe(true)
    expect(isSupportedInputDrop(dataTransferWithTypes('Files'))).toBe(true)
    expect(isSupportedInputDrop(dataTransferWithTypes('text/plain'))).toBe(true)
    // 外部富文本常常不带 text/plain，不能顺手挡掉
    expect(isSupportedInputDrop(dataTransferWithTypes('text/html'))).toBe(true)
    expect(isSupportedInputDrop(dataTransferWithTypes('text/uri-list'))).toBe(true)
  })

  test('Given 未知自定义载荷 When 判定 Then 不接管，浏览器显示禁止光标', () => {
    expect(isSupportedInputDrop(dataTransferWithTypes(CURRENT_SESSION_REORDER_MIME))).toBe(false)
    expect(isSupportedInputDrop(dataTransferWithTypes('application/x-unknown'))).toBe(false)
    expect(isSupportedInputDrop(dataTransferWithTypes())).toBe(false)
  })

  test('Given 混合载荷 When 含任意已知项 Then 仍接管', () => {
    expect(isSupportedInputDrop(dataTransferWithTypes(SESSION_REFERENCE_DRAG_MIME, 'text/plain'))).toBe(true)
    expect(isSupportedInputDrop(dataTransferWithTypes('Files', 'text/plain'))).toBe(true)
  })
})
