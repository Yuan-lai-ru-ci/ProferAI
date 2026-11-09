/**
 * Shadow Git 文件系统层（Phase 0-B）的行为测试。
 *
 * 全部用 os.tmpdir() 下的真实目录，而不是 mock fs：
 * 这一层真正容易出错的地方是路径语义（分隔符、大小写、符号链接、边界前缀），
 * mock 会把这些细节一并抹掉，测出来的只是「我的假设和我的实现一致」。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ShadowRoot } from './types'
import {
  SHADOW_ROOTS_PREFIX,
  deriveAttachedRootId,
  fromGitRelativePath,
  isSafeShadowRelativePath,
  isSafeShadowRootId,
  normalizeShadowRoots,
  parseShadowTreePath,
  shadowTreePath,
  toGitRelativePath,
} from './roots'
import {
  SHADOW_NEVER_ENTER_DIRS,
  isExcludedAbsolutePath,
  isWithinPath,
  shouldSkipShadowDirectory,
  shouldSkipShadowFile,
} from './exclusions'
import { DEFAULT_SHADOW_LIMITS, walkShadowRoot } from './walk'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, ...relativePath.split('/'))
    await mkdir(join(absolutePath, '..'), { recursive: true })
    await writeFile(absolutePath, content)
  }
}

function makeRoot(rootId: string, rootPath: string, kind: ShadowRoot['kind'] = 'project'): ShadowRoot {
  return { rootId, rootPath, kind }
}

describe('roots', () => {
  test('拒绝非法 rootId，接受常规工作区 id 与 attached id', () => {
    for (const value of ['', '.', '..', '/abs', 'a/b', 'a\\b', 'bad id', '-leading', '_no', 'a'.repeat(81)]) {
      expect(isSafeShadowRootId(value)).toBe(false)
    }
    for (const value of ['ws-1', 'A', 'attached-0123456789abcdef', 'a'.repeat(80)]) {
      expect(isSafeShadowRootId(value)).toBe(true)
    }
  })

  test('relativePath 允许混用分隔符，但拒绝绝对路径、盘符、空段与点段', () => {
    for (const value of ['a/b', 'a\\b', '中文 目录/说明 文件.md', 'a/b/c.txt']) {
      expect(isSafeShadowRelativePath(value)).toBe(true)
    }
    for (const value of ['', '/a', '\\a', 'C:\\a', 'c:/a', 'a/../b', 'a//b', './a', 'a/', 'a/.', 'a\0b']) {
      expect(isSafeShadowRelativePath(value)).toBe(false)
    }
  })

  test('统一输出正斜杠，再按平台还原', () => {
    expect(toGitRelativePath('a\\b/c')).toBe('a/b/c')
    expect(toGitRelativePath('./a//b')).toBe('a/b')
    expect(toGitRelativePath('')).toBe('')
    // 折叠 `..` 会改写语义，必须原样保留，由校验层拒绝
    expect(toGitRelativePath('a/../b')).toBe('a/../b')
    expect(fromGitRelativePath('a/b')).toBe(join('a', 'b'))
  })

  test('shadowTreePath 与 parseShadowTreePath 往返（含中文与空格）', () => {
    expect(shadowTreePath('ws-1', '中文 目录/说明 文件.md')).toBe('roots/ws-1/中文 目录/说明 文件.md')
    expect(shadowTreePath('ws-1', '中文 目录\\说明 文件.md')).toBe('roots/ws-1/中文 目录/说明 文件.md')

    const parsed = parseShadowTreePath('roots/ws-1/中文 目录/说明 文件.md')
    expect(parsed).toEqual({ rootId: 'ws-1', relativePath: '中文 目录/说明 文件.md' })
    if (parsed) {
      expect(shadowTreePath(parsed.rootId, parsed.relativePath)).toBe('roots/ws-1/中文 目录/说明 文件.md')
    }
    expect(SHADOW_ROOTS_PREFIX).toBe('roots')
  })

  test('parseShadowTreePath 对缺前缀、非法 id、非法相对路径返回 null', () => {
    for (const value of [
      '',
      'ws-1/a.md',
      'roots',
      'roots/ws-1',
      'roots/bad id!/a.md',
      'roots/../a.md',
      'roots/ws-1/../a.md',
      'roots/ws-1//a.md',
      'roots/ws-1/a\0b',
    ]) {
      expect(parseShadowTreePath(value)).toBeNull()
    }
  })

  test('deriveAttachedRootId 稳定、形状固定，不同路径得到不同 id', () => {
    const base = join(tmpdir(), 'profer-shadow-root-sample')
    const id = deriveAttachedRootId(base)
    expect(id).toMatch(/^attached-[0-9a-f]{16}$/)
    // 同一目录的不同写法必须落到同一个 id，否则历史快照会分裂
    expect(deriveAttachedRootId(join(base, '.'))).toBe(id)
    expect(deriveAttachedRootId(`${base}/`)).toBe(id)
    expect(deriveAttachedRootId(join(base, '..', 'profer-shadow-root-sample'))).toBe(id)
    expect(deriveAttachedRootId(join(tmpdir(), 'profer-shadow-root-other'))).not.toBe(id)
  })

  test('normalizeShadowRoots 过滤非法项，并按 id 与物理路径去重且保持顺序', () => {
    const first = join(tmpdir(), 'profer-normalize-main')
    const second = join(tmpdir(), 'profer-normalize-attached')
    const input: ShadowRoot[] = [
      makeRoot('main', first),
      makeRoot('.', join(tmpdir(), 'profer-normalize-bad-id'), 'attached'),
      makeRoot('relative-root', 'relative/path', 'attached'),
      // id 与第一项重复：先到先得
      makeRoot('main', second, 'attached'),
      // 物理路径与第一项相同：写法不同但 resolve 后一致
      makeRoot('dup-path', join(first, '.'), 'attached'),
      makeRoot('attached-1', second, 'attached'),
    ]

    const normalized = normalizeShadowRoots(input)
    expect(normalized.map((root) => root.rootId)).toEqual(['main', 'attached-1'])
    expect(normalized[0]?.rootPath).toBe(first)
    expect(normalized[1]?.kind).toBe('attached')
    // resolve 后同一路径，去重稳定
    expect(resolve(normalized[1]?.rootPath ?? '')).toBe(resolve(second))
  })
})

describe('exclusions', () => {
  test('高噪声目录被排除，用户源码目录不被排除', () => {
    for (const name of ['node_modules', '.git', 'dist', 'coverage', '.profer', 'shadow.git']) {
      expect(shouldSkipShadowDirectory(name)).toBe(true)
      expect(SHADOW_NEVER_ENTER_DIRS.has(name)).toBe(true)
    }
    // macOS/Windows 大小写不敏感：换个大小写不能绕过排除
    expect(shouldSkipShadowDirectory('NODE_MODULES')).toBe(true)
    for (const name of ['src', 'docs', 'vendor', 'lib', 'test']) {
      expect(shouldSkipShadowDirectory(name)).toBe(false)
    }
  })

  test('系统噪音文件与运行时锁被跳过，依赖声明锁文件保留', () => {
    for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini', 'SingletonLock', '.cache.lock']) {
      expect(shouldSkipShadowFile(name)).toBe(true)
    }
    for (const name of ['package-lock.json', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml', 'index.ts']) {
      expect(shouldSkipShadowFile(name)).toBe(false)
    }
  })

  test('isWithinPath 不做前缀字面比较：/a/b 不是 /a/bc 的父级', () => {
    expect(isWithinPath('/a/b', '/a/b/c')).toBe(true)
    expect(isWithinPath('/a/b', '/a/b')).toBe(true)
    expect(isWithinPath('/a/b', '/a/bc')).toBe(false)
    expect(isWithinPath('/a/b', '/a')).toBe(false)
    expect(isWithinPath(resolve('/a/b'), resolve('/a/b/c/d'))).toBe(true)
  })

  test('isExcludedAbsolutePath 忽略相对排除项，且不吃掉兄弟目录', () => {
    expect(isExcludedAbsolutePath('/a/b/c', ['/a/b'])).toBe(true)
    expect(isExcludedAbsolutePath('/a/bc/c', ['/a/b'])).toBe(false)
    expect(isExcludedAbsolutePath('/a/b/c', ['relative/exclude'])).toBe(false)
    expect(isExcludedAbsolutePath('/a/b/c', [])).toBe(false)
  })
})

describe('walk', () => {
  test('默认上限符合契约', () => {
    expect(DEFAULT_SHADOW_LIMITS.maxFileBytes).toBe(50 * 1024 * 1024)
    expect(DEFAULT_SHADOW_LIMITS.maxTotalBytes).toBe(1024 * 1024 * 1024)
    expect(DEFAULT_SHADOW_LIMITS.maxEntries).toBe(200_000)
  })

  test('枚举嵌套目录与中文空格文件名，跳过 node_modules/.git，结果有序', async () => {
    const rootPath = await makeTempDir('profer-shadow-walk-')
    await writeFiles(rootPath, {
      'README.md': 'root',
      '中文 目录/说明 文件.md': '中文内容',
      'src/index.ts': 'export {}',
      'node_modules/pkg/index.js': 'module.exports = {}',
      '.git/config': '[core]',
    })

    const result = await walkShadowRoot({ root: makeRoot('ws-test', rootPath) })

    expect(result.files).toEqual(['README.md', 'src/index.ts', '中文 目录/说明 文件.md'])
    expect(result.skipped).toEqual([])
    expect(result.partial).toBe(false)
    expect(result.totalBytes).toBe(
      Buffer.byteLength('root') + Buffer.byteLength('中文内容') + Buffer.byteLength('export {}'),
    )
    // 确定性：同一棵树再跑一次结果逐字相同
    const again = await walkShadowRoot({ root: makeRoot('ws-test', rootPath) })
    expect(again).toEqual(result)
  })

  test('符号链接记录为 symlink 且不跟随', async () => {
    const rootPath = await makeTempDir('profer-shadow-walk-link-')
    await writeFiles(rootPath, { 'real.md': 'real' })
    await symlink(join(rootPath, 'real.md'), join(rootPath, 'link.md'))

    const result = await walkShadowRoot({ root: makeRoot('ws-test', rootPath) })

    expect(result.files).toEqual(['real.md'])
    expect(result.skipped).toEqual([{ path: 'ws-test/link.md', reason: 'symlink' }])
    expect(result.partial).toBe(false)
  })

  test('超大文件进 skipped 并标记 partial（避免缺失被误读为删除）', async () => {
    const rootPath = await makeTempDir('profer-shadow-walk-large-')
    await writeFiles(rootPath, { 'small.txt': 'ab', 'big.txt': 'x'.repeat(64) })

    const result = await walkShadowRoot({
      root: makeRoot('ws-test', rootPath),
      limits: { maxFileBytes: 8 },
    })

    expect(result.files).toEqual(['small.txt'])
    expect(result.skipped).toEqual([{ path: 'ws-test/big.txt', reason: 'file-too-large' }])
    expect(result.totalBytes).toBe(2)
    expect(result.partial).toBe(true)
    expect(result.rootStatus).toBe('ok')
  })

  test('条目上限触发 partial 并停止枚举', async () => {
    const rootPath = await makeTempDir('profer-shadow-walk-entries-')
    await writeFiles(rootPath, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })

    const result = await walkShadowRoot({
      root: makeRoot('ws-test', rootPath),
      limits: { maxEntries: 2 },
    })

    expect(result.partial).toBe(true)
    expect(result.files).toEqual(['a.txt', 'b.txt'])
  })

  test('总量上限触发 partial 且保留已收集文件', async () => {
    const rootPath = await makeTempDir('profer-shadow-walk-bytes-')
    await writeFiles(rootPath, { 'a.txt': 'aaaa', 'b.txt': 'bbbb' })

    const result = await walkShadowRoot({
      root: makeRoot('ws-test', rootPath),
      limits: { maxTotalBytes: 4 },
    })

    expect(result.partial).toBe(true)
    expect(result.files).toEqual(['a.txt'])
    expect(result.totalBytes).toBe(4)
  })

  test('根不存在与根不是目录都通过返回值报告，不 throw', async () => {
    const missing = await walkShadowRoot({
      root: makeRoot('ghost', join(tmpdir(), 'profer-shadow-does-not-exist-9f3a')),
    })
    expect(missing).toEqual({
      files: [],
      skipped: [{ path: 'ghost', reason: 'root-missing' }],
      totalBytes: 0,
      partial: true,
      rootStatus: 'missing',
      stats: {},
    })

    const rootPath = await makeTempDir('profer-shadow-walk-fileroot-')
    await writeFiles(rootPath, { 'file.txt': 'x' })
    const notDirectory = await walkShadowRoot({ root: makeRoot('ws-test', join(rootPath, 'file.txt')) })
    expect(notDirectory.skipped).toEqual([{ path: 'ws-test', reason: 'root-not-directory' }])
    expect(notDirectory.files).toEqual([])
    expect(notDirectory.rootStatus).toBe('not-directory')
  })

  test('排除路径只作用于其内部，不影响根目录本身', async () => {
    const rootPath = await makeTempDir('profer-shadow-walk-exclude-')
    await writeFiles(rootPath, {
      'keep.md': 'keep',
      'generated/out.js': 'built',
      'generated/nested/deep.js': 'built',
    })

    const result = await walkShadowRoot({
      root: makeRoot('ws-test', rootPath),
      // 根自身也在排除列表里：不应导致整棵树为空
      excludeAbsolutePaths: [rootPath, join(rootPath, 'generated')],
    })

    expect(result.files).toEqual(['keep.md'])
    expect(result.skipped).toEqual([])
  })
})
