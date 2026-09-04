import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { searchFileCandidate } from './file-search-service'

describe('searchFileCandidate', () => {
  test('按深度逐个返回同名候选并跳过 alreadyFound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    try {
      await mkdir(join(root, 'nested'), { recursive: true })
      await writeFile(join(root, 'settings.json'), '{}')
      await writeFile(join(root, 'nested', 'settings.json'), '{}')

      const first = await searchFileCandidate({
        requestId: 'first',
        targetName: 'settings.json',
        roots: [root],
        maxDepth: 2,
      })
      expect(first.candidate?.path?.toLowerCase()).toBe(join(root, 'settings.json').toLowerCase())

      const second = await searchFileCandidate({
        requestId: 'second',
        targetName: 'settings.json',
        roots: [root],
        maxDepth: 2,
        alreadyFound: [first.candidate?.path ?? ''],
      })
      expect(second.candidate?.path?.toLowerCase()).toBe(join(root, 'nested', 'settings.json').toLowerCase())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('深度搜索一次收集多个未发现候选', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    try {
      await mkdir(join(root, 'first', 'nested'), { recursive: true })
      await mkdir(join(root, 'second', 'nested'), { recursive: true })
      await writeFile(join(root, 'first', 'nested', 'settings.json'), '{}')
      await writeFile(join(root, 'second', 'nested', 'settings.json'), '{}')

      const result = await searchFileCandidate({
        requestId: 'deep-all',
        targetName: 'settings.json',
        roots: [root],
        maxDepth: 4,
        maxResults: 50,
      })

      expect(result.candidates?.map((candidate) => candidate.path.toLowerCase()).sort()).toEqual([
        join(root, 'first', 'nested', 'settings.json').toLowerCase(),
        join(root, 'second', 'nested', 'settings.json').toLowerCase(),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('完整路径命中时只返回该路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    try {
      await mkdir(join(root, 'nested'), { recursive: true })
      await writeFile(join(root, 'target.txt'), 'root')
      await writeFile(join(root, 'nested', 'target.txt'), 'nested')

      const result = await searchFileCandidate({
        requestId: 'exact-hit',
        targetName: 'target.txt',
        targetPath: join(root, 'nested', 'target.txt'),
        roots: [root],
        maxDepth: 0,
      })

      expect(result.candidates).toEqual([{ path: join(root, 'nested', 'target.txt') }])
      expect(result.candidate?.path).toBe(join(root, 'nested', 'target.txt'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('完整路径不存在时不回退到同名文件搜索', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    try {
      await mkdir(join(root, 'other'), { recursive: true })
      await writeFile(join(root, 'other', 'target.txt'), 'other')

      const result = await searchFileCandidate({
        requestId: 'exact-missing',
        targetName: 'target.txt',
        targetPath: join(root, 'missing', 'target.txt'),
        roots: [root],
        maxDepth: 12,
        maxResults: 50,
      })

      expect(result.candidate).toBeUndefined()
      expect(result.candidates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('完整路径位于授权根目录外时返回空结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    const outside = await mkdtemp(join(tmpdir(), 'profer-file-search-outside-'))
    try {
      await writeFile(join(outside, 'target.txt'), 'outside')

      const result = await searchFileCandidate({
        requestId: 'exact-outside',
        targetName: 'target.txt',
        targetPath: join(outside, 'target.txt'),
        roots: [root],
        maxDepth: 12,
      })

      expect(result.candidate).toBeUndefined()
      expect(result.candidates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('深度完整路径查询最多返回该路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    try {
      await mkdir(join(root, 'first'), { recursive: true })
      await mkdir(join(root, 'second'), { recursive: true })
      await writeFile(join(root, 'first', 'target.txt'), 'first')
      await writeFile(join(root, 'second', 'target.txt'), 'second')

      const result = await searchFileCandidate({
        requestId: 'exact-deep',
        targetName: 'target.txt',
        targetPath: join(root, 'first', 'target.txt'),
        roots: [root],
        maxDepth: 12,
        maxResults: 50,
      })

      expect(result.candidates).toEqual([{ path: join(root, 'first', 'target.txt') }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('完整路径不能通过授权根目录内的符号链接访问目录外文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    const outside = await mkdtemp(join(tmpdir(), 'profer-file-search-outside-'))
    try {
      const outsideFile = join(outside, 'target.txt')
      const linkedFile = join(root, 'linked-target.txt')
      await writeFile(outsideFile, 'outside')
      await symlink(outsideFile, linkedFile, 'file')

      const result = await searchFileCandidate({
        requestId: 'exact-symlink-outside',
        targetName: 'linked-target.txt',
        targetPath: linkedFile,
        roots: [root],
        maxDepth: 12,
      })

      expect(result.candidate).toBeUndefined()
      expect(result.candidates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('搜索会话隐藏目录中的 .claude 配置文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    try {
      await mkdir(join(root, '.claude'), { recursive: true })
      await writeFile(join(root, '.claude', 'settings.json'), '{}')

      const result = await searchFileCandidate({
        requestId: 'hidden-context',
        targetName: 'settings.json',
        roots: [root],
        maxDepth: 2,
      })

      expect(result.candidate?.path?.toLowerCase()).toBe(join(root, '.claude', 'settings.json').toLowerCase())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('已取消任务不返回候选', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-file-search-'))
    try {
      await writeFile(join(root, 'settings.json'), '{}')
      const controller = new AbortController()
      controller.abort()
      const result = await searchFileCandidate({
        requestId: 'cancelled',
        targetName: 'settings.json',
        roots: [root],
        maxDepth: 2,
        signal: controller.signal,
      })
      expect(result.candidate).toBeUndefined()
      expect(result.cancelled).toBe(true)
      expect(result.done).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
