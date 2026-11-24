import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertOperablePath, copyEntry, moveEntry, readEntryPreview, renameEntry, trashEntry } from './core-fs-ops'

const cleanup: string[] = []
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-fs-scope-'))); cleanup.push(root)
  const config = join(root, 'config'), workbench = join(config, 'session-workspaces', 'sid')
  mkdirSync(workbench, { recursive: true })
  writeFileSync(join(workbench, 'result.txt'), 'result')
  writeFileSync(join(config, 'credential.json'), 'private')
  return { root, config, workbench, file: join(workbench, 'result.txt') }
}
describe('会话工作台是 Core 配置保护中的受限例外', () => {
  test('Given 默认系统操作 When 指向工作台 Then 仍然拒绝', () => {
    const { config, workbench, file } = fixture()
    for (const path of [config, workbench, file]) expect(() => assertOperablePath(path, config)).toThrow()
    expect(() => renameEntry(file, 'new.txt', config)).toThrow()
    expect(() => trashEntry(file, config)).toThrow()
    expect(() => readEntryPreview(file, config)).toThrow()
  })
  test('Given 显式当前工作台 When 读写子文件 Then 成功，但不准操作工作台根及其他配置', () => {
    const { config, workbench, file } = fixture()
    expect(readEntryPreview(file, config, undefined, workbench)?.base64).toBe(Buffer.from('result').toString('base64'))
    const renamed = renameEntry(file, 'renamed.txt', config, workbench).path
    mkdirSync(join(workbench, 'copies'))
    const copied = copyEntry(renamed, join(workbench, 'copies'), config, false, workbench).path
    mkdirSync(join(workbench, 'moved'))
    const moved = moveEntry(copied, join(workbench, 'moved'), config, false, workbench).path
    const trash = trashEntry(moved, config, workbench).path
    expect(readFileSync(trash, 'utf8')).toBe('result')
    for (const path of [workbench, config, join(config, 'credential.json'), join(config, 'session-workspaces')]) {
      expect(() => trashEntry(path, config, workbench)).toThrow()
    }
    expect(() => moveEntry(renamed, config, config, false, workbench)).toThrow()
    expect(() => renameEntry(renamed, '../credential.json', config, workbench)).toThrow()
  })
  test('Given 工作台内链接指向凭据或其他会话 When 读取/写入 Then 不放开链接真实路径', () => {
    const { config, workbench, file } = fixture()
    const other = join(config, 'session-workspaces', 'other')
    mkdirSync(other); writeFileSync(join(other, 'private.txt'), 'other')
    symlinkSync(other, join(workbench, 'escape'))
    symlinkSync(join(config, 'credential.json'), join(workbench, 'credential-link'))
    for (const path of [join(workbench, 'credential-link'), join(workbench, 'escape', 'private.txt')]) {
      expect(() => readEntryPreview(path, config, undefined, workbench)).toThrow()
    }
    expect(() => copyEntry(file, join(workbench, 'escape'), config, false, workbench)).toThrow()
    // 即使工作台路径本身是链接，也不能把它当作另一个配置目录的授权凭证。
    const fake = join(config, 'session-workspaces', 'fake')
    symlinkSync(config, fake)
    expect(() => readEntryPreview(join(fake, 'credential.json'), config, undefined, fake)).toThrow()
  })
})
