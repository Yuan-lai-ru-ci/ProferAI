import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@profer/shared'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

const MAX = 256 * 1024
/** 与源码一致：片段长度即可抽取下限 */
const PREVIEW = 2000
const REFS_FIELD = '_proferBlobs'
const MISSING_FIELD = '_proferBlobsMissing'

let root = ''
let sessions: typeof import('./agent-session-manager')
let blobStore: typeof import('./blob-store')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-externalize-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const key = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?ext=${key}`)
  blobStore = await import(`./blob-store?ext=${key}`)
  configPaths = await import(`./config-paths?ext=${key}`)
  mkdirSync(configPaths.getAgentSessionsDir(), { recursive: true })
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

const bigText = (marker: string, n = 400_000): string => `${marker}${'X'.repeat(n)}`

/** 真实形态：顶层 tool_use_result 携带整页 HTML */
function oversizedMessage(text: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }] },
    tool_use_result: { content: [{ type: 'text', text }], isError: false },
  } as unknown as SDKMessage
}

function writeAndRead(message: SDKMessage): Record<string, unknown> {
  const meta = sessions.createAgentSession('externalize')
  sessions.appendSDKMessages(meta.id, [message])
  const file = join(configPaths.getAgentSessionsDir(), `${meta.id}.jsonl`)
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const last = lines[lines.length - 1]!
  expect(last.length).toBeLessThanOrEqual(MAX)
  return JSON.parse(last!) as Record<string, unknown>
}

/** 统计 blob 目录下的实际文件数 */
function countBlobs(): number {
  let count = 0
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (!entry.endsWith('.tmp')) count++
    }
  }
  walk(blobStore.blobRootDir())
  return count
}

describe('外部化 · 未超限的行一个字节都不动', () => {
  test('Given 普通消息 When 落盘 Then 无引用表且不产生任何 blob', () => {
    const message = { type: 'assistant', message: { content: [{ type: 'text', text: '普通回复' }] } } as unknown as SDKMessage
    const line = writeAndRead(message)

    expect(line[REFS_FIELD]).toBeUndefined()
    expect(countBlobs()).toBe(0)
    expect((line as { message: { content: { text: string }[] } }).message.content[0]!.text).toBe('普通回复')
  })

  test('Given 刚好不超限的长文本 When 落盘 Then 内容完整保留为原字符串', () => {
    // 200K 字符 < 256K，必须原样
    const text = 'Y'.repeat(200_000)
    const line = writeAndRead({ type: 'assistant', message: { content: [{ type: 'text', text }] } } as unknown as SDKMessage)

    expect(line[REFS_FIELD]).toBeUndefined()
    expect((line as { message: { content: { text: string }[] } }).message.content[0]!.text).toBe(text)
    expect(countBlobs()).toBe(0)
  })
})

describe('外部化 · 超限行搬到 blob', () => {
  test('Given 超限行 When 落盘 Then 行落回上限内且行内留片段 + 引用表', () => {
    const text = bigText('HTML-')
    const line = writeAndRead(oversizedMessage(text))

    const refs = line[REFS_FIELD] as { path: string; hash: string; chars: number }[]
    expect(Array.isArray(refs)).toBe(true)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.path).toBe('tool_use_result.content[0].text')
    expect(refs[0]!.chars).toBe(text.length)

    // 行内留下片段，不是空白
    const inline = (line as { tool_use_result: { content: { text: string }[] } }).tool_use_result.content[0]!.text
    expect(inline.length).toBe(PREVIEW)
    expect(text.startsWith(inline)).toBe(true)
  })

  test('Given 超限行 When 还原 Then 与原文逐字节一致', async () => {
    const text = bigText('HTML-')
    const line = writeAndRead(oversizedMessage(text))

    const resolved = await sessions.resolveMessageBlobs(line as unknown as SDKMessage)

    expect((resolved as unknown as { tool_use_result: { content: { text: string }[] } }).tool_use_result.content[0]!.text).toBe(text)
    // 还原后回到原始形状：不再有引用表
    expect((resolved as unknown as Record<string, unknown>)[REFS_FIELD]).toBeUndefined()
    expect((resolved as unknown as Record<string, unknown>)[MISSING_FIELD]).toBeUndefined()
  })

  test('Given 140 条中等长度图片字段 When 落盘 Then 引用表参与第二级收敛且每张图片可还原', async () => {
    const images = Array.from({ length: 140 }, (_, index) => `${String(index).padStart(3, '0')}-${'I'.repeat(2_500)}`)
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'images', content: images.map(text => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: text } })) }] },
    } as unknown as SDKMessage
    const line = writeAndRead(message)
    const refs = line[REFS_FIELD] as { path: string; hash: string; chars: number }[]
    expect(refs).toHaveLength(140)
    const resolved = await sessions.resolveMessageBlobs(line as unknown as SDKMessage) as unknown as { message: { content: { content: { source: { data: string } }[] }[] } }
    expect(resolved.message.content[0]!.content.map(image => image.source.data)).toEqual(images)
  })

  test('Given 200 个中等长度字段 When 落盘 Then 引用表预算仍允许完整还原', async () => {
    const values = Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, '0')}-${'J'.repeat(2_500)}`)
    const message = { type: 'user', payload: values } as unknown as SDKMessage
    const line = writeAndRead(message)
    expect((line[REFS_FIELD] as unknown[]).length).toBe(200)
    const resolved = await sessions.resolveMessageBlobs(line as unknown as SDKMessage) as unknown as { payload: string[] }
    expect(resolved.payload).toEqual(values)
  })

  test('Given 同一段内容出现两次 When 落盘 Then 两个引用指向同一个 blob（去重）', () => {
    const shared = bigText('SAME-')
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: shared }] }] },
      // 顶层副本与正文完全同源 —— 实测这是巨型行的主因
      tool_use_result: { content: [{ type: 'text', text: shared }] },
    } as unknown as SDKMessage

    const line = writeAndRead(message)
    const refs = line[REFS_FIELD] as { path: string; hash: string; chars: number }[]

    expect(refs.length).toBeGreaterThanOrEqual(2)
    const hashes = new Set(refs.map((r) => r.hash))
    expect(hashes.size).toBe(1)          // 同一个哈希
    expect(countBlobs()).toBe(1)         // 磁盘上只有一份
  })

  test('Given 多个超长字段 When 落盘 Then 全部落回上限且都被引用', async () => {
    const a = bigText('A-', 300_000)
    const b = bigText('B-', 300_000)
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: a }] }] },
      tool_use_result: { content: [{ type: 'text', text: b }] },
    } as unknown as SDKMessage

    const line = writeAndRead(message)
    const refs = line[REFS_FIELD] as { path: string }[]
    expect(refs).toHaveLength(2)

    const resolved = await sessions.resolveMessageBlobs(line as unknown as SDKMessage) as unknown as {
      message: { content: { content: { text: string }[] }[] }
      tool_use_result: { content: { text: string }[] }
    }
    expect(resolved.message.content[0]!.content[0]!.text).toBe(a)
    expect(resolved.tool_use_result.content[0]!.text).toBe(b)
  })
})

describe('外部化 · 幂等与降级', () => {
  test('Given 已外部化的行 When 再走一次 When Then 零改动', () => {
    const text = bigText('IDEM-')
    const line = writeAndRead(oversizedMessage(text))
    const serialized = JSON.stringify(line)

    const again = sessions.externalizeSerializedSessionLine(serialized)

    expect(again).toBe(serialized)
  })

  test('Given blob 被删掉 When 还原 Then 保留片段并标记缺失，不抛异常', async () => {
    const text = bigText('GONE-')
    const line = writeAndRead(oversizedMessage(text))
    const refs = line[REFS_FIELD] as { hash: string }[]

    // 模拟 blob 被孤儿清理误删
    rmSync(blobStore.blobPathFor(refs[0]!.hash), { force: true })

    const resolved = await sessions.resolveMessageBlobs(line as unknown as SDKMessage) as unknown as Record<string, unknown>

    const missing = resolved[MISSING_FIELD] as string[]
    expect(missing).toEqual(['tool_use_result.content[0].text'])
    const inline = (resolved as { tool_use_result: { content: { text: string }[] } }).tool_use_result.content[0]!.text
    expect(inline.length).toBe(PREVIEW)   // 降级为片段，不崩
  })

  test('Given 引用表指向不存在的路径 When 还原 Then 记为缺失而非抛异常', async () => {
    const line = {
      type: 'user',
      message: { content: [{ type: 'text', text: 'ok' }] },
      [REFS_FIELD]: [{ path: 'not.here.at.all', hash: 'sha256:deadbeef', chars: 9999, bytes: 9999 }],
    } as unknown as SDKMessage

    const resolved = await sessions.resolveMessageBlobs(line) as unknown as Record<string, unknown>
    expect(resolved[MISSING_FIELD]).toEqual(['not.here.at.all'])
  })

  test('Given 没有引用表 When 还原 Then 原样返回同一个对象（零开销）', async () => {
    const message = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as unknown as SDKMessage
    const resolved = await sessions.resolveMessageBlobs(message)
    expect(resolved).toBe(message)
  })
})
