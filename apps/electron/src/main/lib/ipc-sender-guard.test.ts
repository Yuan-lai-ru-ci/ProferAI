import { describe, expect, test } from 'bun:test'
import { assertMainWindowSender, isMainWindowSender } from './ipc-sender-guard'

interface FakeWebContents {
  isDestroyed(): boolean
}

interface FakeWindow {
  isDestroyed(): boolean
  webContents: FakeWebContents
}

function fake(destroyed = false): FakeWebContents {
  return { isDestroyed: () => destroyed }
}

function windowWith(webContents: FakeWebContents, destroyed = false): FakeWindow {
  return { isDestroyed: () => destroyed, webContents }
}

describe('敏感 Agent IPC 主窗口 sender guard', () => {
  test('主窗口 sender 通过，其他窗口和销毁 sender 拒绝', () => {
    const sender = fake()
    const mainWindow = windowWith(sender)
    const otherSender = fake()

    expect(isMainWindowSender({ sender }, () => mainWindow)).toBe(true)
    expect(isMainWindowSender({ sender: otherSender }, () => mainWindow)).toBe(false)
    expect(isMainWindowSender({ sender: fake(true) }, () => mainWindow)).toBe(false)
    expect(isMainWindowSender({ sender }, () => windowWith(sender, true))).toBe(false)
    expect(() => assertMainWindowSender({ sender: otherSender }, () => mainWindow)).toThrow('仅允许 Profer 主窗口')
  })
})
