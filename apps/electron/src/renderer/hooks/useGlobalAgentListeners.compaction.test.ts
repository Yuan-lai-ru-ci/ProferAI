import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, SDKMessage } from '@profer/shared'
import { applyAgentEvent, type AgentStreamState } from '../atoms/agent-atoms'
import { payloadToLegacyEvents } from './useGlobalAgentListeners'

const system = (subtype: string, extra: Record<string, unknown> = {}): AgentStreamPayload => ({
  kind: 'sdk_message',
  message: { type: 'system', subtype, ...extra } as unknown as SDKMessage,
})

describe('压缩系统消息 → 流式事件', () => {
  test('compacting / compact_boundary 驱动压缩中与压缩完成', () => {
    expect(payloadToLegacyEvents(system('compacting'))).toEqual([{ type: 'compacting' }])
    expect(payloadToLegacyEvents(system('compact_boundary'))).toEqual([{ type: 'compact_complete' }])
  })

  test('压缩失败/取消/跳过没有 compact_boundary，也必须释放压缩锁', () => {
    // 适配器在 compaction_end 失败或中止时只发 status(compact_result)；
    // 手动压缩被守卫挡下时发 compact_skipped。两者都不能让本轮停在「压缩中」。
    for (const payload of [
      system('status', { compact_result: 'failed', compact_error: '摘要请求失败' }),
      system('status', { compact_result: 'skipped' }),
      system('compact_skipped', { reason: 'too_few_turns', message: '轮次过少' }),
    ]) {
      expect(payloadToLegacyEvents(payload)).toEqual([{ type: 'compact_failed' }])
    }
  })

  test('普通 status 消息不改变压缩态', () => {
    expect(payloadToLegacyEvents(system('status', { status: 'running' }))).toEqual([])
  })
})

const initial: AgentStreamState = { running: true, content: '', toolActivities: [], contextWindow: 64, cacheCreationTokens: 8 }
const snapshot = { inputTokens: 250, outputTokens: 18, cacheReadTokens: 99, contextWindow: 1024, usageUpdatedAt: 1111 }

test('单轮单模型 result 的宿主读数立即生效，恢复后的窗口、缓存明细和时间与实时一致', () => {
  const events = payloadToLegacyEvents({ kind: 'sdk_message', contextUsage: snapshot,
    message: { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 250, output_tokens: 18 },
      modelUsage: { main: { contextWindow: 1024 } } } as SDKMessage })
  expect(events.map(e => e.type)).toEqual(['complete', 'usage_update'])
  const state = events.reduce(applyAgentEvent, initial)
  expect(state).toMatchObject(snapshot)
  expect(state.cacheCreationTokens).toBeUndefined()
})

test('边界先废弃旧值，再采用权威读数，不重复应用本地 post_tokens 推断或补造时间', () => {
  const events = payloadToLegacyEvents({ kind: 'sdk_message', contextUsage: { inputTokens: 42 },
    message: { type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: 40 } } })
  expect(events.map(e => e.type)).toEqual(['compact_complete', 'usage_update'])
  const state = events.reduce(applyAgentEvent, initial)
  expect(state.inputTokens).toBe(42)
  expect(state.contextWindow).toBeUndefined()
  expect(state.usageUpdatedAt).toBeUndefined()
})
