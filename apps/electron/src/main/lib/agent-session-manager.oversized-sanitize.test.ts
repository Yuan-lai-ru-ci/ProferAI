// 本文件验收旧桌面 writer；新核默认与归属保护由 Core 专项测试覆盖。
process.env.PROFER_LOCAL_CORE_MODE = 'legacy'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@profer/shared'

// 会话管理器经 workspace 服务间接导入 Electron；Bun 单测需提供最小主进程 mock。
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

/** 与源码保持一致：单行序列化上限 256K chars */
const MAX_SDK_MESSAGE_LENGTH = 256 * 1024
const TRUNCATION_MARK = '内容已截断'
/** 行内片段长度 = 可抽取下限 */
const PREVIEW = 2000
const REFS_FIELD = '_proferBlobs'

let root = ''
let sessions: typeof import('./agent-session-manager')
let blobStore: typeof import('./blob-store')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-oversized-sanitize-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?oversized-test=${cacheKey}`)
  blobStore = await import(`./blob-store?oversized-test=${cacheKey}`)
  configPaths = await import(`./config-paths?oversized-test=${cacheKey}`)
  mkdirSync(configPaths.getAgentSessionsDir(), { recursive: true })
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 写一条消息并回读它的落盘行，用于断言最终体积与结构 */
function writeAndReadLine(message: SDKMessage): Record<string, unknown> {
  const meta = sessions.createAgentSession('oversized sanitize')
  sessions.appendSDKMessages(meta.id, [message])
  const file = join(configPaths.getAgentSessionsDir(), `${meta.id}.jsonl`)
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const last = lines[lines.length - 1]!
  expect(last.length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
  return JSON.parse(last) as Record<string, unknown>
}

const bigString = (n: number): string => 'A'.repeat(n)

interface StoredRef { path: string; hash: string; chars: number }
const refsOf = (line: Record<string, unknown>): StoredRef[] => (line[REFS_FIELD] ?? []) as StoredRef[]

/** 按 `a.b[0].c` 取值（与源码同一套路径语法） */
function valueAtPath(rootValue: unknown, path: string): unknown {
  const tokens: (string | number)[] = []
  const pattern = /([^.[\]]+)|\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(path)) !== null) {
    tokens.push(match[2] !== undefined ? Number(match[2]) : match[1]!)
  }
  let node: unknown = rootValue
  for (const token of tokens) {
    if (node === null || node === undefined) return undefined
    node = (node as Record<string | number, unknown>)[token]
  }
  return node
}

/**
 * 断言某个路径被**外部化**：行内是片段、引用表里有它、blob 里能逐字节取回原文。
 * 这是写入路径的现在行为——超限载荷搬到 blob，而不是删掉。
 */
function expectExternalized(line: Record<string, unknown>, path: string, original: string): void {
  const ref = refsOf(line).find((item) => item.path === path)
  expect(ref).toBeDefined()
  expect(ref!.chars).toBe(original.length)

  const inline = valueAtPath(line, path)
  expect(typeof inline).toBe('string')
  expect((inline as string).length).toBe(PREVIEW)      // 片段，不是空白
  expect(original.startsWith(inline as string)).toBe(true)

  expect(blobStore.readBlobSync(ref!.hash)).toBe(original)   // 原文可完整还原
}

describe('超限消息落盘：外部化（写入路径现在的行为）', () => {
  test('Given 顶层 tool_use_result 携带整页 HTML When 落盘 Then 搬到 blob 且整行不超限', () => {
    // 真实形态：{content:[{type:'text',text:'<!DOCTYPE html>...'}], isError}
    const html = bigString(400_000)
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      tool_use_result: { content: [{ type: 'text', text: html }], isError: false },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)

    expectExternalized(persisted, 'tool_use_result.content[0].text', html)
    // 非载荷字段原样保留
    expect((persisted.tool_use_result as { isError: boolean }).isError).toBe(false)
    expect((persisted.message as { content: Array<{ content: string }> }).content[0]!.content).toBe('ok')
  })

  test('Given 顶层 tool_use_result 携带 PDF base64 When 落盘 Then 搬到 blob', () => {
    // 真实形态：{type:'pdf', file:{filePath, base64}}（实测单条最大 9.4 MB）
    const base64 = `JVBERi0${bigString(400_000)}`
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'ok' }] },
      tool_use_result: { type: 'pdf', file: { filePath: 'W:\\spec.pdf', base64 } },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)

    expectExternalized(persisted, 'tool_use_result.file.base64', base64)
    // 路径型标记必须留着——渲染侧靠它定位文件
    expect((persisted.tool_use_result as { file: { filePath: string } }).file.filePath).toBe('W:\\spec.pdf')
  })

  test('Given message.content 内嵌扁平 data 图片 When 落盘 Then 搬到 blob（此前约 95 MB 漏处理）', () => {
    // Pi 风格：{type:'image', data, mimeType}；此前代码只认 source.data
    const data = `iVBORw0KGgo${bigString(400_000)}`
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_3',
          content: [
            { type: 'text', text: 'Screenshot rendered (returned inline).' },
            { type: 'image', data, mimeType: 'image/png' },
          ],
        }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)

    expectExternalized(persisted, 'message.content[0].content[1].data', data)
    // 图片块本身仍是图片块，媒体类型保留
    const image = valueAtPath(persisted, 'message.content[0].content[1]') as Record<string, unknown>
    expect(image.type).toBe('image')
    expect(image.mimeType).toBe('image/png')
  })

  test('Given Anthropic 风格 source.data 图片 When 落盘 Then 同样搬到 blob', () => {
    const data = `iVBORw0KGgo${bigString(400_000)}`
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_4',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
        }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)

    expectExternalized(persisted, 'message.content[0].content[0].source.data', data)
  })

  test('Given 嵌套在数组里的超长 text block When 落盘 Then 搬到 blob（此前不受限）', () => {
    const text = bigString(400_000)
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_5',
          content: [{ type: 'text', text }],
        }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)

    expectExternalized(persisted, 'message.content[0].content[0].text', text)
  })

  test('Given 未超限的普通消息 When 落盘 Then 内容与结构完全不被改动', () => {
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_6',
          content: [{ type: 'text', text: '短文本' }, { type: 'image', data: 'short', mimeType: 'image/png' }],
        }],
      },
      tool_use_result: { content: [{ type: 'text', text: '同样很短' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)

    expect(refsOf(persisted)).toHaveLength(0)      // 一个字节都不动，也不建 blob
    expect(valueAtPath(persisted, 'message.content[0].content[0].text')).toBe('短文本')
    expect(valueAtPath(persisted, 'message.content[0].content[1].data')).toBe('short')
    expect(valueAtPath(persisted, 'tool_use_result.content[0].text')).toBe('同样很短')
  })
})

describe('转义膨胀与多字段累加', () => {
  test('Given 原文未超阈值但 JSON 转义后膨胀 When 落盘 Then 按序列化结果判定并搬到 blob', () => {
    // 每个 U+0001 序列化后变成 6 个字符（\u0001），100K 原文 → 约 600K JSON。
    // 只按原文长度判断会漏掉这种情况。
    const controlHeavy = '\u0001'.repeat(100_000)
    expect(controlHeavy.length).toBeLessThan(MAX_SDK_MESSAGE_LENGTH / 2)
    expect(JSON.stringify(controlHeavy).length).toBeGreaterThan(MAX_SDK_MESSAGE_LENGTH)

    const message = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_7', content: [{ type: 'text', text: controlHeavy }] }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    // writeAndReadLine 内部会断言落盘行 ≤ 上限
    const persisted = writeAndReadLine(message)

    expectExternalized(persisted, 'message.content[0].content[0].text', controlHeavy)
  })

  test('Given 多个中等字段累加超限 When 落盘 Then 逐个大字段搬走直到落入限内', () => {
    // 参考真机残留样本：单字段均低于上限，但多字段累加超过上限
    const mid = 'B'.repeat(60_000)
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_8',
          content: [{ type: 'text', text: mid }, { type: 'text', text: mid }, { type: 'text', text: mid }],
        }],
      },
      tool_use_result: { output: mid, truncation: { content: mid } },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    expect(JSON.stringify(message).length).toBeGreaterThan(MAX_SDK_MESSAGE_LENGTH)

    const persisted = writeAndReadLine(message)

    expect(JSON.stringify(persisted).length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
    // 确实动用了外部化（而不是整条丢掉）
    expect(refsOf(persisted).length).toBeGreaterThan(0)
    // 每个被搬走的字段都能完整取回
    for (const ref of refsOf(persisted)) {
      expect(blobStore.readBlobSync(ref.hash)).toHaveLength(ref.chars)
    }
  })
})

describe('截断兜底（不再走主路径，但仍必须可用）', () => {
  // 外部化抽不动时（剩下的字符串都不足片段长度）或 blob 写失败时，退回截断。
  // 这条路径由 sanitizeSerializedSessionLine 直接承载。
  test('Given 大字符串场景 When 调用兜底 Then 仍收敛到限内并留下截断标记', () => {
    // 3 × 100K：均高于截断的阈值下限 4K，逐级收紧后可以截断
    const chunk = 'C'.repeat(100_000)
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_9',
          content: [{ type: 'text', text: chunk }, { type: 'text', text: chunk }, { type: 'text', text: chunk }],
        }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const serialized = JSON.stringify(message)
    expect(serialized.length).toBeGreaterThan(MAX_SDK_MESSAGE_LENGTH)

    const result = sessions.sanitizeSerializedSessionLine(serialized)

    expect(result.length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
    expect(result).toContain(TRUNCATION_MARK)
  })

  test('Given 未超限的行 When 调用兜底 Then 原样返回', () => {
    const serialized = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })
    expect(sessions.sanitizeSerializedSessionLine(serialized)).toBe(serialized)
  })
})

describe('第二级阈值：极多中等字符串的行也能收敛', () => {
  // 形态来源（真机确实存在雏形）：一个工具返回大量结构化记录，每条带一个中等长度字段。
  // 真机的委派列表工具已出现过 25 条记录的实例；规模再大一个数量级即命中。
  // 第一级（下限 2000）对这些字符串无解，因此需要第二级（下限 512、片段 200）。
  test('Given 全是 1500 字符的字符串累加超限 When 落盘 Then 第二级搬走它们且收敛', () => {
    const small = 'D'.repeat(1500)
    const blocks = Array.from({ length: 200 }, () => ({ type: 'text', text: small }))
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_10', content: blocks }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const serialized = JSON.stringify(message)
    expect(serialized.length).toBeGreaterThan(MAX_SDK_MESSAGE_LENGTH)

    const externalized = sessions.externalizeSerializedSessionLine(serialized)
    const parsed = JSON.parse(externalized) as Record<string, unknown>

    // 收敛了——这是第一级做不到的
    expect(externalized.length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
    expect(refsOf(parsed).length).toBeGreaterThan(0)

    // 留的是【短片段】而不是 2000 字片段——第二级的标志
    expect((valueAtPath(parsed, 'message.content[0].content[0].text') as string).length)
      .toBe(200)
  })

  test('Given 第二级抽走的中等字符串 When 还原 Then 每条都能完整取回', async () => {
    const small = 'E'.repeat(1500)
    const blocks = Array.from({ length: 200 }, () => ({ type: 'text', text: small }))
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_11', content: blocks }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const parsed = JSON.parse(sessions.externalizeSerializedSessionLine(JSON.stringify(message))) as Record<string, unknown>
    const refs = refsOf(parsed)

    // 200 条内容完全相同 → 内容寻址让它们共用一个 blob
    expect(new Set(refs.map((r) => r.hash)).size).toBe(1)

    const resolved = await sessions.resolveMessageBlobs(parsed as unknown as SDKMessage) as unknown as {
      message: { content: { content: { text: string }[] }[] }
    }
    for (const ref of refs) {
      const index = Number(ref.path.match(/content\[(\d+)\]\.text$/)![1])
      expect(resolved.message.content[0]!.content[index]!.text).toBe(small)
    }
  })

  test('Given 两级都抽不动 When 落盘 Then 不丢数据（原样保留）', () => {
    // 300 个 400 字符的字符串：低于第二级下限 512 → 两级都动不了
    const tiny = 'F'.repeat(400)
    const blocks = Array.from({ length: 300 }, () => ({ type: 'text', text: tiny }))
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_12', content: blocks }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const serialized = JSON.stringify(message)
    const externalized = sessions.externalizeSerializedSessionLine(serialized)

    // 不抽、不截——原样保留，完整无损
    expect(externalized).toBe(serialized)
  })
})
