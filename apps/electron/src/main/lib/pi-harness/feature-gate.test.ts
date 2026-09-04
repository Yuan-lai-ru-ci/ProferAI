import { describe, expect, test } from 'bun:test'
import { PI_HARNESS_FEATURE_ENV, isPiHarnessEnabled } from './feature-gate'

describe('Pi Host Harness feature gate', () => {
  test('fails closed when the environment flag is absent', () => {
    expect(isPiHarnessEnabled({})).toBe(false)
  })

  test('enables only for the explicit controlled opt-in value', () => {
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: '1' })).toBe(true)
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: ' 1 ' })).toBe(true)
  })

  test.each(['0', 'true', 'yes', '', '  ', '1.0'])(
    'fails closed for unsupported value %j',
    (value) => {
      expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: value })).toBe(false)
    },
  )
})
