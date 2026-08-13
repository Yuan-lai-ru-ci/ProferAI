import { describe, test, expect, beforeEach } from 'bun:test'
import { migrateLocalStorageKeys } from './localstorage-migration.ts'

/**
 * localstorage-migration 迁移逻辑验证（覆盖本次新增的浏览器 key）。
 * 通过查询参数打破模块缓存，模拟每次调用的独立初始状态。
 */

function makeStore() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    has: (k: string) => m.has(k),
  }
}

describe('migrateLocalStorageKeys', () => {
  test('新浏览器 split-ratio key 迁移正确', async () => {
    const store = makeStore()
    store.setItem('proma-browser-split-ratio', '0.6')
    // 用 fresh import 重置模块级 migrated 标志
    const { migrateLocalStorageKeys: run } = await import(`./localstorage-migration.ts?t=${Date.now()}-split`)
    ;(globalThis as any).localStorage = store
    run()
    expect(store.getItem('profer-browser-split-ratio')).toBe('0.6')
  })

  test('新浏览器 file-panel key 迁移正确', async () => {
    const store = makeStore()
    store.setItem('proma-browser-file-panel-manual-restore-session-ids', '["s1","s2"]')
    const { migrateLocalStorageKeys: run } = await import(`./localstorage-migration.ts?t=${Date.now()}-fp`)
    ;(globalThis as any).localStorage = store
    run()
    expect(store.getItem('profer-browser-file-panel-manual-restore-session-ids')).toBe('["s1","s2"]')
  })

  test('无旧 key 时不写新 key（数据安全）', () => {
    const store = makeStore()
    ;(globalThis as any).localStorage = store
    migrateLocalStorageKeys()
    expect(store.has('profer-browser-split-ratio')).toBe(false)
  })
})
