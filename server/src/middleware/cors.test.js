import { describe, expect, test } from 'bun:test'
import { applyCorsHeaders, applySecurityHeaders } from './cors.js'

function context(origin, method = 'GET') {
  return { req: { method, header: (name) => name === 'origin' ? origin : undefined }, res: { headers: new Headers() } }
}

describe('CORS middleware 行为', () => {
  test('Given none When GET 或 OPTIONS Then 不授予跨域但保留安全头', () => {
    const get = context('https://evil.example')
    applyCorsHeaders(get, 'none')
    expect(get.res.headers.get('Access-Control-Allow-Origin')).toBeNull()

    const options = context('https://evil.example', 'OPTIONS')
    applyCorsHeaders(options, 'none')
    applySecurityHeaders(options)
    expect(options.res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(options.res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  test('Given 白名单或显式通配符 When 请求 Then 仅按配置授权', () => {
    const allowed = context('https://app.example.com')
    applyCorsHeaders(allowed, 'https://app.example.com')
    expect(allowed.res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com')
    expect(allowed.res.headers.get('Vary')).toBe('Origin')

    const denied = context('https://evil.example')
    applyCorsHeaders(denied, 'https://app.example.com')
    expect(denied.res.headers.get('Access-Control-Allow-Origin')).toBeNull()

    const wildcard = context('https://localhost:5173')
    applyCorsHeaders(wildcard, '*')
    expect(wildcard.res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
