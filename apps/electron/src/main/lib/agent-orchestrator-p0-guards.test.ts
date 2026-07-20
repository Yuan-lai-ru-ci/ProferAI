import { describe, expect, test } from 'bun:test'
import {
  applySdkCredentials,
  isPartialSDKMessage,
  isPlanModeMarkdownPath,
  isPlanModeMcpTool,
  releaseActiveSession,
  tryAcquireActiveSession,
} from './agent-orchestrator-p0-guards'

describe('AgentOrchestrator P0 guards', () => {
  test('Given 同一 session 已在运行 When 再次占用 Then 拒绝并保留原运行令牌', () => {
    const sessions = new Map<string, string>()

    expect(tryAcquireActiveSession(sessions, 'session-1', 'run-a')).toBe(true)
    expect(tryAcquireActiveSession(sessions, 'session-1', 'run-b')).toBe(false)
    expect(sessions.get('session-1')).toBe('run-a')
  })

  test('Given 运行异常后持有当前令牌 When finally 释放 Then 同 session 可再次占用', () => {
    const sessions = new Map<string, string>()
    tryAcquireActiveSession(sessions, 'session-1', 'run-a')

    expect(releaseActiveSession(sessions, 'session-1', 'run-a')).toBe(true)
    expect(tryAcquireActiveSession(sessions, 'session-1', 'run-b')).toBe(true)
  })

  test('Given 旧运行 finally 晚于新运行 When 旧令牌尝试释放 Then 不清除新运行', () => {
    const sessions = new Map<string, string>([['session-1', 'run-b']])

    expect(releaseActiveSession(sessions, 'session-1', 'run-a')).toBe(false)
    expect(sessions.get('session-1')).toBe('run-b')
  })

  test('Given 本轮 SDK env When 注入凭证 Then 仅写入 query env 且 process env 不变', () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    const sdkEnv: Record<string, string | undefined> = { PATH: process.env.PATH }

    applySdkCredentials(sdkEnv, 'session-only-secret', 'https://gateway.example/v1', 'anthropic')

    expect(sdkEnv.ANTHROPIC_API_KEY).toBe('session-only-secret')
    expect(sdkEnv.ANTHROPIC_BASE_URL).toBe('https://gateway.example')
    expect(process.env.ANTHROPIC_API_KEY).toBe(originalApiKey)
    expect(process.env.ANTHROPIC_BASE_URL).toBe(originalBaseUrl)
  })

  test('Given Pi partial preview When checking persistence eligibility Then identifies it as non-persistable', () => {
    expect(isPartialSDKMessage({ type: 'assistant', _partial: true } as never)).toBe(true)
    expect(isPartialSDKMessage({ type: 'assistant', _partial: false } as never)).toBe(false)
    expect(isPartialSDKMessage({ type: 'assistant' } as never)).toBe(false)
  })

  test('Given Plan 模式 When 写入当前 cwd/.context/plan 下 Markdown Then 允许', () => {
    expect(isPlanModeMarkdownPath('/workspace/session', '.context/plan/p0-regression.md')).toBe(true)
  })

  test('Given Plan 模式 When 路径越界或不是 Markdown Then 拒绝', () => {
    expect(isPlanModeMarkdownPath('/workspace/session', '.context/plan/../outside.md')).toBe(false)
    expect(isPlanModeMarkdownPath('/workspace/session', '.context/plan/notes.txt')).toBe(false)
    expect(isPlanModeMarkdownPath('/workspace/session', '/workspace/other/.context/plan/plan.md')).toBe(false)
  })

  test('Given Plan 模式 When 调用 MCP 工具 Then 拒绝', () => {
    expect(isPlanModeMcpTool('mcp__automation__create_automation')).toBe(true)
    expect(isPlanModeMcpTool('Read')).toBe(false)
  })
})
