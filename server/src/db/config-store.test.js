import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBunSqliteMock } from '../test-helpers/sqlite-bun-adapter.js'

installBunSqliteMock(mock)

let tempDir
let dbModule

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'profer-config-store-'))
  process.env.JWT_SECRET = 'x'.repeat(64)
  process.env.DB_PATH = join(tempDir, 'test.db')
  process.env.DATA_DIR = tempDir
  dbModule = await import('../db.js')
})

afterAll(() => {
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
})

describe('计费配置单一事实来源', () => {
  test('Given DB 覆盖值 When 读取 billing snapshot Then 覆盖默认值且无需重启立即生效', () => {
    const { setConfigs, resetConfig, getBillingConfig } = dbModule
    resetConfig('billing.markup')
    resetConfig('billing.defaultCreditGrant')
    resetConfig('billing.overdraftLimit')

    setConfigs({
      'billing.markup': 1.5,
      'billing.defaultCreditGrant': 123456,
      'billing.overdraftLimit': 789,
    }, 'admin-config-test')

    expect(getBillingConfig()).toEqual({
      markup: 1.5,
      defaultCreditGrant: 123456,
      overdraftLimit: 789,
    })
  })

  test('Given 非法数字或类型 When 设置配置 Then 拒绝且不污染现有有效值', () => {
    const { getConfig, setConfig, setConfigs } = dbModule
    const before = getConfig('billing.markup')

    for (const value of [NaN, Infinity, -1, 0, '1.2abc', '  ', {}, [], true]) {
      expect(() => setConfig('billing.markup', value, 'admin-config-test')).toThrow(/配置值无效/)
    }
    expect(getConfig('billing.markup')).toBe(before)

    const oldGrant = getConfig('billing.defaultCreditGrant')
    expect(() => setConfigs({
      'billing.defaultCreditGrant': 777,
      'billing.markup': 'not-a-number',
    }, 'admin-config-test')).toThrow(/配置值无效/)
    expect(getConfig('billing.defaultCreditGrant')).toBe(oldGrant)
  })

  test('Given 未知 key When 重置或批量更新 Then 整体拒绝', () => {
    const { resetConfig, setConfigs } = dbModule
    expect(() => resetConfig('billing.missing')).toThrow(/未知配置项/)
    expect(() => setConfigs({ 'billing.markup': 1.2, 'billing.missing': 1 }, 'admin-config-test')).toThrow(/未知配置项/)
  })
})
