import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import AdmZip from 'adm-zip'
import { ZipStreamWriter } from './zip-stream-writer'
import { extractZipEntries, readZipEntries } from './zip-stream-reader'

const root = join(tmpdir(), `profer-zip-stream-${Date.now()}`)

beforeAll(() => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', '中文 文件.txt'), '你好，世界\n'.repeat(500))
  writeFileSync(join(root, 'src', 'empty.txt'), '')
  writeFileSync(join(root, 'src', 'big.bin'), randomBytes(3 * 1024 * 1024))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('流式 ZIP 读写', () => {
  test('Given 中文名/空文件/二进制 When 往返 Then 内容逐字节一致', async () => {
    const zipPath = join(root, 'roundtrip.zip')
    const writer = new ZipStreamWriter(zipPath)
    await writer.addBuffer(JSON.stringify({ hello: '世界' }), 'manifest.json')
    await writer.addFile(join(root, 'src', '中文 文件.txt'), 'dir/中文 文件.txt')
    await writer.addFile(join(root, 'src', 'empty.txt'), 'dir/empty.txt')
    await writer.addFile(join(root, 'src', 'big.bin'), 'dir/big.bin')
    const result = await writer.finalize()
    expect(result.entries).toBe(4)
    expect(existsSync(zipPath)).toBe(true)

    const entries = await readZipEntries(zipPath)
    expect(entries.map((entry) => entry.name)).toEqual([
      'manifest.json',
      'dir/中文 文件.txt',
      'dir/empty.txt',
      'dir/big.bin',
    ])

    const outDir = join(root, 'roundtrip-out')
    const extract = await extractZipEntries(zipPath, entries, outDir)
    expect(extract.warnings).toEqual([])
    expect(extract.files).toBe(4)
    expect(readFileSync(join(outDir, 'dir', '中文 文件.txt'), 'utf8')).toBe('你好，世界\n'.repeat(500))
    expect(readFileSync(join(outDir, 'dir', 'empty.txt')).length).toBe(0)
    expect(readFileSync(join(outDir, 'dir', 'big.bin')).equals(readFileSync(join(root, 'src', 'big.bin')))).toBe(true)
  })

  test('Given 条目数超过 65535 When 读取 Then 走 zip64 目录结尾且条目完整', async () => {
    const zipPath = join(root, 'many.zip')
    const writer = new ZipStreamWriter(zipPath)
    const total = 65546
    for (let index = 0; index < total; index++) {
      await writer.addBuffer(`file-${index}`, `many/${index}.txt`)
    }
    await writer.finalize()

    const entries = await readZipEntries(zipPath)
    expect(entries.length).toBe(total)
    expect(entries[total - 1]!.name).toBe(`many/${total - 1}.txt`)
  }, 120_000)

  test('Given adm-zip 写出的旧备份 When 读取 Then 兼容', async () => {
    const zipPath = join(root, 'legacy.zip')
    const legacy = new AdmZip()
    legacy.addFile('sessions/agent/a.jsonl', Buffer.from('{"type":"user"}\n'))
    legacy.addFile('manifest.json', Buffer.from('{"version":"3.0"}'))
    legacy.writeZip(zipPath)

    const entries = await readZipEntries(zipPath)
    expect(entries.map((entry) => entry.name).sort()).toEqual(['manifest.json', 'sessions/agent/a.jsonl'])

    const outDir = join(root, 'legacy-out')
    const extract = await extractZipEntries(zipPath, entries, outDir)
    expect(extract.warnings).toEqual([])
    expect(readFileSync(join(outDir, 'sessions/agent/a.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
  })

  test('Given 条目名试图逃逸目标目录 When 解包 Then 拒绝', async () => {
    const zipPath = join(root, 'slip.zip')
    const writer = new ZipStreamWriter(zipPath)
    await writer.addBuffer('evil', '../escape.txt')
    await writer.finalize()

    const entries = await readZipEntries(zipPath)
    await expect(extractZipEntries(zipPath, entries, join(root, 'slip-out'))).rejects.toThrow('非法路径')
  })

  test('Given 归档内容被篡改 When 解包 Then 报告校验和不匹配但不中断', async () => {
    const zipPath = join(root, 'corrupt.zip')
    const writer = new ZipStreamWriter(zipPath)
    await writer.addBuffer('0123456789'.repeat(100), 'a.png')
    await writer.addBuffer('second', 'b.txt')
    await writer.finalize()

    const entries = await readZipEntries(zipPath)
    const target = entries[0]!
    expect(target.method).toBe(0) // .png 走存储模式，篡改后仍能解出内容
    const dataOffset = target.localHeaderOffset + 30 + Buffer.byteLength(target.name, 'utf8')
    const file = readFileSync(zipPath)
    file[dataOffset + 10] = file[dataOffset + 10]! ^ 0xff
    writeFileSync(zipPath, file)

    const warnings: string[] = []
    const freshEntries = await readZipEntries(zipPath)
    const extract = await extractZipEntries(zipPath, freshEntries, join(root, 'corrupt-out'), {
      onWarning: (message) => warnings.push(message),
    })
    expect(warnings.some((message) => message.includes('校验和不匹配'))).toBe(true)
    // 其余条目照常恢复
    expect(extract.files).toBe(2)
  })

  test('Given 导出被取消 When 继续写入 Then 立即抛 AbortError 且不生成目标文件', async () => {
    const zipPath = join(root, 'cancelled.zip')
    const controller = new AbortController()
    const writer = new ZipStreamWriter(zipPath, { signal: controller.signal })
    await writer.addBuffer('before-cancel', 'before.txt')
    controller.abort()

    await expect(writer.addFile(join(root, 'src', 'big.bin'), 'big.bin')).rejects.toThrow('导出已取消')
    await writer.abort()
    expect(existsSync(zipPath)).toBe(false)
  })
})
