import { expect, test } from 'bun:test'
import { AgentAskUserService } from './ask-user-service'

test('问答先登记再通知，支持同步回答且保留原输入', async () => {
  const service = new AgentAskUserService()
  const input = { questions: [{ question: '选择？', options: [{ label: 'A' }] }], metadata: { fixture: true } }
  const pending = service.handleAskUserQuestion('s', input, new AbortController().signal, request => {
    void service.respondToAskUser(request.requestId, { '选择？': 'A' })
  })
  await expect(pending).resolves.toMatchObject({ behavior: 'allow', updatedInput: { ...input, answers: { '选择？': 'A' } } })
  expect(service.getPendingRequests()).toEqual([])
})

test('Core问答必须匹配session/run，重复回答无效', async () => {
  const service = new AgentAskUserService()
  const lifecycle: string[] = []
  const pending = service.handleAskUserQuestion('s', { questions: [] }, new AbortController().signal, () => {}, {
    runId: 'run-1', lifecycle: { wait: id => lifecycle.push(`wait:${id}`), resume: id => lifecycle.push(`resume:${id}`) },
  })
  const request = service.getPendingRequests()[0]!
  expect(await service.respondToAskUser(request.requestId, {}, { sessionId: 'other', runId: 'run-1' })).toBeNull()
  expect(await service.respondToAskUser(request.requestId, {}, { sessionId: 's', runId: 'run-2' })).toBeNull()
  expect(await service.respondToAskUser(request.requestId, {})).toBeNull()
  expect(await service.respondToAskUser(request.requestId, {}, { sessionId: 's', runId: 'run-1' })).toBe('s')
  await expect(pending).resolves.toMatchObject({ behavior: 'allow' })
  expect(await service.respondToAskUser(request.requestId, {}, { sessionId: 's', runId: 'run-1' })).toBeNull()
  expect(lifecycle).toEqual([`wait:${request.requestId}`, `resume:${request.requestId}`])
})

test('取消、通知异常与恢复记账异常均拒绝，不遗留pending', async () => {
  const service = new AgentAskUserService()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(service.handleAskUserQuestion('s', {}, cancelled.signal, () => {})).resolves.toMatchObject({ behavior: 'deny' })
  await expect(service.handleAskUserQuestion('s', {}, new AbortController().signal, () => { throw new Error('offline') })).resolves.toMatchObject({ behavior: 'deny' })
  const pending = service.handleAskUserQuestion('s', {}, new AbortController().signal, () => {}, { lifecycle: { wait() {}, resume() { throw new Error('disk') } } })
  const request = service.getPendingRequests()[0]!
  await service.respondToAskUser(request.requestId, {})
  await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
  expect(service.getPendingRequests()).toEqual([])
})

test('按原Run清理问答不会清掉其他Run，快照修改不影响原请求', async () => {
  const service = new AgentAskUserService()
  const first = service.handleAskUserQuestion('s', { questions: [null, { question: 'Q', options: [null, { label: 'A' }] }] }, new AbortController().signal, () => {}, { runId: 'first' })
  const second = service.handleAskUserQuestion('s', {}, new AbortController().signal, () => {}, { runId: 'second' })
  const snapshot = service.getPendingRequests()
  expect(snapshot[0]!.questions[0]!.options).toEqual([{ label: 'A', description: undefined, preview: undefined }])
  snapshot[0]!.sessionId = 'changed'
  service.clearSessionPending('s', 'first')
  await expect(first).resolves.toMatchObject({ behavior: 'deny' })
  expect(service.getPendingRequests()).toHaveLength(1)
  service.clearSessionPending('s', 'second')
  await expect(second).resolves.toMatchObject({ behavior: 'deny' })
})
