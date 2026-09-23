import { describe, expect, test } from 'bun:test'
import { PI_HARNESS_FEATURE_ENV, isPiHarnessEnabled, shouldStartPiHarness } from './feature-gate'

describe('Pi Host Harness feature gate', () => {
  test('enables by default when the environment flag is absent', () => {
    expect(isPiHarnessEnabled({})).toBe(true)
  })

  test('allows an explicit process-local kill switch', () => {
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: '0' })).toBe(false)
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: ' 0 ' })).toBe(false)
  })

  test('keeps the default-on behavior for non-zero values', () => {
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: '1' })).toBe(true)
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: 'true' })).toBe(true)
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: 'yes' })).toBe(true)
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: '' })).toBe(true)
  })

  test('does not enter Harness startup for Claude', () => {
    let startCalls = 0
    const startIfEnabled = (runtime: 'pi' | 'claude', env: NodeJS.ProcessEnv): string | undefined => {
      if (!shouldStartPiHarness(runtime, env)) return undefined
      startCalls += 1
      return 'started'
    }

    expect(startIfEnabled('claude', {})).toBeUndefined()
    expect(startIfEnabled('claude', { [PI_HARNESS_FEATURE_ENV]: '1' })).toBeUndefined()
    expect(startCalls).toBe(0)
  })

  test('starts Harness for Pi by default and with explicit opt-in', () => {
    expect(shouldStartPiHarness('pi', {})).toBe(true)
    expect(shouldStartPiHarness('pi', { [PI_HARNESS_FEATURE_ENV]: '1' })).toBe(true)
    expect(shouldStartPiHarness('pi', { [PI_HARNESS_FEATURE_ENV]: '0' })).toBe(false)
  })
})
