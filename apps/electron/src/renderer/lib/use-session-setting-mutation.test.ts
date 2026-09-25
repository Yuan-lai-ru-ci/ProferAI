import { describe, expect, test } from 'bun:test'
import { isLatestSessionSettingRequest } from './use-session-setting-mutation'

describe('session setting mutation ordering', () => {
  test('only the latest request may apply an asynchronous result', () => {
    expect(isLatestSessionSettingRequest(1, 2)).toBe(false)
    expect(isLatestSessionSettingRequest(2, 2)).toBe(true)
  })

  test('a stale response cannot become authoritative after a newer request', () => {
    expect(isLatestSessionSettingRequest(1, 3)).toBe(false)
    expect(isLatestSessionSettingRequest(3, 3)).toBe(true)
  })
})
