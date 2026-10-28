/**
 * 移动端新建会话的渠道/模型决议。
 *
 * 缺口来源：桌面每次切换模型都会把选择写进 settings.agentChannelId / agentModelId，
 * 但 remote-service 从未下发这份「上次使用」；Pocket 新建会话只能自己猜
 * 「第一个启用渠道的第一个模型」，于是手机上的模型记忆看起来完全不生效。
 *
 * 两层证据：
 * 1. 行为：`pickAgentSelection` 的优先级与回退；
 * 2. 接线：`create_session` / `ensure_project_draft_session` 真的走了决议函数，
 *    且 `update_session_model` 把选择写回全局默认（否则手机上连建两个会话又回到旧模型）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pickAgentSelection } from './remote-service'

const source = readFileSync(new URL('./remote-service.ts', import.meta.url), 'utf8')

function slice(from: string, to: string): string {
  const start = source.indexOf(from)
  expect(start, `未找到起点片段: ${from}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(to, start)
  expect(end, `未找到终点片段: ${to}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

const channels = [
  { id: 'anthropic-official', models: [{ id: 'claude-sonnet-4-6', enabled: true }, { id: 'claude-opus-4-5', enabled: true }] },
  { id: 'openai-official', models: [{ id: 'gpt-5.6', enabled: true }, { id: 'gpt-5.6-terra', enabled: false }] },
]

describe('pickAgentSelection（新建会话的渠道/模型优先级）', () => {
  test('客户端没指定时继承桌面默认（上次使用的渠道与模型）', () => {
    expect(pickAgentSelection(channels, {}, { channelId: 'openai-official', modelId: 'gpt-5.6' }))
      .toEqual({ channelId: 'openai-official', modelId: 'gpt-5.6' })
  })

  test('桌面默认渠道不存在时回落到首个可用渠道，并保留仍有效的默认模型', () => {
    expect(pickAgentSelection(channels, {}, { channelId: 'deleted-channel', modelId: 'claude-opus-4-5' }))
      .toEqual({ channelId: 'anthropic-official', modelId: 'claude-opus-4-5' })
  })

  test('默认模型不属于最终渠道时回落到该渠道首个启用模型', () => {
    expect(pickAgentSelection(channels, {}, { channelId: 'anthropic-official', modelId: 'gpt-5.6' }))
      .toEqual({ channelId: 'anthropic-official', modelId: 'claude-sonnet-4-6' })
  })

  test('客户端显式指定的渠道/模型优先于桌面默认', () => {
    expect(pickAgentSelection(
      channels,
      { channelId: 'openai-official', modelId: 'gpt-5.6' },
      { channelId: 'anthropic-official', modelId: 'claude-opus-4-5' },
    )).toEqual({ channelId: 'openai-official', modelId: 'gpt-5.6' })
  })

  test('停用的模型不可作为会话模型', () => {
    expect(pickAgentSelection(
      channels,
      { channelId: 'openai-official', modelId: 'gpt-5.6-terra' },
      {},
    )).toEqual({ channelId: 'openai-official', modelId: 'gpt-5.6' })
  })

  test('没有任何可用渠道时保持原样，交给上层提示未配置', () => {
    expect(pickAgentSelection([], {}, { channelId: 'gone', modelId: 'gone-model' }))
      .toEqual({ channelId: undefined, modelId: undefined })
  })
})

describe('remote-service 接线', () => {
  test('create_session 与 ensure_project_draft_session 都走同一份决议', () => {
    const create = slice("case 'create_session': {", "case 'migrate_chat_to_agent': {")
    expect(create).toContain('resolveRemoteAgentSelection(')
    expect(create).toContain('selection.channelId')
    expect(create).toContain('selection.modelId')

    const draft = slice("case 'ensure_project_draft_session': {", "case 'send_message': {")
    expect(draft).toContain('resolveRemoteAgentSelection(')
    expect(draft).toContain('selection.modelId')
  })

  test('get_agent_defaults 下发桌面默认，供移动端在建会话前展示', () => {
    const command = slice("case 'get_agent_defaults': {", '// Chat 工具（function calling）')
    expect(command).toContain('resolveRemoteAgentSelection(undefined, undefined, runtime)')
    expect(command).toContain('channelId: selection.channelId ?? null')
    expect(command).toContain('modelId: selection.modelId ?? null')
  })

  test('update_session_model 把移动端选择写回全局默认', () => {
    const update = slice("case 'update_session_model': {", "case 'update_session_runtime': {")
    expect(update).toContain('updateSettings({ agentChannelId: updated.channelId, agentModelId: updated.modelId })')
  })
})
