import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, AutomationTriggerRecord, Automation } from '@profer/shared'
import {
  buildAutomationDispatchMetadata,
  createAutomationOccurrenceId,
  enqueueAutomationTrigger,
  transitionAutomationTrigger,
  normalizeAutomationTriggerRecords,
  validateBoundAutomationSession,
  validateBoundAutomationChannel,
  withTrustedAutomationPromptAuthor,
} from './automation-dispatch'

const automation: Automation = {
  id: 'auto-1', name: '巡检', prompt: '检查项目', scheduleType: 'daily', intervalMinutes: 10,
  channelId: 'channel-1', workspaceId: 'workspace-1', agentRuntime: 'pi', active: true,
  createdAt: 1, updatedAt: 1, nextRunAt: 2, runHistory: [],
}

const session: Pick<AgentSessionMeta, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'workspaceId' | 'channelId' | 'agentRuntime' | 'presetId'> = {
  id: 'session-1', title: '工作会话', createdAt: 1, updatedAt: 1,
  channelId: 'channel-1', workspaceId: 'workspace-1', agentRuntime: 'pi', presetId: 'code',
}

describe('automation dispatch contract', () => {
  test('scheduled occurrence identity is stable for retries and changes across schedule slots', () => {
    expect(createAutomationOccurrenceId('auto-1', 1234)).toBe(createAutomationOccurrenceId('auto-1', 1234))
    expect(createAutomationOccurrenceId('auto-1', 1234)).not.toBe(createAutomationOccurrenceId('auto-1', 1235))
  })

  test('dispatch metadata keeps automation source/authorization separate from prompt author', () => {
    const metadata = buildAutomationDispatchMetadata({
      automation: { ...automation, promptAuthor: { type: 'agent', id: 'source-session' } },
      triggerId: 'auto-1:1234',
    })
    expect(metadata).toEqual({
      taskId: 'automation:auto-1',
      triggerId: 'auto-1:1234',
      taskOrigin: { actor: { type: 'automation', id: 'auto-1' }, source: { type: 'automation', id: 'auto-1' } },
      taskAuthorization: { kind: 'scheduled', sourceRef: { type: 'automation', id: 'auto-1' } },
      messageAuthor: { type: 'agent', id: 'source-session' },
    })
  })

  test('old task without prompt author stays automation-authored, never user-authored', () => {
    expect(buildAutomationDispatchMetadata({ automation, triggerId: 't' }).messageAuthor)
      .toEqual({ type: 'automation', id: 'auto-1' })
  })

  test('IPC prompt-author binding discards forged authors unless prompt is edited by the user', () => {
    expect(withTrustedAutomationPromptAuthor({ id: 'a', promptAuthor: { type: 'user' as const } }, { type: 'user' }))
      .toEqual({ id: 'a' })
    expect(withTrustedAutomationPromptAuthor({ id: 'a', prompt: 'edited', promptAuthor: { type: 'agent' as const, id: 'forged' } }, { type: 'user' }))
      .toEqual({ id: 'a', prompt: 'edited', promptAuthor: { type: 'user' } })
  })

  test('bound target must match workspace, runtime, channel and explicit preset', () => {
    expect(validateBoundAutomationSession(automation, session, 'code')).toEqual({ valid: true })
    expect(validateBoundAutomationSession(automation, { ...session, workspaceId: 'other' }, 'code').valid).toBe(false)
    expect(validateBoundAutomationSession(automation, { ...session, agentRuntime: 'claude' }, 'code').valid).toBe(false)
    expect(validateBoundAutomationSession(automation, { ...session, channelId: 'other' }, 'code').valid).toBe(false)
    expect(validateBoundAutomationSession({ ...automation, presetId: undefined }, { ...session, presetId: undefined }, 'standard')).toEqual({ valid: true })
    expect(validateBoundAutomationSession({ ...automation, presetId: 'code' }, { ...session, presetId: undefined }, 'code').valid).toBe(false)
  })

  test('bound target channel and model must remain enabled at dispatch time', () => {
    const channel = {
      provider: 'anthropic' as const,
      enabled: true,
      agentRuntimes: ['claude' as const],
      models: [{ id: 'model-1', name: 'Model', enabled: true }],
    }
    expect(validateBoundAutomationChannel({ ...automation, agentRuntime: 'claude', modelId: 'model-1' }, { modelId: 'model-1' }, channel)).toEqual({ valid: true })
    expect(validateBoundAutomationChannel({ ...automation, agentRuntime: 'claude', modelId: 'model-1' }, { modelId: 'model-1' }, { ...channel, enabled: false })).toMatchObject({ valid: false })
    expect(validateBoundAutomationChannel({ ...automation, agentRuntime: 'claude', modelId: 'model-2' }, { modelId: 'model-1' }, channel)).toMatchObject({ valid: false })
  })

  test('queue deduplicates trigger IDs and allows only queued-to-running then terminal transitions', () => {
    const first: AutomationTriggerRecord = {
      triggerId: 'trigger-1', occurrenceId: 'occurrence-1', automationId: 'auto-1', scheduledAt: 10,
      status: 'queued', createdAt: 1, updatedAt: 1,
    }
    expect(enqueueAutomationTrigger([first], { ...first, status: 'queued' }, 2)).toEqual([first])
    const claimed = transitionAutomationTrigger(first, 'running', 3)
    expect(claimed.status).toBe('running')
    expect(transitionAutomationTrigger(claimed, 'completed', 4, { targetSessionId: 'session-1' }).status).toBe('completed')
    expect(() => transitionAutomationTrigger(claimed, 'running', 4)).toThrow()
  })

  test('blocked target remains visible and can be unblocked after route repair', () => {
    const blocked: AutomationTriggerRecord = {
      triggerId: 'trigger-blocked', occurrenceId: 'occurrence-blocked', automationId: 'auto-1', scheduledAt: 10,
      status: 'blocked', error: '绑定会话已删除', createdAt: 1, updatedAt: 1,
    }
    const queued = transitionAutomationTrigger(blocked, 'queued', 2, { error: undefined, boundSessionId: 'replacement-session' })
    expect(queued).toMatchObject({ status: 'queued', boundSessionId: 'replacement-session' })
    expect(() => transitionAutomationTrigger(blocked, 'running', 2)).toThrow()
  })

  test('restart keeps queued records and converts in-flight records to interrupted without replay', () => {
    const records: AutomationTriggerRecord[] = [
      { triggerId: 'queued', occurrenceId: 'o1', automationId: 'auto-1', scheduledAt: 1, status: 'queued', createdAt: 1, updatedAt: 1 },
      { triggerId: 'running', occurrenceId: 'o2', automationId: 'auto-1', scheduledAt: 2, status: 'running', createdAt: 1, updatedAt: 2 },
    ]
    expect(normalizeAutomationTriggerRecords(records, 3)).toEqual([
      records[0]!, { ...records[1]!, status: 'interrupted', error: '应用重启时运行状态无法恢复', updatedAt: 3 },
    ])
  })
})
