import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { VISUALIZATION_LIMITS } from '@profer/shared'
import type {
  PresentVisualizationInput, VisualizationContext, VisualizationKind, VisualizationContent,
  VisualizationRecord, VisualizationViewState,
} from '@profer/shared'
import {
  boundedText, optionalText, plainObject, strictKeys, validateChart, validateFragment, validateHtml, validateObjects, validateViewState,
} from './visualization-validation'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const REVISION = /^[a-f0-9]{64}$/
const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_SOURCE_TEXT_CHARS = 20_000
const KINDS = new Set<VisualizationKind>(['structure', 'comparison', 'data', 'explanation'])
const RECORD_FIELDS = ['schemaVersion', 'id', 'sessionId', 'toolCallId', 'sourceMessageId', 'sourceText', 'title', 'kind', 'format', 'chart', 'revision', 'recordVersion', 'summary', 'objects', 'createdAt', 'updatedAt']
const INPUT_FIELDS = ['filePath', 'chart', 'format', 'title', 'kind', 'summary', 'objects', 'visualizationId', 'baseRevision', 'sourceMessageId', 'sourceText']
const locks = new Map<string, Promise<void>>()

function checkId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('可视化 id 无效')
}

function checkRevision(revision: unknown): asserts revision is string {
  if (typeof revision !== 'string' || !REVISION.test(revision)) throw new Error('可视化 revision 无效')
}

function kind(value: unknown): VisualizationKind {
  if (typeof value !== 'string' || !KINDS.has(value as VisualizationKind)) throw new Error('可视化类型无效')
  return value as VisualizationKind
}

function contentFormat(value: unknown): 'html' | 'fragment' | 'chart' {
  if (value !== 'html' && value !== 'fragment' && value !== 'chart') throw new Error('可视化内容格式无效')
  return value
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

function checkContext(context: VisualizationContext): void {
  if (!plainObject(context)) throw new Error('可视化会话上下文无效')
  boundedText(context.sessionId, 'sessionId', 256)
  boundedText(context.agentCwd, '会话工作目录', 4096)
  boundedText(context.storageDir, '可视化存储根', 4096)
  if (!Array.isArray(context.allowedRoots) || context.allowedRoots.some((root) => typeof root !== 'string')) throw new Error('可视化授权目录无效')
}

/**
 * 记录存储根：由 config 目录下的会话专属目录提供，位于会话工作区之外。
 *
 * 绝不能落在会话工作区里：文件检查点会把基线之后新增的记录当作“本轮新增文件”，
 * 一次快照回退就会删掉它们，而残留的对话历史仍然引用着这些记录。
 */
async function storageRoot(context: VisualizationContext, create = false): Promise<string> {
  checkContext(context)
  const requested = resolve(context.storageDir)
  if (create) await mkdir(requested, { recursive: true, mode: 0o700 })
  const root = await realpath(requested)
  if (!(await stat(root)).isDirectory()) throw new Error('可视化存储根无效')
  return root
}

/** 源文件解析基准：只用于读取生成内容的相对路径与授权校验。 */
async function sourceRoot(context: VisualizationContext): Promise<string> {
  checkContext(context)
  const root = await realpath(resolve(context.agentCwd))
  if (!(await stat(root)).isDirectory()) throw new Error('可视化会话工作目录无效')
  return root
}

/** 存储树不接受任何符号链接；只有源文件可以在 realpath 授权后读取。 */
async function storageDirectory(root: string, segments: string[], create = false): Promise<string> {
  let directory = root
  for (const segment of segments) {
    directory = join(directory, segment)
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('可视化存储目录或符号链接路径无效')
  }
  return directory
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('可视化文件必须是普通文件，不能是符号链接')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== details.ino || opened.dev !== details.dev) throw new Error('可视化文件读取期间路径已变化')
    if (opened.size > maxBytes) throw new Error(`可视化文件大小超过 ${maxBytes} 字节限制`)
    const buffer = Buffer.alloc(maxBytes + 1)
    let bytes = 0
    while (bytes <= maxBytes) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    if (bytes > maxBytes) throw new Error(`可视化文件大小超过 ${maxBytes} 字节限制`)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)) } catch { throw new Error('可视化文件必须是有效 UTF-8') }
  } finally { await handle.close() }
}

async function readSource(inputPath: string, context: VisualizationContext, root: string): Promise<string> {
  boundedText(inputPath, '文件路径', 4096)
  const path = await realpath(resolve(root, inputPath))
  const allowed = await Promise.all([root, ...context.allowedRoots].map(async (candidate) => {
    const canonical = await realpath(resolve(candidate))
    if (!(await stat(canonical)).isDirectory()) throw new Error('可视化授权根必须是目录')
    return canonical
  }))
  if (!allowed.some((candidate) => inside(candidate, path))) throw new Error('可视化文件未获授权，符号链接不可越界')
  const html = await readBoundedFile(path, VISUALIZATION_LIMITS.maxHtmlBytes)
  validateHtml(html)
  return html
}

function parseRecord(value: unknown): VisualizationRecord {
  if (!plainObject(value)) throw new Error('可视化记录损坏')
  strictKeys(value, RECORD_FIELDS, '记录')
  if (value.schemaVersion !== 1) throw new Error('可视化记录版本无效')
  checkId(value.id)
  checkRevision(value.revision)
  if (typeof value.recordVersion !== 'number' || !Number.isSafeInteger(value.recordVersion) || value.recordVersion < 1
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
    || !Array.isArray(value.objects)) throw new Error('可视化记录损坏')
  if (value.format === 'chart' ? value.chart === undefined : value.chart !== undefined) throw new Error('可视化格式与图表规格不匹配')
  const sourceMessageId = optionalText(value.sourceMessageId, 'sourceMessageId', 256)
  const sourceText = optionalText(value.sourceText, 'sourceText', MAX_SOURCE_TEXT_CHARS)
  // 固定字段顺序用于内容哈希；不从磁盘读取任何可变源路径。
  return {
    schemaVersion: 1, id: value.id,
    sessionId: boundedText(value.sessionId, 'sessionId', 256),
    toolCallId: boundedText(value.toolCallId, 'toolCallId', 256),
    ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
    ...(sourceText === undefined ? {} : { sourceText }),
    title: boundedText(value.title, '标题', VISUALIZATION_LIMITS.maxTitleChars), kind: kind(value.kind),
    ...(value.format === undefined ? {} : { format: contentFormat(value.format) }),
    ...(value.chart === undefined ? {} : { chart: validateChart(value.chart) }),
    revision: value.revision, recordVersion: value.recordVersion,
    summary: boundedText(value.summary, '摘要', VISUALIZATION_LIMITS.maxSummaryChars), objects: validateObjects(value.objects),
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  }
}

function revisionHash(html: string, record: VisualizationRecord): string {
  const { revision: _revision, ...metadata } = record
  return createHash('sha256').update(JSON.stringify({ html, metadata })).digest('hex')
}

async function readRecord(path: string, context: VisualizationContext, id: string, revision?: string): Promise<VisualizationRecord> {
  let raw: string
  try {
    raw = await readBoundedFile(path, MAX_METADATA_BYTES)
  } catch (error) {
    // 区分“文件不在”和“文件坏了”：被清理/回退删掉的记录不应该报成损坏。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('可视化记录不存在：存储中找不到该修订（可能已被清理或删除）')
    throw new Error(`可视化记录不可读：${error instanceof Error ? error.message : '读取失败'}`)
  }
  let record: VisualizationRecord
  try {
    record = parseRecord(JSON.parse(raw) as unknown)
  } catch (error) {
    throw new Error(`可视化记录损坏：${error instanceof Error ? error.message : '无效 JSON'}`)
  }
  if (record.id !== id || record.sessionId !== context.sessionId) throw new Error('可视化记录不存在或不属于当前会话')
  if (revision !== undefined && record.revision !== revision) throw new Error('可视化记录损坏：revision 不匹配')
  return record
}

async function locate(context: VisualizationContext, id: string, revision?: string): Promise<{ root: string; directory: string; record: VisualizationRecord }> {
  checkId(id)
  if (revision !== undefined) checkRevision(revision)
  let root: string
  try {
    root = await storageRoot(context)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('可视化记录不存在：会话可视化存储尚未创建')
    throw error
  }
  const directory = await storageDirectory(root, [id])
  const current = await readRecord(join(directory, 'record.json'), context, id)
  const revisions = await storageDirectory(root, [id, 'revisions'])
  const record = await readRecord(join(revisions, `${revision ?? current.revision}.json`), context, id, revision ?? current.revision)
  if ((!revision || revision === current.revision) && JSON.stringify(record) !== JSON.stringify(current)) throw new Error('可视化记录损坏：当前记录与修订不匹配')
  return { root, directory, record }
}

async function atomicWrite(path: string, content: string, immutable = false, assertCanCommit?: () => void): Promise<void> {
  if (immutable) {
    try { await lstat(path); throw new Error('可视化不可变 revision 已存在') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    assertCanCommit?.()
    await rename(temporary, path)
  } finally {
    try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

async function assertStorageBudget(root: string, additionalBytes: number, creating: boolean): Promise<void> {
  let directory: string
  try { directory = await storageDirectory(root, []) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const pending = [directory]
  let bytes = additionalBytes
  let results = 0
  let entries = 0
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++entries > 20_000) throw new Error('可视化存储条目超出会话额度')
      if (entry.isSymbolicLink()) throw new Error('可视化存储不能包含符号链接')
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (current === directory && UUID.test(entry.name)) results++
        pending.push(path)
      } else if (entry.isFile()) bytes += (await lstat(path)).size
      if (bytes > VISUALIZATION_LIMITS.maxSessionStorageBytes) throw new Error('可视化修订已达到本会话 64 MiB 存储额度；旧结果保持可用')
    }
  }
  if (creating && results >= VISUALIZATION_LIMITS.maxResultsPerSession) throw new Error('本会话已达到 128 个可视结果额度；旧结果保持可用')
}

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveRelease) => { release = resolveRelease })
  locks.set(key, current)
  await previous
  try { return await operation() } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

export async function presentVisualization(input: PresentVisualizationInput, context: VisualizationContext, toolCallId: string, assertCanCommit?: () => void): Promise<VisualizationRecord> {
  assertCanCommit?.()
  if (!plainObject(input)) throw new Error('可视化输入无效')
  strictKeys(input, INPUT_FIELDS, '输入')
  const title = boundedText(input.title, '标题', VISUALIZATION_LIMITS.maxTitleChars)
  const summary = boundedText(input.summary, '摘要', VISUALIZATION_LIMITS.maxSummaryChars)
  const chart = input.chart === undefined ? undefined : validateChart(input.chart)
  if ((input.filePath === undefined) === (chart === undefined)) throw new Error('必须且只能提供 chart 或 filePath')
  if (chart && (input.format !== undefined || input.objects !== undefined)) throw new Error('原生图表的格式与对象由宿主生成')
  if (input.format !== undefined && input.format !== 'html' && input.format !== 'fragment') throw new Error('可视化输入格式无效')
  const format = chart ? 'chart' : input.format === undefined ? 'html' : contentFormat(input.format)
  const visualizationKind = kind(input.kind === undefined ? (chart ? 'data' : 'explanation') : input.kind)
  const objects = chart ? chart.data.map((row, index) => ({ id: `row-${index}`, label: String(row[chart.nameKey ?? chart.xKey ?? ''] ?? index + 1), text: Object.entries(row).map(([key, value]) => `${key}: ${value}`).join('；').slice(0, 2000) })) : validateObjects(input.objects)
  const sourceMessageId = optionalText(input.sourceMessageId, 'sourceMessageId', 256)
  const sourceText = optionalText(input.sourceText, 'sourceText', MAX_SOURCE_TEXT_CHARS)
  boundedText(toolCallId, 'toolCallId', 256)
  const { visualizationId, baseRevision } = input
  if ((visualizationId === undefined) !== (baseRevision === undefined)) throw new Error('更新可视化必须同时提供 visualizationId 和 baseRevision')
  if (visualizationId !== undefined) { checkId(visualizationId); checkRevision(baseRevision) }
  let html = chart ? '' : await readSource(input.filePath!, context, await sourceRoot(context))
  if (format === 'fragment') validateFragment(html)
  // 确保 HTML 内容包含字符编码声明，避免直接访问文件时出现乱码
  if (html && !html.toLowerCase().includes('charset')) {
    html = `<meta charset="UTF-8">\n${html}`
  }
  const id = visualizationId ?? randomUUID()
  // 输入全部校验通过后才创建存储目录，失败的调用不留下空目录。
  const root = await storageRoot(context, true)
  return withLock(root, async () => {
    if (visualizationId === undefined) {
      const existing = (await listVisualizations(context)).find((record) => record.toolCallId === toolCallId)
      if (existing) { assertCanCommit?.(); return existing }
    }
    let previous: VisualizationRecord | undefined
    if (visualizationId !== undefined) {
      previous = (await locate(context, id)).record
      if (baseRevision !== previous.revision) throw new Error('可视化基础 revision 已过期，更新被拒绝')
      if (previous.recordVersion === Number.MAX_SAFE_INTEGER) throw new Error('可视化 recordVersion 已达上限')
    }
    const now = Math.max(Date.now(), previous?.updatedAt ?? 0)
    const record: VisualizationRecord = {
      schemaVersion: 1, id, sessionId: context.sessionId, toolCallId: previous?.toolCallId ?? toolCallId,
      ...((previous ? previous.sourceMessageId : sourceMessageId) === undefined ? {} : { sourceMessageId: previous ? previous.sourceMessageId : sourceMessageId }),
      ...((sourceText ?? previous?.sourceText) === undefined ? {} : { sourceText: sourceText ?? previous?.sourceText }),
      title, kind: visualizationKind, format, ...(chart ? { chart } : {}), revision: '', recordVersion: (previous?.recordVersion ?? 0) + 1,
      summary, objects, createdAt: previous?.createdAt ?? now, updatedAt: now,
    }
    record.revision = revisionHash(html, record)
    await assertStorageBudget(root, Buffer.byteLength(html, 'utf8') + Buffer.byteLength(JSON.stringify(record), 'utf8') * 2 + VISUALIZATION_LIMITS.maxStateBytes, previous === undefined)
    const directory = await storageDirectory(root, [id], true)
    const revisions = await storageDirectory(root, [id, 'revisions'], true)
    await atomicWrite(join(revisions, `${record.revision}.html`), html, true)
    await atomicWrite(join(revisions, `${record.revision}.json`), JSON.stringify(record), true)
    // 完整 revision 先落盘，最后切换当前记录；取消/失去权限时只留下未公布 staging。
    assertCanCommit?.()
    await atomicWrite(join(directory, 'record.json'), JSON.stringify(record), false, assertCanCommit)
    return record
  })
}

export async function listVisualizations(context: VisualizationContext): Promise<VisualizationRecord[]> {
  let root: string
  try {
    root = await storageRoot(context)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let directory: string
  try { directory = await storageDirectory(root, []) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: VisualizationRecord[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue
    try {
      const { record, directory: result } = await locate(context, entry.name)
      const details = await lstat(join(result, 'revisions', `${record.revision}.html`))
      if (details.isFile() && !details.isSymbolicLink() && details.size <= VISUALIZATION_LIMITS.maxHtmlBytes) records.push(record)
    } catch (error) {
      // 列表依旧只返回可用的记录，但不静默：否则记录被删掉/坏掉时用户只会看到卡片无解释地消失。
      console.warn(`[可视化] 跳过不可读的记录 ${entry.name}：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  return records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export async function readVisualization(context: VisualizationContext, id: string, revision?: string): Promise<VisualizationContent> {
  const { directory, record } = await locate(context, id, revision)
  let html: string
  try {
    html = await readBoundedFile(join(directory, 'revisions', `${record.revision}.html`), VISUALIZATION_LIMITS.maxHtmlBytes)
    if (record.format === 'chart') {
      if (html !== '' || !record.chart) throw new Error('原生图表记录损坏')
    } else {
      if (html === '') throw new Error('可视化 HTML 内容为空')
      validateHtml(html)
      if (record.format === 'fragment') validateFragment(html)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('可视化记录不存在：存储中找不到该修订内容')
    throw new Error(`可视化记录损坏：${error instanceof Error ? error.message : 'HTML 无效'}`)
  }
  if (revisionHash(html, record) !== record.revision) throw new Error('可视化记录损坏：revision hash 不匹配')
  return { record, html }
}

export async function readVisualizationViewState(context: VisualizationContext, id: string, revision: string): Promise<VisualizationViewState> {
  checkRevision(revision)
  const { root, record } = await locate(context, id, revision)
  try {
    const directory = await storageDirectory(root, [id, 'state'])
    return validateViewState(JSON.parse(await readBoundedFile(join(directory, `${record.revision}.json`), VISUALIZATION_LIMITS.maxStateBytes)) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`可视化视图状态损坏：${error instanceof Error ? error.message : '状态无效'}`)
  }
}

export async function saveVisualizationViewState(context: VisualizationContext, id: string, revision: string, state: VisualizationViewState): Promise<void> {
  checkRevision(revision)
  const snapshot = validateViewState(state)
  const { root, record } = await locate(context, id, revision)
  await withLock(`${root}\0${id}`, async () => {
    const directory = await storageDirectory(root, [id, 'state'], true)
    await atomicWrite(join(directory, `${record.revision}.json`), JSON.stringify(snapshot))
  })
}
