import { describe, expect, test } from 'bun:test'
import { resolvePiThinkingLevel, resolveGlobalThinkingLevel, type ThinkingLevelSettings } from './agent-thinking-level'

const defaults: ThinkingLevelSettings = { agentThinking: true, agentEffort: 'high' }

describe('resolveGlobalThinkingLevel', () => {
  test('Given agentThinking 关闭 Then 返回 off', () => {
    expect(resolveGlobalThinkingLevel({ agentThinking: false })).toBe('off')
  })

  test('Given agentThinking 开启且 effort=low Then 返回 low', () => {
    expect(resolveGlobalThinkingLevel({ agentThinking: true, agentEffort: 'low' })).toBe('low')
  })

  test('Given agentThinking 开启且 effort=medium Then 返回 medium', () => {
    expect(resolveGlobalThinkingLevel({ agentThinking: true, agentEffort: 'medium' })).toBe('medium')
  })

  test('Given agentThinking 开启且 effort=high Then 返回 high', () => {
    expect(resolveGlobalThinkingLevel({ agentThinking: true, agentEffort: 'high' })).toBe('high')
  })

  test('Given agentThinking 开启且 effort=max Then 返回 xhigh', () => {
    expect(resolveGlobalThinkingLevel({ agentThinking: true, agentEffort: 'max' })).toBe('xhigh')
  })

  test('Given agentThinking 开启但 effort 未设置 Then 默认返回 high', () => {
    expect(resolveGlobalThinkingLevel({ agentThinking: true })).toBe('high')
  })
})

describe('resolvePiThinkingLevel', () => {
  test('Given 无 reasoning 协议的 provider(google) Then 返回 off', () => {
    expect(resolvePiThinkingLevel('high', defaults, 'google')).toBe('off')
  })

  test('Given anthropic provider 且开启 Then 返回档位（原生 extended thinking）', () => {
    expect(resolvePiThinkingLevel('high', defaults, 'anthropic')).toBe('high')
  })

  test('Given deepseek 且开启 Then 返回档位', () => {
    expect(resolvePiThinkingLevel('high', defaults, 'deepseek')).toBe('high')
  })

  test('Given deepseek 未设会话级且全局默认 Then 返回全局默认', () => {
    expect(resolvePiThinkingLevel(undefined, defaults, 'deepseek')).toBe('high')
  })

  test('Given openai provider 且档位 medium Then 返回 medium', () => {
    expect(resolvePiThinkingLevel('medium', { agentThinking: true, agentEffort: 'high' }, 'openai')).toBe('medium')
  })

  test('Given 关闭推理 Then 任意 provider 均返回 off', () => {
    expect(resolvePiThinkingLevel('off', { agentThinking: true, agentEffort: 'high' }, 'deepseek')).toBe('off')
    expect(resolvePiThinkingLevel('off', { agentThinking: true, agentEffort: 'high' }, 'openai-codex')).toBe('off')
  })

  test('Given Codex + 会话级 xhigh Then 返回 xhigh（覆盖全局）', () => {
    expect(resolvePiThinkingLevel('xhigh', defaults, 'openai-codex')).toBe('xhigh')
  })

  test('Given Codex + 会话级 off Then 返回 off（覆盖全局）', () => {
    expect(resolvePiThinkingLevel('off', { agentThinking: true, agentEffort: 'high' }, 'openai-codex')).toBe('off')
  })

  test('Given Codex + 会话级 null（使用全局默认）Then 使用全局设置', () => {
    // null 表示「使用全局默认」，不是「关闭」
    expect(resolvePiThinkingLevel(null, { agentThinking: true, agentEffort: 'high' }, 'openai-codex')).toBe('high')
    expect(resolvePiThinkingLevel(null, { agentThinking: true, agentEffort: 'low' }, 'openai-codex')).toBe('low')
  })

  test('Given Codex + 会话级 undefined（未设置）Then 使用全局设置', () => {
    expect(resolvePiThinkingLevel(undefined, { agentThinking: false }, 'openai-codex')).toBe('off')
    expect(resolvePiThinkingLevel(undefined, { agentThinking: true, agentEffort: 'max' }, 'openai-codex')).toBe('xhigh')
  })

  test('Given Codex + 会话级 medium Then 返回 medium（忽略全局 high）', () => {
    expect(resolvePiThinkingLevel('medium', { agentThinking: true, agentEffort: 'high' }, 'openai-codex')).toBe('medium')
  })
})
