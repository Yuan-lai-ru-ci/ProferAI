import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearSettingsCache,
  getSettings,
  updateSettings,
} from './settings-service'
import { getAgentUnreadPolicyMode } from './agent-unread-mode'
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
    expect('openEpistemicModeEnabled' in settings).toBe(false)
    // 兜底默认值仍生效
    expect(settings.notificationsEnabled).toBe(true)
  })

  test('Given 旧版插件入口已解锁 When 重读设置 Then 迁移为开发者模式且不再写回旧键', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { pluginSystemEnabled: true })

    const settings = getSettings()
    expect(settings.developerModeEnabled).toBe(true)
    expect('openEpistemicModeEnabled' in settings).toBe(false)
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

  test('Given 旧配置含认识论字段 When 读取并保存 Then 丢弃废弃字段且保留其他设置', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    for (const developerModeEnabled of [true, false]) {
      clearSettingsCache()
      writeSettingsFile(configDir, { developerModeEnabled, openEpistemicModeEnabled: true })
      expect('openEpistemicModeEnabled' in getSettings()).toBe(false)
      updateSettings({ notificationsEnabled: false })
      expect('openEpistemicModeEnabled' in readSettingsFile(configDir)).toBe(false)
      expect(getSettings().developerModeEnabled).toBe(developerModeEnabled)
      expect(getSettings().notificationsEnabled).toBe(false)
    }
  })

  test('Given 旧客户端仍发送废弃字段 When 更新 Then 不重新持久化', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    const legacyPatch = { developerModeEnabled: true, openEpistemicModeEnabled: true }
    updateSettings(legacyPatch)
    expect('openEpistemicModeEnabled' in getSettings()).toBe(false)
    expect('openEpistemicModeEnabled' in readSettingsFile(configDir)).toBe(false)
    expect(getSettings().developerModeEnabled).toBe(true)
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

/**
 * 侧栏积分条显隐设置：默认显示，关闭后持久化并在重读时保持关闭。
 */
describe('侧栏积分条显隐设置', () => {
  test('Given 旧 settings.json 无该键 When 读取 Then 默认显示积分条', () => {
    writeSettingsFile(process.env.PROFER_CONFIG_DIR!, {})

    expect(getSettings().showCreditsInSidebar).toBe(true)
  })

  test('Given 关闭积分条 When 更新设置 Then 立即落盘并保持关闭', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ showCreditsInSidebar: false })

    expect(getSettings().showCreditsInSidebar).toBe(false)
    expect(readSettingsFile(configDir).showCreditsInSidebar).toBe(false)
  })

  test('Given 积分条已关闭 When 清缓存重读 Then 仍保持关闭', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { showCreditsInSidebar: false })

    clearSettingsCache()

    expect(getSettings().showCreditsInSidebar).toBe(false)
  })
})

describe('用户消息位置设置', () => {
  test('Given 旧 settings.json 无该键 When 读取 Then 默认显示在右侧', () => {
    writeSettingsFile(process.env.PROFER_CONFIG_DIR!, {})

    expect(getSettings().userMessagePosition).toBe('right')
  })

  test('Given 用户选择左侧 When 更新设置 Then 落盘并保持左侧', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ userMessagePosition: 'left' })

    expect(getSettings().userMessagePosition).toBe('left')
    expect(readSettingsFile(configDir).userMessagePosition).toBe('left')
  })

  test('Given 配置值非法 When 读取或更新 Then 回退到右侧', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { userMessagePosition: 'center' })
    expect(getSettings().userMessagePosition).toBe('right')

    updateSettings({ userMessagePosition: 'center' as 'left' | 'right' })
    expect(getSettings().userMessagePosition).toBe('right')
    expect(readSettingsFile(configDir).userMessagePosition).toBe('right')
  })
})

/**
 * 「手动确认已读」开关的配置层（`design.md` §4.1 / §10 单测第 7 组）。
 *
 * 口径：默认关闭；旧 `settings.json` 无该键时归一为 `false`；开关落盘后主进程读到的
 * 策略模式立即变成 `manual`（**无需重启**，因为 updateSettings 同步更新内存缓存）。
 */
describe('手动确认已读开关', () => {
  test('Given 未落盘任何设置 When 读默认值 Then manualReadConfirmEnabled 为 false', () => {
    expect(getSettings().manualReadConfirmEnabled).toBe(false)
    expect(getAgentUnreadPolicyMode()).toBe('auto')
  })

  test('Given 旧 settings.json 无该键 When 读取 Then 归一为 false', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { themeMode: 'dark', notificationsEnabled: true })

    expect(getSettings().manualReadConfirmEnabled).toBe(false)
    expect(getAgentUnreadPolicyMode()).toBe('auto')
  })

  test('Given 旧文件写了非布尔值 When 读取 Then 归一为 false（只有字面 true 才算开启）', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { manualReadConfirmEnabled: 'true' })

    expect(getSettings().manualReadConfirmEnabled).toBe(false)
    expect(getAgentUnreadPolicyMode()).toBe('auto')
  })

  test('Given 开启开关 When 更新设置 Then 落盘且策略模式立即为 manual（无需重启）', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ manualReadConfirmEnabled: true })

    expect(readSettingsFile(configDir).manualReadConfirmEnabled).toBe(true)
    expect(getSettings().manualReadConfirmEnabled).toBe(true)
    expect(getAgentUnreadPolicyMode()).toBe('manual')
  })

  test('Given 开关已开启 When 再关闭 Then 策略模式立即回到 auto（不追溯清理未读由渲染层负责）', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ manualReadConfirmEnabled: true })
    expect(getAgentUnreadPolicyMode()).toBe('manual')

    updateSettings({ manualReadConfirmEnabled: false })

    expect(readSettingsFile(configDir).manualReadConfirmEnabled).toBe(false)
    expect(getAgentUnreadPolicyMode()).toBe('auto')
  })

  test('Given 落盘为开启 When 进程重启后重读（清缓存） Then 仍为 manual', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { manualReadConfirmEnabled: true })

    clearSettingsCache()

    expect(getSettings().manualReadConfirmEnabled).toBe(true)
    expect(getAgentUnreadPolicyMode()).toBe('manual')
  })
})

describe('文件预览打开方式', () => {
  test('Given 未落盘任何设置 When 读默认值 Then 独立标签页', () => {
    expect(getSettings().previewModePreference).toBe('tab')
  })

  test('Given 旧 settings.json 无该键 When 读取 Then 归一为 tab', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { themeMode: 'dark' })

    expect(getSettings().previewModePreference).toBe('tab')
    expect(getSettings().themeMode).toBe('dark')
  })

  test('Given 落盘非法值 When 读取 Then 回退 tab', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { previewModePreference: 'merged' })

    expect(getSettings().previewModePreference).toBe('tab')
  })

  test('Given 选择与对话分屏 When 更新设置 Then 落盘且重启后保持', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ previewModePreference: 'split' })

    expect(readSettingsFile(configDir).previewModePreference).toBe('split')
    clearSettingsCache()
    expect(getSettings().previewModePreference).toBe('split')
  })

  test('Given 传入非法模式 When 更新设置 Then 写盘值归一为 tab', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ previewModePreference: 'whatever' as never })

    expect(readSettingsFile(configDir).previewModePreference).toBe('tab')
  })
})

describe('建议新开会话的轮数阈值', () => {
  test('Given 未落盘该键 When 读取设置 Then 默认关闭（0）', () => {
    expect(getSettings().handoffSuggestTurnCount).toBe(0)
  })

  test('Given 落盘负数或非数字 When 读取设置 Then 归一为关闭（0）', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { handoffSuggestTurnCount: -5 })
    expect(getSettings().handoffSuggestTurnCount).toBe(0)

    clearSettingsCache()
    writeSettingsFile(configDir, { handoffSuggestTurnCount: '30' })
    expect(getSettings().handoffSuggestTurnCount).toBe(0)
  })

  test('Given 落盘超过上限 When 读取设置 Then 截断到上限', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!
    writeSettingsFile(configDir, { handoffSuggestTurnCount: 9999 })

    expect(getSettings().handoffSuggestTurnCount).toBe(500)
  })

  test('Given 设置为 30 When 更新设置 Then 落盘且重启后保持', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ handoffSuggestTurnCount: 30 })

    expect(readSettingsFile(configDir).handoffSuggestTurnCount).toBe(30)
    clearSettingsCache()
    expect(getSettings().handoffSuggestTurnCount).toBe(30)
  })

  test('Given 传小数 When 更新设置 Then 取整落盘', () => {
    const configDir = process.env.PROFER_CONFIG_DIR!

    updateSettings({ handoffSuggestTurnCount: 12.6 })

    expect(readSettingsFile(configDir).handoffSuggestTurnCount).toBe(13)
  })
})
