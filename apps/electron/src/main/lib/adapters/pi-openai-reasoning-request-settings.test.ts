import { describe, expect, test } from 'bun:test'
import { injectOpenAIReasoningLevel } from './pi-openai-reasoning-request-settings'

describe('OpenAI reasoning request settings', () => {
  test('Given upstream effort and mode When injecting session level Then session effort wins and mode is removed', () => {
    expect(injectOpenAIReasoningLevel(
      { model: 'gpt-5.6-sol', reasoning: { effort: 'medium', mode: 'adaptive' } },
      { thinkingLevel: 'high' },
    )).toEqual({ model: 'gpt-5.6-sol', reasoning: { effort: 'high' } })
  })

  test('Given off level When injecting Then explicitly sends none', () => {
    expect(injectOpenAIReasoningLevel(
      { model: 'gpt-5.6-sol' },
      { thinkingLevel: 'off' },
    )).toEqual({ model: 'gpt-5.6-sol', reasoning: { effort: 'none' } })
  })
})
