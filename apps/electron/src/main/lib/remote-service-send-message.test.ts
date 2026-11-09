import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import * as actualAgentService from './agent-service'

/**
 * `send_message` 的 `uuid` / `startedAt` 透传（WS 命令级）。
 *
 * 缺口来源：`quality-report-server.md` §7.2 条目 3 —— 实施者自述这两项无测试。
 *
 * 验证方式：只替换 `agent-service` 的 `runAgentHeadless`（真跑会启动真实 run），
 * 其余导出保持真实；直调 `handleRemoteCommand` 并断言**真实传入的实参**。
 */
type CapturedRun = {
  input: Record<string, unknown>
  callbacks: Record<string, unknown>
}

const captured: CapturedRun[] = []

/** 宿主生成的 uuid 必须是合法 UUID（`randomUUID()`），而不是时间戳或空串。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

mock.module('./agent-service', () => ({
  ...actualAgentService,
  // 仅捕获实参，不启动真实 run（避免副作用与外部依赖）。
  runAgentHeadless: (input: Record<string, unknown>, callbacks: Record<string, unknown>) => {
    captured.push({ input, callbacks })
    return Promise.resolve()
  },
  // 默认已切新链：新入口也要捕获同一份实参，否则这里会启动真实 run。
  runAgentRuntimeHeadless: (input: Record<string, unknown>, callbacks: Record<string, unknown>) => {
    captured.push({ input, callbacks })
    return Promise.resolve()
  },
  // 新分支在起 run 之前做非破坏性执行权预检；fixture 里恒无阻塞。
  peekAgentRunClaimFailureForSession: () => undefined,
}))

let handleRemoteCommand: typeof import('./remote-service')['handleRemoteCommand']
let moduleReady: Promise<void>

beforeEach(async () => {
  captured.length = 0
  moduleReady ??= import('./remote-service').then((mod) => {
    handleRemoteCommand = mod.handleRemoteCommand
  })
  await moduleReady
})

interface SendMessageOverrides {
  startedAt?: unknown
  uuid?: unknown
  omitStartedAt?: boolean
  omitUuid?: boolean
}

async function sendMessage(overrides: SendMessageOverrides = {}) {
  const payload: Record<string, unknown> = {
    type: 'send_message',
    sessionId: 'session-under-test',
    userMessage: 'harness message',
    channelId: 'channel-under-test',
    modelId: 'model-under-test',
    workspaceId: 'workspace-under-test',
  }
  if (!overrides.omitStartedAt) payload.startedAt = overrides.startedAt
  if (!overrides.omitUuid) payload.uuid = overrides.uuid
  const result = await handleRemoteCommand(JSON.stringify(payload), 7)
  // runAgentHeadless 是同步调用点，microtask 后捕获必然已就绪。
  await Promise.resolve()
  return result
}

describe('send_message 的 uuid / startedAt 透传', () => {
  test('逐字透传客户端预生成的 uuid 与 startedAt 到 runAgentHeadless 实参', async () => {
    const result = await sendMessage({ startedAt: 1700000000000, uuid: 'pocket-uuid-abc-123' })

    expect(result).toEqual({ ok: true, data: { accepted: true } })
    expect(captured).toHaveLength(1)

    const { input, callbacks } = captured[0]!
    expect(input.startedAt).toBe(1700000000000)
    expect(input.uuid).toBe('pocket-uuid-abc-123')
    // 其余字段原样透传（防止透传改造时漏字段）
    expect(input).toMatchObject({
      sessionId: 'session-under-test',
      userMessage: 'harness message',
      channelId: 'channel-under-test',
      modelId: 'model-under-test',
      workspaceId: 'workspace-under-test',
    })
    expect(callbacks.source).toBe('bridge')
  })

  test('两者均缺省时回退：startedAt 取当前时间，uuid 由宿主生成', async () => {
    const before = Date.now()
    const result = await sendMessage({ omitStartedAt: true, omitUuid: true })
    const after = Date.now()

    expect(result).toEqual({ ok: true, data: { accepted: true } })
    expect(captured).toHaveLength(1)

    const { input } = captured[0]!
    expect(typeof input.startedAt).toBe('number')
    expect(input.startedAt as number).toBeGreaterThanOrEqual(before)
    expect(input.startedAt as number).toBeLessThanOrEqual(after)
    // 缺省时宿主生成 uuid：它同时是消息身份（乐观气泡去重）与归属记录关联 turn 的依据，
    // 缺失会让 rewindTurnId 退化成时间戳、Shadow Git 的 turn 无法与 JSONL 消息对齐。
    expect(typeof input.uuid).toBe('string')
    expect(input.uuid as string).toMatch(UUID_PATTERN)
  })

  test('类型不符 / 空串一律按缺省处理，不把非法值传入 run', async () => {
    const before = Date.now()
    const result = await sendMessage({ startedAt: '1700000000000', uuid: '' })
    const after = Date.now()

    expect(result).toEqual({ ok: true, data: { accepted: true } })
    expect(captured).toHaveLength(1)

    const { input } = captured[0]!
    expect(typeof input.startedAt).toBe('number')
    expect(input.startedAt as number).toBeGreaterThanOrEqual(before)
    expect(input.startedAt as number).toBeLessThanOrEqual(after)
    // 空串按缺省处理：宿主生成合法 uuid，非法值本身不得进入 run。
    expect(typeof input.uuid).toBe('string')
    expect(input.uuid as string).not.toBe('')
    expect(input.uuid as string).toMatch(UUID_PATTERN)
  })
})

describe('runtime coordinator remote 默认路由', () => {
  test('Given the default remote service When sending a message Then the runtime chain is the default and explicit 0 rolls back', async () => {
    const source = await Bun.file(join(import.meta.dir, 'remote-service.ts')).text()
    expect(source).toContain("process.env.PROFER_RUNTIME_REMOTE !== '0'")
    expect(source).toContain('runAgentRuntimeHeadless(')
    expect(source).toContain('runAgentHeadless(headlessInput, {')
    expect(source).toContain("initiator: 'user'")
    // 2026-10-16 集成会话：remote 新分支改为共享入口接线，query 构造移入 agent-runtime-entry；
    // 入口在副作用之前先做非破坏性执行权预检（被拒绝时同步返回 ok:false）。
    expect(source).toContain('peekAgentRunClaimFailureForSession(')
  })
})
