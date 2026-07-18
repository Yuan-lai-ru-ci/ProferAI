import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_AGENT_RUNTIME,
  isAgentRuntime,
  normalizeAgentRuntime,
} from './agent-provider'

describe('Agent runtime persistence compatibility', () => {
  test('Given missing or invalid historical values When normalizing Then falls back to Claude', () => {
    expect(DEFAULT_AGENT_RUNTIME).toBe('claude')
    expect(normalizeAgentRuntime(undefined)).toBe('claude')
    expect(normalizeAgentRuntime('unknown')).toBe('claude')
  })

  test('Given supported runtime values When validating Then preserves Claude and Pi only', () => {
    expect(isAgentRuntime('claude')).toBe(true)
    expect(isAgentRuntime('pi')).toBe(true)
    expect(isAgentRuntime(undefined)).toBe(false)
    expect(isAgentRuntime('codex')).toBe(false)
    expect(normalizeAgentRuntime('pi')).toBe('pi')
  })
})
