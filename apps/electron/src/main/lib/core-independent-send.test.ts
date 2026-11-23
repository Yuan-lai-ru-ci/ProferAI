import { expect, test } from 'bun:test'
import { prepareIndependentCoreMessage } from './core-local-bridge'
import type { AgentSendInput } from '@profer/shared'

const session: import('./core-client').CoreSession = {
  id: 'fixture-session', title: 'Fixture', agentRuntime: 'pi', workspaceId: 'fixture-workspace',
  createdAt: 1, updatedAt: 1,
}
const channel: import('./core-client').CoreChannel = {
  id: 'fixture-channel', name: 'Fixture', provider: 'anthropic', baseUrl: 'https://fixture.invalid',
  enabled: true, agentRuntimes: ['pi', 'claude'], models: [{ id: 'fixture-model', name: 'Fixture', enabled: true }],
}
const input: AgentSendInput = {
  sessionId: session.id, workspaceId: session.workspaceId!, agentRuntime: 'pi', channelId: channel.id,
  modelId: 'fixture-model', userMessage: 'synthetic prompt', rawUserMessage: 'display prompt', uuid: 'fixture-uuid',
}

test.each(['pi', 'claude'] as const)('independent local Core prepares a credential-free message (%s)', async agentRuntime => {
  const prepared = await prepareIndependentCoreMessage({ ...input, agentRuntime }, {
    async getSessionDetail(id) { expect(id).toBe(session.id); return { session: { ...session, agentRuntime }, active: false } },
    async listChannels() { return [channel] },
  }, () => {})
  expect(prepared).toMatchObject({ channelId: channel.id, modelId: 'fixture-model', uuid: input.uuid, rawUserMessage: input.rawUserMessage })
  expect(prepared).not.toHaveProperty('credentials')
  expect(prepared.context?.trigger.id).toBe(`message:${session.id}:${input.uuid}`)
})

test('independent local Core rejects a missing/disabled channel without credential fallback', async () => {
  const core = {
    async getSessionDetail() { return { session, active: false } },
    async listChannels() { return [] },
  }
  await expect(prepareIndependentCoreMessage(input, core, () => {})).rejects.toThrow('AGENT_CHANNEL_NOT_FOUND')
  await expect(prepareIndependentCoreMessage(input, {
    ...core, async listChannels() { return [{ ...channel, enabled: false }] },
  }, () => {})).rejects.toThrow('AGENT_CHANNEL_DISABLED')
})

test('independent local Core refuses a target changed while catalog is loading', async () => {
  let current = true
  await expect(prepareIndependentCoreMessage(input, {
    async getSessionDetail() { return { session, active: false } },
    async listChannels() { current = false; return [channel] },
  }, () => { if (!current) throw new Error('target changed') })).rejects.toThrow('target changed')
})
