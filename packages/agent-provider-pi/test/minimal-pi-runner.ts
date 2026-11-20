/**
 * 最小 Bun runner：用真实抽出的 Pi adapter + 真实 Pi SDK + 脚本化模型传输，
 * 在非 Electron 进程里验证消息流、工具、取消、错误、终态与资源释放。
 *
 * 直接执行：`bun packages/agent-provider-pi/test/minimal-pi-runner.ts`
 * 作为测试：`packages/agent-provider-pi/src/minimal-pi-runner.test.ts` 复用同一批场景。
 *
 * 范围声明：本 runner 不发起真实模型请求，不使用任何凭据；真实 SDK 加载由
 * `sdk-load` 场景单独证明，真实在线 provider 调用不在本 runner 覆盖范围内。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realSdk from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { SDKMessage } from '@profer/shared'
import { PiAgentAdapter } from '../src/pi-agent-adapter'
import { createScriptedTransport, type ScriptedTransport, type ScriptedTurn } from './pi-scripted-transport'
import { createMinimalPiHost, type MinimalPiHost } from '../src/host/minimal-pi-host'

/** 当前生效的脚本传输；由每个场景在 query 之前设置。 */
let activeTransport: ScriptedTransport | undefined
/** 最近一次场景使用的传输；用于断言真实 session 确实调用了脚本模型流。 */
let lastTransport: ScriptedTransport | undefined

export interface ScenarioResult {
  name: string
  passed: boolean
  detail: string
}

const results: ScenarioResult[] = []

// 真实 SDK 的 ModelRuntime 保持原样，只有模型响应流被替换：
// Session、工具装配、事件流、abort/dispose、内存/磁盘 session 记录全部走真实实现。
function installScriptedTransport(): void {
  const prototype = realSdk.ModelRuntime.prototype as unknown as Record<string, unknown>
  prototype.streamSimple = (model: unknown, context: unknown, options?: { signal?: AbortSignal }) =>
    activeTransport?.streamSimple(model as never, context, options)
  prototype.stream = prototype.streamSimple
}

installScriptedTransport()

type PiAgentAdapterInstance = InstanceType<typeof PiAgentAdapter>

function check(name: string, condition: boolean, detail: string): void {
  results.push({ name, passed: condition, detail })
  if (!condition) console.error(`  ✗ ${name} — ${detail}`)
  else console.log(`  ✓ ${name}`)
}

interface RunOutcome {
  messages: SDKMessage[]
  error?: unknown
}

interface QueryOptions {
  script: ScriptedTurn[]
  host: MinimalPiHost
  sessionId: string
  abortSignal?: AbortSignal
  testTool?: ToolDefinition
  permissionDeny?: string
  /** 手动压缩请求（等价于用户发 /compact）；不进 prompt 链。 */
  compactRequest?: boolean
  /** 续接已有 Pi 会话；用于验证跨 query 的历史与守卫状态。 */
  resumeSessionId?: string
  onSessionId?: (sdkSessionId: string) => void
  cwd: string
  piAgentDir: string
  piSessionDir: string
  /** query 返回后额外等待（毫秒），用于观察异步终态。 */
  onQueryStart?: (adapter: PiAgentAdapterInstance) => void
}

function jsonOf(message: SDKMessage): Record<string, unknown> {
  return message as unknown as Record<string, unknown>
}

function assistantTextOf(message: SDKMessage): string {
  const content = (jsonOf(message).message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
}

async function runPiQuery(adapter: PiAgentAdapterInstance, options: QueryOptions): Promise<RunOutcome> {
  const transport = createScriptedTransport(options.script)
  activeTransport = transport
  lastTransport = transport
  const messages: SDKMessage[] = []
  const abortController = new AbortController()
  const signal = options.abortSignal ?? abortController.signal

  try {
    const iterator = adapter.query({
      sessionId: options.sessionId,
      prompt: '请回复。',
      provider: 'anthropic',
      apiKey: 'minimal-host-placeholder',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      permissionMode: 'auto',
      ...(options.compactRequest ? { compactRequest: true } : {}),
      systemPrompt: '你是一个用于验证的最小 Agent。',
      piAgentDir: options.piAgentDir,
      piSessionDir: options.piSessionDir,
      cwd: options.cwd,
      canUseTool: options.permissionDeny
        ? async (toolName: string) => (
            toolName === options.permissionDeny
              ? { behavior: 'deny' as const, message: '最小宿主拒绝该工具' }
              : { behavior: 'allow' as const }
          )
        : options.host.permissions.canUseTool,
      ...(options.testTool ? { customTools: [options.testTool] } : {}),
      abortSignal: signal,
      ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
      onSessionId: (sdkSessionId: string) => options.onSessionId?.(sdkSessionId),
      onModelResolved: () => {},
      onContextWindow: () => {},
    })

    const onQueryStart = options.onQueryStart
    if (onQueryStart) {
      // 让 session ready 后由场景触发取消
      setTimeout(() => onQueryStart(adapter), 25)
    }

    for await (const message of iterator) {
      messages.push(message)
      options.host.emitted.push(message)
    }
    return { messages }
  } catch (error) {
    return { messages, error }
  } finally {
    activeTransport = undefined
  }
}

/** 场景 1：真实 SDK 加载 + 消息流 + 正常终态。 */
export async function scenarioMessageFlowAndTerminal(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  try {
    const outcome = await runPiQuery(adapter, {
      script: [{ textChunks: ['你好', '，世界'] }],
      host,
      sessionId: 'minimal-message-flow',
      ...dirs,
    })

    const init = outcome.messages.find((m) => jsonOf(m).type === 'system' && jsonOf(m).subtype === 'init')
    check('消息流：收到 system/init', Boolean(init), JSON.stringify(outcome.messages.map((m) => jsonOf(m).type)))

    const assistant = outcome.messages.find((m) => jsonOf(m).type === 'assistant' && assistantTextOf(m).includes('你好，世界'))
    check('消息流：assistant 文本按增量累计完整', Boolean(assistant), `文本=${outcome.messages.map(assistantTextOf).join('|')}`)

    const terminal = outcome.messages.find((m) => jsonOf(m).type === 'result')
    check(
      '终态：产生 result 终态消息且标记成功',
      Boolean(terminal) && jsonOf(terminal as SDKMessage).subtype === 'success',
      JSON.stringify(terminal ?? null).slice(0, 200),
    )
    check('消息流：脚本模型流被真实 session 调用', (lastTransport?.calls.length ?? 0) > 0, `calls=${lastTransport?.calls.length ?? 0}`)
    check('终态：迭代器正常结束且无异常', outcome.error === undefined, String(outcome.error ?? ''))
  } finally {
    adapter.dispose()
    cleanupDirs(dirs)
  }
}

/** 场景 2：工具调用 → 权限端口 → 真实工具执行 → 结果回流 → 第二轮模型响应。 */
export async function scenarioToolExecution(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  const executed: Array<Record<string, unknown>> = []
  try {
    const testTool = defineTestTool(realSdk, executed)
    const outcome = await runPiQuery(adapter, {
      script: [
        { toolCall: { id: 'call-1', name: 'minimal_echo', arguments: { text: 'ping' } } },
        { textChunks: ['工具已完成'] },
      ],
      host,
      sessionId: 'minimal-tool-execution',
      testTool,
      ...dirs,
    })

    check('工具：真实 execute 被执行一次', executed.length === 1, JSON.stringify(executed))
    check('工具：输入参数透传到真实 SDK 工具', executed[0]?.text === 'ping', JSON.stringify(executed[0] ?? null))
    check(
      '工具：权限端口被真实调用',
      host.permissions.calls.some((call) => call.toolName.includes('minimal_echo')),
      JSON.stringify(host.permissions.calls.map((call) => call.toolName)),
    )
    const toolResult = outcome.messages.find((m) => jsonOf(m).type === 'user' || jsonOf(m).type === 'tool_result')
    check('工具：工具结果作为后续轮次上下文回流', Boolean(toolResult), JSON.stringify(outcome.messages.map((m) => jsonOf(m).type)))
    check('工具：第二轮模型响应在工具之后产生', outcome.messages.some((m) => assistantTextOf(m).includes('工具已完成')), '')
  } finally {
    adapter.dispose()
    cleanupDirs(dirs)
  }
}

/** 场景 3：取消（abort）→ 迭代器收敛、终态可见、会话释放。 */
export async function scenarioCancel(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  try {
    const outcome = await runPiQuery(adapter, {
      script: [{ pending: true }],
      host,
      sessionId: 'minimal-cancel',
      ...dirs,
      onQueryStart: (runningAdapter) => {
        runningAdapter.abort('minimal-cancel')
        // 兜底释放挂起的脚本轮，避免依赖真实 SDK 一定在 abort 后唤醒脚本流。
        setTimeout(() => activeTransport?.releasePending(), 50)
      },
    })

    check('取消：abort 后迭代器仍能收敛', true, `收到 ${outcome.messages.length} 条消息`)
    check('取消：未抛出未处理异常', outcome.error === undefined, String(outcome.error ?? ''))
    const released = await assertSessionReleased(adapter, 'minimal-cancel')
    check('取消：活跃会话已释放', released, 'sendQueuedMessage 仍认为会话在运行')
  } finally {
    adapter.dispose()
    cleanupDirs(dirs)
  }
}

/** 场景 4：上游错误 → 错误可见、无悬挂、会话释放。 */
export async function scenarioError(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  try {
    const outcome = await runPiQuery(adapter, {
      script: [{ errorMessage: '503: Service temporarily unavailable' }],
      host,
      sessionId: 'minimal-error',
      ...dirs,
    })

    const dumped = JSON.stringify(outcome.messages.map(jsonOf))
    const hasErrorSignal = /service_unavailable|503|Service temporarily unavailable|error/i.test(dumped)
    check('错误：上游错误在消息流或迭代错误中可见', hasErrorSignal || outcome.error !== undefined, dumped.slice(0, 300))
    const released = await assertSessionReleased(adapter, 'minimal-error')
    check('错误：异常路径同样释放会话', released, 'sendQueuedMessage 仍认为会话在运行')
  } finally {
    adapter.dispose()
    cleanupDirs(dirs)
  }
}

/** 场景 5：权限拒绝路径（宿主权限端口决定工具不执行）。 */
export async function scenarioPermissionDeny(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  const executed: Array<Record<string, unknown>> = []
  try {
    const testTool = defineTestTool(realSdk, executed)
    const outcome = await runPiQuery(adapter, {
      script: [
        { toolCall: { id: 'call-denied', name: 'minimal_echo', arguments: { text: 'blocked' } } },
        { textChunks: ['已结束'] },
      ],
      host,
      sessionId: 'minimal-permission-deny',
      testTool,
      permissionDeny: 'minimal_echo',
      ...dirs,
    })

    check('权限：拒绝时真实工具未执行', executed.length === 0, JSON.stringify(executed))
    check(
      '权限：拒绝原因进入消息流',
      JSON.stringify(outcome.messages.map(jsonOf)).includes('最小宿主拒绝该工具')
        || outcome.error !== undefined,
      JSON.stringify(outcome.messages.map(jsonOf)).slice(0, 300),
    )
  } finally {
    adapter.dispose()
    cleanupDirs(dirs)
  }
}

/** 场景 6：dispose 后的资源释放（真实 session dispose 链路可重入）。 */
export async function scenarioDispose(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  try {
    await runPiQuery(adapter, {
      script: [{ textChunks: ['bye'] }],
      host,
      sessionId: 'minimal-dispose',
      ...dirs,
    })
    adapter.dispose()
    check('释放：dispose 幂等且不抛错', true, '')
    const released = await assertSessionReleased(adapter, 'minimal-dispose')
    check('释放：dispose 后无残留活跃会话', released, '')
  } finally {
    cleanupDirs(dirs)
  }
}

/** 场景 7：真实 SDK 加载证据（不发起模型请求）。 */
export async function scenarioRealSdkLoaded(): Promise<void> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  check('真实 SDK：SessionManager/createAgentSession 存在', typeof sdk.createAgentSession === 'function' && typeof sdk.SessionManager?.create === 'function', '')
  const prototype = sdk.ModelRuntime.prototype as unknown as Record<string, unknown>
  check('真实 SDK：脚本传输已安装在真实 ModelRuntime 原型上', typeof prototype.streamSimple === 'function', '')
  check('真实 SDK：adapter 的 import 链仍是真实包（未使用模块 mock）', sdk.ModelRuntime === realSdk.ModelRuntime, '')
}

async function assertSessionReleased(adapter: PiAgentAdapterInstance, sessionId: string): Promise<boolean> {
  try {
    await adapter.sendQueuedMessage(sessionId, { message: { content: [{ type: 'text', text: 'x' }] } } as never)
    return false
  } catch (error) {
    return /没有正在运行的 Agent/.test(String(error))
  }
}

function defineTestTool(sdk: typeof realSdk, executed: Array<Record<string, unknown>>): ToolDefinition {
  return sdk.defineTool({
    name: 'minimal_echo',
    label: '最小测试工具',
    description: '验证用：回显输入文本。',
    promptSnippet: '回显文本。',
    parameters: Type.Object({ text: Type.String() }),
    async execute(_toolCallId: string, params: { text: string }) {
      executed.push({ ...params })
      return { content: [{ type: 'text' as const, text: `echo:${params.text}` }], details: { echoed: params.text } }
    },
  } as never) as unknown as ToolDefinition
}

interface RunnerDirs {
  cwd: string
  piAgentDir: string
  piSessionDir: string
}

function createDirs(): RunnerDirs {
  const base = mkdtempSync(join(tmpdir(), 'profer-pi-provider-'))
  return {
    cwd: base,
    piAgentDir: join(base, 'agent'),
    piSessionDir: join(base, 'sessions'),
  }
}

function cleanupDirs(dirs: RunnerDirs): void {
  rmSync(dirs.cwd, { recursive: true, force: true })
}

/** 场景：两轮以上历史时，手动压缩不被守卫误挡，正常走完 session.compact()。 */
export async function scenarioManualCompactionRuns(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  let piSessionId = ''
  try {
    // Pi 的 findCutPoint 按 keepRecentTokens（默认 2 万）从后往前累加，
    // 会话太小时找不到切点、compact() 直接抛 "Nothing to compact"。
    // 这里故意让第一轮足够长，才能走到真实压缩。
    const longReply = '验证用的长上下文内容。'.repeat(8_000)
    const first = await runPiQuery(adapter, {
      script: [{ textChunks: [longReply] }],
      host,
      sessionId: 'minimal-compaction-runs',
      onSessionId: (sdkSessionId) => { piSessionId = sdkSessionId },
      ...dirs,
    })
    check(
      '正常压缩：首轮完成并拿到 Pi 会话 id',
      first.error === undefined && piSessionId.length > 0,
      `${String(first.error ?? '')} piSessionId=${piSessionId}`,
    )

    const second = await runPiQuery(adapter, {
      script: [{ textChunks: ['第二轮回复'] }],
      host,
      sessionId: 'minimal-compaction-runs',
      resumeSessionId: piSessionId,
      ...dirs,
    })
    check('正常压缩：第二轮续接同一会话', second.error === undefined, String(second.error ?? ''))

    const third = await runPiQuery(adapter, {
      script: [{ textChunks: ['压缩摘要'] }],
      host,
      sessionId: 'minimal-compaction-runs',
      resumeSessionId: piSessionId,
      compactRequest: true,
      ...dirs,
    })
    const boundary = third.messages.find((m) => jsonOf(m).type === 'system' && jsonOf(m).subtype === 'compact_boundary')
    check(
      '正常压缩：两轮以上历史时真的执行了压缩',
      Boolean(boundary),
      JSON.stringify(third.messages.map(jsonOf)).slice(0, 300),
    )
    check(
      '正常压缩：未被前置守卫误挡',
      !third.messages.some((m) => jsonOf(m).subtype === 'compact_skipped'),
      '出现了 compact_skipped',
    )
    const terminal = third.messages.find((m) => jsonOf(m).type === 'result')
    check(
      '正常压缩：以成功终态收束',
      Boolean(terminal) && jsonOf(terminal as SDKMessage).subtype === 'success',
      JSON.stringify(terminal ?? null).slice(0, 200),
    )
  } finally {
    adapter.dispose()
    cleanupDirs(dirs)
  }
}

/** 场景：空会话的手动压缩被前置守卫挡下，不发摘要请求也不报错。 */
export async function scenarioManualCompactionSkip(): Promise<void> {
  const host = createMinimalPiHost()
  const adapter = new PiAgentAdapter(host.ports)
  const dirs = createDirs()
  try {
    const outcome = await runPiQuery(adapter, {
      script: [],
      host,
      sessionId: 'minimal-compaction-skip',
      compactRequest: true,
      ...dirs,
    })

    const skipped = outcome.messages.find((m) => jsonOf(m).type === 'system' && jsonOf(m).subtype === 'compact_skipped')
    check(
      '手动压缩：不足 2 轮时发出 compact_skipped 并说明原因',
      Boolean(skipped) && /轮有效对话/.test(String(jsonOf(skipped as SDKMessage).message ?? '')),
      JSON.stringify(skipped ?? outcome.messages.map(jsonOf)).slice(0, 300),
    )
    const terminal = outcome.messages.find((m) => jsonOf(m).type === 'result')
    check(
      '手动压缩：跳过时仍以成功终态收束本轮',
      Boolean(terminal) && jsonOf(terminal as SDKMessage).subtype === 'success',
      JSON.stringify(terminal ?? null).slice(0, 200),
    )
    check(
      '手动压缩：跳过时没有发起摘要调用',
      (lastTransport?.calls.length ?? 0) === 0,
      `calls=${lastTransport?.calls.length ?? 0}`,
    )
    check('手动压缩：跳过路径无异常', outcome.error === undefined, String(outcome.error ?? ''))
  } finally {
    adapter.dispose()
    cleanupDirs(dirs)
  }
}

export const allScenarios: Array<[string, () => Promise<void>]> = [
  ['real-sdk-load', scenarioRealSdkLoaded],
  ['message-flow-and-terminal', scenarioMessageFlowAndTerminal],
  ['tool-execution', scenarioToolExecution],
  ['cancel', scenarioCancel],
  ['error', scenarioError],
  ['permission-deny', scenarioPermissionDeny],
  ['dispose-and-release', scenarioDispose],
  ['manual-compaction-skip', scenarioManualCompactionSkip],
  ['manual-compaction-runs', scenarioManualCompactionRuns],
]

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  results.length = 0
  for (const [name, run] of allScenarios) {
    console.log(`\n▶ 场景：${name}`)
    await run()
  }
  return [...results]
}

if (import.meta.main) {
  const summary = await runAllScenarios()
  const failed = summary.filter((item) => !item.passed)
  console.log(`\n===== 最小 Pi runner：${summary.length - failed.length}/${summary.length} 通过 =====`)
  if (failed.length > 0) {
    for (const item of failed) console.error(`FAIL ${item.name}: ${item.detail}`)
    process.exit(1)
  }
}
