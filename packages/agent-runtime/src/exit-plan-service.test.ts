import { expect, test } from 'bun:test'
import { AgentExitPlanService } from './exit-plan-service'

test.each([
  ['approve_auto', 'allow', 'bypassPermissions'], ['approve_edit', 'allow', 'auto'], ['deny', 'deny', undefined], ['feedback', 'deny', undefined],
] as const)('计划审批%s 保留既有动作映射与原Run绑定', async (action, behavior, targetMode) => {
  const service = new AgentExitPlanService()
  const lifecycle: string[] = []
  const pending = service.handleExitPlanMode('s', { plan: 'fixture', allowedPrompts: [{ tool: 'Bash', prompt: 'test' }] }, new AbortController().signal, () => {}, {
    runId: 'run-1', lifecycle: { wait: id => lifecycle.push(`wait:${id}`), resume: id => lifecycle.push(`resume:${id}`) },
  })
  const request = service.getPendingRequests()[0]!
  expect(service.respondToExitPlanMode({ requestId: request.requestId, sessionId: 's', runId: 'wrong', action })).toBeNull()
  expect(service.respondToExitPlanMode({ requestId: request.requestId, sessionId: 'wrong', runId: 'run-1', action })).toBeNull()
  expect(service.respondToExitPlanMode({ requestId: request.requestId, action })).toBeNull()
  expect(service.respondToExitPlanMode({ requestId: request.requestId, sessionId: 's', runId: 'run-1', action, feedback: 'revise fixture' })).toMatchObject({ sessionId: 's', targetMode: targetMode ?? null })
  await expect(pending).resolves.toMatchObject({ behavior, ...(targetMode ? { targetMode } : {}) })
  expect(service.getPendingRequests()).toEqual([])
  expect(lifecycle).toEqual([`wait:${request.requestId}`, `resume:${request.requestId}`])
})

test('恢复记账失败时计划不能报告目标模式已批准', async () => {
  const service = new AgentExitPlanService()
  const pending = service.handleExitPlanMode('s', {}, new AbortController().signal, () => {}, {
    lifecycle: { wait() {}, resume() { throw new Error('disk failure') } },
  })
  const request = service.getPendingRequests()[0]!
  expect(service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_auto' })).toMatchObject({ sessionId: 's', targetMode: null })
  await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('恢复记账失败') })
})

test('计划请求先登记再通知；取消、通知失败均不遗留请求', async () => {
  const service = new AgentExitPlanService()
  const synchronous = service.handleExitPlanMode('s', {}, new AbortController().signal, request => {
    service.respondToExitPlanMode({ requestId: request.requestId, action: 'deny' })
  })
  await expect(synchronous).resolves.toMatchObject({ behavior: 'deny' })
  const controller = new AbortController()
  const pending = service.handleExitPlanMode('s', {}, controller.signal, () => {})
  controller.abort()
  await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
  await expect(service.handleExitPlanMode('s', {}, controller.signal, () => {})).resolves.toMatchObject({ behavior: 'deny' })
  await expect(service.handleExitPlanMode('s', {}, new AbortController().signal, () => { throw new Error('offline') })).resolves.toMatchObject({ behavior: 'deny' })
  expect(service.getPendingRequests()).toEqual([])
})
