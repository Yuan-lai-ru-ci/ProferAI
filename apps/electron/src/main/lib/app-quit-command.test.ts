import { describe, expect, test } from 'bun:test'
import { isQuitRequest, QUIT_REQUEST_FLAG } from './app-quit-command'

describe('外部退出请求', () => {
  test('Given 安装器传入 --quit When 解析 argv Then 识别为退出请求', () => {
    expect(QUIT_REQUEST_FLAG).toBe('--quit')
    expect(isQuitRequest(['/Applications/Profer.app/Contents/MacOS/Profer', '--quit'])).toBe(true)
    expect(isQuitRequest(['C:\\Program Files\\Profer\\Profer.exe', '--quit'])).toBe(true)
  })

  test('Given 普通启动或文件关联参数 When 解析 argv Then 不误判', () => {
    expect(isQuitRequest(['Profer.exe'])).toBe(false)
    expect(isQuitRequest(['Profer.exe', 'C:\\tmp\\a.profer-backup'])).toBe(false)
    // 必须是独立参数，拼在路径里不算。
    expect(isQuitRequest(['Profer.exe', '--quit=true'])).toBe(false)
  })
})
