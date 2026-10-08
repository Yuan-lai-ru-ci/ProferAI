import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const settingsDir = new URL('.', import.meta.url)

function readSettingsFile(name: string): string {
  return readFileSync(new URL(name, settingsDir), 'utf8')
}

describe('远程连接设置重构契约', () => {
  test('Hub 保留六个入口并由外层 SettingsPanel 负责滚动', () => {
    const source = readSettingsFile('./BotHubSettings.tsx')

    for (const id of ['pocket', 'feishu', 'wechat', 'dingtalk', 'defaults', 'logos']) {
      expect(source).toContain(`id: '${id}'`)
    }
    expect(source).not.toContain("from '@profer/ui/primitives/scroll-area'")
    expect(source).not.toContain('className="-mx-6 -my-5')
    expect(source).toContain('aria-current={isActive ? \'page\' : undefined}')
    expect(source).toContain('aria-controls={`bot-settings-panel-${platform.id}`}')
  })

  test('默认配置与 Logo 页面保持现有能力并具备响应式布局契约', () => {
    const defaults = readSettingsFile('./BotDefaultSettings.tsx')
    const logos = readSettingsFile('./ProferLogoSettings.tsx')

    expect(defaults).toContain('window.electronAPI.updateSettings')
    expect(defaults).toContain('role="alert"')
    expect(defaults).toContain('grid-cols-[minmax(110px,140px)_minmax(0,1fr)]')
    expect(logos).toContain('window.electronAPI.saveResourceFileAs')
    expect(logos).toContain('repeat(auto-fit,minmax(150px,1fr))')
  })
})
