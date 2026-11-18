import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCorePiSessionDir } from './pi-session-location'

const temporaryRoots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'profer-core-pi-location-'))
  temporaryRoots.push(root)
  return { root, current: join(root, 'pi-sessions'), legacy: join(root, 'sdk-config', 'sessions', 'pi') }
}
function transcript(root: string, name: string, id: string) {
  mkdirSync(root, { recursive: true })
  const file = join(root, name)
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(0).toISOString(), cwd: root }) + '\n')
  return file
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Core Pi 上下文位置', () => {
  test('新会话仍使用 Core 目录，不触碰旧上下文', () => {
    const { root, current, legacy } = setup()
    const file = transcript(legacy, 'old.jsonl', 'old-id')
    const before = readFileSync(file, 'utf8')
    expect(resolveCorePiSessionDir(root)).toBe(current)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('迁移后按 header ID 找到旧目录中任意文件名的上下文，保持文件不变', () => {
    const { root, legacy } = setup()
    const file = transcript(join(legacy, 'cwd-folder'), 'unrelated-name.jsonl', 'old-id')
    const before = readFileSync(file, 'utf8')
    expect(resolveCorePiSessionDir(root, 'old-id')).toBe(legacy)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('Core 新目录中的已有会话仍可恢复', () => {
    const { root, current } = setup()
    transcript(current, 'new.jsonl', 'new-id')
    expect(resolveCorePiSessionDir(root, 'new-id')).toBe(current)
  })

  test('两个目录都存在时按准确 ID 选择旧或新根', () => {
    const { root, current, legacy } = setup()
    transcript(current, 'new.jsonl', 'new-id')
    transcript(legacy, 'old.jsonl', 'old-id')
    expect(resolveCorePiSessionDir(root, 'old-id')).toBe(legacy)
    expect(resolveCorePiSessionDir(root, 'new-id')).toBe(current)
  })

  test('文件名包含目标 ID 但 header 不匹配时拒绝，不以空会话替代', () => {
    const { root, legacy } = setup()
    transcript(legacy, 'wanted-id.jsonl', 'other-id')
    expect(() => resolveCorePiSessionDir(root, 'wanted-id')).toThrow('未找到')
  })

  test('同 ID 多文件或跨根重复时拒绝任选', () => {
    const { root, current, legacy } = setup()
    transcript(current, 'one.jsonl', 'same-id')
    transcript(legacy, 'two.jsonl', 'same-id')
    expect(() => resolveCorePiSessionDir(root, 'same-id')).toThrow('多个')
  })

  test('只在正式版或外部目录有文件时拒绝访问', () => {
    const { root } = setup()
    const external = setup()
    transcript(external.legacy, 'old.jsonl', 'old-id')
    expect(() => resolveCorePiSessionDir(root, 'old-id')).toThrow('未找到')
  })

  test('Pi 根通过目录链接指向其他数据目录时拒绝', () => {
    const { root, current } = setup()
    const external = setup()
    transcript(external.current, 'old.jsonl', 'old-id')
    symlinkSync(external.current, current, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolveCorePiSessionDir(root, 'old-id')).toThrow('未找到')
  })
})
