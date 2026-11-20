import { expect, test } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { injectAutomationMcpServer } from './automation-tools'
import { createAutomationManager, type AutomationsIndex } from '@profer/agent-runtime/automation-manager'
import type { AutomationToolOperations } from '@profer/agent-runtime/automation-tool-operations'

test('Claude Automation使用真实SDK工具/schema与宿主操作，保留时区和可信身份', async () => {
  let index: AutomationsIndex = { version: 4, automations: [], triggers: [] }
  const manager = createAutomationManager({ readIndex: () => structuredClone(index), writeIndex: value => { index = structuredClone(value) },
    presetReferenceForAutomation: (_workspace, presetId) => ({ presetId, presetScope: 'builtin-meta' }), assertValidBoundAutomation() {},
  })
  const operations: AutomationToolOperations = { ...manager, broadcastAutomationsChanged() {}, runAutomationNow: async () => {},
    getAgentSessionMeta: () => undefined,
  }
  const captured: Parameters<typeof sdk.createSdkMcpServer>[0]['tools'] = []
  const recording: Pick<typeof sdk, 'tool' | 'createSdkMcpServer'> = { tool: sdk.tool, createSdkMcpServer: options => { captured.push(...options.tools ?? []); return sdk.createSdkMcpServer(options) } }
  const servers: Record<string, Record<string, unknown>> = {}
  await injectAutomationMcpServer(recording, servers, { sessionId: 'parent', channelId: 'fixture', workspaceId: 'workspace', agentRuntime: 'claude' }, [], operations)
  expect(servers.automation).toBeDefined()
  const create = captured.find(tool => tool.name === 'create_automation')!
  const result = await create.handler({ name: 'fixture', prompt: 'fixture only', scheduleType: 'daily', timeOfDay: ['09:00'], timeZone: 'Asia/Shanghai', active: false }, undefined)
  expect(result.isError).not.toBe(true)
  expect(manager.listAutomations()[0]).toMatchObject({ name: 'fixture', timeZone: 'Asia/Shanghai', workspaceId: 'workspace', channelId: 'fixture', promptAuthor: { type: 'agent', id: 'parent' } })
  const task = manager.listAutomations()[0]!
  const update = captured.find(tool => tool.name === 'update_automation')!
  await update.handler({ id: task.id, name: 'updated' }, undefined)
  expect(manager.getAutomation(task.id)?.name).toBe('updated')
  expect(manager.getAutomation(task.id)?.prompt).toBe('fixture only')
  expect(captured.map(tool => tool.name)).toEqual(['list_automations', 'get_automation', 'create_automation', 'update_automation', 'delete_automation', 'run_automation_now'])
})
