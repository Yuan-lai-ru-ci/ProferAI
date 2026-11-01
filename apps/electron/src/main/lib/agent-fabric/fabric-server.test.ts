/**
 * Loopback HTTP/SSE 传输端到端测试
 * 验收点（Phase 1）：外部本地客户端可以提交自然语言任务、订阅事件、
 * 查询结构化结果与产物引用；断线重连（同 requestId / SSE 游标）不重复执行。
 * 全程使用假执行器与临时目录，不启动真实 Agent。
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentFabricGateway,
  AgentNodeStatus,
  ALL_CAPABILITIES,
  createInMemoryRegistry,
  type TaskExecutor,
  type TaskExecution,
} from '@profer/agent-fabric'
import { pairClient, authenticateToken, revokeClient } from './fabric-pairing'
import { createFileEventLog, createFileTaskStore } from './fabric-store'
import { startFabricServer, type FabricServerHandle } from './fabric-server'

class FakeExecutor implements TaskExecutor {
  readonly started: TaskExecution[] = []
  readonly cancelled: string[] = []
  /** 启动后延迟自动完成（模拟异步执行）。 */
  autoCompleteMs: number | null = null

  start(execution: TaskExecution): void {
    this.started.push(execution)
    if (this.autoCompleteMs !== null) {
      setTimeout(() => {
        execution.reporter.progress({ message: 'running' })
        execution.reporter.artifactCreated({
          artifactId: `artifact-${execution.task.request.taskId}`,
          taskId: execution.task.request.taskId,
          kind: 'log',
          createdAt: Date.now(),
          label: '测试日志',
        })
        execution.reporter.complete({
          status: 'completed',
          summary: '任务完成：smoke test 通过',
          changedFiles: [],
          testResults: [{ command: 'bun test', exitCode: 0, passed: 3, failed: 0 }],
          artifacts: [],
          evidence: [{ type: 'log', ref: `artifact-${execution.task.request.taskId}` }],
          blockers: [],
          nextActions: [],
        })
      }, this.autoCompleteMs)
    }
  }
  cancel(taskId: string): void {
    this.cancelled.push(taskId)
  }
}

let tempDir: string
let pairingPath: string
let server: FabricServerHandle | null = null
let executor: FakeExecutor
let baseUrl: string
let token: string

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function makeEnvelope(requestId: string, overrides: Record<string, unknown> = {}): unknown {
  const taskId = `task_${requestId}`
  return {
    protocolVersion: '1.0',
    requestId,
    actor: { agentId: 'spoofed-attacker' }, // 服务端必须用认证身份覆盖
    payload: {
      taskId,
      rootTaskId: taskId,
      requesterAgentId: 'spoofed-attacker',
      orchestratorAgentId: 'profer-stable',
      targetAgentId: 'profer-stable',
      objective: '运行 smoke test 并返回结果',
      workspaceId: 'ws-test',
      constraints: [],
      dependsOn: [],
      policy: {
        approvalMode: 'auto_deny',
        allowDelegation: false,
        maxDelegationDepth: 0,
        maxChildren: 0,
        timeoutSeconds: 600,
        workspaceMode: 'read-shared',
        retryClass: 'safe-to-retry',
      },
      submittedAt: Date.now(),
      ...overrides,
    },
  }
}

async function readSseUntilTerminal(taskId: string, after = 0): Promise<Array<{ sequence: number; type: string }>> {
  const res = await fetch(`${baseUrl}/v1/tasks/${taskId}/events?after=${after}`, { headers: authHeaders() })
  expect(res.status).toBe(200)
  const text = await res.text()
  const events: Array<{ sequence: number; type: string }> = []
  for (const frame of text.split('\n\n')) {
    const idLine = frame.split('\n').find((l) => l.startsWith('id: '))
    const typeLine = frame.split('\n').find((l) => l.startsWith('event: '))
    if (idLine && typeLine) {
      events.push({ sequence: Number(idLine.slice(4)), type: typeLine.slice(7) })
    }
  }
  return events
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'fabric-server-'))
  pairingPath = join(tempDir, 'clients.json')

  executor = new FakeExecutor()
  const registry = createInMemoryRegistry()
  registry.register({
    agentId: 'profer-stable',
    instanceId: 'inst_test',
    displayName: 'Profer 稳定版',
    version: '0.0.0-test',
    status: AgentNodeStatus.ONLINE,
    endpoint: { transport: 'local-http', address: '127.0.0.1:0' },
    capabilities: [...ALL_CAPABILITIES],
    workspaceBindings: [],
    maxConcurrency: 1,
    policy: { allowDelegation: true, maxDelegationDepth: 2 },
    registeredAt: 0,
    lastHeartbeatAt: 0,
  })
  const gateway = new AgentFabricGateway({
    registry,
    store: createFileTaskStore(tempDir),
    eventLog: createFileEventLog(tempDir),
    resolveExecutor: () => executor,
  })

  const paired = pairClient('hermes-test', undefined, pairingPath)
  token = paired.token

  server = await startFabricServer({
    gateway,
    authenticate: (candidate) => authenticateToken(candidate, pairingPath),
    host: '127.0.0.1',
    port: 0,
  })
  baseUrl = `http://${server.address}`
})

afterEach(async () => {
  await server?.close()
  server = null
  rmSync(tempDir, { recursive: true, force: true })
})

describe('认证与发现', () => {
  it('健康检查免认证', async () => {
    const res = await fetch(`${baseUrl}/v1/health`)
    expect(res.status).toBe(200)
  })

  it('未配对请求被拒绝（403 CALLER_NOT_PAIRED）', async () => {
    const res = await fetch(`${baseUrl}/v1/agents`)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('CALLER_NOT_PAIRED')
  })

  it('错误 token 被拒绝', async () => {
    const res = await fetch(`${baseUrl}/v1/agents`, { headers: { authorization: 'Bearer wrong' } })
    expect(res.status).toBe(403)
  })

  it('撤销配对后立即拒绝', async () => {
    const { listPairedClients } = await import('./fabric-pairing')
    const clientId = listPairedClients(pairingPath)[0]!.clientId
    expect(revokeClient(clientId, pairingPath)).toBe(true)
    const res = await fetch(`${baseUrl}/v1/agents`, { headers: authHeaders() })
    expect(res.status).toBe(403)
  })

  it('配对客户端可以发现节点', async () => {
    const res = await fetch(`${baseUrl}/v1/agents`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.payload.agents[0].agentId).toBe('profer-stable')
  })
})

describe('任务生命周期（Phase 1 验收主路径）', () => {
  it('提交 → SSE 进度 → 结构化结果 + 产物引用；actor 伪造被覆盖', async () => {
    executor.autoCompleteMs = 50

    const submitRes = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeEnvelope('req_e2e')),
    })
    expect(submitRes.status).toBe(201)
    const submitBody = await submitRes.json()
    const task = submitBody.payload.task
    expect(task.status).toBe('running')
    // actor 与 requester 都以认证身份为准，payload 伪造不生效。
    expect(executor.started[0]!.task.request.requesterAgentId).toBe('hermes-test')
    expect(executor.started[0]!.task.request.origin?.actor).toEqual({ type: 'external', id: 'hermes-test' })

    // SSE：从 0 订阅，收全生命周期事件直到终态
    const events = await readSseUntilTerminal(task.request.taskId)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('task.created')
    expect(types).toContain('task.started')
    expect(types).toContain('task.progress')
    expect(types).toContain('task.artifact_created')
    expect(types[types.length - 1]).toBe('task.completed')
    // 序列单调
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBe(events[i - 1]!.sequence + 1)
    }

    // 结构化结果
    const resultRes = await fetch(`${baseUrl}/v1/tasks/${task.request.taskId}/result`, { headers: authHeaders() })
    expect(resultRes.status).toBe(200)
    const resultBody = await resultRes.json()
    expect(resultBody.payload.result.summary).toContain('smoke test')
    expect(resultBody.payload.result.testResults[0].exitCode).toBe(0)

    // 产物引用
    const artifactsRes = await fetch(`${baseUrl}/v1/tasks/${task.request.taskId}/artifacts`, { headers: authHeaders() })
    const artifactsBody = await artifactsRes.json()
    expect(artifactsBody.payload.artifacts[0].artifactId).toBe(`artifact-${task.request.taskId}`)
  })

  it('同一 requestId 重发返回同一任务，不重复执行（断线重发安全）', async () => {
    executor.autoCompleteMs = 200
    const envelope = makeEnvelope('req_retry')

    const first = await fetch(`${baseUrl}/v1/tasks`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(envelope) })
    expect(first.status).toBe(201)
    const second = await fetch(`${baseUrl}/v1/tasks`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(envelope) })
    expect(second.status).toBe(200) // deduplicated
    const secondBody = await second.json()
    expect(secondBody.payload.deduplicated).toBe(true)

    const firstBody = await first.json()
    expect(secondBody.payload.task.request.taskId).toBe(firstBody.payload.task.request.taskId)
    expect(executor.started).toHaveLength(1)
  })

  it('SSE 断线后用 after 游标恢复，不丢事件', async () => {
    executor.autoCompleteMs = 30
    const submitRes = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(makeEnvelope('req_sse')),
    })
    const { task } = (await submitRes.json()).payload

    await readSseUntilTerminal(task.request.taskId)
    // 客户端“断线”后从中途游标恢复：after=2 应只返回之后的事件
    const replay = await readSseUntilTerminal(task.request.taskId, 2)
    expect(replay.length).toBeGreaterThan(0)
    expect(replay.every((e) => e.sequence > 2)).toBe(true)
    expect(replay[replay.length - 1]!.type).toBe('task.completed')
  })

  it('取消运行中的任务', async () => {
    // 不自动完成：任务停在 running
    const submitRes = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(makeEnvelope('req_cancel')),
    })
    const { task } = (await submitRes.json()).payload
    expect(task.status).toBe('running')

    const cancelRes = await fetch(`${baseUrl}/v1/tasks/${task.request.taskId}/cancel`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ requestId: 'req_cancel_op' }),
    })
    expect(cancelRes.status).toBe(200)
    const cancelBody = await cancelRes.json()
    expect(cancelBody.payload.task.status).toBe('cancelled')
    expect(executor.cancelled).toEqual([task.request.taskId])

    // 终态后重复取消 → 409
    const again = await fetch(`${baseUrl}/v1/tasks/${task.request.taskId}/cancel`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ requestId: 'req_cancel_op2' }),
    })
    expect(again.status).toBe(409)
  })

  it('查询不存在的任务返回 404', async () => {
    const res = await fetch(`${baseUrl}/v1/tasks/task_ghost`, { headers: authHeaders() })
    expect(res.status).toBe(404)
  })
})
