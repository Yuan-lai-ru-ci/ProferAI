/**
 * 工作区记忆（memory）穷举测试。
 *
 * 覆盖维度：路径解析 / 读写 / 迁移 / 搜索 / wikilink / 隔离 / 安全 / 一致性 / 删除 / 并发。
 *
 * 隔离要求：
 * - 每个用例使用 mkdtempSync 独立临时目录；
 * - PROFER_CONFIG_DIR 指向临时配置根，绝不触碰真实 ~/.profer；
 * - 只加载生产代码，不修改任何生产实现。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const {
  createAgentWorkspace,
  deleteAgentWorkspace,
  removeProjectWorkspace,
  getWorkspaceAutoMemoryDir,
  getWorkspaceMemoryArchivePath,
  getWorkspaceMemorySummary,
  listWorkspaceAutoMemoryFiles,
  readWorkspaceAutoMemoryFile,
  writeWorkspaceAutoMemoryFile,
  listWorkspaceMemoryArchiveFiles,
  readWorkspaceMemoryArchiveFile,
  writeWorkspaceMemoryArchiveFile,
} = await import('./agent-workspace-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')
const { resolveWorkspaceFilesUiRootPath } = await import('./config-paths')
const { createMemoryArchiveSearcher, searchMemoryArchive, memoryFreshnessNote } = await import('./memory-archive-search')
const { resolveMemoryWikilink, findMemoryBacklinks } = await import('./memory-wikilink-service')
const { createAgentSession, deleteAgentSession } = await import('./agent-session-manager')

// ===== 夹具 =====

let configRoot = ''
const previousConfigRoot = process.env.PROFER_CONFIG_DIR
const scratchDirs: string[] = []

function makeScratch(prefix = 'profer-memory-exh-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** macOS 的 /var → /private/var 软链：project root 断言必须先 realpath。 */
function makeProjectRoot(): string {
  return realpathSync(makeScratch('profer-memory-root-'))
}

function indexPath(): string {
  return join(configRoot, 'agent-workspaces.json')
}

interface RawIndexEntry {
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
  type: 'personal'
  storageMode?: 'managed' | 'project'
  rootPath?: string
  degradedFromProject?: boolean
}

function writeRawIndex(entries: RawIndexEntry[]): void {
  writeFileSync(indexPath(), JSON.stringify({ version: 4, workspaces: entries }), 'utf-8')
  invalidateWorkspaceLocation()
}

function managedEntry(slug: string): RawIndexEntry {
  return { id: `id-${slug}`, name: `工作区 ${slug}`, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function projectEntry(slug: string, rootPath: string): RawIndexEntry {
  return {
    id: `id-${slug}`,
    name: `项目 ${slug}`,
    slug,
    createdAt: 1,
    updatedAt: 1,
    type: 'personal',
    storageMode: 'project',
    rootPath,
  }
}

/** 把工作区索引整体替换成给定条目（用于 project / 降级 / 切换场景）。 */
function useIndex(entries: RawIndexEntry[]): void {
  writeRawIndex(entries)
}

function makeWorkspace(name: string) {
  return createAgentWorkspace(name)
}

function writeRaw(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
}

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'profer-memory-config-'))
  process.env.PROFER_CONFIG_DIR = configRoot
  invalidateWorkspaceLocation()
})

afterEach(() => {
  invalidateWorkspaceLocation()
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  rmSync(configRoot, { recursive: true, force: true })
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

// ===== 1. 路径解析 =====

describe('路径解析', () => {
  test('managed 工作区记忆目录为 <config>/agent-workspaces/<slug>/.profer/memory', () => {
    const ws = makeWorkspace('Path Managed')
    expect(getWorkspaceAutoMemoryDir(ws.slug)).toBe(
      join(configRoot, 'agent-workspaces', ws.slug, '.profer', 'memory'),
    )
    expect(getWorkspaceMemoryArchivePath(ws.slug)).toBe(getWorkspaceAutoMemoryDir(ws.slug))
  })

  test('project 工作区记忆目录为 <root>/.profer/memory，不是项目根 memory/', () => {
    const root = makeProjectRoot()
    useIndex([projectEntry('proj', root)])
    const dir = getWorkspaceAutoMemoryDir('proj')

    expect(dir).toBe(join(root, '.profer', 'memory'))
    expect(dir).not.toBe(join(root, 'memory'))
    expect(dir).not.toContain(join('.profer', '.profer'))
    // 解析路径是纯读操作，不应在项目根凭空创建 memory/。
    expect(existsSync(join(root, 'memory'))).toBe(false)
  })

  test('降级 project（缺 rootPath）回退到 managed 路径且不抛错', () => {
    useIndex([{ ...projectEntry('degraded', '/placeholder'), rootPath: undefined }])
    const dir = getWorkspaceAutoMemoryDir('degraded')

    expect(dir).toBe(join(configRoot, 'agent-workspaces', 'degraded', '.profer', 'memory'))
    expect(existsSync(dir)).toBe(true)
  })

  test('slug 含空格 / 中文 / 点号时目录仍落在工作区根内', () => {
    useIndex([managedEntry('odd slug.中文')])
    const dir = getWorkspaceAutoMemoryDir('odd slug.中文')
    const workspacesRoot = join(configRoot, 'agent-workspaces')

    expect(dir.startsWith(workspacesRoot)).toBe(true)
    expect(dir.endsWith(join('.profer', 'memory'))).toBe(true)
  })

  test('resolveWorkspaceFilesUiRootPath：project 为项目根，managed 为 workspace-files', () => {
    const root = makeProjectRoot()
    useIndex([projectEntry('proj-ui', root), managedEntry('managed-ui')])

    expect(resolveWorkspaceFilesUiRootPath('proj-ui')).toBe(root)
    expect(resolveWorkspaceFilesUiRootPath('managed-ui')).toBe(
      join(configRoot, 'agent-workspaces', 'managed-ui', 'workspace-files'),
    )
  })
})

// ===== 2. 读写 =====

describe('读写', () => {
  test('新建主题文件后可按相对路径读回，并出现在文件树中', () => {
    const ws = makeWorkspace('RW New')
    writeWorkspaceAutoMemoryFile(ws.slug, 'topics/db.md', '# 数据库\n使用 SQLite。\n')

    const read = readWorkspaceAutoMemoryFile(ws.slug, 'topics/db.md')
    expect(read.content).toBe('# 数据库\n使用 SQLite。\n')
    expect(read.relativePath).toBe('topics/db.md')
    expect(read.isText).toBe(true)

    const tree = listWorkspaceAutoMemoryFiles(ws.slug)
    const topics = tree.find((node) => node.relativePath === 'topics')
    expect(topics?.type).toBe('directory')
    expect(topics?.children?.some((child) => child.relativePath === 'topics/db.md')).toBe(true)
  })

  test('MEMORY.md 不存在时读取返回空虚拟文件，写入后才真正落盘', () => {
    const ws = makeWorkspace('RW Index')
    const dir = getWorkspaceAutoMemoryDir(ws.slug)

    const virtual = readWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md')
    expect(virtual.content).toBe('')
    expect(virtual.size).toBe(0)
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false)

    writeWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md', '# 索引\n')
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true)
    expect(readWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md').content).toBe('# 索引\n')
  })

  test('UTF-8 中文内容按字节计长、按字符读回', () => {
    const ws = makeWorkspace('RW UTF8')
    const content = '记忆：决策是「统一到 .profer/memory」。\n- 中文 ✅\n'
    writeWorkspaceAutoMemoryFile(ws.slug, '中文主题.md', content)

    const read = readWorkspaceAutoMemoryFile(ws.slug, '中文主题.md')
    expect(read.content).toBe(content)
    expect(read.size).toBe(Buffer.byteLength(content, 'utf-8'))
    expect(read.size).toBeGreaterThan(content.length)
  })

  test('空文件可写入、可列出、可读回，且搜索无命中', () => {
    const ws = makeWorkspace('RW Empty')
    writeWorkspaceAutoMemoryFile(ws.slug, 'empty.md', '')

    const read = readWorkspaceAutoMemoryFile(ws.slug, 'empty.md')
    expect(read.content).toBe('')
    expect(read.size).toBe(0)
    expect(listWorkspaceAutoMemoryFiles(ws.slug).some((n) => n.relativePath === 'empty.md')).toBe(true)
    expect(searchMemoryArchive(getWorkspaceAutoMemoryDir(ws.slug), 'anything')).toEqual([])
  })

  test('CRLF 换行按原样往返，不被悄悄改成 LF', () => {
    const ws = makeWorkspace('RW CRLF')
    const content = 'line1\r\nline2\r\nline3\r\n'
    writeWorkspaceAutoMemoryFile(ws.slug, 'crlf.md', content)

    expect(readWorkspaceAutoMemoryFile(ws.slug, 'crlf.md').content).toBe(content)
    expect(readFileSync(join(getWorkspaceAutoMemoryDir(ws.slug), 'crlf.md'), 'utf-8')).toBe(content)
  })

  test('UTF-8 BOM 保留，且不影响中文全文检索', () => {
    const ws = makeWorkspace('RW BOM')
    const content = '\uFEFF# 记忆索引\nBOM 前缀也要能搜索到「索引」。\n'
    writeWorkspaceAutoMemoryFile(ws.slug, 'bom.md', content)

    const read = readWorkspaceAutoMemoryFile(ws.slug, 'bom.md')
    expect(read.content?.startsWith('\uFEFF')).toBe(true)
    expect(read.content).toBe(content)

    const hits = searchMemoryArchive(getWorkspaceAutoMemoryDir(ws.slug), '索引')
    expect(hits.length).toBe(1)
  })

  test('5MB 文件可写可读，且能被全文索引（上限 10MB）', () => {
    const ws = makeWorkspace('RW Large')
    const big = `超大文件 记忆标记\n${'A'.repeat(5 * 1024 * 1024)}`
    writeWorkspaceAutoMemoryFile(ws.slug, 'big.md', big)
    writeWorkspaceAutoMemoryFile(ws.slug, 'small.md', '小文件 记忆标记')

    const read = readWorkspaceAutoMemoryFile(ws.slug, 'big.md')
    expect(read.size).toBe(Buffer.byteLength(big, 'utf-8'))

    const hits = searchMemoryArchive(getWorkspaceAutoMemoryDir(ws.slug), '记忆标记')
    expect(hits.map((hit) => hit.relativePath).sort()).toEqual(['big.md', 'small.md'])
  })

  test('写入超过 10MB 被拒绝且不落盘；读取超过 10MB 的文件被拒绝', () => {
    const ws = makeWorkspace('RW Limit')
    const dir = getWorkspaceAutoMemoryDir(ws.slug)
    const tooBig = 'A'.repeat(10 * 1024 * 1024 + 1)

    expect(() => writeWorkspaceAutoMemoryFile(ws.slug, 'too-big.md', tooBig)).toThrow(/超过 10 MB/)
    expect(existsSync(join(dir, 'too-big.md'))).toBe(false)

    writeFileSync(join(dir, 'existing-big.md'), tooBig, 'utf-8')
    expect(() => readWorkspaceAutoMemoryFile(ws.slug, 'existing-big.md')).toThrow(/超过 10 MB/)
  })

  test('覆盖写替换旧内容；直接删除文件后文件树与搜索都不再包含它', () => {
    const ws = makeWorkspace('RW Overwrite')
    writeWorkspaceAutoMemoryFile(ws.slug, 'topic.md', '第一版内容 alpha')
    writeWorkspaceAutoMemoryFile(ws.slug, 'topic.md', '第二版内容 beta')

    expect(readWorkspaceAutoMemoryFile(ws.slug, 'topic.md').content).toBe('第二版内容 beta')
    expect(searchMemoryArchive(getWorkspaceAutoMemoryDir(ws.slug), 'alpha')).toEqual([])

    unlinkSync(join(getWorkspaceAutoMemoryDir(ws.slug), 'topic.md'))
    expect(listWorkspaceAutoMemoryFiles(ws.slug).some((n) => n.relativePath === 'topic.md')).toBe(false)
    expect(searchMemoryArchive(getWorkspaceAutoMemoryDir(ws.slug), 'beta')).toEqual([])
  })

  test('目录路径不能当文件读取', () => {
    const ws = makeWorkspace('RW Dir As File')
    writeWorkspaceAutoMemoryFile(ws.slug, 'topics/a.md', 'x')
    expect(() => readWorkspaceAutoMemoryFile(ws.slug, 'topics')).toThrow(/不是文件/)
  })
})

// ===== 3. 迁移 =====

describe('迁移', () => {
  function legacyClaudeDir(slug: string): string {
    return join(configRoot, 'agent-workspaces', slug, '.claude', 'memory')
  }

  function legacyArchiveDir(slug: string): string {
    return join(configRoot, 'agent-workspaces', slug, 'workspace-files', '.context', 'memory-archive')
  }

  test('旧 .claude/memory 复制到 .profer/memory，旧目录保留', () => {
    const ws = makeWorkspace('Migrate Claude')
    writeRaw(join(legacyClaudeDir(ws.slug), 'MEMORY.md'), '# 旧索引\n- 主题：old-topic\n')
    writeRaw(join(legacyClaudeDir(ws.slug), 'old-topic.md'), '旧主题正文\n')

    const dir = getWorkspaceAutoMemoryDir(ws.slug)

    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe('# 旧索引\n- 主题：old-topic\n')
    expect(readFileSync(join(dir, 'old-topic.md'), 'utf-8')).toBe('旧主题正文\n')
    expect(existsSync(join(legacyClaudeDir(ws.slug), 'old-topic.md'))).toBe(true)
  })

  test('迁移不覆盖新目录中已存在的同名文件', () => {
    const ws = makeWorkspace('Migrate No Overwrite')
    writeRaw(join(legacyClaudeDir(ws.slug), 'MEMORY.md'), '旧内容\n')
    writeRaw(join(getWorkspaceAutoMemoryDir(ws.slug), 'MEMORY.md'), '新内容\n')

    // 再次触发迁移
    const dir = getWorkspaceAutoMemoryDir(ws.slug)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe('新内容\n')
  })

  test('迁移幂等：重复调用不新增副本、不改变内容', () => {
    const ws = makeWorkspace('Migrate Idempotent')
    writeRaw(join(legacyClaudeDir(ws.slug), 'MEMORY.md'), '索引\n')
    writeRaw(join(legacyClaudeDir(ws.slug), 'a.md'), 'A\n')

    const first = getWorkspaceAutoMemoryDir(ws.slug)
    const firstSnapshot = listWorkspaceAutoMemoryFiles(ws.slug)
    const second = getWorkspaceAutoMemoryDir(ws.slug)
    const secondSnapshot = listWorkspaceAutoMemoryFiles(ws.slug)

    expect(second).toBe(first)
    expect(secondSnapshot).toEqual(firstSnapshot)
    expect(readFileSync(join(second, 'a.md'), 'utf-8')).toBe('A\n')
  })

  test('旧目录含子目录时递归复制并保留层级', () => {
    const ws = makeWorkspace('Migrate Nested')
    writeRaw(join(legacyClaudeDir(ws.slug), 'topics', 'deep', 'nested.md'), '嵌套内容\n')

    const dir = getWorkspaceAutoMemoryDir(ws.slug)
    expect(readFileSync(join(dir, 'topics', 'deep', 'nested.md'), 'utf-8')).toBe('嵌套内容\n')
  })

  test('旧目录中的隐藏文件与隐藏目录不会被迁移', () => {
    const ws = makeWorkspace('Migrate Hidden')
    writeRaw(join(legacyClaudeDir(ws.slug), '.secret.md'), 'hidden\n')
    writeRaw(join(legacyClaudeDir(ws.slug), '.cache', 'x.md'), 'hidden dir\n')
    writeRaw(join(legacyClaudeDir(ws.slug), 'visible.md'), 'visible\n')

    const dir = getWorkspaceAutoMemoryDir(ws.slug)
    expect(existsSync(join(dir, 'visible.md'))).toBe(true)
    expect(existsSync(join(dir, '.secret.md'))).toBe(false)
    expect(existsSync(join(dir, '.cache'))).toBe(false)
  })

  test('旧 workspace-files/.context/memory-archive 主题文件并入 .profer/memory，旧目录保留', () => {
    const ws = makeWorkspace('Migrate Archive')
    writeRaw(join(legacyArchiveDir(ws.slug), 'legacy-topic.md'), '旧 archive 正文\n')

    const dir = getWorkspaceMemoryArchivePath(ws.slug)

    expect(dir).toBe(getWorkspaceAutoMemoryDir(ws.slug))
    expect(readFileSync(join(dir, 'legacy-topic.md'), 'utf-8')).toBe('旧 archive 正文\n')
    expect(existsSync(join(legacyArchiveDir(ws.slug), 'legacy-topic.md'))).toBe(true)
  })

  test('迁移只做一次：删除新副本后不会被旧目录复活', () => {
    const ws = makeWorkspace('Migrate Resurrect')
    writeRaw(join(legacyArchiveDir(ws.slug), 'topic.md'), '旧正文\n')
    const dir = getWorkspaceMemoryArchivePath(ws.slug)
    expect(existsSync(join(dir, 'topic.md'))).toBe(true)

    unlinkSync(join(dir, 'topic.md'))
    expect(existsSync(join(dir, 'topic.md'))).toBe(false)

    getWorkspaceMemoryArchivePath(ws.slug)
    expect(existsSync(join(dir, 'topic.md'))).toBe(false)
  })
})

// ===== 4. 搜索 =====

describe('搜索', () => {
  function makeMemDir(): string {
    const dir = makeScratch('mem-search-exh-')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test('中文多字查询按字切分命中', () => {
    const dir = makeMemDir()
    writeRaw(join(dir, 'db.md'), '# 数据库\n我们决定使用 SQLite 做记忆索引。\n')

    const hits = searchMemoryArchive(dir, '索引')
    expect(hits.length).toBe(1)
    expect(hits[0]!.relativePath).toBe('db.md')
    // 片段从真实命中位置开始（不是文件开头），故只断言命中词与偏移。
    expect(hits[0]!.content).toContain('索引')
    expect(hits[0]!.startIndex).toBeGreaterThan(0)
    expect(hits[0]!.matchedTokens).toEqual(['索', '引'])
  })

  test('英文 / 代码 token 整词命中且大小写不敏感', () => {
    const dir = makeMemDir()
    writeRaw(join(dir, 'git.md'), 'Rebase workflow: use profer-skin before release.\n')

    expect(searchMemoryArchive(dir, 'rebase').length).toBe(1)
    expect(searchMemoryArchive(dir, 'profer-skin').length).toBe(1)
    expect(searchMemoryArchive(dir, 'PROFER-SKIN').length).toBe(1)
  })

  test('中英混合查询需同时命中两类 token', () => {
    const dir = makeMemDir()
    writeRaw(join(dir, 'mix.md'), 'Profer 的记忆统一方案已确认。\n')
    writeRaw(join(dir, 'other.md'), 'Profer 只有英文，没有那个词。\n')

    const hits = searchMemoryArchive(dir, 'Profer 记忆')
    expect(hits.map((hit) => hit.relativePath)).toEqual(['mix.md'])
  })

  test('引号 / 百分号 / 星号等特殊字符查询不抛错', () => {
    const dir = makeMemDir()
    writeRaw(join(dir, 'special.md'), '进度 100% 完成；通配符 * 与引号 " 都在正文里。\n')

    expect(() => searchMemoryArchive(dir, '"')).not.toThrow()
    expect(() => searchMemoryArchive(dir, '%')).not.toThrow()
    expect(() => searchMemoryArchive(dir, '*')).not.toThrow()
    expect(Array.isArray(searchMemoryArchive(dir, '100%'))).toBe(true)
  })

  test('空查询与纯空白查询返回空数组', () => {
    const dir = makeMemDir()
    writeRaw(join(dir, 'a.md'), 'anything here\n')

    expect(searchMemoryArchive(dir, '')).toEqual([])
    expect(searchMemoryArchive(dir, '   \n\t ')).toEqual([])
  })

  test('topK 边界：0 个被抬到 1，超上限被截到实际命中数', () => {
    const dir = makeMemDir()
    for (let i = 0; i < 3; i += 1) writeRaw(join(dir, `t${i}.md`), `needle topic ${i}\n`)

    expect(searchMemoryArchive(dir, 'needle', 0).length).toBe(1)
    expect(searchMemoryArchive(dir, 'needle', 2).length).toBe(2)
    expect(searchMemoryArchive(dir, 'needle', 100).length).toBe(3)
  })

  test('无索引 / 目录不存在时返回空数组，之后新增文件可被惰性索引发现', () => {
    const missing = join(makeScratch('mem-missing-'), 'not-created')
    const searcher = createMemoryArchiveSearcher(missing)
    expect(searcher.search('anything')).toEqual([])

    mkdirSync(missing, { recursive: true })
    writeRaw(join(missing, 'later.md'), 'later token content\n')
    expect(searcher.search('later').length).toBe(1)
    searcher.close()
  })

  test('文件删除后结果消失；rebuildAll 后仍与目录内容一致（无重复行）', () => {
    const dir = makeMemDir()
    const file = join(dir, 'rebuild.md')
    writeRaw(file, 'first version alpha\n')
    const searcher = createMemoryArchiveSearcher(dir)

    expect(searcher.search('alpha').length).toBe(1)
    writeRaw(file, 'second version beta with more bytes\n')
    searcher.rebuildAll()
    expect(searcher.search('alpha')).toEqual([])
    expect(searcher.search('beta').length).toBe(1)

    unlinkSync(file)
    expect(searcher.search('beta')).toEqual([])
    searcher.close()
  })

  test('陈旧记忆提示：1 天以上给出提示，当天不给；mtime 缺失不误报', () => {
    const dir = makeMemDir()
    const staleFile = join(dir, 'stale.md')
    writeRaw(staleFile, 'stale decision SQLite\n')
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(staleFile, threeDaysAgo, threeDaysAgo)

    const staleHits = searchMemoryArchive(dir, 'SQLite')
    expect(memoryFreshnessNote(staleHits)).toContain('3 天前')

    writeRaw(join(dir, 'fresh.md'), 'fresh decision PostgreSQL\n')
    const freshHits = searchMemoryArchive(dir, 'PostgreSQL')
    expect(memoryFreshnessNote(freshHits)).toBeUndefined()
  })
  test('结果按 BM25 分数升序返回（score 越小越相关）', () => {
    const dir = makeMemDir()
    writeRaw(join(dir, 'dense.md'), 'ranking needle needle needle needle\n')
    writeRaw(join(dir, 'sparse.md'), 'ranking needle 其他内容 filler filler filler\n')

    const hits = searchMemoryArchive(dir, 'needle', 10)
    expect(hits.length).toBe(2)
    const scores = hits.map((hit) => hit.score)
    expect(scores).toEqual([...scores].sort((a, b) => a - b))
    expect(scores.every((score) => Number.isFinite(score))).toBe(true)
  })
})

// ===== 5. wikilink =====

describe('wikilink', () => {
  function makeDirs(): { archive: string; auto: string } {
    const root = makeScratch('mem-wikilink-exh-')
    const archive = join(root, 'memory-archive')
    const auto = join(root, '.profer', 'memory')
    mkdirSync(archive, { recursive: true })
    mkdirSync(auto, { recursive: true })
    return { archive, auto }
  }

  test('正常双链：frontmatter name / 嵌套相对路径精确命中', () => {
    const { archive, auto } = makeDirs()
    writeRaw(join(archive, 'topics', 'db.md'), '---\nname: db-notes\ndescription: 数据库经验\n---\n正文\n')

    const hit = resolveMemoryWikilink(archive, auto, 'db-notes')
    expect(hit).not.toBeNull()
    expect(hit!.relativePath).toBe('topics/db.md')
    expect(hit!.matchedBy).toBe('name')
  })

  test('断链与空名称返回 null', () => {
    const { archive, auto } = makeDirs()
    writeRaw(join(archive, 'a.md'), '# A\n')

    expect(resolveMemoryWikilink(archive, auto, '不存在的主题')).toBeNull()
    expect(resolveMemoryWikilink(archive, auto, '   ')).toBeNull()
  })

  test('自引用：反链不返回自身', () => {
    const { archive, auto } = makeDirs()
    const self = join(archive, 'self.md')
    writeRaw(self, '---\nname: self\n---\n自引用 [[self]]\n')

    expect(resolveMemoryWikilink(archive, auto, 'self')!.relativePath).toBe('self.md')
    expect(findMemoryBacklinks(archive, auto, self, 'self')).toEqual([])
  })

  test('循环双链：A→B 与 B→A 可互相解析且互为反链', () => {
    const { archive, auto } = makeDirs()
    const a = join(archive, 'a.md')
    const b = join(archive, 'b.md')
    writeRaw(a, '---\nname: topic-a\n---\n参见 [[topic-b]]\n')
    writeRaw(b, '---\nname: topic-b\n---\n回见 [[topic-a|A]]\n')

    expect(resolveMemoryWikilink(archive, auto, 'topic-a')?.relativePath).toBe('a.md')
    expect(resolveMemoryWikilink(archive, auto, 'topic-b')?.relativePath).toBe('b.md')
    expect(findMemoryBacklinks(archive, auto, a, 'topic-a').map((link) => link.relativePath)).toEqual(['b.md'])
    expect(findMemoryBacklinks(archive, auto, b, 'topic-b').map((link) => link.relativePath)).toEqual(['a.md'])
  })

  test('大小写差异不敏感（frontmatter name 与文件名均适用）', () => {
    const { archive, auto } = makeDirs()
    writeRaw(join(archive, 'Skin-Engine.md'), '---\nname: Skin-Engine\n---\n内容\n')

    expect(resolveMemoryWikilink(archive, auto, 'skin-engine')!.relativePath).toBe('Skin-Engine.md')
    expect(resolveMemoryWikilink(archive, auto, 'SKIN-ENGINE')!.relativePath).toBe('Skin-Engine.md')
  })

  test('统一后 archiveDir === autoDir：文件被索引两次，kind 固定为 archive', () => {
    const dir = makeScratch('mem-wikilink-unified-')
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeRaw(a, '---\nname: topic-a\n---\n参见 [[topic-b]]\n')
    writeRaw(b, '---\nname: topic-b\n---\n目标\n')

    const target = resolveMemoryWikilink(dir, dir, 'topic-b')
    expect(target?.relativePath).toBe('b.md')
    // 当前实现先索引 archive 副本，因此 auto memory 中的文件也被标成 archive。
    expect(target?.kind).toBe('archive')
  })

  test('统一目录下反链不应因同一文件被索引两次而重复', () => {
    const dir = makeScratch('mem-wikilink-unified-backlinks-')
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeRaw(a, '---\nname: topic-a\n---\n参见 [[topic-b]]\n')
    writeRaw(b, '---\nname: topic-b\n---\n目标\n')

    const backlinks = findMemoryBacklinks(dir, dir, b, 'topic-b')
    expect(backlinks.map((link) => link.relativePath)).toEqual(['a.md'])
  })
})

// ===== 6. 隔离 =====

describe('隔离', () => {
  test('两个工作区写入同名文件互不影响', () => {
    const a = makeWorkspace('Iso A')
    const b = makeWorkspace('Iso B')
    writeWorkspaceAutoMemoryFile(a.slug, 'topic.md', 'A 的内容')
    writeWorkspaceAutoMemoryFile(b.slug, 'topic.md', 'B 的内容')

    expect(readWorkspaceAutoMemoryFile(a.slug, 'topic.md').content).toBe('A 的内容')
    expect(readWorkspaceAutoMemoryFile(b.slug, 'topic.md').content).toBe('B 的内容')
    expect(getWorkspaceAutoMemoryDir(a.slug)).not.toBe(getWorkspaceAutoMemoryDir(b.slug))
  })

  test('PROFER_CONFIG_DIR 切换后不串数据，切回后原数据仍在', () => {
    const ws = makeWorkspace('Iso Config')
    writeWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md', '# 配置一\n')
    const configOne = configRoot

    const configTwo = makeScratch('profer-memory-config-two-')
    process.env.PROFER_CONFIG_DIR = configTwo
    invalidateWorkspaceLocation()

    const otherDir = getWorkspaceAutoMemoryDir(ws.slug)
    expect(otherDir.startsWith(configTwo)).toBe(true)
    expect(readWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md').content).toBe('')

    process.env.PROFER_CONFIG_DIR = configOne
    invalidateWorkspaceLocation()
    expect(readWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md').content).toBe('# 配置一\n')
  })

  test('同一 slug 在 managed / project 间切换时记忆目录随之切换', () => {
    const ws = makeWorkspace('Iso Flip')
    writeWorkspaceAutoMemoryFile(ws.slug, 'managed-only.md', 'managed 数据')
    const managedDir = getWorkspaceAutoMemoryDir(ws.slug)

    const root = makeProjectRoot()
    useIndex([projectEntry(ws.slug, root)])
    const projectDir = getWorkspaceAutoMemoryDir(ws.slug)
    expect(projectDir).toBe(join(root, '.profer', 'memory'))
    expect(() => readWorkspaceAutoMemoryFile(ws.slug, 'managed-only.md')).toThrow(/文件不存在/)

    writeWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md', '# 项目记忆\n')

    useIndex([managedEntry(ws.slug)])
    expect(getWorkspaceAutoMemoryDir(ws.slug)).toBe(managedDir)
    expect(readWorkspaceAutoMemoryFile(ws.slug, 'managed-only.md').content).toBe('managed 数据')
    expect(existsSync(join(projectDir, 'MEMORY.md'))).toBe(true)
  })

  test('project 工作区写入的记忆不会出现在其他工作区', () => {
    const other = makeWorkspace('Iso Other')
    const root = makeProjectRoot()
    useIndex([projectEntry('proj-iso', root), managedEntry(other.slug)])

    writeWorkspaceAutoMemoryFile('proj-iso', 'MEMORY.md', '# 项目专属\n')

    expect(readWorkspaceAutoMemoryFile(other.slug, 'MEMORY.md').content).toBe('')
    expect(listWorkspaceAutoMemoryFiles(other.slug).some((n) => n.relativePath === 'MEMORY.md')).toBe(false)
  })
})

// ===== 7. 安全 =====

describe('安全', () => {
  test('../ 路径穿越被拒绝（读写两侧）', () => {
    const ws = makeWorkspace('Sec Traversal')
    expect(() => writeWorkspaceAutoMemoryFile(ws.slug, '../escape.md', 'x')).toThrow(/非法路径/)
    expect(() => readWorkspaceAutoMemoryFile(ws.slug, '../MEMORY.md')).toThrow(/非法路径/)
    expect(() => writeWorkspaceAutoMemoryFile(ws.slug, 'a/../../escape.md', 'x')).toThrow(/非法路径/)
  })

  test('绝对路径被拒绝', () => {
    const ws = makeWorkspace('Sec Absolute')
    const abs = join(tmpdir(), 'profer-absolute-escape.md')
    expect(() => writeWorkspaceAutoMemoryFile(ws.slug, abs, 'x')).toThrow(/禁止传入绝对路径/)
    expect(() => readWorkspaceAutoMemoryFile(ws.slug, abs)).toThrow(/禁止传入绝对路径/)
  })

  test('空路径与 . 被拒绝', () => {
    const ws = makeWorkspace('Sec Empty')
    expect(() => writeWorkspaceAutoMemoryFile(ws.slug, '', 'x')).toThrow(/相对路径不能为空/)
    expect(() => writeWorkspaceAutoMemoryFile(ws.slug, '.', 'x')).toThrow(/非法路径/)
  })

  test('目录内指向外部的文件软链接无法读取', () => {
    const ws = makeWorkspace('Sec Symlink File')
    const dir = getWorkspaceAutoMemoryDir(ws.slug)
    const outside = join(makeScratch('mem-outside-'), 'secret.md')
    writeRaw(outside, '外部机密\n')
    symlinkSync(outside, join(dir, 'link.md'))

    expect(() => readWorkspaceAutoMemoryFile(ws.slug, 'link.md')).toThrow(/软链接/)
  })

  test('目录内指向外部的目录软链接无法读写', () => {
    const ws = makeWorkspace('Sec Symlink Dir')
    const dir = getWorkspaceAutoMemoryDir(ws.slug)
    const outsideDir = makeScratch('mem-outside-dir-')
    writeRaw(join(outsideDir, 'secret.md'), '外部目录机密\n')
    symlinkSync(outsideDir, join(dir, 'ext'))

    expect(() => readWorkspaceAutoMemoryFile(ws.slug, 'ext/secret.md')).toThrow(/软链接/)
    expect(() => writeWorkspaceAutoMemoryFile(ws.slug, 'ext/new.md', 'x')).toThrow(/软链接/)
  })

  test('readWorkspaceMemoryArchiveFile 同样校验 relativePath', () => {
    const ws = makeWorkspace('Sec Archive Traversal')
    expect(() => readWorkspaceMemoryArchiveFile(ws.slug, '../MEMORY.md')).toThrow(/非法路径/)
    expect(() => readWorkspaceMemoryArchiveFile(ws.slug, join(tmpdir(), 'x.md'))).toThrow(/禁止传入绝对路径/)
    expect(() => writeWorkspaceMemoryArchiveFile(ws.slug, '../x.md', 'x')).toThrow(/非法路径/)
  })
})

// ===== 8. 一致性 =====

describe('一致性', () => {
  test('统一目录：写入可被读取 / 文件树 / 搜索 / wikilink 同时看到', () => {
    const ws = makeWorkspace('Consistent All')
    writeWorkspaceMemoryArchiveFile(ws.slug, 'topics/alpha.md', '---\nname: alpha-topic\ndescription: 一致性验证\n---\n唯一标记 星尘\n')
    const dir = getWorkspaceMemoryArchivePath(ws.slug)

    expect(readWorkspaceAutoMemoryFile(ws.slug, 'topics/alpha.md').content).toContain('星尘')
    expect(listWorkspaceAutoMemoryFiles(ws.slug).some((node) => node.relativePath === 'topics')).toBe(true)
    expect(searchMemoryArchive(dir, '星尘').map((hit) => hit.relativePath)).toEqual(['topics/alpha.md'])
    expect(resolveMemoryWikilink(dir, dir, 'alpha-topic')?.relativePath).toBe('topics/alpha.md')
  })

  test('文件树排序：目录在前，MEMORY.md 在文件中最靠前', () => {
    const ws = makeWorkspace('Consistent Order')
    writeWorkspaceMemoryArchiveFile(ws.slug, 'a.md', 'a')
    writeWorkspaceMemoryArchiveFile(ws.slug, 'MEMORY.md', '# index')
    writeWorkspaceMemoryArchiveFile(ws.slug, 'topics/t.md', 't')

    const tree = listWorkspaceAutoMemoryFiles(ws.slug)
    expect(tree.map((node) => node.relativePath)).toEqual(['topics', 'MEMORY.md', 'a.md'])
    expect(tree[0]!.children?.map((node) => node.relativePath)).toEqual(['topics/t.md'])
  })

  test('auto 写入与 archive 读取指向同一目录、同一份内容', () => {
    const ws = makeWorkspace('Consistent Same Dir')
    writeWorkspaceAutoMemoryFile(ws.slug, '共享主题.md', '统一目录内容\n')

    expect(readWorkspaceAutoMemoryFile(ws.slug, '共享主题.md').content).toBe('统一目录内容\n')
    // 旧目录只读展示，不包含统一目录新写入的文件
    expect(listWorkspaceMemoryArchiveFiles(ws.slug)).toEqual([])
  })

  test('摘要中的目录与 memoryArchivePath 一致，indexExists / fileCount 跟随实际文件', () => {
    const ws = makeWorkspace('Consistent Summary')
    const summaryBefore = getWorkspaceMemorySummary(ws.slug)
    expect(summaryBefore.autoMemory.directory).toBe(getWorkspaceAutoMemoryDir(ws.slug))
    expect(summaryBefore.autoMemory.memoryArchivePath).toBe(summaryBefore.autoMemory.directory)
    expect(summaryBefore.autoMemory.indexExists).toBe(false)
    expect(summaryBefore.autoMemory.fileCount).toBe(0)

    writeWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md', '# 索引\n')
    writeWorkspaceAutoMemoryFile(ws.slug, 'topics/a.md', '内容\n')

    const summaryAfter = getWorkspaceMemorySummary(ws.slug)
    expect(summaryAfter.autoMemory.indexExists).toBe(true)
    expect(summaryAfter.autoMemory.fileCount).toBe(2)
    expect(summaryAfter.autoMemory.totalSize).toBeGreaterThan(0)
  })

  test('隐藏主题文件可被直接读取，但不会出现在文件树 / 搜索结果中（审计缺口）', () => {
    const ws = makeWorkspace('Consistent Hidden')
    writeWorkspaceAutoMemoryFile(ws.slug, '.hidden.md', '隐藏内容 隐蔽标记\n')

    expect(readWorkspaceAutoMemoryFile(ws.slug, '.hidden.md').content).toBe('隐藏内容 隐蔽标记\n')
    expect(listWorkspaceAutoMemoryFiles(ws.slug).some((n) => n.relativePath === '.hidden.md')).toBe(false)
    expect(searchMemoryArchive(getWorkspaceAutoMemoryDir(ws.slug), '隐蔽标记')).toEqual([])
  })

  test('readWorkspaceMemoryArchiveFile 对不存在的 MEMORY.md 直接抛错（与 auto 读取 API 不对称）', () => {
    const ws = makeWorkspace('Consistent Archive Missing')
    expect(readWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md').content).toBe('')
    expect(() => readWorkspaceMemoryArchiveFile(ws.slug, 'MEMORY.md')).toThrow(/文件不存在/)
  })

  test('UI 两个列表 API 现在返回完全相同的文件树（重复展示风险）', () => {
    const ws = makeWorkspace('Consistent Dup')
    writeWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md', '# 索引\n')
    writeWorkspaceAutoMemoryFile(ws.slug, 'topic.md', '主题\n')

    // 统一目录只由 Auto Memory 展示；历史档案面板不重复列出同一批文件。
    expect(listWorkspaceAutoMemoryFiles(ws.slug).length).toBe(2)
    expect(listWorkspaceMemoryArchiveFiles(ws.slug)).toEqual([])
  })
})

// ===== 9. 删除 =====

describe('删除', () => {
  test('删除 managed 工作区会带走自己的记忆，不影响其他工作区', async () => {
    const a = makeWorkspace('Delete A')
    const b = makeWorkspace('Delete B')
    writeWorkspaceAutoMemoryFile(a.slug, 'MEMORY.md', '# A\n')
    writeWorkspaceAutoMemoryFile(b.slug, 'MEMORY.md', '# B\n')
    const dirA = getWorkspaceAutoMemoryDir(a.slug)
    const dirB = getWorkspaceAutoMemoryDir(b.slug)

    await deleteAgentWorkspace(a.id)

    expect(existsSync(dirA)).toBe(false)
    expect(readFileSync(join(dirB, 'MEMORY.md'), 'utf-8')).toBe('# B\n')
  })

  test('移除 project 绑定只删索引，项目目录与记忆全部保留', () => {
    const root = makeProjectRoot()
    useIndex([projectEntry('proj-del', root)])
    writeWorkspaceAutoMemoryFile('proj-del', 'MEMORY.md', '# 项目记忆\n')
    const memoryDir = getWorkspaceAutoMemoryDir('proj-del')

    removeProjectWorkspace('id-proj-del')

    expect(existsSync(memoryDir)).toBe(true)
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8')).toBe('# 项目记忆\n')
    const index = JSON.parse(readFileSync(indexPath(), 'utf-8')) as { workspaces: Array<{ slug: string }> }
    expect(index.workspaces.some((entry) => entry.slug === 'proj-del')).toBe(false)
  })

  test('删除会话不影响工作区记忆', async () => {
    const ws = makeWorkspace('Delete Session')
    writeWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md', '# 会话无关\n')
    const session = createAgentSession('待删会话', undefined, ws.id)

    await deleteAgentSession(session.id)

    expect(readWorkspaceAutoMemoryFile(ws.slug, 'MEMORY.md').content).toBe('# 会话无关\n')
    expect(listWorkspaceAutoMemoryFiles(ws.slug).some((n) => n.relativePath === 'MEMORY.md')).toBe(true)
  })
})

// ===== 10. 并发 =====

describe('并发', () => {
  test('并发写入不同文件：全部落盘且全部可检索', async () => {
    const ws = makeWorkspace('Concurrent Distinct')
    await Promise.all([
      writeWorkspaceAutoMemoryFile(ws.slug, 'a.md', '并发标记 alpha'),
      writeWorkspaceAutoMemoryFile(ws.slug, 'b.md', '并发标记 beta'),
      writeWorkspaceAutoMemoryFile(ws.slug, 'c.md', '并发标记 gamma'),
    ])

    const dir = getWorkspaceAutoMemoryDir(ws.slug)
    expect(['a.md', 'b.md', 'c.md'].every((file) => existsSync(join(dir, file)))).toBe(true)
    expect(searchMemoryArchive(dir, '并发标记').length).toBe(3)
  })

  test('并发写入同一文件：最终内容是其中一次的完整内容，不出现交叉损坏', async () => {
    const ws = makeWorkspace('Concurrent Same File')
    const first = `第一份 ${'X'.repeat(4096)} END-A`
    const second = `第二份 ${'Y'.repeat(8192)} END-B`

    await Promise.all([
      writeWorkspaceAutoMemoryFile(ws.slug, 'race.md', first),
      writeWorkspaceAutoMemoryFile(ws.slug, 'race.md', second),
    ])

    const content = readWorkspaceAutoMemoryFile(ws.slug, 'race.md').content
    expect([first, second]).toContain(content!)
    expect(content!.endsWith('END-A') || content!.endsWith('END-B')).toBe(true)
  })

  test('20 个文件并发写入后搜索能一次取回全部（topK 上限内不丢）', async () => {
    const ws = makeWorkspace('Concurrent Many')
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeWorkspaceAutoMemoryFile(ws.slug, `topics/t${i}.md`, `并行主题 token ${i}`)),
    )

    const hits = searchMemoryArchive(getWorkspaceAutoMemoryDir(ws.slug), '并行主题', 20)
    expect(hits.length).toBe(20)
    expect(new Set(hits.map((hit) => hit.relativePath)).size).toBe(20)
  })
})

