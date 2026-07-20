import { describe, expect, test } from 'bun:test'
import { isRetryablePaperpipeSyncError } from './kb-paperpipe-retry-utils'

function errorWithStatus(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe('Paperpipe PDF 显式重试策略', () => {
  test('Given 网络层错误 When 判断 Then 允许用户稍后重试', () => {
    expect(isRetryablePaperpipeSyncError(new Error('fetch failed'))).toBe(true)
  })

  test('Given Bridge 暂时不可用或超时 When 判断 Then 允许用户重试', () => {
    expect(isRetryablePaperpipeSyncError(errorWithStatus(502))).toBe(true)
    expect(isRetryablePaperpipeSyncError(errorWithStatus(504))).toBe(true)
  })

  test('Given 文件、鉴权或业务错误 When 判断 Then 不建议重复上传', () => {
    for (const status of [400, 401, 403, 413, 415, 500]) {
      expect(isRetryablePaperpipeSyncError(errorWithStatus(status))).toBe(false)
    }
  })
})
