import { describe, expect, test } from 'bun:test'
import { validateHtml, validateObjects, validateViewState } from './visualization-validation'

// 服务行为测试覆盖落盘；这里针对编码、JSON 和大小边界做最小验证。
describe('visualization validation', () => {
  test('accepts inline CSS/JS, SVG fragments and data image resources', () => {
    expect(() => validateHtml(`<html><head><style>body{background:url("data:image/png;base64,YQ==")}svg{filter:url(#blur)}</style></head><body><svg><defs><filter id="blur"/></defs><use href="#shape"/><image href="data:image/svg+xml,%3Csvg/%3E"/></svg><script>window.foo=1</script></body></html>`)).not.toThrow()
  })

  test('ignores external URL text inside comments and inline script strings', () => {
    expect(() => validateHtml('<html><!-- <img src="https://example.com"> --><body><script>const s="https://example.com";</script></body></html>')).not.toThrow()
  })

  test('rejects resource URLs encoded in entities, CSS escapes or comments', () => {
    for (const html of [
      '<svg><image xlink:href="&#x68;ttps://example.com/x.svg"/></svg>',
      '<img src="file:///tmp/example.png">',
      '<style>body{background:u/**/rl(https://example.com/x.png)}</style>',
      '<style>@import url("data:text/css,body{}");</style>',
      '<script src="data:application/javascript,1"></script>',
      '<a href="https://example.com">external</a>',
      '<iframe srcdoc="hello"></iframe>',
    ]) expect(() => validateHtml(html)).toThrow(/资源|CSS/)
  })

  test('rejects unknown object fields, duplicates and sparse arrays', () => {
    expect(() => validateObjects([{ id: 'a', label: 'A', path: '/tmp/a' }])).toThrow(/对象/)
    expect(() => validateObjects([{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }])).toThrow(/重复/)
    expect(() => validateObjects(Array(1))).toThrow(/数组/)
    expect(() => validateObjects([{ id: 'a', label: 'A', text: 'x'.repeat(2_001) }])).toThrow(/文本/)
  })

  test('rejects accessors, symbols, hidden fields and prototype keys without executing them', () => {
    let called = false
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: () => { called = true; return 1 } })
    const hidden = Object.defineProperty({}, 'secret', { enumerable: false, value: 1 })
    for (const state of [getter, hidden, { [Symbol('x')]: 1 }, { nested: JSON.parse('{"__proto__":1}') }, { sparse: Array(2) }]) {
      expect(() => validateViewState(state)).toThrow(/状态|JSON/)
    }
    expect(called).toBe(false)
  })

  test('accepts exact 16 KiB UTF-8 state and rejects one byte more', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ text: '' }))
    expect(validateViewState({ text: 'x'.repeat(16 * 1024 - overhead) })).toEqual({ text: 'x'.repeat(16 * 1024 - overhead) })
    expect(() => validateViewState({ text: 'x'.repeat(16 * 1024 - overhead + 1) })).toThrow(/16 KiB/)
    expect(() => validateViewState({ text: '中'.repeat(6_000) })).toThrow(/16 KiB/)
  })
})
