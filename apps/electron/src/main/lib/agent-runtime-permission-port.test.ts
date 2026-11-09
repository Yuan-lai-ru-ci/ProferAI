import { afterEach, describe, expect, test } from 'bun:test'
import type { AskUserRequest, ExitPlanModeRequest, PermissionRequest } from '@profer/shared'
import { createAgentQueryPreparationPort } from '@profer/agent-runtime'
import { createElectronPermissionPort } from './agent-runtime-permission-port'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'

const sessionId = 'permission-port-lifecycle'
const otherSessionId = 'permission-port-other'
afterEach(() => {
  for (const id of [sessionId, otherSessionId]) {
    permissionService.clearSessionPending(id)
    permissionService.clearSessionWhitelist(id)
    askUserService.clearSessionPending(id)
    exitPlanService.clearSessionPending(id)
  }
})

describe('无人值守语义（bypassPermissions）', () => {
  test('Given bypass 会话 When 写类工具请求权限 Then 直接放行且不产生审批请求', async () => {
    const requests: PermissionRequest[] = []
    const port = createElectronPermissionPort({ isBypassPermissions: id => id === sessionId })
    const canUseTool = port.createCanUseTool!({ sessionId, sendPermissionRequest: request => requests.push(request) })
    const signal = new AbortController().signal
    const result = await canUseTool('Write', { file_path: '/unsafe/file', content: 'fixture' }, { signal, toolUseID: 'tool-1' })
    expect(result).toMatchObject({ behavior: 'allow', toolUseID: 'tool-1' })
    // 关键：不能落审批请求，否则无界面入口会永久等待。
    expect(requests).toHaveLength(0)
    expect(permissionService.getPendingRequests()).toHaveLength(0)
  })

  test('非 bypass 会话仍走真实审批', async () => {
    const requests: PermissionRequest[] = []
    const port = createElectronPermissionPort({ isBypassPermissions: () => false })
    const canUseTool = port.createCanUseTool!({ sessionId, sendPermissionRequest: request => requests.push(request) })
    void canUseTool('Write', { file_path: '/unsafe/file', content: 'fixture' }, { signal: new AbortController().signal })
    expect(requests).toHaveLength(1)
  })
})

describe('Electron runtime permission lifecycle', () => {
  test('Given outstanding approvals and questions When a turn ends Then only that session permission and plan requests are denied', async () => {
    const port = createElectronPermissionPort()
    const signal = new AbortController().signal
    const permissions: PermissionRequest[] = []
    const canUseTool = port.createCanUseTool!({ sessionId, sendPermissionRequest: (request) => permissions.push(request) })
    const permission = canUseTool('Write', { file_path: '/safe/file', content: 'fixture' }, { signal })
    const plans: ExitPlanModeRequest[] = []
    const plan = port.handleExitPlanMode!({ sessionId, toolInput: { plan: 'fixture' }, signal, sendToRenderer: (request) => plans.push(request) })
    const questions: AskUserRequest[] = []
    const question = port.handleAskUserQuestion!({ sessionId, toolInput: { questions: [{ question: '选择方案' }] }, signal, sendToRenderer: (request) => questions.push(request) })
    const otherPermissions: PermissionRequest[] = []
    const otherPermission = port.createCanUseTool!({ sessionId: otherSessionId, sendPermissionRequest: (request) => otherPermissions.push(request) })('Write', {}, { signal })
    expect(permissions).toHaveLength(1)
    expect(plans).toHaveLength(1)
    port.clearSessionPending!(sessionId)
    await expect(permission).resolves.toMatchObject({ behavior: 'deny', message: '会话已结束' })
    await expect(plan).resolves.toMatchObject({ behavior: 'deny', message: '会话已结束' })
    expect(askUserService.getPendingRequests()).toContainEqual(questions[0]!)
    expect(permissionService.getPendingRequests()).toContainEqual(otherPermissions[0]!)
    await askUserService.respondToAskUser(questions[0]!.requestId, { '选择方案': 'A' })
    await expect(question).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { '选择方案': 'A' } } })
    permissionService.respondToPermission(otherPermissions[0]!.requestId, 'deny', false)
    await expect(otherPermission).resolves.toMatchObject({ behavior: 'deny' })
  })

  test('Given a session always-allow decision When a turn ends Then it survives until explicitly cleared', async () => {
    const port = createElectronPermissionPort()
    const requests: PermissionRequest[] = []
    const signal = new AbortController().signal
    const canUseTool = port.createCanUseTool!({ sessionId, sendPermissionRequest: (request) => requests.push(request) })
    const first = canUseTool('Write', { file_path: '/safe/a' }, { signal })
    permissionService.respondToPermission(requests[0]!.requestId, 'allow', true)
    await expect(first).resolves.toMatchObject({ behavior: 'allow' })
    port.clearSessionPending!(sessionId)
    await expect(canUseTool('Write', { file_path: '/safe/b' }, { signal })).resolves.toMatchObject({ behavior: 'allow' })
    expect(requests).toHaveLength(1)
    port.clearSessionWhitelist!(sessionId)
    const next = canUseTool('Write', { file_path: '/safe/c' }, { signal })
    expect(requests).toHaveLength(2)
    permissionService.respondToPermission(requests[1]!.requestId, 'deny', false)
    await expect(next).resolves.toMatchObject({ behavior: 'deny' })
  })

  test('Given runtime preparation When real approvals and AskUser complete Then EventPort dispatch reaches the original pending services', async () => {
    const events: Array<PermissionRequest | AskUserRequest> = []
    const prepare = createAgentQueryPreparationPort({
      permissions: createElectronPermissionPort(),
      events: { emit: (_id, payload) => {
        if (payload.kind === 'profer_event' && (payload.event.type === 'permission_request' || payload.event.type === 'ask_user_request')) events.push(payload.event.request)
      } },
    })
    const signal = new AbortController().signal
    const prepared = await prepare.prepare({ sessionId, runtime: 'pi', prompt: 'fixture' }, signal)
    const approval = prepared.canUseTool!('Write', { file_path: '/safe/fixture' }, { signal, toolUseID: 'prepared-call' })
    expect(events).toHaveLength(1)
    expect(permissionService.respondToPermission(events[0]!.requestId, 'allow', false)).toBe(sessionId)
    await expect(approval).resolves.toMatchObject({ behavior: 'allow', toolUseID: 'prepared-call', decisionClassification: 'user_temporary' })
    const answer = prepared.canUseTool!('AskUserQuestion', { questions: [{ question: '继续？' }], metadata: 'keep' }, { signal })
    expect(events).toHaveLength(2)
    await askUserService.respondToAskUser(events[1]!.requestId, { '继续？': '继续' })
    await expect(answer).resolves.toMatchObject({ behavior: 'allow', updatedInput: { metadata: 'keep', answers: { '继续？': '继续' } } })
  })

  test('Given an AskUser bridge callback When auto permissions intercept AskUserQuestion Then answers reach the original tool input', async () => {
    const port = createElectronPermissionPort()
    const requests: AskUserRequest[] = []
    const signal = new AbortController().signal
    const canUseTool = port.createCanUseTool!({
      sessionId,
      sendPermissionRequest() { throw new Error('AskUser 不应变成通用审批') },
      sendAskUserRequest: (request) => requests.push(request),
      handleAskUser: (id, input, abortSignal, send) => port.handleAskUserQuestion!({ sessionId: id, toolInput: input, signal: abortSignal, sendToRenderer: send }),
    })
    const answer = canUseTool('AskUserQuestion', { questions: [{ question: '继续？' }], metadata: 'keep' }, { signal })
    await askUserService.respondToAskUser(requests[0]!.requestId, { '继续？': '继续' })
    await expect(answer).resolves.toMatchObject({ behavior: 'allow', updatedInput: { metadata: 'keep', answers: { '继续？': '继续' } } })
  })
})
