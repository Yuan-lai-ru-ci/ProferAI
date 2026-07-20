import { describe, expect, test } from 'bun:test'
import { getWindowsPowerShellPath, mapSDKErrorToTypedError, SDK_SETTING_SOURCES } from './claude-agent-adapter'

describe('Claude 适配器 Windows 清理命令', () => {
  test('Given PowerShell 未加入 PATH 但系统组件存在 When 解析 Then 使用 SystemRoot 下的绝对路径', () => {
    const path = getWindowsPowerShellPath(
      { SystemRoot: 'C:\\Windows' },
      (candidate) => candidate === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(path).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  test('Given 系统组件不可用 When 解析 Then 安全降级为 null', () => {
    expect(getWindowsPowerShellPath({ SystemRoot: 'C:\\Windows' }, () => false)).toBeNull()
    expect(getWindowsPowerShellPath({}, () => true)).toBeNull()
  })
})

describe('Claude 适配器 SDK 设置隔离', () => {
  test('Given Profer Agent SDK 查询 When 配置设置来源 Then 不加载用户级 Claude 设置', () => {
    expect(SDK_SETTING_SOURCES).toEqual(['project'])
    expect(SDK_SETTING_SOURCES).not.toContain('user')
  })
})

describe('Claude 适配器上游额度错误', () => {
  test('Given 独立上游 billing 页面 402 When 映射错误 Then 识别为不可自动重试的额度不足', () => {
    const message = 'API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('insufficient_credits')
    expect(error.title).toBe('额度不足')
    expect(error.canRetry).toBe(false)
  })
})
