import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMemoryWikilink, findMemoryBacklinks } from './memory-wikilink-service'

let root = ''
let archiveDir = ''
let autoDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-wikilink-test-'))
  archiveDir = join(root, 'memory-archive')
  autoDir = join(root, '.claude', 'memory')
  mkdirSync(archiveDir, { recursive: true })
  mkdirSync(autoDir, { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('resolveMemoryWikilink（[[名称]] → 记忆文件）', () => {
  test('按 frontmatter name 精确匹配', () => {
    writeFileSync(join(archiveDir, 'skin-engine.md'), '---\nname: skin-engine\ndescription: 皮肤引擎经验\n---\n皮肤相关内容')
    const hit = resolveMemoryWikilink(archiveDir, autoDir, 'skin-engine')
    expect(hit).not.toBeNull()
    expect(hit!.relativePath).toBe('skin-engine.md')
    expect(hit!.matchedBy).toBe('name')
  })

  test('按文件名（无 frontmatter）也能精确匹配（name 回退到文件名）', () => {
    writeFileSync(join(archiveDir, 'pr-workflow.md'), '# 干净 PR 工作流\n没有 frontmatter')
    const hit = resolveMemoryWikilink(archiveDir, autoDir, 'pr-workflow')
    expect(hit).not.toBeNull()
    expect(hit!.name).toBe('pr-workflow')
    expect(hit!.kind).toBe('archive')
  })

  test('大小写不敏感匹配', () => {
    writeFileSync(join(archiveDir, 'Skin-Engine.md'), '---\nname: Skin-Engine\n---\n内容')
    const hit = resolveMemoryWikilink(archiveDir, autoDir, 'skin-engine')
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe('archive')
  })

  test('auto memory 目录也能命中', () => {
    writeFileSync(join(autoDir, 'MEMORY.md'), '---\nname: memory-index\n---\n# 索引')
    const hit = resolveMemoryWikilink(archiveDir, autoDir, 'memory-index')
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe('auto')
  })

  test('不存在返回 null', () => {
    expect(resolveMemoryWikilink(archiveDir, autoDir, '不存在的主题')).toBeNull()
  })
})

describe('findMemoryBacklinks（谁引用了我）', () => {
  test('识别写有 [[name]] 的其他文件', () => {
    writeFileSync(join(archiveDir, 'a.md'), '---\nname: a-topic\n---\n参见 [[security-encryption]]')
    writeFileSync(join(archiveDir, 'security-encryption.md'), '---\nname: security-encryption\n---\n加密经验')
    const links = findMemoryBacklinks(archiveDir, autoDir, join(archiveDir, 'security-encryption.md'), 'security-encryption')
    expect(links.length).toBe(1)
    expect(links[0]!.relativePath).toBe('a.md')
  })

  test('不返回自身', () => {
    writeFileSync(join(archiveDir, 'self.md'), '---\nname: self\n---\n自引用 [[self]]')
    const links = findMemoryBacklinks(archiveDir, autoDir, join(archiveDir, 'self.md'), 'self')
    expect(links.length).toBe(0)
  })

  test('支持 [[name|显示文本]] 别名形式', () => {
    writeFileSync(join(archiveDir, 'b.md'), '---\nname: b\n---\n链接 [[skin-engine|皮肤]]')
    writeFileSync(join(archiveDir, 'skin-engine.md'), '---\nname: skin-engine\n---\n内容')
    const links = findMemoryBacklinks(archiveDir, autoDir, join(archiveDir, 'skin-engine.md'), 'skin-engine')
    expect(links.length).toBe(1)
    expect(links[0]!.relativePath).toBe('b.md')
  })

  test('无引用返回空数组', () => {
    writeFileSync(join(archiveDir, 'c.md'), '---\nname: c\n---\n无链接内容')
    const links = findMemoryBacklinks(archiveDir, autoDir, join(archiveDir, 'c.md'), 'c')
    expect(links).toEqual([])
  })
})
