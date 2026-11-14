import { describe, expect, mock, test } from 'bun:test'
import type { AgentRuntimeQuery } from '@profer/agent-runtime'
import type { SDKMessage } from '@profer/shared'

mock.module('../agent-sdk-env', () => ({ buildAgentSdkEnv: async () => ({}) }))
mock.module('../agent-runtime-env-host', () => ({ resolveHostAgentRuntimeEnv: async () => undefined }))
mock.module('../agent-sdk-cli-path', () => ({ resolveSDKCliPath: () => '/fixture/cli' }))
mock.module('../config-paths', () => ({ getPiTranscriptDirForSession: () => '/fixture/transcripts', getSdkConfigDir: () => '/fixture/config' }))
mock.module('../agent-workspace-manager', () => ({ getAgentWorkspace: () => undefined, getWorkspaceAutoMemoryDir: () => '/fixture/memory' }))
mock.module('../agent-session-manager', () => ({ resolveAgentSessionWriteLayout: (slug: string) => {
  if (slug === 'missing-root') throw new Error('workspace root missing')
  return { storageDir: '/fixture/storage' }
} }))
mock.module('../workspace-locator', () => ({ resolveWorkspaceLocation: () => ({ mode: 'managed' }) }))
mock.module('../agent-runtime-turn-prompt', () => ({ buildRuntimeTurnPrompt: () => undefined }))
mock.module('../agent-directory-utils', () => ({ isPathInsideDirectory: (path: string, root: string) => path === root || path.startsWith(`${root}/`) }))
const { createElectronProviderQueryPreparation } = await import('../agent-runtime-provider-preparation')
const { fileWriteChips } = await import('../agent-file-write-chips')

describe('provider chip-only 观察接线', () => {
  for (const runtime of ['claude', 'pi'] as const) {
    test(`${runtime}: 展示增强不让布局缺失的查询失败`, async () => {
      const result = await createElectronProviderQueryPreparation({
        resolveRuntimeEnv: async () => ({ env: {}, shellKind: 'posix', shellPath: '/bin/bash' }),
      }).prepare({
        sessionId: 'missing-root', runtime, prompt: 'hi', cwd: '/fixture/project',
        deferredToolAssemblyContext: { workspaceSlug: 'missing-root' },
      } as AgentRuntimeQuery, {
        credentials: { apiKey: 'fake', baseUrl: undefined, provider: 'anthropic', forceBearerAuth: false },
      }, new AbortController().signal) as { onFileChangeObserved?: unknown }
      expect(result.onFileChangeObserved).toBeFunction()
    })

    test(`${runtime}: 观察仅写 chip，过滤草稿，绝不写 Shadow`, async () => {
      const sessionId = `chip-observation-${runtime}`
      const shadow: unknown[] = []
      const input = {
        sessionId, runtime, prompt: 'hi', cwd: '/fixture/project',
        deferredToolAssemblyContext: { workspaceSlug: 'demo' },
        metadata: { shadowLedger: { push: (fact: unknown) => { shadow.push(fact) } } },
      } as AgentRuntimeQuery
      const options = await createElectronProviderQueryPreparation({
        resolveRuntimeEnv: async () => ({ env: {}, shellKind: 'posix', shellPath: '/bin/bash' }),
      }).prepare(input, {
        credentials: { apiKey: 'fake', baseUrl: undefined, provider: 'anthropic', forceBearerAuth: false },
      }, new AbortController().signal) as {
        onFileChangeObserved: (id: string, fact: { path: string; source: string }) => void
        onFileWrite?: (id: string, fact: { path: string; source: string }) => void
      }
      expect(options.onFileChangeObserved).toBeFunction()
      options.onFileChangeObserved('tool-1', { path: '/fixture/project/a.ts', source: runtime === 'pi' ? 'bash' : 'write' })
      options.onFileChangeObserved('tool-1', { path: '/fixture/storage/tmp.png', source: 'write' })
      expect(shadow).toEqual([])
      const message = {
        type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
      } as SDKMessage
      const attached = fileWriteChips.attach(sessionId, message)
      expect(attached).toMatchObject({ message: { content: [{ proferFileChanges: [{ path: '/fixture/project/a.ts', source: runtime === 'pi' ? 'bash' : 'write' }] }] } })
      if (runtime === 'pi') {
        options.onFileWrite!('tool-2', { path: '/fixture/project/b.ts', source: 'edit' })
        expect(shadow).toEqual([{ toolUseId: 'tool-2', path: '/fixture/project/b.ts', source: 'edit' }])
      }
      fileWriteChips.dropSession(sessionId)
    })
  }
})
