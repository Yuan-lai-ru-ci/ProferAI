import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearSettingsCache,
  getSettings,
  updateSettings,
} from './settings-service'
import { getSettingsPath } from './config-paths'

const tempRoots: string[] = []
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function makeTempConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-settings-'))
  tempRoots.push(root)
  return root
}

/** 写入一份待测的 settings.json（键值由调用方决定，用于模拟不同历史版本的落盘内容） */
function writeSettingsFile(configDir: string, content: Record<string, unknown>): void {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(content, null, 2), 'utf-8')
}

function readSettingsFile(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = makeTempConfigDir()
  // 模块内缓存按文件级进程存在，逐个用例重置，保证读盘路径真实生效。
  clearSettingsCache()
})

afterEach(() => {
  clearSettingsCache()
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('设置服务命名收敛兼容（Tablet* → Pocket*）', () => {
  test('Given 落盘为旧版 tabletMode* 键 When 读取设置 Then 归一为 pocketMode* 且不再暴露旧键', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, {
      themeMode: 'dark',
      tabletModeEnabled: true,
      tabletModePort: 8899,
    })

    const settings = getSettings()

    expect(settings.pocketModeEnabled).toBe(true)
    expect(settings.pocketModePort).toBe(8899)
    // 其余字段不受归一影响
    expect(settings.themeMode).toBe('dark')
    // 旧键不得进入内存对象，否则会被后续写回重新落盘
    expect('tabletModeEnabled' in settings).toBe(false)
    expect('tabletModePort' in settings).toBe(false)
  })

  test('Given 旧键已被归一 When 更新设置 Then 落盘只保留 pocketMode* 且值正确', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { tabletModeEnabled: true, tabletModePort: 8899 })

    getSettings()
    updateSettings({ pocketModeEnabled: false })

    const persisted = readSettingsFile(configDir)
    expect(persisted.pocketModeEnabled).toBe(false)
    // 端口为未显式修改的字段，随缓存一并写回
    expect(persisted.pocketModePort).toBe(8899)
    expect('tabletModeEnabled' in persisted).toBe(false)
    expect('tabletModePort' in persisted).toBe(false)
  })

  test('Given 新旧键同时存在 When 读取设置 Then 以新键为准', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, {
      pocketModeEnabled: false,
      pocketModePort: 7788,
      tabletModeEnabled: true,
      tabletModePort: 8899,
    })

    const settings = getSettings()

    expect(settings.pocketModeEnabled).toBe(false)
    expect(settings.pocketModePort).toBe(7788)
  })

  test('Given 配置缺失或为空 When 读取设置 Then 移动模式保持未配置且开发者功能默认关闭', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, {})

    const settings = getSettings()

    expect(settings.pocketModeEnabled).toBeUndefined()
    expect(settings.pocketModePort).toBeUndefined()
    expect(settings.developerModeEnabled).toBe(false)
    expect(settings.openEpistemicModeEnabled).toBe(false)
    // 兜底默认值仍生效
    expect(settings.notificationsEnabled).toBe(true)
  })

  test('Given 旧版插件入口已解锁 When 重读设置 Then 迁移为开发者模式且不再写回旧键', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { pluginSystemEnabled: true })

    const settings = getSettings()
    expect(settings.developerModeEnabled).toBe(true)
    expect(settings.openEpistemicModeEnabled).toBe(false)
    expect('pluginSystemEnabled' in settings).toBe(false)

    updateSettings({ notificationsEnabled: false })
    const persisted = readSettingsFile(configDir)
    expect(persisted.developerModeEnabled).toBe(true)
    expect('pluginSystemEnabled' in persisted).toBe(false)
  })

  test('Given 新旧开发者字段同时存在 When 新字段明确关闭 Then 以新字段为准', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, {
      developerModeEnabled: false,
      pluginSystemEnabled: true,
    })

    expect(getSettings().developerModeEnabled).toBe(false)
  })

  test('Given 旧版更新输入 When 仍发送 pluginSystemEnabled Then 转换为开发者模式且不写回旧键', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, {})

    getSettings()
    updateSettings({ pluginSystemEnabled: true })

    expect(getSettings().developerModeEnabled).toBe(true)
    const persisted = readSettingsFile(configDir)
    expect(persisted.developerModeEnabled).toBe(true)
    expect('pluginSystemEnabled' in persisted).toBe(false)
  })

  test('Given 开发者模式关闭 When 开放认识论被设置为 true Then 强制归一为关闭', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, {
      developerModeEnabled: false,
      openEpistemicModeEnabled: true,
    })

    expect(getSettings().openEpistemicModeEnabled).toBe(false)
    updateSettings({ openEpistemicModeEnabled: true })
    expect(getSettings().openEpistemicModeEnabled).toBe(false)
    expect(readSettingsFile(configDir).openEpistemicModeEnabled).toBe(false)
  })

  test('Given 开放认识论已开启 When 关闭开发者模式 Then 两个设置一并关闭', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, {
      developerModeEnabled: true,
      openEpistemicModeEnabled: true,
    })

    getSettings()
    updateSettings({ developerModeEnabled: false })

    expect(getSettings().developerModeEnabled).toBe(false)
    expect(getSettings().openEpistemicModeEnabled).toBe(false)
    expect(readSettingsFile(configDir).openEpistemicModeEnabled).toBe(false)
  })

  test('Given 未显式配置端口 When 更新为 0 Then 写入 0 表示回落默认端口', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { pocketModePort: 8899 })

    getSettings()
    updateSettings({ pocketModePort: 0 })

    expect(readSettingsFile(configDir).pocketModePort).toBe(0)
    expect(getSettingsPath()).toBe(join(configDir, 'settings.json'))
  })
})
