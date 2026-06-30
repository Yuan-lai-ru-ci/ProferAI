/**
 * server/src/utils 测试
 *
 * 覆盖密码哈希、路径安全校验等纯函数。
 */
import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { hashPassword, verifyPassword, safePath } from './utils.js'

describe('hashPassword / verifyPassword', () => {
  test('哈希和验证一致性', () => {
    const hash = hashPassword('myPassword123')
    expect(hash).toBeTypeOf('string')
    expect(hash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/)

    expect(verifyPassword('myPassword123', hash)).toBe(true)
    expect(verifyPassword('wrongPassword', hash)).toBe(false)
  })

  test('相同密码使用随机盐生成不同哈希', () => {
    const h1 = hashPassword('test')
    const h2 = hashPassword('test')
    expect(h1).not.toBe(h2)
    expect(verifyPassword('test', h1)).toBe(true)
    expect(verifyPassword('test', h2)).toBe(true)
  })

  test('不同密码生成不同哈希', () => {
    const h1 = hashPassword('password1')
    const h2 = hashPassword('password2')
    expect(h1).not.toBe(h2)
  })
})

describe('safePath', () => {
  const { sep } = require('node:path')
  const root = sep === '\\' ? 'C:\\data' : '/data'

  test('合法路径通过检查', () => {
    const result = safePath(root, 'file.txt')
    expect(result).not.toBeNull()
    if (result) {
      expect(result.endsWith('file.txt')).toBe(true)
    }
  })

  test('路径遍历被拦截', () => {
    const result = safePath(root, '..', '..', 'etc', 'passwd')
    expect(result).toBeNull()
  })

  test('root 自身通过检查', () => {
    const result = safePath(root)
    expect(result).toBe(root)
  })

  test('多级合法子路径', () => {
    const result = safePath(root, 'a', 'b', 'c.txt')
    expect(result).not.toBeNull()
    if (result) {
      expect(result).toBe(join(root, 'a', 'b', 'c.txt'))
    }
  })

  test('带 ../ 的复杂路径', () => {
    // a/../b 会被归一化为 b，仍在 root 下
    const result = safePath(root, 'a', '..', 'b', 'file.txt')
    expect(result).not.toBeNull()
    if (result) {
      expect(result).toBe(join(root, 'b', 'file.txt'))
    }
  })
})
