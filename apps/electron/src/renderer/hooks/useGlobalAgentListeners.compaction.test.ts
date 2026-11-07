import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, SDKMessage } from '@profer/shared'
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
