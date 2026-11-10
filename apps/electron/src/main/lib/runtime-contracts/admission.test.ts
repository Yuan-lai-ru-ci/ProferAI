import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntimeCoordinator, createAgentRunOwnershipRegistry } from '@profer/agent-runtime'
import type { AgentRunOutcome, AgentRuntimeAdapter, AgentRuntimeQuery, AgentRuntimeCallbacks } from '@profer/agent-runtime'
import type { AgentPreset, AgentSendInput } from '@profer/shared'

mock.module('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))
let shadowStarts = 0
mock.module('../workspace-shadow-turns', () => ({
  beginWorkspaceShadowTurn: () => { shadowStarts += 1; return undefined },
  endWorkspaceShadowTurn: () => undefined,
}))
const root = mkdtempSync(join(tmpdir(), 'profer-admission-contract-'))
const oldConfig = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = root
const { runRuntimeHeadlessEntry } = await import('../agent-runtime-entry')
const { getAgentRuntimeRunFacts } = await import('../agent-runtime-host')
const { agentRuntimePolicyRuns } = await import('../agent-runtime-policy-snapshot')
afterAll(() => {
  if (oldConfig === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = oldConfig
  rmSync(root, { recursive: true, force: true })
})

const preset: AgentPreset = {
  id: 'fixture', name: 'fixture', description: '', isBuiltin: false,
  createdAt: 0, updatedAt: 0, permissionMode: 'auto',
}

for (const runtime of ['claude', 'pi'] as const) {
  test('仅本轮最终答复交付，不依赖保存时序，也不读取上一轮历史', async () => {
    const sessionId = `result-handoff-${runtime}`
    let turn = 0
    let reads = 0
    const completions: import('@profer/shared').AgentMessage[][] = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { [runtime]: { runtime, query: async (_input: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks) => {
        if (turn++ === 0) {
          await callbacks.onMessage?.({ type: 'assistant', uuid: 'current-answer', message: { content: [{ type: 'text', text: 'CURRENT_RUN_RESULT' }] } } as never)
        }
        return { status: 'completed' }
      } } },
      ports: { queryPreparation: { prepare: async () => ({}) }, sessions: {
        getMeta: () => undefined, appendMessages() {}, enqueueMessages() {}, updateMeta: () => undefined,
      } },
    })
    const deps: Parameters<typeof runRuntimeHeadlessEntry>[2] = {
      execution: { ownership: coordinator.ownership, isRunning: id => coordinator.isRunning(id) },
      resolveRunContext: () => ({ runtime, cwd: root, toolAssemblyContext: {}, policy: { preset, presetReference: { presetId: preset.id, presetScope: 'user-global' } } }),
      run: (query, callbacks) => coordinator.run(query, callbacks),
      sessions: { getMeta: () => undefined, appendMessages() {}, updateMeta: () => undefined, getMessages: () => [] },
      messages: () => { reads += 1; return [{ id: 'old', role: 'assistant', content: 'PREVIOUS_RUN_RESULT', createdAt: 1 }] },
      emitPlanModeEvent() {}, onRunStarted() {}, applyCompletionUnread() {},
      sink: { onError() {}, onComplete(messages) { completions.push(messages ?? []) } },
    }
    const input = { sessionId, agentRuntime: runtime, channelId: 'fixture', userMessage: 'fixture' }
    await runRuntimeHeadlessEntry(input, { onEvent() {} }, deps)
    await runRuntimeHeadlessEntry(input, { onEvent() {} }, deps)
    expect(reads).toBe(0)
    expect(completions[0]?.map(message => message.content)).toEqual(['CURRENT_RUN_RESULT'])
    expect(completions[1]).toEqual([])
  })

  describe(`${runtime} entry admission contract`, () => {
    test('被拒绝请求不解析上下文、不建检查点、不覆盖或清理 owner 的策略事实', async () => {
      const sessionId = `admission-${runtime}`
      let resolveProvider!: (outcome: AgentRunOutcome) => void
      let signalStarted!: () => void
      const providerStarted = new Promise<void>(resolve => { signalStarted = resolve })
      const pending = new Promise<AgentRunOutcome>(resolve => { resolveProvider = resolve })
      const adapter: AgentRuntimeAdapter = {
        runtime,
        query: async () => { signalStarted(); return pending },
      }
      const ownership = createAgentRunOwnershipRegistry()
      const coordinator = new AgentRuntimeCoordinator({
        adapters: { [runtime]: adapter }, ownership,
        ports: {
          queryPreparation: { prepare: async () => ({}) },
          sessions: { getMeta: () => undefined, appendMessages() {}, updateMeta: () => undefined },
        },
      })
      let contexts = 0
      let checkpoints = 0
      let completions = 0
      const deps: Parameters<typeof runRuntimeHeadlessEntry>[2] = {
        execution: { ownership, isRunning: id => coordinator.isRunning(id) },
        resolveRunContext: () => {
          contexts += 1
          return { runtime, cwd: root, toolAssemblyContext: {}, policy: {
            preset, presetReference: { presetId: preset.id, presetScope: 'user-global' },
          } }
        },
        beginCheckpointTurn: () => { checkpoints += 1; return undefined },
        run: (query, callbacks) => coordinator.run(query, callbacks),
        sessions: { getMeta: () => undefined, appendMessages() {}, updateMeta: () => undefined, getMessages: () => [] },
        messages: () => [], emitPlanModeEvent() {}, onRunStarted() {}, applyCompletionUnread() {},
        sink: { onError() {}, onComplete() { completions += 1 } },
      }
      const input: AgentSendInput = { sessionId, agentRuntime: runtime, channelId: 'fixture', userMessage: 'owner', permissionModeOverride: 'bypassPermissions' }
      const owner = runRuntimeHeadlessEntry(input, { onEvent() {} }, deps)
      await providerStarted
      const activeFacts = getAgentRuntimeRunFacts(sessionId)
      const activePolicy = agentRuntimePolicyRuns.getForRun(sessionId)
      const beforeShadow = shadowStarts
      try {
        await expect(runRuntimeHeadlessEntry({ ...input, userMessage: 'rejected' }, { onEvent() {} }, deps)).rejects.toMatchObject({ name: 'AgentRunAlreadyActiveError' })
        expect(contexts).toBe(1)
        expect(checkpoints).toBe(1)
        expect(shadowStarts).toBe(beforeShadow)
        expect(getAgentRuntimeRunFacts(sessionId)).toBe(activeFacts)
        expect(agentRuntimePolicyRuns.getForRun(sessionId)).toBe(activePolicy)
        expect(completions).toBe(0)
      } finally { resolveProvider({ status: 'completed' }) }
      await expect(owner).resolves.toEqual({ status: 'completed' })
      expect(completions).toBe(1)
      expect(ownership.ownerCount()).toBe(0)
      expect(getAgentRuntimeRunFacts(sessionId)).toBeUndefined()
      expect(agentRuntimePolicyRuns.getForRun(sessionId)).toBeUndefined()
    })

    test('上下文解析失败也释放仅属于请求自身的执行权', async () => {
      const ownership = createAgentRunOwnershipRegistry()
      const sessionId = `admission-prepare-failed-${runtime}`
      const deps: Parameters<typeof runRuntimeHeadlessEntry>[2] = {
        execution: { ownership, isRunning: () => false },
        sessions: { getMeta: () => undefined, appendMessages() {}, updateMeta: () => undefined },
        resolveRunContext: () => { throw new Error('context unavailable') },
        run: () => { throw new Error('provider must not start') },
        messages: () => [], emitPlanModeEvent() {}, onRunStarted() {}, applyCompletionUnread() {},
        sink: { onError() {}, onComplete() {} },
      }
      await expect(runRuntimeHeadlessEntry({ sessionId, agentRuntime: runtime } as AgentSendInput, { onEvent() {} }, deps)).rejects.toThrow('context unavailable')
      expect(ownership.ownerCount()).toBe(0)
    })
  })
}
