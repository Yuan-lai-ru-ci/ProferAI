import { describe, expect, test } from 'bun:test'
import { clampOfficeScale, normalizeOfficeFormat } from './silurus-bridge'

describe('silurus bridge helpers', () => {
  test('routes supported Office extensions', () => {
    expect(normalizeOfficeFormat('报告.DOCX')).toBe('docx')
    expect(normalizeOfficeFormat('预算.xlsx')).toBe('xlsx')
    expect(normalizeOfficeFormat('/tmp/slides.PPTX')).toBe('pptx')
    expect(normalizeOfficeFormat('legacy.doc')).toBeNull()
  })

  test('clamps invalid and out-of-range scales', () => {
    expect(clampOfficeScale(Number.NaN)).toBe(1)
    expect(clampOfficeScale(0.1)).toBe(0.25)
    expect(clampOfficeScale(2.5)).toBe(2.5)
    expect(clampOfficeScale(9)).toBe(4)
  })
})
