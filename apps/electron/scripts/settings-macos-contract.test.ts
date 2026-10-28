import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// 源码接线契约补充：验证 UI 到现有状态/API 的接线，不冒充真实窗口 E2E。
function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
}

function between(text: string, start: string, end: string): string {
  const offset = text.indexOf(start)
  expect(offset).toBeGreaterThanOrEqual(0)
  const endOffset = text.indexOf(end, offset + start.length)
  expect(endOffset).toBeGreaterThan(offset)
  return text.slice(offset, endOffset)
}

describe('Mac 设置页接线契约', () => {
  test('Given 新建渠道有未保存内容 When 遮罩或 Esc 请求关闭 Then 先请求确认', () => {
    const dialog = source('renderer/components/settings/SettingsDialog.tsx')
    const handler = between(dialog, 'const handleOpenChange', '\n  return (')
    expect(handler).toContain('if (!nextOpen && channelFormDirty)')
    expect(handler).toMatch(/setCloseRequested\(true\)\s+return/)
    expect(handler.indexOf('setCloseRequested(true)')).toBeLessThan(handler.indexOf('setOpen(nextOpen)'))
    expect(dialog).toContain('onOpenChange={handleOpenChange}')
  })

  test('Given 未保存渠道 When 跳转教程 Then 保护先于导航且确认后仍打开教程', () => {
    const panel = source('renderer/components/settings/SettingsPanel.tsx')
    const handler = between(panel, 'const handleTabChange', '/** 关闭设置面板')
    expect(handler).toMatch(/channelFormDirty\)\s*\{\s*setPendingAction/)
    expect(handler.indexOf('setPendingAction')).toBeLessThan(handler.indexOf('navigateToTab(tabId)'))
    expect(handler).not.toContain('setSettingsOpen(false)')
    const confirmed = between(panel, 'const executePendingAction', '/** 取消待处理')
    expect(confirmed).toContain('navigateToTab(pendingAction.tabId)')
    const navigate = between(panel, 'const navigateToTab', '/** 执行待处理')
    // 教程与 FRP 教程是文档入口：由 DOC_SETTINGS_TABS 打开主区单例 Tab，再关闭设置面板
    expect(navigate).toContain('const docTab = DOC_SETTINGS_TABS[tabId]')
    expect(navigate).toContain('openTab(mainTabs, docTab)')
    expect(navigate).toContain('setSettingsOpen(false)')
    const docTabs = between(panel, 'const DOC_SETTINGS_TABS', '\n};')
    expect(docTabs).toContain('tutorial: { type: "tutorial", sessionId: TUTORIAL_TAB_ID')
  })

  test('Given Mac 通用设置 When 渲染 Shell 控件 Then 仅 Windows 条件允许显示', () => {
    const general = source('renderer/components/settings/GeneralSettings.tsx')
    expect(general).toContain('const isWindows = detectIsWindows()')
    expect(general).toMatch(/\{isWindows && <SettingsSelect\s+label="Agent Shell 环境"/)
  })

  test('Given 系统登录项被用户修改 When 打开设置或启动 Mac Then 读取系统而不覆盖它', () => {
    const general = source('renderer/components/settings/GeneralSettings.tsx')
    expect(general).toContain('window.electronAPI.getAutoLaunch().then')
    expect(general).not.toContain('setAutoLaunch(settings.autoLaunch')
    expect(general).toContain('disabled={autoLaunchBusy}')
    const startup = between(source('main/index.ts'), "safeRun('applyAutoLaunch'", '// 启动工作区文件监听')
    const mac = between(startup, "if (process.platform === 'darwin')", '\n    const settings')
    expect(mac).toContain('app.getLoginItemSettings().openAtLogin')
    expect(mac).toContain('updateSettings({ autoLaunch: enabled })')
    expect(mac).toContain('return')
    expect(mac).not.toContain('setLoginItemSettings')
    // 非 Mac 保留原行为，避免本次兼容修复改变 Windows 启动逻辑。
    expect(startup).toContain('app.setLoginItemSettings({ openAtLogin: enabled })')
  })

  test('Given 开发版只能手动下载更新 When 设置页展示 Then 引导打开发布页且类型贯通 IPC', () => {
    const about = source('renderer/components/settings/AboutSettings.tsx')
    expect(about).toContain("case 'disabled':")
    expect(about).toContain('当前版本暂不支持应用内更新')
    // 开发版不再因 'disabled' 禁用检查按钮：自动安装仍不可用，但可以查最新 Release。
    expect(about).toContain('disabled={isChecking}')
    expect(about).not.toContain("status.status === 'disabled'")
    // 开发版发现新版本时只给手动下载入口，不进入 quitAndInstall 流程。
    expect(about).toContain("status.manualUrl && status.status === 'available'")
    expect(about).toContain('请手动下载')
    expect(about).toContain('handleOpenManualUpdate')
    for (const path of ['renderer/atoms/updater.ts', 'renderer/vite-env.d.ts', 'preload/index.ts']) {
      expect(source(path)).toContain("| 'disabled' | 'error'")
    }
  })
})

test('快速任务 Mac/Windows 默认值与主进程一致，设置文案跟随自定义绑定', () => {
  const defaults = source('renderer/lib/shortcut-defaults.ts')
  const quickTask = between(defaults, "id: 'quick-task'", "id: 'show-main-window'")
  expect(quickTask).toContain("defaultMac: 'Cmd+Shift+Space'")
  expect(quickTask).toContain("defaultWin: 'Alt+Space'")
  expect(source('main/lib/global-shortcut-service.ts')).toContain("'quick-task': { mac: 'Cmd+Shift+Space', win: 'Alt+Space' }")
  const general = source('renderer/components/settings/GeneralSettings.tsx')
  expect(general).not.toContain('Alt+Space')
  expect(general).toContain('getAcceleratorDisplay(quickTaskAccelerator)')
  expect(general).toContain('quickTaskOverride === null ? null')
  expect(general).toContain("results['quick-task'] === true")
})
