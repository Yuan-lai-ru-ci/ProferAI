import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandHomeDirectory, readFileAsDataUrl, resolveFilePath, resolveTargetPath } from './file-preview-service'

/**
 * resolveTargetPath 预检模式（skipGlobalSearch）浅层搜索行为测试。
 *
 * 背景：FilePathChip 批量预检用 preflight 标记跳过全工作区全局递归搜索（避免主进程卡顿），
 * 但在 basePaths 内做浅层递归（深度 3），把工作区/授权目录子目录中的文件识别为「已存在」，
 * 避免裸文件名引用几乎全部落到「待查找」。本测试覆盖该浅层搜索的命中与边界。
 */
describe('文件预览路径安全解析', () => {
  test('Given 当前用户 home 缩写 When 解析路径 Then 只展开当前用户目录', () => {
    expect(expandHomeDirectory('~')).toBe(homedir())
    expect(expandHomeDirectory('~/Documents/a.md')).toBe(join(homedir(), 'Documents', 'a.md'))
    expect(expandHomeDirectory('~other-user/a.md')).toBe('~other-user/a.md')
  })

  test('Given home 下存在文件 When 解析 ~ 路径 Then 返回展开后的文件路径', () => {
    const home = homedir()
    const target = join(home, '.profer-preview-test-do-not-create')
    expect(resolveTargetPath('~/.profer-preview-test-do-not-create')).toBe(target)
  })
})

describe('readFileAsDataUrl 的 MIME 判定', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fpc-mime-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('Given PDF When 转 data URL Then 带 application/pdf（浏览器才会内嵌预览）', () => {
    const file = join(tmpDir, '报告.pdf')
    writeFileSync(file, Buffer.from('%PDF-1.4\n%%EOF'))
    const result = readFileAsDataUrl(file, [tmpDir])
    expect(result?.dataUrl.startsWith('data:application/pdf;base64,')).toBe(true)
  })

  test('Given 未知扩展名 When 转 data URL Then 回退 application/octet-stream', () => {
    const file = join(tmpDir, 'a.bin')
    writeFileSync(file, Buffer.from([1, 2, 3]))
    const result = readFileAsDataUrl(file, [tmpDir])
    expect(result?.dataUrl.startsWith('data:application/octet-stream;base64,')).toBe(true)
  })
})

describe('resolveTargetPath 预检浅层搜索（skipGlobalSearch）', () => {
  let tmpBase: string

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'fpcs-'))
    // ws/src/foo.ts —— 深度 2，预检浅层（深度 3）应命中
    mkdirSync(join(tmpBase, 'ws', 'src'), { recursive: true })
    writeFileSync(join(tmpBase, 'ws', 'src', 'foo.ts'), 'x')
    // ws/deep/a/b/c/bar.ts —— 深度 5，超出预检浅层深度 3，不应命中
    mkdirSync(join(tmpBase, 'ws', 'deep', 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(tmpBase, 'ws', 'deep', 'a', 'b', 'c', 'bar.ts'), 'x')
  })

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true })
  })

  test('预检模式：base 子目录（深度 2）的裸文件名能解析到绝对路径', () => {
    const resolved = resolveFilePath('foo.ts', [join(tmpBase, 'ws')], { skipGlobalSearch: true })
    expect(resolved).toBe(join(tmpBase, 'ws', 'src', 'foo.ts'))
  })

  test('预检模式：不存在的文件返回 null（不误报存在）', () => {
    const resolved = resolveFilePath('nope.ts', [join(tmpBase, 'ws')], { skipGlobalSearch: true })
    expect(resolved).toBeNull()
  })

  test('预检模式：深度超过 3 的裸文件名不命中，返回 null（点击时走完整解析兜底）', () => {
    const resolved = resolveFilePath('bar.ts', [join(tmpBase, 'ws')], { skipGlobalSearch: true })
    expect(resolved).toBeNull()
  })
})
