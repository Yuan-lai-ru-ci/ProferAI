/**
 * server/src/utils 测试
 *
 * 覆盖密码哈希、路径安全校验等纯函数。
 */
import { beforeAll, describe, test, expect } from 'bun:test'
import { join } from 'node:path'

// utils.js 引入 TRUST_PROXY 后 import 链会顶层加载 config.js（JWT_SECRET 缺失时 process.exit(1)）。
// 静态 import 被 ESM 提升，env 赋值来不及；必须动态 import（与 api-keys-db/newapi-client 同款模式）。
process.env.JWT_SECRET = 'x'.repeat(64)

let utils

beforeAll(async () => {
  utils = await import('./utils.js')
})

describe('hashPassword / verifyPassword', () => {
  test('哈希和验证一致性', () => {
    const hash = utils.hashPassword('myPassword123')
    expect(hash).toBeTypeOf('string')
    expect(hash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/)

    expect(utils.verifyPassword('myPassword123', hash)).toBe(true)
    expect(utils.verifyPassword('wrongPassword', hash)).toBe(false)
  })

  test('相同密码使用随机盐生成不同哈希', () => {
    const h1 = utils.hashPassword('test')
    const h2 = utils.hashPassword('test')
    expect(h1).not.toBe(h2)
    expect(utils.verifyPassword('test', h1)).toBe(true)
    expect(utils.verifyPassword('test', h2)).toBe(true)
  })

  test('不同密码生成不同哈希', () => {
    const h1 = utils.hashPassword('password1')
    const h2 = utils.hashPassword('password2')
    expect(h1).not.toBe(h2)
  })
})

describe('safePath', () => {
  const { sep } = require('node:path')
  const root = sep === '\\' ? 'C:\\data' : '/data'

  test('合法路径通过检查', () => {
    const result = utils.safePath(root, 'file.txt')
    expect(result).not.toBeNull()
    if (result) {
      expect(result.endsWith('file.txt')).toBe(true)
    }
  })

  test('路径遍历被拦截', () => {
    const result = utils.safePath(root, '..', '..', 'etc', 'passwd')
    expect(result).toBeNull()
  })

  test('root 自身通过检查', () => {
    const result = utils.safePath(root)
    expect(result).toBe(root)
  })

  test('多级合法子路径', () => {
    const result = utils.safePath(root, 'a', 'b', 'c.txt')
    expect(result).not.toBeNull()
    if (result) {
      expect(result).toBe(join(root, 'a', 'b', 'c.txt'))
    }
  })

  test('带 ../ 的复杂路径', () => {
    // a/../b 会被归一化为 b，仍在 root 下
    const result = utils.safePath(root, 'a', '..', 'b', 'file.txt')
    expect(result).not.toBeNull()
    if (result) {
      expect(result).toBe(join(root, 'b', 'file.txt'))
    }
  })
})
