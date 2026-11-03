import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findPiSessionJsonlCached,
  getPiTranscriptIndex,
  invalidatePiTranscriptCache,
  isPiTranscriptPathFor,
  readPiSessionHeaderId,
  resolvePiTranscriptPath,
} from './pi-session-files'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
  invalidatePiTranscriptCache()
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-pi-transcript-'))
  roots.push(root)
  return root
}

function writeTranscript(dir: string, fileName: string, sessionId: string, extra = ''): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, fileName)
  writeFileSync(path, `{"type":"session","id":"${sessionId}"}\n${extra}`, 'utf8')
  return path
}

describe('Pi transcript 路径解析', () => {
  test('Given 索引已记录路径 When 解析 Then 直接返回且不依赖文件名包含 id', () => {
    const root = makeRoot()
    const path = writeTranscript(root, '2026-11-04T00-00-00-000Z_abc.jsonl', 'session-1')

    expect(resolvePiTranscriptPath('session-1', path, { rootDir: root })).toBe(path)
  })

  test('Given 索引路径的 header 属于另一会话 When 解析 Then 拒绝该路径并回退扫描', () => {
    const root = makeRoot()
    const wrong = writeTranscript(root, 'wrong.jsonl', 'session-other')
    const correct = writeTranscript(join(root, 'nested'), 'correct.jsonl', 'session-1')

    expect(isPiTranscriptPathFor('session-1', wrong, { rootDir: root })).toBe(false)
    expect(resolvePiTranscriptPath('session-1', wrong, { rootDir: root })).toBe(correct)
  })

  test('Given 路径在根目录之外 When 校验 Then 拒绝', () => {
    const root = makeRoot()
    const outsideRoot = makeRoot()
    const outside = writeTranscript(outsideRoot, 'x.jsonl', 'session-1')

    expect(isPiTranscriptPathFor('session-1', outside, { rootDir: root })).toBe(false)
  })

  test('Given 同一 sessionId 有多个文件 When 解析 Then 返回 undefined 避免误删', () => {
    const root = makeRoot()
    writeTranscript(root, 'a.jsonl', 'session-1')
    writeTranscript(root, 'b.jsonl', 'session-1')

    expect(findPiSessionJsonlCached('session-1', { rootDir: root, force: true })).toBeUndefined()
    expect(resolvePiTranscriptPath('session-1', undefined, { rootDir: root, force: true })).toBeUndefined()
  })

  test('Given 缓存已建立 When 新增 transcript 且强制重建 Then 能找到', () => {
    const root = makeRoot()
    writeTranscript(root, 'old.jsonl', 'session-old')
    expect(getPiTranscriptIndex({ rootDir: root, force: true }).size).toBe(1)

    writeTranscript(root, 'new.jsonl', 'session-new')
    expect(findPiSessionJsonlCached('session-new', { rootDir: root, force: true })).toBe(
      join(root, 'new.jsonl'),
    )
  })

  test('Given 缓存未过期 When 新增 transcript Then 仍在缓存窗口内（记录当前降级语义）', () => {
    const root = makeRoot()
    writeTranscript(root, 'old.jsonl', 'session-old')
    let now = 1_000
    getPiTranscriptIndex({ rootDir: root, now: () => now, cacheTtlMs: 30_000, force: true })

    writeTranscript(root, 'new.jsonl', 'session-new')
    expect(findPiSessionJsonlCached('session-new', { rootDir: root, now: () => now, cacheTtlMs: 30_000 })).toBeUndefined()

    now += 30_001
    expect(findPiSessionJsonlCached('session-new', { rootDir: root, now: () => now, cacheTtlMs: 30_000 })).toBe(
      join(root, 'new.jsonl'),
    )
  })

  test('Given header 带 BOM 或损坏 When 读取 Then 正确解析或安全返回 undefined', () => {
    const root = makeRoot()
    const bomPath = join(root, 'bom.jsonl')
    mkdirSync(root, { recursive: true })
    writeFileSync(bomPath, `\uFEFF{"type":"session","id":"bom-session"}\n`, 'utf8')
    expect(readPiSessionHeaderId(bomPath)).toBe('bom-session')

    const brokenPath = join(root, 'broken.jsonl')
    writeFileSync(brokenPath, 'not-json\n', 'utf8')
    expect(readPiSessionHeaderId(brokenPath)).toBeUndefined()
    expect(readPiSessionHeaderId(join(root, 'missing.jsonl'))).toBeUndefined()
  })

  test('Given 非 session 类型的首行 When 读取 Then 返回 undefined', () => {
    const root = makeRoot()
    const path = join(root, 'other.jsonl')
    writeFileSync(path, '{"type":"message","id":"session-1"}\n', 'utf8')
    expect(readPiSessionHeaderId(path)).toBeUndefined()
  })
})
