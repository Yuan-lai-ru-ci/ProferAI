import { describe, expect, test } from 'bun:test'
import { PROFER_PERMISSION_MODE_ORDER } from '@profer/shared'
import { buildPermissionModeMenu, resolveSelectorMode } from './permission-mode-selector-utils'

describe('permission-mode-selector-utils', () => {
  test('每种预设默认下所有模式均可由用户明确选择，顺序同源', () => {
    for (const presetDefault of PROFER_PERMISSION_MODE_ORDER) {
      expect(buildPermissionModeMenu(presetDefault)).toEqual(PROFER_PERMISSION_MODE_ORDER.map(mode => ({ mode, selectable: true })))
      for (const chosen of PROFER_PERMISSION_MODE_ORDER) expect(resolveSelectorMode(presetDefault, chosen)).toBe(chosen)
    }
  })
  test('尚无权威选择时跟随预设默认', () => {
    expect(resolveSelectorMode('plan', undefined)).toBe('plan')
    expect(resolveSelectorMode('auto', undefined)).toBe('auto')
  })
})
