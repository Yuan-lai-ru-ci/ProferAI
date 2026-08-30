import { describe, expect, test } from 'bun:test'
import { friendlyErrorMessage, getWindowsPowerShellPath, mapSDKErrorToTypedError, SDK_SETTING_SOURCES } from './claude-agent-adapter'

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

describe('Claude 适配器 Ollama 工具流错误', () => {
  test('Given Ollama tool-result stream error When mapping Then do not classify as transient network retry', () => {
    const message = 'API Error: 500 no user query found in messages'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('Ollama 工具流兼容性错误')
    expect(error.canRetry).toBe(false)
    expect(friendlyErrorMessage(message)).toContain('Ollama')
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

  test('Given 上游供应通道账户余额不足 When 映射错误 Then 不引导用户充值且可重试', () => {
    const message = 'API Error: 403 {"error":"当前模型供应通道额度不足","code":"upstream_channel_insufficient"}'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('模型供应通道暂不可用')
    expect(error.canRetry).toBe(true)
    expect(error.actions.some((action) => action.action === 'open_credits')).toBe(false)
  })
})
