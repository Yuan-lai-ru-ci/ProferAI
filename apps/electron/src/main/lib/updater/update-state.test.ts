import { describe, expect, test } from 'bun:test'
import { canReplaceUpdateStatus } from './update-state'

describe('更新状态终态保护', () => {
  test('已下载后，迟到的检查和错误事件不能覆盖重启入口', () => {
    const downloaded = { status: 'downloaded' as const, version: '0.15.53' }
    expect(canReplaceUpdateStatus(downloaded, { status: 'checking' })).toBe(false)
    expect(canReplaceUpdateStatus(downloaded, { status: 'error', error: '网络超时' })).toBe(false)
  })

  test('普通状态仍可正常推进', () => {
    expect(canReplaceUpdateStatus({ status: 'checking' }, { status: 'available', version: '0.15.53' })).toBe(true)
  })
})
