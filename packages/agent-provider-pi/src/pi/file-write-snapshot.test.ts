import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffSnapshots, snapshotTree } from './file-write-snapshot'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'profer-snapshot-'))
}

describe('snapshotTree', () => {
  test('records file metadata and skips heavy directories', async () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'a.md'), 'a')
      mkdirSync(join(dir, 'node_modules'))
      writeFileSync(join(dir, 'node_modules', 'ignored.js'), 'x')

      const snapshot = await snapshotTree(dir)

      expect(snapshot).not.toBeNull()
      expect(snapshot!.has(join(dir, 'a.md'))).toBe(true)
      expect(snapshot!.has(join(dir, 'node_modules', 'ignored.js'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('walks nested directories', async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
      writeFileSync(join(dir, 'src', 'deep', 'b.ts'), 'b')

      const snapshot = await snapshotTree(dir)

      expect(snapshot!.has(join(dir, 'src', 'deep', 'b.ts'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when the file budget is exceeded', async () => {
    const dir = tempDir()
    try {
      for (let index = 0; index < 5; index += 1) writeFileSync(join(dir, `f${index}.txt`), 'x')

      expect(await snapshotTree(dir, { maxFiles: 2 })).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('diffSnapshots', () => {
  test('reports added and modified files, ignores deletions', () => {
    const before = new Map([
      ['/repo/keep.ts', { mtimeMs: 1, size: 1 }],
      ['/repo/changed.ts', { mtimeMs: 1, size: 1 }],
      ['/repo/deleted.ts', { mtimeMs: 1, size: 1 }],
    ])
    const after = new Map([
      ['/repo/keep.ts', { mtimeMs: 1, size: 1 }],
      ['/repo/changed.ts', { mtimeMs: 2, size: 3 }],
      ['/repo/added.ts', { mtimeMs: 1, size: 1 }],
    ])

    expect(diffSnapshots(before, after).sort()).toEqual(['/repo/added.ts', '/repo/changed.ts'])
  })

  test('reports nothing when metadata is unchanged', () => {
    const snapshot = new Map([['/repo/a.ts', { mtimeMs: 1, size: 1 }]])

    expect(diffSnapshots(snapshot, snapshot)).toEqual([])
  })
})
