import { beforeEach, describe, expect, mock, test } from 'bun:test'
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

mock.module('./agent-service', () => ({
  ...actualAgentService,
  // 仅捕获实参，不启动真实 run（避免副作用与外部依赖）。
  runAgentHeadless: (input: Record<string, unknown>, callbacks: Record<string, unknown>) => {
    captured.push({ input, callbacks })
    return Promise.resolve()
  },
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

  test('两者均缺省时回退：startedAt 取当前时间，uuid 不作为键出现', async () => {
    const before = Date.now()
    const result = await sendMessage({ omitStartedAt: true, omitUuid: true })
    const after = Date.now()

    expect(result).toEqual({ ok: true, data: { accepted: true } })
    expect(captured).toHaveLength(1)

    const { input } = captured[0]!
    expect(typeof input.startedAt).toBe('number')
    expect(input.startedAt as number).toBeGreaterThanOrEqual(before)
    expect(input.startedAt as number).toBeLessThanOrEqual(after)
    // 实现为 { ...(uuid ? { uuid } : {}) }：缺省时不应出现该键
    expect(Object.prototype.hasOwnProperty.call(input, 'uuid')).toBe(false)
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
    expect(Object.prototype.hasOwnProperty.call(input, 'uuid')).toBe(false)
  })
})
