import { describe, expect, test } from 'bun:test'
import { getWindowsPowerShellPath, mapSDKErrorToTypedError } from './claude-agent-adapter'

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

describe('Claude 适配器上游额度错误', () => {
  test('Given 独立上游 billing 页面 402 When 映射错误 Then 不误报 Profer 余额不足且允许重试', () => {
    const message = 'API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('模型渠道额度暂不可用')
    expect(error.canRetry).toBe(true)
  })
})
