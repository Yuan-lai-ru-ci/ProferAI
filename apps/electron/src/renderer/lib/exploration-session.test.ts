import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { buildExplorationReferenceDraft, getLatestExplorationConclusion, mergeExplorationMessages, resolveForkActionAvailability, resolveLatestExplorationSourceMessageId } from './exploration-session'
import { parseQueuedMessageMentions } from './agent-message-queue'

function message(uuid: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as SDKMessage
}

describe('探索分支引用', () => {
  test('Given 主线 Pi 会话 When 解析分叉动作可用性 Then 分叉与探索都可用', () => {
    expect(resolveForkActionAvailability({ isBranch: false, agentRuntime: 'pi' }))
      .toEqual({ canFork: true, canExplore: true })
  })

  test('Given 主线 Claude 会话 When 解析分叉动作可用性 Then 仍可分叉但不提供探索', () => {
    expect(resolveForkActionAvailability({ isBranch: false, agentRuntime: 'claude' }))
      .toEqual({ canFork: true, canExplore: false })
  })

  test('Given 探索分支会话 When 解析分叉动作可用性 Then 两个入口都不提供', () => {
    expect(resolveForkActionAvailability({ isBranch: true, agentRuntime: 'pi' }))
      .toEqual({ canFork: false, canExplore: false })
  })

  test('Given 历史会话缺省 runtime When 解析分叉动作可用性 Then 按 claude 处理仍保留分叉', () => {
    expect(resolveForkActionAvailability({ isBranch: false, agentRuntime: undefined }))
      .toEqual({ canFork: true, canExplore: false })
  })

  test('Given 消息时间线与多个 binding When 选择文件探索锚点 Then 返回最近的主线 assistant', () => {
    const sidechain = { ...message('sidechain', '内部结果'), parent_tool_use_id: 'tool-1' } as SDKMessage
    const messages = [message('assistant-1', '第一轮'), sidechain, message('assistant-2', '第二轮')]
    expect(resolveLatestExplorationSourceMessageId(messages, {
      'assistant-1': 'entry-1',
      sidechain: 'entry-sidechain',
      'assistant-2': 'entry-2',
    })).toBe('assistant-2')
  })

  test('Given 当前消息窗口不含绑定节点 When 选择文件探索锚点 Then 回退最后一个持久化 binding', () => {
    expect(resolveLatestExplorationSourceMessageId([], {
      'assistant-1': 'entry-1',
      'assistant-2': 'entry-2',
    })).toBe('assistant-2')
  })

  test('Given 初次读取的旧快照与后续缓存的新回复 When 合并探索消息 Then 保留新回复作为结论', () => {
    const initial = [message('source', '主线旧结论')]
    const refreshed = [message('source', '主线旧结论'), message('new', '探索新结论')]
    const merged = mergeExplorationMessages(initial, refreshed)
    expect(getLatestExplorationConclusion(merged, 'source')).toBe('探索新结论')
  })

  test('Given fork 前历史与 fork 后回复 When 提取结论 Then 只返回锚点后的最新 assistant 文本', () => {
    const messages = [message('source', '主线旧结论'), message('new-1', '探索第一轮'), message('new-2', '探索最终结论')]
    expect(getLatestExplorationConclusion(messages, 'source')).toBe('探索最终结论')
  })

  test('Given 锚点不存在或没有新增回复 When 提取结论 Then 返回空字符串', () => {
    expect(getLatestExplorationConclusion([message('other', '内容')], 'missing')).toBe('')
    expect(getLatestExplorationConclusion([message('source', '旧内容')], 'source')).toBe('')
  })

  test('Given fork 后只有内部 sidechain 回复 When 提取结论 Then 不把子 Agent 内容作为主线结论', () => {
    const sidechain = { ...message('sidechain', '内部工具结果'), parent_tool_use_id: 'tool-1' } as SDKMessage
    expect(getLatestExplorationConclusion([message('source', '旧内容'), sidechain], 'source')).toBe('')
  })

  test('Given 分支 ID 和标题 When 构造带回引用 Then markdown/html 都只包含受控 mention', () => {
    const result = buildExplorationReferenceDraft('branch-1', '探索方案')
    expect(result.markdown).toContain('&session:branch-1::')
    expect(result.markdown).not.toContain('探索最终结论')
    expect(result.html).toContain('data-type="mention"')
    expect(result.html).toContain('data-id="branch-1"')
  })

  test('Given 带回生成的 session mention When 解析发送文本 Then 保留分支 ID 并移除展示标签', () => {
    const result = buildExplorationReferenceDraft('branch-1', '探索方案')
    const parsed = parseQueuedMessageMentions(`请吸收\n${result.markdown}`)
    expect(parsed.mentionedSessionIds).toEqual(['branch-1'])
    expect(parsed.cleanedText).toBe('请吸收\n这是探索后的新增内容：')
  })
})
