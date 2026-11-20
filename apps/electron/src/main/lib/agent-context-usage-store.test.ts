import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inferContextWindow } from '@profer/shared'
import { registerSessionStorageLayout, unregisterSessionStorageLayout } from '@profer/session-store'
import { flushAgentContextUsageWrites as flush, deleteAgentContextUsageSnapshot as drop, readAgentContextUsageSnapshot as read, saveAgentContextUsageSnapshot as save } from './agent-context-usage-store'

let root: string, log: string, previous: string | undefined
beforeEach(async () => {
  previous = process.env.PROFER_CONFIG_DIR
  root = await mkdtemp(join(tmpdir(), 'context-store-'))
  process.env.PROFER_CONFIG_DIR = root
  await mkdir(join(root, 'agent-sessions'))
  log = join(root, 'agent-sessions', 's.jsonl')
})
afterEach(async () => {
  unregisterSessionStorageLayout('s')
  if (previous === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previous
  await rm(root, { recursive: true, force: true })
})
const assistant = { type: 'assistant', timestamp: 123, message: { model: 'm', usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } }
const result = { type: 'result', usage: { input_tokens: 999 }, modelUsage: { child: { contextWindow: 16 }, m: { contextWindow: 456 } } }
const history = (...rows: unknown[]) => writeFile(log, rows.map(r => JSON.stringify(r)).join('\n') + '\n')

test('旧会话回填仅使用主调用实测缓存、窗口、时间；冷读恢复', async () => {
  await history(assistant, { ...assistant, parent_tool_use_id: 'child', message: { usage: { input_tokens: 55 } } }, result)
  const expected = { inputTokens: 14, outputTokens: 2, cacheReadTokens: 7, cacheCreationTokens: 3, contextWindow: 456, usageUpdatedAt: 123, model: 'm' }
  expect(await read('s')).toEqual(expected)
  expect(JSON.parse(await readFile(`${log}.context-usage.json`, 'utf8')).snapshot).toEqual(expected)
  expect(await read('s')).toEqual(expected)
})
test('主写优先于回填；清空、删除不再返回旧值', async () => {
  await history(assistant)
  await Promise.all([read('s'), save('s', { inputTokens: 28 })])
  expect(await read('s')).toEqual({ inputTokens: 28 })
  await history()
  expect(await read('s')).toBeNull()
  await rm(log)
  await save('s', { inputTokens: 25 })
  expect(await read('s')).toBeNull()
})
test('压缩、非法计数、累计结果与超出查找范围一律未知', async () => {
  for (const rows of [[assistant, { type: 'system', subtype: 'compact_boundary' }, result], [result],
    [assistant, { type: 'assistant', message: { usage: { input_tokens: -2 } } }], [assistant, { text: 'a'.repeat(9 * 1024 * 1024) }]]) {
    await history(...rows)
    expect(await read('s')).toBeNull()
  }
})
test('project 注册布局隔离 managed；拒绝目录别名和非法 ID', async () => {
  await history(assistant)
  const dataDir = join(root, '.profer', 'sessions', 's')
  await mkdir(dataDir, { recursive: true })
  registerSessionStorageLayout('s', { kind: 'project', dataDir })
  expect(await read('s')).toBeNull()
  log = join(dataDir, 'messages.jsonl')
  await history(assistant)
  expect((await read('s'))?.inputTokens).toBe(14)
  await rm(log)
  await symlink(join(root, 'agent-sessions', 's.jsonl'), log)
  expect(await read('s')).toBeNull()
  expect(await read('../s')).toBeNull()
})

test('压缩后只认 post_tokens；删除操作清理快照文件', async () => {
  await history(assistant, { type: 'system', subtype: 'compact_boundary', _createdAt: 234, compact_metadata: { pre_tokens: 900, post_tokens: 30 } })
  expect(await read('s')).toEqual({ inputTokens: 30, usageUpdatedAt: 234 })
  await rm(log)
  await drop('s')
  await expect(readFile(`${log}.context-usage.json`)).rejects.toThrow()
})

test('逐块跨越大工具结果和累计超过 2MiB 的小行；无时间不伪造', async () => {
  const tool = (text: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', text }] } })
  await history({ ...assistant, timestamp: undefined }, tool('大'.repeat(800000)), ...Array(2200).fill(tool('x'.repeat(1024))))
  const restored = await read('s')
  expect(restored?.contextWindow).toBe(inferContextWindow('m'))
  expect(restored?.usageUpdatedAt).toBeUndefined()
  expect(restored?.inputTokens).toBe(14)
})
test('纯 result 仅接受可判定的单调用', async () => {
  await history({ ...result, num_turns: 1, _channelModelId: 'm', modelUsage: { m: { contextWindow: 456 } } })
  expect(await read('s')).toMatchObject({ inputTokens: 999, contextWindow: 456 })
})
test('首条消息 ACK 后重存，退出等待已排队写；追加后保留实测窗口', async () => {
  await writeFile(log, '')
  const live = { inputTokens: 14, outputTokens: 2, cacheReadTokens: 7, cacheCreationTokens: 3, model: 'm', contextWindow: 777, usageUpdatedAt: 123 }
  await save('s', live)
  expect(await read('s')).toBeNull()
  await history(assistant)
  const write = save('s', live)
  await flush()
  expect(JSON.parse(await readFile(`${log}.context-usage.json`, 'utf8')).snapshot).toEqual(live)
  await write
  await appendFile(log, JSON.stringify({ type: 'user' }) + '\n')
  expect(await read('s')).toEqual(live)
})
