import { beforeAll, describe, expect, test, mock } from 'bun:test'
import { installBunSqliteMock } from '../test-helpers/sqlite-bun-adapter.js'

// credit-gate.js import 链顶层加载 config.js（JWT_SECRET 缺失时 process.exit(1)）与 db.js
// （better-sqlite3 在 bun 下 ERR_DLOPEN_FAILED）。静态 import 被 ESM 提升，env 赋值来不及；
// 必须动态 import + 先安装 sqlite 适配器（与 api-keys-db/config-store 同款模式）。
process.env.JWT_SECRET = 'x'.repeat(64)
process.env.DB_PATH = ':memory:'
installBunSqliteMock(mock)

let exceedsOverdraftLimit

beforeAll(async () => {
  const mod = await import('./credit-gate.js')
  exceedsOverdraftLimit = mod.exceedsOverdraftLimit
})

describe('credit gate 动态透支边界', () => {
  test('Given 动态透支为 50 When 余额恰好在边界 Then 仍允许', () => {
    expect(exceedsOverdraftLimit(-50, 50)).toBe(false)
  })

  test('Given 动态透支为 50 When 余额低于边界 Then 拒绝', () => {
    expect(exceedsOverdraftLimit(-51, 50)).toBe(true)
  })
})
