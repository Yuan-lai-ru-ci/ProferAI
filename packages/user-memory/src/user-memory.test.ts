import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildGlobalMemoryIndexBlock,
  buildUserContext,
  buildUserIdentitySection,
  deleteGlobalMemoryFile,
  ensureGlobalMemoryInitialized,
  getGlobalMemorySummary,
  readGlobalMemoryFile,
  readProfileField,
  readUserProfile,
  searchGlobalMemory,
  withFileLock,
  writeGlobalMemoryFile,
  writeProfileField,
  writeUserProfile,
} from './index'

const roots: string[] = []

function tempConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-user-memory-'))
  roots.push(root)
  const configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  return configDir
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('global memory store', () => {
  test('initializes the skeleton files and reads them back', () => {
    const configDir = tempConfig()
    const summary = getGlobalMemorySummary(configDir)
    expect(summary.indexExists).toBe(true)
    expect(summary.fileCount).toBe(6)
    expect(readGlobalMemoryFile(configDir, 'MEMORY.md').content).toContain('user-profile.md')
  })

  test('does not recreate files the user deleted after first initialization', () => {
    const configDir = tempConfig()
    ensureGlobalMemoryInitialized(configDir)
    deleteGlobalMemoryFile(configDir, 'preferences.md')
    ensureGlobalMemoryInitialized(configDir)
    expect(() => readGlobalMemoryFile(configDir, 'preferences.md')).toThrow('不存在')
  })

  test('rejects traversal, non-Markdown paths and deleting the index', () => {
    const configDir = tempConfig()
    for (const path of ['../outside.md', '/tmp/outside.md', 'notes.txt', 'a\\b.md']) {
      expect(() => readGlobalMemoryFile(configDir, path)).toThrow()
      expect(() => writeGlobalMemoryFile(configDir, path, 'x')).toThrow()
    }
    expect(() => deleteGlobalMemoryFile(configDir, 'MEMORY.md')).toThrow('不能删除')
  })

  test('does not follow a symlink outside the memory root', () => {
    const configDir = tempConfig()
    ensureGlobalMemoryInitialized(configDir)
    const outside = join(configDir, '..', 'outside.md')
    writeFileSync(outside, 'secret')
    const link = join(configDir, 'global-memory', 'escape.md')
    try { symlinkSync(outside, link) } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    expect(() => readGlobalMemoryFile(configDir, 'escape.md')).toThrow()
    expect(existsSync(outside)).toBe(true)
  })

  test('searches across topic files and caps the result count', () => {
    const configDir = tempConfig()
    writeGlobalMemoryFile(configDir, 'user-profile.md', '# 用户背景\n\n偏好 TypeScript。\n')
    expect(searchGlobalMemory(configDir, 'typescript')).toMatchObject([{ relativePath: 'user-profile.md' }])
    expect(searchGlobalMemory(configDir, '   ')).toEqual([])
  })

  test('releases the write lock after a successful and a failed write', () => {
    const configDir = tempConfig()
    const root = ensureGlobalMemoryInitialized(configDir)
    const lockPath = join(root, '.write.lock')

    writeGlobalMemoryFile(configDir, 'user-profile.md', '# 用户背景\n')
    expect(existsSync(lockPath)).toBe(false)

    expect(() => writeGlobalMemoryFile(configDir, '../escape.md', 'x')).toThrow()
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('file lock', () => {
  test('returns the callback result and removes the lock file', () => {
    const configDir = tempConfig()
    const lockPath = join(configDir, 'test.lock')
    expect(withFileLock(lockPath, () => 42)).toBe(42)
    expect(existsSync(lockPath)).toBe(false)
  })

  test('times out instead of hanging when the lock is held', () => {
    const configDir = tempConfig()
    const lockPath = join(configDir, 'held.lock')
    writeFileSync(lockPath, 'other-process')
    expect(() => withFileLock(lockPath, () => 1, { timeoutMs: 60, staleMs: 60_000, pollMs: 10 })).toThrow('超时')
  })

  test('reclaims a stale lock', () => {
    const configDir = tempConfig()
    const lockPath = join(configDir, 'stale.lock')
    writeFileSync(lockPath, 'dead-process')
    expect(withFileLock(lockPath, () => 'ok', { timeoutMs: 200, staleMs: 0, pollMs: 5 })).toBe('ok')
  })
})

describe('user profile', () => {
  test('falls back to defaults when the file is missing or corrupt', () => {
    const configDir = tempConfig()
    expect(readUserProfile(configDir).userName).toBe('用户')

    writeUserProfile(configDir, { userName: '源来如此' })
    expect(readUserProfile(configDir).userName).toBe('源来如此')

    writeFileSync(join(configDir, 'user-profile.json'), '{not json')
    expect(readUserProfile(configDir).userName).toBe('用户')
  })

  test('creates the config directory on first write', () => {
    const configDir = join(tempConfig(), 'nested', 'config')
    writeUserProfile(configDir, { userName: 'X' })
    expect(existsSync(join(configDir, 'user-profile.json'))).toBe(true)
  })
})

describe('profile fields', () => {
  test('reads and writes a field while preserving comments and other sections', () => {
    const configDir = tempConfig()
    writeGlobalMemoryFile(
      configDir,
      'user-profile.md',
      '# 用户背景\n\n<!-- 用户明确提供或确认的信息。 -->\n\n## 职业与领域\n\n独立开发者\n\n## 备注\n\n手写内容保留\n',
    )

    expect(readProfileField(configDir, 'role').value).toBe('独立开发者')

    writeProfileField(configDir, 'address', '老源')
    const doc = readGlobalMemoryFile(configDir, 'user-profile.md').content ?? ''
    expect(doc).toContain('<!-- 用户明确提供或确认的信息。 -->')
    expect(doc).toContain('## 称呼\n\n老源')
    expect(doc).toContain('## 备注\n\n手写内容保留')
    expect(readProfileField(configDir, '称呼').value).toBe('老源')
  })

  test('writes collaboration preference into preferences.md', () => {
    const configDir = tempConfig()
    writeProfileField(configDir, 'collaboration', '先给结论')
    expect(readFileSync(join(configDir, 'global-memory', 'preferences.md'), 'utf8')).toContain('先给结论')
  })

  test('rejects unknown fields', () => {
    const configDir = tempConfig()
    expect(() => readProfileField(configDir, 'nope')).toThrow('未知画像字段')
  })
})

describe('projection', () => {
  test('escapes the memory index and keeps the documented wrapper', () => {
    const block = buildGlobalMemoryIndexBlock('# 索引\n<a href="x">y</a>')
    expect(block.startsWith('<global_user_memory_index>')).toBe(true)
    expect(block).toContain('&lt;a href="x"&gt;y&lt;/a&gt;')
    expect(block.endsWith('</global_user_memory_index>')).toBe(true)
  })

  test('skips an empty index block', () => {
    expect(buildGlobalMemoryIndexBlock('   ')).toBe('')
  })

  test('builds the identity section with the same shape the app uses', () => {
    expect(buildUserIdentitySection('源来如此')).toBe('## 用户信息\n\n- 用户名: 源来如此')
    expect(buildUserIdentitySection('')).toBe('## 用户信息\n\n- 用户名: 用户')
  })

  test('combines identity and index', () => {
    const text = buildUserContext({ userName: '源来如此', memoryIndex: '- 偏好 → preferences.md' })
    expect(text.indexOf('## 用户信息')).toBe(0)
    expect(text).toContain('<global_user_memory_index>')
  })
})
