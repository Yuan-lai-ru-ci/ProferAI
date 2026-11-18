import { createRequire } from 'node:module'
import type { PlanningSqliteDatabase } from '@profer/session-store'

const require = createRequire(import.meta.url)

/** Both runtimes use their native SQLite engine; no Node compatibility shim under Bun. */
export function openCorePlanningDatabase(path: string): PlanningSqliteDatabase {
  if (!process.versions.bun) {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => PlanningSqliteDatabase }
    return new DatabaseSync(path)
  }
  interface Statement {
    all(params: Record<string, unknown>): unknown[]
    get(params: Record<string, unknown>): unknown
    run(params: Record<string, unknown>): unknown
    finalize(): void
  }
  const { Database } = require('bun:sqlite') as { Database: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): Statement
    close(): void
  } }
  const db = new Database(path)
  const statements = new Map<string, Statement>()
  return {
    exec: sql => db.exec(sql),
    close: () => { for (const statement of statements.values()) statement.finalize(); db.close() },
    prepare(sql) {
      let statement = statements.get(sql)
      if (!statement) {
        statement = db.prepare(sql)
        statements.set(sql, statement)
      }
      const prepared = statement
      const parameters = (input: Record<string, unknown> = {}) => Object.fromEntries(
        Object.entries(input).map(([key, value]) => [':' + key, value]),
      )
      return {
        all: input => prepared.all(parameters(input)),
        get: input => prepared.get(parameters(input)),
        run: input => prepared.run(parameters(input)),
      }
    },
  }
}
