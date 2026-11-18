import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, 'migration-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('迁移 IPC 注册（结构检查）', () => {
  test('覆盖导入导出和文件对话框通道', () => {
    for (const channel of ['migration:getExportPreview', 'migration:getShareExportPreview', 'migration:export', 'migration:exportV2', 'migration:cancelExport', 'migration:parseImportFile', 'migration:confirmImport', 'migration:openFileDialog', 'migration:saveFileDialog']) expect(source).toContain(channel)
  })
  test('ipc.ts 只保留注册入口', () => expect(ipc).toContain('registerMigrationIpc()'))
})
