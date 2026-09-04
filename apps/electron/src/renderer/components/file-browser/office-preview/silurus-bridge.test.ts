import { describe, expect, test } from 'bun:test'
import { clampOfficeScale, getRenderedPptxSlideCanvas, normalizeOfficeFormat } from './silurus-bridge'

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

  test('returns a canvas only after the requested virtualized slide finished rendering', () => {
    const canvas = { isConnected: true } as HTMLCanvasElement
    const viewer = { _slots: new Map([[2, { canvas, renderedSlide: 2, renderedScale: 0.75 }]]) }
    expect(getRenderedPptxSlideCanvas(viewer as never, 2)).toBe(canvas)
    expect(getRenderedPptxSlideCanvas(viewer as never, 1)).toBeNull()
    expect(getRenderedPptxSlideCanvas({ _slots: new Map([[2, { canvas, renderedSlide: 1, renderedScale: 0.75 }]]) } as never, 2)).toBeNull()
    expect(getRenderedPptxSlideCanvas({ _slots: new Map([[2, { canvas, renderedSlide: 2, renderedScale: -1 }]]) } as never, 2)).toBeNull()
  })
})
