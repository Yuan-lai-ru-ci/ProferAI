/**
 * 测试专用：用 bun:sqlite 冒充 better-sqlite3
 *
 * 生产环境跑在 node + better-sqlite3（原生编译）上，但测试跑在 bun 下，
 * 而 bun 至今不支持 better-sqlite3（ERR_DLOPEN_FAILED，见 oven-sh/bun#4290）。
 *
 * bun:sqlite 的 API 与 better-sqlite3 高度一致（prepare/run/get/all/transaction，
 * 且 .run() 同样返回 { changes, lastInsertRowid }），唯一缺的是 .pragma()。
 * 这里用一个继承 bun:sqlite Database 的适配器补上 .pragma()，再通过
 * mock.module 把 better-sqlite3 的 import 重定向到它。
 *
 * 这样 db.js 里【真实的】扣费/退款/调整 SQL 逻辑会跑在【真实的】内存 SQLite 上，
 * 是真覆盖，而非 stub。
 *
 * 用法（必须在 import('./db.js') 之前调用）：
 *   import { installBunSqliteMock } from './test-helpers/sqlite-bun-adapter.js'
 *   installBunSqliteMock(mock)              // mock 来自 'bun:test'
 *   const dbModule = await import('../db.js')
 */
import { Database as BunDatabase } from 'bun:sqlite'

/** 继承 bun:sqlite，补齐 better-sqlite3 风格的 .pragma()。 */
export class BetterSqliteCompatDatabase extends BunDatabase {
  pragma(statement) {
    // journal_mode=WAL 对 :memory: 无意义且会报错，测试场景直接忽略。
    if (/journal_mode/i.test(statement)) return
    try {
      this.exec(`PRAGMA ${statement}`)
    } catch {
      // 测试环境下个别 pragma 不支持时静默跳过，不影响逻辑覆盖
    }
  }
}

/**
 * 安装 better-sqlite3 → bun:sqlite 适配器。
 * @param {typeof import('bun:test').mock} mock - bun:test 的 mock 对象
 */
export function installBunSqliteMock(mock) {
  mock.module('better-sqlite3', () => ({ default: BetterSqliteCompatDatabase }))
}
