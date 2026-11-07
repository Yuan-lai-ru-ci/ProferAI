import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const previousConfigDir = process.env.PROFER_CONFIG_DIR
const roots: string[] = []

function useTempConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-global-memory-'))
  roots.push(root)
  process.env.PROFER_CONFIG_DIR = join(root, 'config')
  return root
}

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigDir
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('global-memory-service', () => {
  test('initializes shared index and topic files, then reads and searches them', async () => {
    useTempConfig()
    const service = await import(`./global-memory-service?case=${Date.now()}-${Math.random()}`)
    const summary = service.getGlobalMemorySummary()
    expect(summary.indexExists).toBe(true)
    expect(summary.fileCount).toBe(6)
    expect(service.readGlobalMemoryFile('MEMORY.md').content).toContain('user-profile.md')

    service.writeGlobalMemoryFile('user-profile.md', '# 用户背景\n\n偏好 TypeScript。\n')
    expect(service.readGlobalMemoryFile('user-profile.md').content).toContain('TypeScript')
    expect(service.searchGlobalMemory('typescript')).toMatchObject([{ relativePath: 'user-profile.md' }])
  })

  test('rejects traversal, non-Markdown files, and deleting the index', async () => {
    useTempConfig()
    const service = await import(`./global-memory-service?case=${Date.now()}-${Math.random()}`)
    for (const path of ['../outside.md', '/tmp/outside.md', 'notes.txt', 'a\\b.md']) {
      expect(() => service.readGlobalMemoryFile(path)).toThrow()
      expect(() => service.writeGlobalMemoryFile(path, 'x')).toThrow()
    }
    expect(() => service.deleteGlobalMemoryFile('MEMORY.md')).toThrow('不能删除')
  })

  test('does not follow a symlink outside the memory root', async () => {
    const root = useTempConfig()
    const service = await import(`./global-memory-service?case=${Date.now()}-${Math.random()}`)
    service.getGlobalMemorySummary()
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'secret')
    const link = join(service.getGlobalMemoryDir(), 'escape.md')
    try { symlinkSync(outside, link) } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    expect(() => service.readGlobalMemoryFile('escape.md')).toThrow()
    expect(existsSync(outside)).toBe(true)
  })

  test('deletes a topic file but keeps the index', async () => {
    useTempConfig()
    const service = await import(`./global-memory-service?case=${Date.now()}-${Math.random()}`)
    service.deleteGlobalMemoryFile('preferences.md')
    expect(() => service.readGlobalMemoryFile('preferences.md')).toThrow('不存在')
    expect(service.readGlobalMemoryFile('MEMORY.md').content).toContain('preferences.md')
  })
})
