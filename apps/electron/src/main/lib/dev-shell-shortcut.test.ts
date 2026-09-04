import { beforeAll, describe, expect, mock, test } from 'bun:test'

beforeAll(() => {
  mock.module('electron', () => ({
    app: { isPackaged: false, getPath: () => '' },
    shell: { writeShortcutLink: () => true },
  }))
})

describe('开发版 Windows Shell 快捷方式', () => {
  test('只在未打包的 Windows 开发运行时维护', async () => {
    const { shouldMaintainDevShellShortcut } = await import('./dev-shell-shortcut')
    expect(shouldMaintainDevShellShortcut('win32', false)).toBe(true)
    expect(shouldMaintainDevShellShortcut('win32', true)).toBe(false)
    expect(shouldMaintainDevShellShortcut('darwin', false)).toBe(false)
    expect(shouldMaintainDevShellShortcut('linux', false)).toBe(false)
  })

  test('使用与生产身份隔离的专属名称和 AUMID', async () => {
    const { DEV_APP_USER_MODEL_ID, DEV_SHORTCUT_NAME } = await import('./dev-shell-shortcut')
    expect(DEV_APP_USER_MODEL_ID).toBe('com.profer.app.dev')
    expect(DEV_SHORTCUT_NAME).toBe('Profer Dev.lnk')
  })
})
