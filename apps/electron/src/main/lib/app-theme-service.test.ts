import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveAppThemeIsDark } from './app-theme-service'
import { clearSettingsCache } from './settings-service'

/**
 * 主进程侧明暗解析（`resolveAppThemeIsDark`）与渲染进程 `atoms/theme.ts` 的
 * `applyThemeToDOM` / `resolvedThemeAtom` 必须给出同一结论，否则「splash 底色 /
 * Agent 打开的预览页」会与主界面明暗相反。
 *
 * 重点锁定：`themeMode === 'special'` 且没有真实皮肤（themeStyle 为空或 'default'）
 * 时，两边都应按「默认主题」解析为浅色（false），而不是主进程独有的硬编码深色。
 */

const tempRoots: string[] = []
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function makeTempConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-app-theme-'))
  tempRoots.push(root)
  return root
}

/** 写入一份 settings.json；调用方只声明关心的键（其余走服务端默认值）。 */
function writeSettingsFile(content: Record<string, unknown>): void {
  writeFileSync(join(process.env.PROFER_CONFIG_DIR!, 'settings.json'), JSON.stringify(content, null, 2), 'utf-8')
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = makeTempConfigDir()
  clearSettingsCache()
})

afterEach(() => {
  clearSettingsCache()
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('resolveAppThemeIsDark 基础明暗模式', () => {
  test('Given themeMode dark When 解析 Then 深色', () => {
    writeSettingsFile({ themeMode: 'dark' })
    expect(resolveAppThemeIsDark()).toBe(true)
  })

  test('Given themeMode light When 解析 Then 浅色', () => {
    writeSettingsFile({ themeMode: 'light' })
    expect(resolveAppThemeIsDark()).toBe(false)
  })

  test('Given 未落盘任何设置 When 解析 Then 跟随默认主题（浅色）', () => {
    expect(resolveAppThemeIsDark()).toBe(false)
  })
})

describe('resolveAppThemeIsDark 与渲染进程在 special 无皮肤时同向', () => {
  test("Given themeMode special 且 themeStyle 'default' When 解析 Then 浅色（与 applyThemeToDOM 同向）", () => {
    writeSettingsFile({ themeMode: 'special', themeStyle: 'default' })
    expect(resolveAppThemeIsDark()).toBe(false)
  })

  test('Given themeMode special 且无 themeStyle When 解析 Then 浅色（无真实皮肤 = 默认主题）', () => {
    writeSettingsFile({ themeMode: 'special' })
    expect(resolveAppThemeIsDark()).toBe(false)
  })
})
