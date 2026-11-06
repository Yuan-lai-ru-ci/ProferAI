import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { isPackaged: true },
}))

const { resolveAppWindowIconFileName, resolveAppWindowIconPath } = await import('./app-window-icon')

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function createResourcesDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-window-icon-'))
  roots.push(root)
  return root
}

describe('窗口图标文件名', () => {
  test('Given 打包态 Windows When 选择图标 Then 使用不被 Shell 引用的 app-icon.ico', () => {
    // resources/icon.ico 曾被文件关联 DefaultIcon 引用，升级时会被 Explorer 占用；
    // 打包态必须改名，安装器才写得进去。
    expect(resolveAppWindowIconFileName('win32', true)).toBe('app-icon.ico')
    expect(resolveAppWindowIconFileName('win32', false)).toBe('icon.ico')
  })

  test('Given macOS 或 Linux When 选择图标 Then 保持既有文件名', () => {
    expect(resolveAppWindowIconFileName('darwin', true)).toBe('icon.icns')
    expect(resolveAppWindowIconFileName('linux', true)).toBe('icon.png')
  })
})

describe('窗口图标路径解析', () => {
  test('Given 资源目录里存在平台图标 When 解析 Then 返回绝对路径', () => {
    const resourcesDir = createResourcesDir()
    writeFileSync(join(resourcesDir, 'app-icon.ico'), 'ico')

    expect(resolveAppWindowIconPath({ resourcesDir, platform: 'win32', isPackaged: true }))
      .toBe(join(resourcesDir, 'app-icon.ico'))
  })

  test('Given 图标缺失 When 解析 Then 返回 undefined 而不是不存在的路径', () => {
    const resourcesDir = createResourcesDir()

    expect(resolveAppWindowIconPath({ resourcesDir, platform: 'win32', isPackaged: true }))
      .toBeUndefined()
  })
})
