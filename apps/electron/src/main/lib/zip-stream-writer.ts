/**
 * 流式 ZIP 写入器（无第三方依赖）。
 *
 * 为什么不用 adm-zip：它把每个条目读进内存后才写盘，备份体量到了 GB 级
 * （会话原文 + blob + 工作区文件）主进程会直接顶到内存上限，且整个压缩过程
 * 同步占住事件循环。备份是「宁慢勿丢」的场景，必须边读边写。
 *
 * 实现要点：
 * - 文件条目一律 deflate + data descriptor（流式压缩时压缩后长度未知）
 * - 条目名统一 UTF-8（通用标志位 bit 11），中文文件名不依赖平台编码
 * - 单文件 ≥4GB 或条目数 >65535 时自动写 zip64 结构
 * - 先写 `<目标>.tmp-*`，finalize 后原子 rename，避免中断留下半个备份
 */

import { createReadStream, createWriteStream, mkdirSync, promises as fsp, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw, deflateRawSync } from 'node:zlib'

const LOCAL_FILE_HEADER_SIG = 0x04034b50
const CENTRAL_DIR_HEADER_SIG = 0x02014b50
const DATA_DESCRIPTOR_SIG = 0x08074b50
const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50
const ZIP64_EXTRA_FIELD_ID = 0x0001

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const VERSION_DEFAULT = 20
const VERSION_ZIP64 = 45

/** 已经压缩过的格式再 deflate 只会白烧 CPU */
const STORE_ONLY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic',
  '.mp3', '.mp4', '.m4a', '.mov', '.mkv', '.webm', '.ogg', '.opus',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pptx', '.docx', '.xlsx', '.sqlite', '.db',
])

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  crcTable = table
  return table
}

function crc32Update(crc: number, chunk: Buffer): number {
  const table = getCrcTable()
  let value = crc ^ -1
  for (let i = 0; i < chunk.length; i++) {
    value = table[(value ^ chunk[i]!) & 0xff]! ^ (value >>> 8)
  }
  return (value ^ -1) >>> 0
}

function crc32(buffer: Buffer): number {
  return crc32Update(0, buffer)
}

/** DOS 时间戳精度只有 2 秒，且不能早于 1980-01-01。 */
function toDosDateTime(input: Date): { time: number; date: number } {
  const year = Math.max(input.getFullYear(), 1980)
  const date = ((year - 1980) << 9) | ((input.getMonth() + 1) << 5) | input.getDate()
  const time = (input.getHours() << 11) | (input.getMinutes() << 5) | Math.floor(input.getSeconds() / 2)
  return { time, date }
}

function shouldStore(entryName: string): boolean {
  const lower = entryName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 && STORE_ONLY_EXTENSIONS.has(lower.slice(dot))
}

interface CentralEntry {
  name: Buffer
  versionNeeded: number
  flags: number
  method: number
  time: number
  date: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  offset: number
}

export interface ZipFinalizeResult {
  bytes: number
  entries: number
}

export interface ZipStreamWriterOptions {
  /**
   * 进度回调：archiveBytes = 已写出的归档字节（压缩后），
   * consumedBytes = 已读入的源字节（压缩前，用于对上「预估总量」）。
   * 调用方自行节流。
   */
  onBytesWritten?: (archiveBytes: number, consumedBytes: number) => void
  /** 用户取消导出：中止后所有写入调用立即抛 AbortError。 */
  signal?: AbortSignal
}

/**
 * 顺序写入 ZIP 的写入器。
 *
 * 用法：构造 → 逐个 addFile/addBuffer → finalize。任一环节抛错后必须 abort()，
 * 否则临时文件会留在目标目录旁边。
 */
export class ZipStreamWriter {
  private readonly tmpPath: string
  private readonly out: WriteStream
  private offset = 0
  /** 已读入的源字节（压缩前），进度百分比用它而不是压缩后体积。 */
  private consumed = 0
  private readonly entries: CentralEntry[] = []
  private finished = false
  private streamError: Error | null = null

  constructor(
    private readonly targetPath: string,
    private readonly options: ZipStreamWriterOptions = {},
  ) {
    this.tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
    // 先建目录：否则 createWriteStream 的失败会变成异步 error，to 到第一次写入才暴露。
    mkdirSync(dirname(targetPath), { recursive: true })
    // 备份内容含凭据，临时文件只给当前用户读写
    this.out = createWriteStream(this.tmpPath, { mode: 0o600 })
    this.out.on('error', (error) => {
      this.streamError = error instanceof Error ? error : new Error(String(error))
    })
  }

  /** 已写入的条目数（调用方用于判断某个目录是否真的产出了内容）。 */
  get entryCount(): number {
    return this.entries.length
  }

  private throwIfAborted(): void {
    if (!this.options.signal?.aborted) return
    const error = new Error('导出已取消')
    error.name = 'AbortError'
    throw error
  }

  private async write(chunk: Buffer): Promise<void> {
    this.throwIfAborted()
    if (this.streamError) throw this.streamError
    this.offset += chunk.length
    this.options.onBytesWritten?.(this.offset, this.consumed)
    if (!this.out.write(chunk)) {
      await once(this.out, 'drain')
      if (this.streamError) throw this.streamError
    }
  }

  /** 把一个本地文件写进归档。文件不存在时抛错，由调用方决定是否降级为警告。 */
  async addFile(absolutePath: string, entryName: string): Promise<void> {
    this.throwIfAborted()
    const stat = await fsp.stat(absolutePath)
    if (!stat.isFile()) throw new Error(`不是普通文件: ${absolutePath}`)

    const store = shouldStore(entryName)
    const method = store ? METHOD_STORE : METHOD_DEFLATE
    const needsZip64Size = stat.size >= U32_MAX
    const name = Buffer.from(entryName, 'utf8')
    const { time, date } = toDosDateTime(stat.mtime)

    const entryOffset = this.offset
    // 流式条目的长度要等压缩完才知道，故头部尺寸留 0 并把真实值放进 data descriptor；
    // 这种情况下局部头不需要 zip64 extra（规范 4.3.9.2）。
    await this.write(buildLocalHeader({
      versionNeeded: needsZip64Size ? VERSION_ZIP64 : VERSION_DEFAULT,
      flags: FLAG_UTF8 | FLAG_DATA_DESCRIPTOR,
      method,
      time,
      date,
      name,
      streamed: true,
    }))

    let crc = 0
    let uncompressedSize = 0
    let compressedSize = 0

    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        crc = crc32Update(crc, chunk)
        uncompressedSize += chunk.length
        this.consumed += chunk.length
        this.options.onBytesWritten?.(this.offset, this.consumed)
        callback(null, chunk)
      },
    })
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        compressedSize += chunk.length
        this.offset += chunk.length
        if (this.streamError) {
          callback(this.streamError)
          return
        }
        if (this.out.write(chunk)) callback()
        else this.out.once('drain', callback)
      },
    })

    if (store) {
      await pipeline(createReadStream(absolutePath), counter, sink, { signal: this.options.signal })
    } else {
      await pipeline(createReadStream(absolutePath), counter, createDeflateRaw({ level: 6 }), sink, { signal: this.options.signal })
    }
    if (this.streamError) throw this.streamError

    await this.write(buildDataDescriptor({
      crc,
      compressedSize,
      uncompressedSize,
      zip64: needsZip64Size || compressedSize >= U32_MAX,
    }))

    this.entries.push({
      name,
      versionNeeded: needsZip64Size ? VERSION_ZIP64 : VERSION_DEFAULT,
      flags: FLAG_UTF8 | FLAG_DATA_DESCRIPTOR,
      method,
      time,
      date,
      crc,
      compressedSize,
      uncompressedSize,
      offset: entryOffset,
    })
  }

  /** 写入内存内容（manifest、索引、小配置文件）。大小已知，不需要 data descriptor。 */
  async addBuffer(content: Buffer | string, entryName: string): Promise<void> {
    this.throwIfAborted()
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const store = shouldStore(entryName)
    const method = store ? METHOD_STORE : METHOD_DEFLATE
    const compressed = store ? raw : deflateRawSync(raw, { level: 6 })
    const crc = crc32(raw)
    const name = Buffer.from(entryName, 'utf8')
    const { time, date } = toDosDateTime(new Date())
    const needsZip64 = raw.length >= U32_MAX || compressed.length >= U32_MAX

    const entryOffset = this.offset
    await this.write(buildLocalHeader({
      versionNeeded: needsZip64 ? VERSION_ZIP64 : VERSION_DEFAULT,
      flags: FLAG_UTF8,
      method,
      time,
      date,
      name,
      crc,
      compressedSize: compressed.length,
      uncompressedSize: raw.length,
      zip64: needsZip64,
    }))
    this.consumed += raw.length
    await this.write(compressed)

    this.entries.push({
      name,
      versionNeeded: needsZip64 ? VERSION_ZIP64 : VERSION_DEFAULT,
      flags: FLAG_UTF8,
      method,
      time,
      date,
      crc,
      compressedSize: compressed.length,
      uncompressedSize: raw.length,
      offset: entryOffset,
    })
  }

  /** 收尾：中心目录 + EOCD，并原子替换目标文件。返回最终体积与条目数。 */
  async finalize(): Promise<ZipFinalizeResult> {
    this.throwIfAborted()
    if (this.finished) throw new Error('归档已经收尾，不能重复 finalize')
    this.finished = true

    const centralDirOffset = this.offset
    for (const entry of this.entries) {
      await this.write(buildCentralDirectoryEntry(entry))
    }
    const centralDirSize = this.offset - centralDirOffset

    const needsZip64 = this.entries.length > U16_MAX
      || centralDirSize >= U32_MAX
      || centralDirOffset >= U32_MAX

    if (needsZip64) {
      const zip64EocdOffset = this.offset
      await this.write(buildZip64Eocd({
        entries: this.entries.length,
        centralDirSize,
        centralDirOffset,
      }))
      await this.write(buildZip64EocdLocator(zip64EocdOffset))
    }

    await this.write(buildEocd({
      entries: this.entries.length,
      centralDirSize,
      centralDirOffset,
      zip64: needsZip64,
    }))

    const bytes = this.offset
    await new Promise<void>((resolve, reject) => {
      this.out.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })
    if (this.streamError) throw this.streamError

    await fsp.mkdir(dirname(this.targetPath), { recursive: true })
    await fsp.rename(this.tmpPath, this.targetPath)
    return { bytes, entries: this.entries.length }
  }

  /** 失败路径：关掉流并删除临时文件，避免留下半成品。 */
  async abort(): Promise<void> {
    try {
      this.out.destroy()
    } catch {
      // 忽略关闭失败
    }
    try {
      await fsp.rm(this.tmpPath, { force: true })
    } catch {
      // 忽略清理失败
    }
  }
}

interface LocalHeaderOptions {
  versionNeeded: number
  flags: number
  method: number
  time: number
  date: number
  name: Buffer
  crc?: number
  compressedSize?: number
  uncompressedSize?: number
  zip64?: boolean
  /** 流式条目：头部尺寸写 0，真实值随后由 data descriptor 补齐 */
  streamed?: boolean
}

function buildLocalHeader(options: LocalHeaderOptions): Buffer {
  const zip64 = options.zip64 === true
  const extra = zip64 ? buildZip64Extra({
    uncompressedSize: options.uncompressedSize ?? 0,
    compressedSize: options.compressedSize ?? 0,
  }) : Buffer.alloc(0)

  const header = Buffer.alloc(30)
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0)
  header.writeUInt16LE(options.versionNeeded, 4)
  header.writeUInt16LE(options.flags, 6)
  header.writeUInt16LE(options.method, 8)
  header.writeUInt16LE(options.time, 10)
  header.writeUInt16LE(options.date, 12)
  header.writeUInt32LE(options.streamed ? 0 : options.crc ?? 0, 14)
  header.writeUInt32LE(options.streamed ? 0 : zip64 ? U32_MAX : Math.min(options.compressedSize ?? 0, U32_MAX), 18)
  header.writeUInt32LE(options.streamed ? 0 : zip64 ? U32_MAX : Math.min(options.uncompressedSize ?? 0, U32_MAX), 22)
  header.writeUInt16LE(options.name.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, options.name, extra])
}

function buildDataDescriptor(options: {
  crc: number
  compressedSize: number
  uncompressedSize: number
  zip64: boolean
}): Buffer {
  if (!options.zip64) {
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0)
    descriptor.writeUInt32LE(options.crc, 4)
    descriptor.writeUInt32LE(options.compressedSize, 8)
    descriptor.writeUInt32LE(options.uncompressedSize, 12)
    return descriptor
  }
  const descriptor = Buffer.alloc(24)
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0)
  descriptor.writeUInt32LE(options.crc, 4)
  descriptor.writeBigUInt64LE(BigInt(options.compressedSize), 8)
  descriptor.writeBigUInt64LE(BigInt(options.uncompressedSize), 16)
  return descriptor
}

function buildZip64Extra(sizes: { uncompressedSize: number; compressedSize: number }): Buffer {
  const body = Buffer.alloc(16)
  body.writeBigUInt64LE(BigInt(sizes.uncompressedSize), 0)
  body.writeBigUInt64LE(BigInt(sizes.compressedSize), 8)
  const head = Buffer.alloc(4)
  head.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0)
  head.writeUInt16LE(body.length, 2)
  return Buffer.concat([head, body])
}

function buildCentralDirectoryEntry(entry: CentralEntry): Buffer {
  const zip64Values: number[] = []
  const sizeOverflow = entry.uncompressedSize >= U32_MAX || entry.compressedSize >= U32_MAX
  const offsetOverflow = entry.offset >= U32_MAX

  if (sizeOverflow) zip64Values.push(entry.uncompressedSize, entry.compressedSize)
  if (offsetOverflow) zip64Values.push(entry.offset)

  let extra = Buffer.alloc(0)
  if (zip64Values.length > 0) {
    const body = Buffer.alloc(zip64Values.length * 8)
    zip64Values.forEach((value, index) => body.writeBigUInt64LE(BigInt(value), index * 8))
    const head = Buffer.alloc(4)
    head.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0)
    head.writeUInt16LE(body.length, 2)
    extra = Buffer.concat([head, body])
  }

  const versionNeeded = zip64Values.length > 0
    ? VERSION_ZIP64
    : entry.versionNeeded

  const header = Buffer.alloc(46)
  header.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0)
  // 高字节 3 = Unix，低字节为规范版本；外部属性据此保留 0644 权限。
  header.writeUInt16LE((3 << 8) | VERSION_ZIP64, 4)
  header.writeUInt16LE(versionNeeded, 6)
  header.writeUInt16LE(entry.flags, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.time, 12)
  header.writeUInt16LE(entry.date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(sizeOverflow ? U32_MAX : entry.compressedSize, 20)
  header.writeUInt32LE(sizeOverflow ? U32_MAX : entry.uncompressedSize, 24)
  header.writeUInt16LE(entry.name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  header.writeUInt32LE(offsetOverflow ? U32_MAX : entry.offset, 42)
  return Buffer.concat([header, entry.name, extra])
}

function buildZip64Eocd(options: {
  entries: number
  centralDirSize: number
  centralDirOffset: number
}): Buffer {
  const record = Buffer.alloc(56)
  record.writeUInt32LE(ZIP64_EOCD_SIG, 0)
  record.writeBigUInt64LE(44n, 4)
  record.writeUInt16LE((3 << 8) | VERSION_ZIP64, 12)
  record.writeUInt16LE(VERSION_ZIP64, 14)
  record.writeUInt32LE(0, 16)
  record.writeUInt32LE(0, 20)
  record.writeBigUInt64LE(BigInt(options.entries), 24)
  record.writeBigUInt64LE(BigInt(options.entries), 32)
  record.writeBigUInt64LE(BigInt(options.centralDirSize), 40)
  record.writeBigUInt64LE(BigInt(options.centralDirOffset), 48)
  return record
}

function buildZip64EocdLocator(zip64EocdOffset: number): Buffer {
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIG, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8)
  locator.writeUInt32LE(1, 16)
  return locator
}

function buildEocd(options: {
  entries: number
  centralDirSize: number
  centralDirOffset: number
  zip64: boolean
}): Buffer {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(options.zip64 ? U16_MAX : options.entries, 8)
  eocd.writeUInt16LE(options.zip64 ? U16_MAX : options.entries, 10)
  eocd.writeUInt32LE(options.zip64 ? U32_MAX : options.centralDirSize, 12)
  eocd.writeUInt32LE(options.zip64 ? U32_MAX : options.centralDirOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return eocd
}
