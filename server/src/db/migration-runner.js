/**
 * SQL-first 迁移执行器。
 *
 * 不引 ORM：每个迁移都有稳定 ID，并由 schema_migrations 记录，避免用静默
 * ALTER TABLE 掩盖真正的 schema 错误。迁移必须同步、可重复执行。
 */
export function runMigrations(db, migrations) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
  const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')

  for (const migration of migrations) {
    if (isApplied.get(migration.id)) continue
    db.transaction(() => {
      migration.up(db)
      record.run(migration.id, Date.now())
    })()
  }
}
