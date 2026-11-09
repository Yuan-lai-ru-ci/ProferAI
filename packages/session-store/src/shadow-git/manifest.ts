/**
 * 增量索引清单：每根「路径 → (stat 身份, blob sha)」。
 *
 * 为什么需要它：采集要能把「自上次快照以来变过的文件」和「没变的文件」区分开。
 * 只靠 git 索引不行——我们为了绕开嵌套仓库的问题走的是 `hash-object`，
 * 它无条件重算内容哈希；4866 个文件的真实项目一次采集 6.5s，按 turn 前后各一次
 * 就是每轮对话十几秒的重复 I/O。
 *
 * 一致性优先于速度：
 * - 清单只在**采集成功后**整份替换，失败时旧清单原样保留（下次宁可多哈希，不能少哈希）；
 * - 清单损坏 / 形状不对时整份作废并留证，回退全量哈希——静默复用错误的 sha
 *   会让快照记录一个从未存在的内容，这是底座最不可接受的错误；
 * - 判断「没变」同时看 size / mtime / ctime / inode：编辑器原子替换会换 inode，
 *   `touch -r` 能改 mtime 但改不掉 ctime；
 * - mode 是可选字段：加上可执行位采集之前写下的清单没有它，读回来就是 undefined，
 *   这种条目一律不复用，否则已有工作区永远等不到 100755 被重新登记。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ShadowFileStat } from './types'

export interface ShadowManifestEntry extends Omit<ShadowFileStat, 'mode'> {
  /**
   * 采集时文件的权限位（低 9 位）。
   *
   * 可选：旧版本清单没有这个字段。缺失时不参与复用判断（见 tree-builder），
   * 下一次采集会重新哈希并补上。
   */
  mode?: number
  sha: string
}

export interface ShadowManifestRoot {
  rootPath: string
  files: Record<string, ShadowManifestEntry>
}

interface ShadowManifestFile {
  schemaVersion: 1
  roots: Record<string, ShadowManifestRoot>
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

export class ShadowManifest {
  readonly path: string
  #roots: Record<string, ShadowManifestRoot>

  private constructor(path: string, roots: Record<string, ShadowManifestRoot>) {
    this.path = path
    this.#roots = roots
  }

  /** 读不到 / 损坏都从空清单开始：宁可全量重哈希，也不能复用来路不明的 sha。 */
  static open(path: string): ShadowManifest {
    const raw = readManifest(path)
    return new ShadowManifest(path, raw)
  }

  root(rootId: string): ShadowManifestRoot | undefined {
    return this.#roots[rootId]
  }

  /**
   * 用本次采集的结果整份替换。
   *
   * 只保留本次出现的根：根被移除后它的清单没有任何用处，留着只会让文件无限增长。
   */
  replaceRoots(roots: Record<string, ShadowManifestRoot>): void {
    this.#roots = roots
  }

  /** 原子落盘；失败只返回 false（采集本身已经成功，不能因为清单写不进去就回滚快照）。 */
  save(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const payload: ShadowManifestFile = { schemaVersion: 1, roots: this.#roots }
      writeAtomic(this.path, JSON.stringify(payload))
      return true
    } catch (error) {
      console.warn('[Shadow Git] 增量清单写入失败，下次将回退全量采集:', error)
      return false
    }
  }

  /** 诊断用：清单里记录了多少个文件。 */
  size(): number {
    return Object.values(this.#roots).reduce((total, root) => total + Object.keys(root.files).length, 0)
  }
}

function readManifest(path: string): Record<string, ShadowManifestRoot> {
  for (const candidate of [path, `${path}.tmp`]) {
    if (!existsSync(candidate)) continue
    let parsed: unknown
    try {
      const text = readFileSync(candidate, 'utf8')
      if (!text.trim()) continue
      parsed = JSON.parse(text)
    } catch (error) {
      // JSON 坏了：留证后按空清单启动，避免每次采集都读到同一份坏文件。
      console.warn(`[Shadow Git] 增量清单不可解析，已作废 (${candidate}): ${(error as Error).message}`)
      quarantine(candidate)
      break
    }
    const roots = validate(parsed)
    if (roots) return roots
    console.warn(`[Shadow Git] 增量清单形状非法，已作废: ${candidate}`)
    quarantine(candidate)
    break
  }
  return {}
}

function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    /* 留证失败不影响继续启动 */
  }
}

function validate(value: unknown): Record<string, ShadowManifestRoot> | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { schemaVersion?: unknown; roots?: unknown }
  if (candidate.schemaVersion !== 1) return null
  if (!candidate.roots || typeof candidate.roots !== 'object') return null
  const roots: Record<string, ShadowManifestRoot> = {}
  for (const [rootId, rawRoot] of Object.entries(candidate.roots as Record<string, unknown>)) {
    if (!rawRoot || typeof rawRoot !== 'object') continue
    const root = rawRoot as { rootPath?: unknown; files?: unknown }
    if (typeof root.rootPath !== 'string' || !root.files || typeof root.files !== 'object') continue
    const files: Record<string, ShadowManifestEntry> = {}
    for (const [filePath, rawEntry] of Object.entries(root.files as Record<string, unknown>)) {
      const entry = readEntry(rawEntry)
      if (entry) files[filePath] = entry
    }
    roots[rootId] = { rootPath: root.rootPath, files }
  }
  return roots
}

function readEntry(value: unknown): ShadowManifestEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as Record<string, unknown>
  const sha = entry.sha
  if (typeof sha !== 'string' || !OBJECT_ID_PATTERN.test(sha)) return undefined
  const numbers = ['size', 'mtimeMs', 'ctimeMs', 'ino'] as const
  for (const key of numbers) {
    if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key] as number)) return undefined
  }
  // mode 只保留低 9 位；形状不对时按「缺失」处理（不复用，下次重新登记）。
  const rawMode = entry.mode
  const mode =
    typeof rawMode === 'number' && Number.isFinite(rawMode) && rawMode >= 0 ? Math.floor(rawMode) & 0o777 : undefined
  return {
    size: entry.size as number,
    mtimeMs: entry.mtimeMs as number,
    ctimeMs: entry.ctimeMs as number,
    ino: entry.ino as number,
    ...(mode === undefined ? {} : { mode }),
    sha,
  }
}

function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, content)
    // fsync 必须在 rename 前：清单描述的是「已经提交的 tree」，写一半断电会污染下一次采集的判断。
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}
