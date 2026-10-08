import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (name: string): string => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8')

// 接线契约不是 GUI 测试；确认错误反馈与持久化/回滚接到同一处理器。
describe('偏好设置持久化接线', () => {
  test('首页保存校验协议，失败保留输入并提供可见错误', () => {
    const general = source('GeneralSettings')
    expect(general).toContain("if (!['http:', 'https:'].includes(url.protocol))")
    expect(general).toContain('savedHomeUrlRef.current = trimmed')
    expect(general).toContain('error={browserHomeError}')
    expect(general).toContain("setBrowserHomeError('首页保存失败")
    expect(general.indexOf("if (!['http:', 'https:']")).toBeLessThan(general.indexOf('await api.updateBrowserHomeUrl'))
  })

  test('通用设置加载失败不允许改写假默认值，快速任务和 Shell 失败回滚', () => {
    const general = source('GeneralSettings')
    expect(general).toContain('role="alert"')
    expect(general).toContain('disabled={settingsLoading || Boolean(settingsError) || quickTaskBusy}')
    expect(general).toContain('disabled={settingsLoading || Boolean(settingsError) || shellBusy}')
    expect(general).toContain('setQuickTaskEnabled(previous)')
    expect(general).toContain('setShellPreference(previous)')
    expect(general).toContain("toast.error('快速任务设置保存失败")
    expect(general).toContain("toast.error('Shell 偏好保存失败")
  })

  test('Agent effort 沿用 mutation 的失败回滚和禁用状态', () => {
    const agent = source('AgentSettings')
    expect(agent).toContain('useSessionSettingMutation()')
    expect(agent).toContain('rollback: () => setEffort(previous)')
    expect(agent).toContain('disabled={pending}')
    expect(agent).toContain("toast.error('思考强度保存失败")
    expect(agent).not.toContain('.catch(console.error)')
    expect(agent).toContain('实际支持的档位由内核与模型决定')
  })
})
