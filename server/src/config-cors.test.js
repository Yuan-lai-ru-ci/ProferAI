import { describe, expect, test } from 'bun:test'
import { resolveAllowedOrigin } from './cors-config.js'

describe('CORS 缺省配置', () => {
  test('Given 未设置或空白 ALLOWED_ORIGIN When 加载配置 Then fail-closed 为 none', () => {
    expect(resolveAllowedOrigin(undefined)).toBe('none')
    expect(resolveAllowedOrigin('   ')).toBe('none')
  })

  test('Given 显式开发通配符或生产白名单 When 加载配置 Then 保持显式值', () => {
    expect(resolveAllowedOrigin('*')).toBe('*')
    expect(resolveAllowedOrigin('https://app.example.com')).toBe('https://app.example.com')
  })
})
