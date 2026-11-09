/**
 * 「assistant 消息 → Pi session entry」绑定登记的回归测试。
 *
 * 缺陷现场：一轮 assistant 消息已经流给用户、entry 也已经由工具级 flush 写进 Pi 文件，
 * 但 `piEntryBindings` 里没有它的 uuid → entry id。回退到这一轮时锚点只能往前找，
 * Pi transcript 被静默截早，而且 rewind 仍然返回 ok。
 *
 * 分两层：
 * 1. `scanPiEntryBindings` 纯逻辑（游标推进、只报新增、未知 uuid 跳过）；
 * 2. 真实 Pi SDK + 脚本化模型传输驱动的 adapter 集成用例（正常轮 / 中断轮 / 续跑轮），
 *    断言不变量「Pi 文件里每条 assistant entry 都有绑定」。
 *
 * 这里的 prototype 替换只在单个用例内生效并在 afterEach 还原，
 * 避免与 `minimal-pi-runner` 的同类补丁互相覆盖。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realSdk from '@earendil-works/pi-coding-agent'
import type { SDKMessage } from '@profer/shared'
import { createScriptedTransport, type ScriptedTransport, type ScriptedTurn } from '../test/pi-scripted-transport'
import { createMinimalPiHost } from './host/minimal-pi-host'
import { PI_ENTRY_BINDING_REPORT_INTERVAL_MS, PiAgentAdapter, scanPiEntryBindings, setPiEntryBindingClock } from './pi-agent-adapter'

type Adapter = InstanceType<typeof PiAgentAdapter>

let activeTransport: ScriptedTransport | undefined
let restoreTransport: (() => void) | undefined
const dirsToClean: string[] = []

/**
 * 手动假时钟：只有测试显式 `advanceClock()` 才前进。
 * 工具级 flush 发生在 `onToolExecutionResult` 之后，因此由测试在该回调里推进时间，
 * 精确模拟「相邻 flush 相距 N ms」，而不是被无关的时钟读取次数干扰。
 */
let fakeClock: { value: number } | undefined

function installFakeClock(start = 1_000_000): void {
  const state = { value: start }
  fakeClock = state
  setPiEntryBindingClock(() => state.value)
}

function advanceClock(ms: number): void {
  if (!fakeClock) throw new Error('fake clock 未安装')
  fakeClock.value += ms
}

function installScriptedTransport(): void {
  const prototype = realSdk.ModelRuntime.prototype as unknown as Record<string, unknown>
  const previous = prototype.streamSimple as (model: unknown, context: unknown, options?: { signal?: AbortSignal }) => unknown
  prototype.streamSimple = (model: unknown, context: unknown, options?: { signal?: AbortSignal }) =>
    activeTransport
      ? activeTransport.streamSimple(model as never, context, options)
      : previous.call(prototype, model, context, options)
  prototype.stream = prototype.streamSimple
  restoreTransport = () => {
    prototype.streamSimple = previous
    prototype.stream = previous
  }
}

afterEach(() => {
  restoreTransport?.()
  restoreTransport = undefined
  activeTransport = undefined
  setPiEntryBindingClock(undefined)
  fakeClock = undefined
  for (const dir of dirsToClean.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RunnerDirs {
  cwd: string
  piAgentDir: string
  piSessionDir: string
}

function createDirs(): RunnerDirs {
  const base = mkdtempSync(join(tmpdir(), 'profer-pi-bindings-'))
  dirsToClean.push(base)
  return {
    cwd: base,
    piAgentDir: join(base, 'agent'),
    piSessionDir: join(base, 'sessions'),
  }
}

interface BindingEmission {
  bindings: Record<string, string>
  /** 该次回调是否发生在 result 终态之前（即工具级 flush 触发，而非轮末补报）。 */
  beforeTerminal: boolean
}

interface TurnOutcome {
  messages: SDKMessage[]
  error?: unknown
  emissions: BindingEmission[]
  piSessionId?: string
  piSessionFile?: string
}

interface PiSessionEntrySnapshot {
  id: string
  stopReason?: string
}

/** 读出 Pi 文件里所有 assistant entry（这条不变量正是回退锚点的依据）。 */
function readAssistantEntries(piSessionFile: string): PiSessionEntrySnapshot[] {
  const entries: PiSessionEntrySnapshot[] = []
  for (const line of readFileSync(piSessionFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line) as {
      type?: string
      id?: string
      message?: { role?: string; stopReason?: string }
    }
    if (parsed.type !== 'message' || parsed.message?.role !== 'assistant' || !parsed.id) continue
    entries.push({ id: parsed.id, ...(parsed.message.stopReason ? { stopReason: parsed.message.stopReason } : {}) })
  }
  return entries
}

async function runTurn(options: {
  adapter: Adapter
  script: ScriptedTurn[]
  sessionId: string
  dirs: RunnerDirs
  resumeSessionId?: string
  onToolExecutionResult?: (toolCallId: string) => void
  onQueryStart?: (adapter: Adapter) => void
}): Promise<TurnOutcome> {
  const transport = createScriptedTransport(options.script)
  activeTransport = transport
  const messages: SDKMessage[] = []
  const emissions: BindingEmission[] = []
  let terminalSeen = false
  let piSessionId: string | undefined
  let piSessionFile: string | undefined
  const iterator = options.adapter.query({
    sessionId: options.sessionId,
    prompt: '请回复。',
    provider: 'anthropic',
    apiKey: 'bindings-test-placeholder',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    permissionMode: 'auto',
    systemPrompt: '你是一个用于验证绑定登记的最小 Agent。',
    piAgentDir: options.dirs.piAgentDir,
    piSessionDir: options.dirs.piSessionDir,
    cwd: options.dirs.cwd,
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    onSessionId: (sdkSessionId: string, sessionFile?: string) => {
      piSessionId = sdkSessionId
      piSessionFile = sessionFile
    },
    onModelResolved: () => {},
    onContextWindow: () => {},
    ...(options.onToolExecutionResult ? { onToolExecutionResult: (id: string) => options.onToolExecutionResult!(id) } : {}),
    onPiEntryBindings: (bindings: Record<string, string>) => {
      emissions.push({ bindings: { ...bindings }, beforeTerminal: !terminalSeen })
    },
  })

  if (options.onQueryStart) {
    setTimeout(() => options.onQueryStart?.(options.adapter), 50)
  }

  try {
    for await (const message of iterator) {
      messages.push(message)
      if (message.type === 'result') terminalSeen = true
    }
    return {
      messages,
      emissions,
      ...(piSessionId ? { piSessionId } : {}),
      ...(piSessionFile ? { piSessionFile } : {}),
    }
  } catch (error) {
    return {
      messages,
      emissions,
      error,
      ...(piSessionId ? { piSessionId } : {}),
      ...(piSessionFile ? { piSessionFile } : {}),
    }
  } finally {
    activeTransport = undefined
  }
}

function finalAssistantMessages(messages: readonly SDKMessage[]): SDKMessage[] {
  return messages.filter(
    (message) => message.type === 'assistant' && (message as { _partial?: boolean })._partial !== true,
  )
}

function boundEntryIds(emissions: readonly BindingEmission[]): Set<string> {
  return new Set(emissions.flatMap((emission) => Object.values(emission.bindings)))
}

function mergedBindings(emissions: readonly BindingEmission[]): Record<string, string> {
  return emissions.reduce<Record<string, string>>((all, item) => ({ ...all, ...item.bindings }), {})
}

function unboundEntryIds(entries: readonly PiSessionEntrySnapshot[], boundIds: ReadonlySet<string>): string[] {
  return entries.map((entry) => entry.id).filter((id) => !boundIds.has(id))
}

/** 按上报顺序摊平 entry id：用于断言「已上报集合是完整集合的前缀」。 */
function reportedEntryIdsInOrder(emissions: readonly BindingEmission[]): string[] {
  return emissions.flatMap((emission) => Object.values(emission.bindings))
}

describe('scanPiEntryBindings', () => {
  const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

  test('首轮扫描绑定已知 uuid 的 assistant entry，跳过 user entry 与未知 uuid', () => {
    const known = assistant('a1')
    const entries = [
      { type: 'message', id: 'e0', message: user('hi') },
      { type: 'message', id: 'e1', message: known },
      { type: 'message', id: 'e2', message: assistant('unregistered') },
      { type: 'thinking_level_change', id: 'e3' },
    ]
    const result = scanPiEntryBindings(entries, 0, (message) => (message === known ? 'uuid-1' : undefined))
    expect(result.bindings).toEqual({ 'uuid-1': 'e1' })
    expect(result.cursor).toBe(entries.length)
  })

  test('游标之后没有新 entry 时不产生任何绑定（调用方据此避免多余写盘）', () => {
    const known = assistant('a1')
    const entries = [{ type: 'message', id: 'e1', message: known }]
    const first = scanPiEntryBindings(entries, 0, (message) => (message === known ? 'uuid-1' : undefined))
    expect(first.bindings).toEqual({ 'uuid-1': 'e1' })

    const second = scanPiEntryBindings(entries, first.cursor, (message) => (message === known ? 'uuid-1' : undefined))
    expect(second.bindings).toEqual({})
    expect(second.cursor).toBe(entries.length)
  })

  test('只报游标之后的新 entry，不重复上报历史绑定', () => {
    const a1 = assistant('a1')
    const a2 = assistant('a2')
    const entries = [
      { type: 'message', id: 'e1', message: a1 },
      { type: 'message', id: 'e2', message: a2 },
    ]
    const uuidOf = (message: unknown) => (message === a1 ? 'uuid-1' : message === a2 ? 'uuid-2' : undefined)
    const first = scanPiEntryBindings(entries, 0, uuidOf)
    expect(first.bindings).toEqual({ 'uuid-1': 'e1', 'uuid-2': 'e2' })

    const appended = [...entries, { type: 'message', id: 'e3', message: assistant('a3') }]
    const second = scanPiEntryBindings(appended, first.cursor, uuidOf)
    expect(second.bindings).toEqual({})
    expect(second.cursor).toBe(3)
  })

  test('非法游标不会漏扫或越界', () => {
    const a1 = assistant('a1')
    const entries = [{ type: 'message', id: 'e1', message: a1 }]
    const uuidOf = (message: unknown) => (message === a1 ? 'uuid-1' : undefined)
    expect(scanPiEntryBindings(entries, -3, uuidOf).bindings).toEqual({ 'uuid-1': 'e1' })
    expect(scanPiEntryBindings(entries, Number.NaN, uuidOf).bindings).toEqual({ 'uuid-1': 'e1' })
    expect(scanPiEntryBindings(entries, 99, uuidOf).bindings).toEqual({})
  })
})

describe('Pi assistant entry 绑定登记（真实 SDK + 脚本传输）', () => {
  function assistantEntryCountFrom(toolCalls: number): number {
    // 每个工具调用轮一条 assistant toolCall 消息 + 收尾一条正文 assistant
    return toolCalls + 1
  }

  function toolTurns(count: number): ScriptedTurn[] {
    return Array.from({ length: count }, (_, index) => ({
      toolCall: { id: `call-${index + 1}`, name: 'bash', arguments: { command: `echo ${index + 1}` } },
    }))
  }

  test('Given 一轮带两次工具调用 When 节流生效 Then 只有首次工具 flush 与轮末强制各上报一次', async () => {
    installScriptedTransport()
    installFakeClock()
    const host = createMinimalPiHost()
    const adapter = new PiAgentAdapter(host.ports)
    const dirs = createDirs()
    const toolExecutionResults: string[] = []
    try {
      const outcome = await runTurn({
        adapter,
        script: [...toolTurns(2), { textChunks: ['全部完成'] }],
        sessionId: 'bindings-tool-turn',
        dirs,
        onToolExecutionResult: (toolCallId) => {
          toolExecutionResults.push(toolCallId)
          advanceClock(100)
        },
      })

      expect(outcome.error).toBeUndefined()
      // 内建 bash 工具经过宿主命令端口，才会触发工具级 flush（与真机路径一致）。
      expect(toolExecutionResults).toEqual(['call-1', 'call-2'])
      expect(outcome.piSessionFile).toBeString()

      // 第一次工具 flush 距上次上报（-Inf）已过间隔 → 立即上报 1 条；
      // 第二次工具 flush 被 1000ms 节流 → 攒到轮末 force 一起上报 2 条。
      expect(outcome.emissions.map((emission) => Object.keys(emission.bindings).length)).toEqual([1, 2])
      expect(outcome.emissions[0]?.beforeTerminal).toBe(true)
      // 同一 uuid 不会在多次回调里重复出现。
      const reportedUuids = outcome.emissions.flatMap((emission) => Object.keys(emission.bindings))
      expect(reportedUuids.length).toBe(new Set(reportedUuids).size)

      const entries = readAssistantEntries(outcome.piSessionFile!)
      expect(entries.length).toBe(assistantEntryCountFrom(2))
      // 核心不变量：Pi 文件里每条 assistant entry 都有绑定（1:1），节流不改变最终完整性。
      expect(unboundEntryIds(entries, boundEntryIds(outcome.emissions))).toEqual([])
      // 上报顺序与 entry 顺序一致 → 任何时刻的中断都只会得到真正的前缀。
      expect(reportedEntryIdsInOrder(outcome.emissions)).toEqual(entries.map((entry) => entry.id))
    } finally {
      adapter.dispose()
    }
  }, 60_000)

  test('Given 10 次工具调用且每次间隔 100ms When 轮末强制上报 Then 回调 ≤2 次且全部绑定到达宿主', async () => {
    installScriptedTransport()
    // 每次工具 flush 前进 100ms：10 次连续 flush 共 1000ms，仍在 1000ms 节流窗口内。
    installFakeClock()
    const host = createMinimalPiHost()
    const adapter = new PiAgentAdapter(host.ports)
    const dirs = createDirs()
    const toolExecutionResults: string[] = []
    try {
      const outcome = await runTurn({
        adapter,
        script: [...toolTurns(10), { textChunks: ['全部完成'] }],
        sessionId: 'bindings-throttle-turn',
        dirs,
        onToolExecutionResult: (toolCallId) => {
          toolExecutionResults.push(toolCallId)
          advanceClock(100)
        },
      })

      expect(outcome.error).toBeUndefined()
      expect(toolExecutionResults.length).toBe(10)
      expect(outcome.piSessionFile).toBeString()
      expect(PI_ENTRY_BINDING_REPORT_INTERVAL_MS).toBeGreaterThanOrEqual(1_000)

      // 10 次工具级 flush 只允许 1 次首报 + 1 次轮末强制；不是 10 次全量索引读写。
      expect(outcome.emissions.length).toBeLessThanOrEqual(2)
      expect(outcome.emissions[0] ? Object.keys(outcome.emissions[0].bindings).length : 0).toBe(1)

      const entries = readAssistantEntries(outcome.piSessionFile!)
      expect(entries.length).toBe(assistantEntryCountFrom(10))
      // force 之后：全部 bindings（含节流期间暂存的）都到达宿主，且没有重复条目。
      const reported = reportedEntryIdsInOrder(outcome.emissions)
      expect(new Set(reported).size).toBe(reported.length)
      expect(unboundEntryIds(entries, boundEntryIds(outcome.emissions))).toEqual([])
      expect(new Set(reported)).toEqual(new Set(entries.map((entry) => entry.id)))
    } finally {
      adapter.dispose()
    }
  }, 60_000)

  test('Given 节流期间宿主只收到首批 When 进程此后不再 flush Then 已上报集合是完整集合的前缀', async () => {
    installScriptedTransport()
    installFakeClock()
    const host = createMinimalPiHost()
    const adapter = new PiAgentAdapter(host.ports)
    const dirs = createDirs()
    try {
      const outcome = await runTurn({
        adapter,
        script: [...toolTurns(5), { textChunks: ['全部完成'] }],
        sessionId: 'bindings-throttle-prefix',
        dirs,
        onToolExecutionResult: () => advanceClock(100),
      })

      const entries = readAssistantEntries(outcome.piSessionFile!)
      // 最后一次回调是轮末 force 补报；去掉它即为「进程在节流窗口内消失」时已经落盘的集合。
      expect(outcome.emissions.length).toBeGreaterThanOrEqual(1)
      const reportedBeforeFinalFlush = reportedEntryIdsInOrder(outcome.emissions.slice(0, -1))
      expect(reportedBeforeFinalFlush.length).toBeGreaterThan(0)
      expect(entries.map((entry) => entry.id).slice(0, reportedBeforeFinalFlush.length))
        .toEqual(reportedBeforeFinalFlush)
    } finally {
      adapter.dispose()
    }
  }, 60_000)

  test('Given 当前轮被软中断 When 新消息续跑 Then 被打断轮的 assistant entry 也完成绑定', async () => {
    installScriptedTransport()
    const host = createMinimalPiHost()
    const adapter = new PiAgentAdapter(host.ports)
    const dirs = createDirs()
    const sessionId = 'bindings-interrupt-turn'
    try {
      const outcome = await runTurn({
        adapter,
        script: [
          { pending: true },
          { textChunks: ['打断后的新回复'] },
        ],
        sessionId,
        dirs,
        onQueryStart: (running) => {
          void running.sendQueuedMessage(
            sessionId,
            {
              type: 'user',
              message: { role: 'user', content: '换一条消息' },
              parent_tool_use_id: null,
              session_id: sessionId,
            },
            { interrupt: true },
          ).catch(() => {})
        },
      })

      expect(outcome.error).toBeUndefined()
      expect(outcome.piSessionFile).toBeString()

      const entries = readAssistantEntries(outcome.piSessionFile!)
      // 被打断轮的 aborted assistant 与续跑轮的正常回复都写进了 transcript。
      expect(entries.some((entry) => entry.stopReason === 'aborted')).toBe(true)
      expect(entries.length).toBeGreaterThanOrEqual(2)

      // 关键断言：包括被打断那条在内的所有 assistant entry 都有绑定。
      expect(unboundEntryIds(entries, boundEntryIds(outcome.emissions))).toEqual([])
    } finally {
      adapter.dispose()
    }
  }, 60_000)

  test('Given 续跑同一 Pi 会话 When 第二轮结束 Then 本轮新增的 assistant entry 同样被绑定', async () => {
    installScriptedTransport()
    const host = createMinimalPiHost()
    const adapter = new PiAgentAdapter(host.ports)
    const dirs = createDirs()
    const sessionId = 'bindings-two-turns'
    try {
      const first = await runTurn({
        adapter,
        script: [{ textChunks: ['第一轮'] }],
        sessionId,
        dirs,
      })
      expect(first.error).toBeUndefined()
      const firstEntries = readAssistantEntries(first.piSessionFile!)
      expect(firstEntries.length).toBe(1)
      expect(unboundEntryIds(firstEntries, boundEntryIds(first.emissions))).toEqual([])

      const second = await runTurn({
        adapter,
        script: [{ textChunks: ['第二轮'] }],
        sessionId,
        dirs,
        resumeSessionId: first.piSessionId!,
      })
      expect(second.error).toBeUndefined()
      const allEntries = readAssistantEntries(second.piSessionFile!)
      expect(allEntries.length).toBe(2)
      // 第二轮只上报本轮新增的 entry（历史 entry 已在宿主 meta 里），
      // 但新增的这条必须被绑定，否则回退到最后一轮会锚到第一轮。
      const secondBound = boundEntryIds(second.emissions)
      expect(allEntries.filter((entry) => !secondBound.has(entry.id)).length).toBe(1)
      expect(second.emissions.length).toBeGreaterThan(0)
    } finally {
      adapter.dispose()
    }
  }, 60_000)
})
