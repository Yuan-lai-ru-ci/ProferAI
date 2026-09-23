import { describe, expect, test } from 'bun:test'
import { resolveAgentRuntimeSystemPrompt, resolveAgentSystemPromptPolicy } from './agent-system-prompt-policy'

describe('resolveAgentSystemPromptPolicy', () => {
  test('默认保持 grounded 并使用 Claude Code preset', () => {
    expect(resolveAgentSystemPromptPolicy({})).toEqual({
      epistemicMode: 'grounded',
      useClaudeCodePreset: true,
    })
  })

  test('只开启开发者模式时仍保持 grounded', () => {
    expect(resolveAgentSystemPromptPolicy({ developerModeEnabled: true })).toEqual({
      epistemicMode: 'grounded',
      useClaudeCodePreset: true,
    })
  })

  test('两个门禁同时开启时使用 open 并停止叠加 Claude Code preset', () => {
    expect(resolveAgentSystemPromptPolicy({
      developerModeEnabled: true,
      openEpistemicModeEnabled: true,
    })).toEqual({
      epistemicMode: 'open',
      useClaudeCodePreset: false,
    })
  })

  test('开发者模式关闭时忽略残留的开放认识论值', () => {
    expect(resolveAgentSystemPromptPolicy({ openEpistemicModeEnabled: true })).toEqual({
      epistemicMode: 'grounded',
      useClaudeCodePreset: true,
    })
  })

  test('Claude grounded 使用 preset，Claude open 与 Pi 使用自管字符串', () => {
    const grounded = resolveAgentSystemPromptPolicy({})
    const open = resolveAgentSystemPromptPolicy({
      developerModeEnabled: true,
      openEpistemicModeEnabled: true,
    })

    expect(resolveAgentRuntimeSystemPrompt('claude', grounded, 'PROMPT')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'PROMPT',
    })
    expect(resolveAgentRuntimeSystemPrompt('claude', open, 'PROMPT')).toBe('PROMPT')
    expect(resolveAgentRuntimeSystemPrompt('pi', grounded, 'PROMPT')).toBe('PROMPT')
    expect(resolveAgentRuntimeSystemPrompt('pi', open, 'PROMPT')).toBe('PROMPT')
  })
})
