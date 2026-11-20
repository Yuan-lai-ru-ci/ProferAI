import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentContextUsageSnapshot, AgentStreamPayload } from '@profer/shared'
import { createContextUsageRecorder } from './agent-context-usage-recorder'
import { deleteAgentContextUsageSnapshot, flushAgentContextUsageWrites, saveAgentContextUsageSnapshot } from './agent-context-usage-store'

const assistant = (): Extract<AgentStreamPayload, { kind: 'sdk_message' }> => ({ kind: 'sdk_message', message: { type: 'assistant', parent_tool_use_id: null, message: { model: 'primary', content: [], usage: { input_tokens: 30, cache_read_input_tokens: 70 } } } })
const pending = (status: 'pending' | 'saved'): AgentStreamPayload => ({ kind: 'profer_event', event: { type: 'session_persistence', status } })

test('首轮读数先于写盘：消息 ACK 后正常退出，独立进程仍能读到同一数值、窗口和原始时间', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-cold-start-'))
  const before = process.env.PROFER_CONFIG_DIR
  process.env.PROFER_CONFIG_DIR = root
  try {
    const dir = join(root, 'agent-sessions')
    await mkdir(dir)
    const recorder = createContextUsageRecorder({ save: saveAgentContextUsageSnapshot, remove: deleteAgentContextUsageSnapshot }, () => 98765)
    const payload = assistant()
    recorder.observe('sess', pending('pending'))
    recorder.observe('sess', payload, 23456)
    await flushAgentContextUsageWrites()
    recorder.finish('sess') // 最终 ACK 晚于运行态回收，也要保存权威窗口和原始时间。
    await writeFile(join(dir, 'sess.jsonl'), JSON.stringify(payload.message) + '\n')
    recorder.observe('sess', pending('saved'))
    await flushAgentContextUsageWrites()
    const proc = Bun.spawn([process.execPath, '-e', `import { readAgentContextUsageSnapshot as read } from './agent-context-usage-store'; console.log(JSON.stringify([await read('sess'), await read('empty')]))`], { cwd: import.meta.dir, env: { ...process.env, PROFER_CONFIG_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual([JSON.parse(JSON.stringify(payload.contextUsage)), null])
    expect(payload.contextUsage).toMatchObject({ inputTokens: 100, contextWindow: 23456, usageUpdatedAt: 98765 })
  } finally {
    if (before === undefined) delete process.env.PROFER_CONFIG_DIR
    else process.env.PROFER_CONFIG_DIR = before
    await rm(root, { recursive: true, force: true })
  }
})

test('压缩前的旧读数不会写回；没有实测 post_tokens 不生成新读数', () => {
  const saved = new Map<string, AgentContextUsageSnapshot>()
  const recorder = createContextUsageRecorder({ save: async (id, v) => { saved.set(id, v) }, remove: async id => { saved.delete(id) } })
  recorder.observe('s', assistant(), 32000)
  recorder.observe('s', { kind: 'sdk_message', message: { type: 'system', subtype: 'compact_boundary' } })
  expect(recorder.hidesPreCompactReading('s')).toBe(true)
  recorder.observe('s', pending('saved'))
  expect(saved.has('s')).toBe(false)
  recorder.observe('s', { kind: 'sdk_message', message: { type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: 21 } } }, 32000)
  expect(saved.get('s')).toMatchObject({ inputTokens: 21, contextWindow: 32000 })
  expect(recorder.hidesPreCompactReading('s')).toBe(false)
})
