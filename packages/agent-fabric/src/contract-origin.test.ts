import { describe, expect, test } from 'bun:test'
import {
  AgentFabricGateway, AgentNodeStatus, ALL_CAPABILITIES, ApprovalMode, RetryClass,
  TaskStatus, TrustLevel, WorkspaceMode, buildSubmitEnvelope, createInMemoryRegistry,
  createInMemoryTaskStore, createTaskView, deriveTaskState, validateTaskRequest,
  type AgentTask, type MessageProvenance, type TaskExecution, type TaskRequest, type TaskResult,
} from './index'

function request(): TaskRequest {
  return {
    taskId: 'task', rootTaskId: 'task', requesterAgentId: 'untrusted-payload',
    orchestratorAgentId: 'orchestrator', targetAgentId: 'executor', objective: '执行目标',
    workspaceId: 'workspace', constraints: ['只读'], dependsOn: [], submittedAt: 10,
    policy: {
      approvalMode: ApprovalMode.AUTO_DENY, allowDelegation: false, maxDelegationDepth: 0,
      maxChildren: 0, timeoutSeconds: 60, workspaceMode: WorkspaceMode.READ_SHARED,
      retryClass: RetryClass.SAFE_TO_RETRY,
    },
  }
}

function task(status: AgentTask['status']): AgentTask {
  return { request: request(), status, createdAt: 10, updatedAt: 20, failureReason: '保留旧原因' }
}

function gateway(executions: TaskExecution[] = [], store = createInMemoryTaskStore(), onCancel?: () => void) {
  const registry = createInMemoryRegistry()
  registry.register({
    agentId: 'executor', instanceId: 'instance', displayName: 'Executor', version: '1',
    status: AgentNodeStatus.ONLINE, endpoint: { transport: 'local-http', address: '127.0.0.1:1' },
    capabilities: [...ALL_CAPABILITIES], workspaceBindings: ['workspace'], maxConcurrency: 1,
    policy: { allowDelegation: true, maxDelegationDepth: 2 }, registeredAt: 0, lastHeartbeatAt: 0,
  })
  return new AgentFabricGateway({ registry, store, resolveExecutor: () => ({ start(execution) { executions.push(execution) }, cancel() { onCancel?.() } }) })
}

const caller = { agentId: 'authenticated-client', trust: TrustLevel.PAIRED_LOCAL_AGENT, grants: [...ALL_CAPABILITIES] }

describe('来源契约与旧任务轻量投影', () => {
  test('来源、授权和消息 provenance 可以序列化，普通消息无需 Task', () => {
    const req: TaskRequest = {
      ...request(), schemaVersion: 1,
      origin: { actor: { type: 'agent', id: 'author' }, source: { type: 'run', id: 'parent-run' } },
      authorization: { kind: 'inherited', sourceRef: { type: 'task', id: 'parent-task' } },
    }
    const provenance: MessageProvenance = {
      schemaVersion: 1, messageId: 'message', author: { type: 'unknown' }, runId: 'run',
      triggerId: 'trigger', source: { type: 'session', id: 'session' },
    }
    expect(JSON.parse(JSON.stringify({ req, provenance }))).toEqual({ req, provenance })
    expect(() => validateTaskRequest(req)).not.toThrow()
  })

  test('旧任务没有新字段仍可读取，失败与过期的目标保持开放且不丢原因', () => {
    for (const status of Object.values(TaskStatus)) {
      const legacy = task(status)
      const expected = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'open'
      expect(deriveTaskState(legacy)).toBe(expected)
      const view = createTaskView(legacy)
      expect(view).toMatchObject({ id: 'task', objective: '执行目标', state: expected, createdAt: 10, updatedAt: 20 })
      expect(view.origin).toEqual({ actor: { type: 'unknown' } })
      expect(legacy.status).toBe(status)
      expect(legacy.failureReason).toBe('保留旧原因')
    }
    expect(() => validateTaskRequest(request())).not.toThrow()
    expect(() => validateTaskRequest({ ...request(), schemaVersion: 2 as 1 })).toThrow('不支持的任务来源版本')
  })

  test('新来源与运行引用通过只读视图投影，不建立第二份可写任务', () => {
    const original: AgentTask = {
      ...task('failed'), runIds: ['run-1', 'run-2'],
      request: { ...request(), parentTaskId: 'parent', origin: { actor: { type: 'user' } }, authorization: { kind: 'direct' } },
    }
    expect(createTaskView(original)).toEqual({
      id: 'task', objective: '执行目标', origin: { actor: { type: 'user' } }, authorization: { kind: 'direct' },
      parentTaskId: 'parent', workspaceRef: 'workspace', state: 'open', createdAt: 10, updatedAt: 20,
      runIds: ['run-1', 'run-2'],
    })
  })
})

describe('Gateway 只接受认证上下文中的身份', () => {
  test('旧请求和伪造 user/confirmed 均按调用方规范化，原策略不变', () => {
    const req: TaskRequest = { ...request(), origin: { actor: { type: 'user' } }, authorization: { kind: 'confirmed' } }
    const submitted = gateway().submitTask(buildSubmitEnvelope({ agentId: caller.agentId }, 'req', req), caller).task.request
    expect(submitted.requesterAgentId).toBe(caller.agentId)
    expect(submitted.origin).toEqual({ actor: { type: 'external', id: caller.agentId }, source: { type: 'request', id: 'req' } })
    expect(submitted.authorization).toEqual({ kind: 'external', sourceRef: { type: 'request', id: 'req' } })
    expect(submitted.policy).toEqual(req.policy)
    expect(submitted.constraints).toEqual(req.constraints)
    expect(submitted.dependsOn).toEqual(req.dependsOn)
    expect(req.requesterAgentId).toBe('untrusted-payload')
    expect(req.origin?.actor.type).toBe('user')
  })

  test('envelope actor 不匹配认证身份时拒绝，包括重复请求', () => {
    const gw = gateway()
    gw.submitTask(buildSubmitEnvelope({ agentId: caller.agentId }, 'req', request()), caller)
    expect(() => gw.submitTask(buildSubmitEnvelope({ agentId: 'spoofed' }, 'req', request()), caller)).toThrow()
    expect(() => gw.submitTask(buildSubmitEnvelope({ agentId: 'spoofed' }, 'another', request()), caller)).toThrow()
  })

  test('不同认证调用方不能利用 requestId 读取他人幂等结果', () => {
    const gw = gateway()
    gw.submitTask(buildSubmitEnvelope({ agentId: caller.agentId }, 'req', request()), caller)
    const secondCaller = { ...caller, agentId: 'other-client' }
    expect(() => gw.submitTask(buildSubmitEnvelope({ agentId: secondCaller.agentId }, 'req', request()), secondCaller)).toThrow()
  })
})


const completedResult: TaskResult = {
  status: 'completed', summary: '完成', changedFiles: [], testResults: [], artifacts: [], evidence: [], blockers: [], nextActions: [],
}

describe('Gateway 真实 Run 关联', () => {
  test('可信 executor 回调写入同一 Task 的 runIds，重复报告幂等且事件可恢复', () => {
    const executions: TaskExecution[] = []
    const store = createInMemoryTaskStore()
    const gw = gateway(executions, store)
    const req = request()
    gw.submitTask(buildSubmitEnvelope({ agentId: caller.agentId }, 'run-ref-request', req), caller)
    const reporter = executions[0]!.reporter
    expect(reporter.runAdmitted).toBeFunction()
    reporter.runAdmitted!({ runId: 'run-1', sessionId: 'session-1', triggerId: 'fabric:task' })
    reporter.runAdmitted!({ runId: 'run-1', sessionId: 'session-1', triggerId: 'fabric:task' })
    reporter.runAdmitted!({ runId: 'run-2', sessionId: 'session-1', triggerId: 'fabric:task:continue' })
    const linked = store.get('task')!
    expect(linked.runIds).toEqual(['run-1', 'run-2'])
    expect(linked.status).toBe('running')
    expect(linked.request.policy).toEqual(req.policy)
    expect(linked.request.constraints).toEqual(req.constraints)
    const events = gw.resumeEvents('task', 0).filter(event => event.payload.kind === 'run_admitted')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'task.progress', payload: { kind: 'run_admitted', runId: 'run-1', sessionId: 'session-1', triggerId: 'fabric:task' } })
    reporter.complete(completedResult)
    expect(store.get('task')?.runIds).toEqual(['run-1', 'run-2'])
    expect(store.get('task')?.status).toBe('completed')
  })

  test('封存 Task 忽略迟到关联、完成、失败，不能复活或覆盖权威状态', () => {
    for (const terminal of ['cancelled', 'expired', 'completed', 'failed'] as const) {
      const executions: TaskExecution[] = []
      const store = createInMemoryTaskStore()
      const gw = gateway(executions, store)
      gw.submitTask(buildSubmitEnvelope({ agentId: caller.agentId }, `terminal-${terminal}`, request()), caller)
      const reporter = executions[0]!.reporter
      reporter.runAdmitted!({ runId: 'run-before' })
      if (terminal === 'cancelled') gw.cancelTask(caller, 'task')
      else if (terminal === 'expired') gw.expireOrphanedTasks('executor', '重启恢复')
      else if (terminal === 'completed') reporter.complete(completedResult)
      else reporter.fail('实际失败')
      const snapshot = structuredClone(store.get('task'))
      const events = gw.resumeEvents('task', 0)
      expect(() => {
        reporter.runAdmitted!({ runId: 'late-run' })
        reporter.complete({ ...completedResult, summary: '迟到完成' })
        reporter.fail('迟到失败')
      }).not.toThrow()
      expect(store.get('task')).toEqual(snapshot)
      expect(gw.resumeEvents('task', 0)).toEqual(events)
      expect(store.getResult('task')?.summary).not.toBe('迟到完成')
    }
  })

  test('取消先封存权威 Task，再允许 executor 同步完成回调', () => {
    const executions: TaskExecution[] = []
    const store = createInMemoryTaskStore()
    const gw = gateway(executions, store, () => {
      executions[0]!.reporter.runAdmitted!({ runId: 'late-during-cancel' })
      executions[0]!.reporter.complete(completedResult)
    })
    gw.submitTask(buildSubmitEnvelope({ agentId: caller.agentId }, 'cancel-sync', request()), caller)
    executions[0]!.reporter.runAdmitted!({ runId: 'admitted-before-cancel' })
    gw.cancelTask(caller, 'task')
    expect(store.get('task')?.runIds).toEqual(['admitted-before-cancel'])
    expect(store.get('task')?.status).toBe('cancelled')
    expect(store.getResult('task')).toBeUndefined()
    expect(gw.resumeEvents('task', 0).some(event => event.type === 'task.completed')).toBe(false)
  })

  test('空运行引用不能进入任务记录', () => {
    const executions: TaskExecution[] = []
    const store = createInMemoryTaskStore()
    const gw = gateway(executions, store)
    gw.submitTask(buildSubmitEnvelope({ agentId: caller.agentId }, 'empty-run', request()), caller)
    executions[0]!.reporter.runAdmitted!({ runId: ' ' })
    expect(store.get('task')?.runIds).toBeUndefined()
  })
})
