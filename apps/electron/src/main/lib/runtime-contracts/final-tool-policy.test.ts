import { describe, expect, mock, test } from 'bun:test'
import type { AgentRuntimeQuery } from '@profer/agent-runtime'
mock.module('../agent-sdk-env', () => ({ buildAgentSdkEnv: async () => ({}) }))
mock.module('../agent-runtime-env-host', () => ({ resolveHostAgentRuntimeEnv: async () => undefined }))
mock.module('../agent-sdk-cli-path', () => ({ resolveSDKCliPath: () => '/fixture/cli' }))
mock.module('../config-paths', () => ({ getPiTranscriptDirForSession: () => '/fixture/transcripts', getSdkConfigDir: () => '/fixture/config' }))
mock.module('../agent-workspace-manager', () => ({ getAgentWorkspace: () => undefined, getWorkspaceAutoMemoryDir: () => '/fixture/memory' }))
mock.module('../agent-session-manager', () => ({ resolveAgentSessionWriteLayout: () => undefined }))
mock.module('../workspace-locator', () => ({ resolveWorkspaceLocation: () => ({ mode: 'managed' }) }))
mock.module('../agent-runtime-turn-prompt', () => ({ buildRuntimeTurnPrompt: () => undefined }))
mock.module('../agent-directory-utils', () => ({ isPathInsideDirectory: () => false }))
mock.module('../agent-file-write-chips', () => ({ fileWriteChips: { record() {} } }))
const { createElectronProviderQueryPreparation } = await import('../agent-runtime-provider-preparation')
const { resolveAgentRuntimePolicySnapshot, AGENT_RUNTIME_POLICY_SNAPSHOT_KEY } = await import('../agent-runtime-policy-snapshot')

describe('冻结策略进入最终 provider options', () => {
  for (const runtime of ['claude', 'pi'] as const) {
    test(`${runtime}: snapshot deny 与 prepared/override 合并，allowedTools 不限制注册`, async () => {
      const preset = { id: 'fixture', name: 'fixture', description: '', isBuiltin: false, scope: 'workspace' as const, createdAt: 1, updatedAt: 1, disabledTools: ['Bash', 'Read', 'Glob'], disabledToolGroups: [] }
      const snapshot = resolveAgentRuntimePolicySnapshot({ preset, presetReference: { presetId: preset.id, presetScope: 'workspace', workspaceSlug: 'demo' } })
      const input = { runtime, sessionId: 'fixture', prompt: 'hi', providerInput: {
        [AGENT_RUNTIME_POLICY_SNAPSHOT_KEY]: snapshot, disallowedTools: ['Write'],
      } } as AgentRuntimeQuery
      const result = await createElectronProviderQueryPreparation({ resolveRuntimeEnv: async () => ({ env: {}, shellKind: 'posix', shellPath: '/bin/bash' }) }).prepare(input, {
        credentials: { apiKey: 'fake', baseUrl: undefined, provider: 'anthropic', forceBearerAuth: false }, allowedTools: ['Read'], disallowedTools: ['Edit'],
      }, new AbortController().signal) as Record<string, unknown>
      expect(result.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Glob', 'Write', 'Edit']))
      expect(result.allowedTools).toEqual(['Read'])
      expect(result[AGENT_RUNTIME_POLICY_SNAPSHOT_KEY]).toBeUndefined()
    })
  }
})
