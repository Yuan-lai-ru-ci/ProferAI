import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * F-4 与 D-2 的调用点守卫（验收缺陷修复）。
 *
 * 这两个缺陷都不在纯策略层（`agent-unread-policy.ts` 的真值表已经是对的），而在
 * `agent-service.ts` 的**调用点**上，所以这里用源码结构断言把「位置 / 参数 / 模式分支」钉死：
 *
 * - **F-4**：经 `onComplete` 收敛但从未真正启动的请求（删除/分叉守卫、preflight 失败）在开启态
 *   不得写未读 ⇒ 终态策略调用必须透传 `started: runStarted`；
 * - **D-2**：关闭态的清未读必须回到原 M1 的位置与原语义（`runAgent()` 开头、`orchestrator.sendMessage`
 *   之前、无条件 + try/catch 容错），开启态才用 `onRunStarted` + initiator 判据。
 */

async function readAgentService(): Promise<string> {
  return (await Bun.file(join(import.meta.dir, 'agent-service.ts')).text()).replace(/\r\n/g, '\n')
}

/** 取 `start` 与 `end` 之间的源码片段（两个锚点都必须存在且有序）。 */
function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  if (from === -1 || to === -1) throw new Error(`源码锚点未找到: start=${start} end=${end}`)
  return source.slice(from, to)
}

describe('runtime headless routing guard', () => {
  test('Given the runtime headless switch When a normal headless input arrives Then it routes through the runtime query adapter', async () => {
    const source = await readAgentService()
    const headlessBody = slice(source, 'export async function runAgentHeadless(', 'setHeadlessAgentRunner(')
    expect(source).toContain("process.env.PROFER_RUNTIME_HEADLESS === '1'")
    // 2026-10-16 集成会话：runtime headless 入口合并为一条（不再有 runAgentRuntimeHeadlessInput 包装）。
    expect(headlessBody).toContain('runAgentRuntimeHeadless(input, callbacks)')
    // query 构造（含策略快照与原生 session 回调）已收敛到 agent-runtime-entry.ts 的入口接线。
    expect(source).not.toContain('createElectronAgentRuntimeQuery(input, {')
  })

  test('Given Goal-specific callbacks When runtime headless routing is considered Then the runtime coordinator is bypassed', async () => {
    const source = await readAgentService()
    const guard = slice(source, 'function canUseRuntimeHeadless(input: AgentSendInput): boolean {', '/**\n * 将完整 headless 输入')
    expect(guard).toContain('!input.goalRunId')
    expect(guard).toContain('!input.reportGoalResult')
    expect(guard).toContain('!input.onRuntimeSessionId')
    expect(guard).toContain('!input.onRuntimeMessage')
  })
})

describe('D-2：关闭态清未读回到原 M1 的位置与原语义', () => {
  test('Given 关闭态需要逐点保真 When 检查 runAgent Then 在 orchestrator.sendMessage 之前按 auto 模式清未读', async () => {
    const source = await readAgentService()
    const runAgentBody = slice(source, 'export async function runAgent(', 'export async function runAgentHeadless(')
    const entryClearAt = runAgentBody.indexOf('clearSessionUnreadOnRequestEntry(input.sessionId)')
    const sendMessageAt = runAgentBody.indexOf('await orchestrator.sendMessage(input, {')
    expect(entryClearAt).toBeGreaterThan(-1)
    expect(sendMessageAt).toBeGreaterThan(-1)
    expect(entryClearAt).toBeLessThan(sendMessageAt)
    // 入口调用必须无条件（模式判定在 helper 内部，连同容错一起），否则设置读取失败会阻断发送。
    expect(runAgentBody).not.toContain("if (getAgentUnreadPolicyMode() === 'auto') clearSessionUnreadOnRequestEntry")
  })

  test('Given 原 M1 有 try/catch 容错且写走唯一写入口 When 检查入口清未读 helper Then 语义保留', async () => {
    const source = await readAgentService()
    const helper = slice(source, 'function clearSessionUnreadOnRequestEntry(sessionId: string): void {', 'function applyRunStartUnreadPolicy(')
    expect(helper).toContain("if (getAgentUnreadPolicyMode() !== 'auto') return")
    expect(helper).toContain('setAgentSessionUnread(sessionId, false)')
    expect(helper).toContain('catch {')
    // 原实现在会话尚未写入索引时会抛错并吞掉 —— 这里靠写入口的 null 幂等 + try/catch 保持等价。
    expect(helper).not.toContain('updateAgentSessionMeta(')
  })

  test('Given 关闭态已在入口清过 When 检查 onRunStarted 落点 Then 只在开启态生效（不重复写盘）', async () => {
    const source = await readAgentService()
    const helper = slice(source, 'function applyRunStartUnreadPolicy(sessionId: string, initiator: AgentRunInitiator): void {', 'function applyCompletionUnreadPolicy(')
    expect(helper).toContain("if (mode === 'auto') return")
    expect(helper).toContain('shouldClearSessionUnreadOnRunStart(initiator, mode)')
    // 两个 onRunStarted 调用点仍在（桌面 + headless），只是关闭态直接返回。
    expect(source).toContain('applyRunStartUnreadPolicy(input.sessionId, initiator)')
    expect(source).toContain('applyRunStartUnreadPolicy(runInput.sessionId, initiator)')
  })

  test('Given 关闭态 headless 与原实现一致 When 检查 headless 入口 Then 不新增请求入口清未读', async () => {
    const source = await readAgentService()
    const headlessBody = slice(source, 'export async function runAgentHeadless(', 'setHeadlessAgentRunner(')
    expect(headlessBody).not.toContain('clearSessionUnreadOnRequestEntry')
  })
})

describe('F-4：从未真正启动的请求不得写未读', () => {
  test('Given 删除/分叉守卫与 preflight 失败都收敛到 onComplete When 检查 runAgent 终态调用 Then 透传 started', async () => {
    const source = await readAgentService()
    const runAgentBody = slice(source, 'export async function runAgent(', 'export async function runAgentHeadless(')
    const onCompleteBlock = slice(runAgentBody, 'onComplete: (messages, opts) => {', 'onRunStarted: async ({ startedAt }) => {')
    expect(onCompleteBlock).toContain('applyCompletionUnreadPolicy({')
    expect(onCompleteBlock).toContain('started: runStarted,')
  })

  test('Given headless 完成经同一转发 When 检查 forwardToRenderer 终态调用 Then 同样透传 started', async () => {
    const source = await readAgentService()
    const headlessBody = slice(source, 'export async function runAgentHeadless(', 'setHeadlessAgentRunner(')
    const forwardBlock = slice(headlessBody, 'forwardToRenderer: (completionMessages, completionOpts) => {', 'onTitleUpdated: (title) => {')
    expect(forwardBlock).toContain('applyCompletionUnreadPolicy({')
    expect(forwardBlock).toContain('started: runStarted,')
  })

  test('Given 终态策略有 5 个调用点（三个 onComplete + 两个异常兜底） When 逐个检查 Then 全部传 started', async () => {
    const source = await readAgentService()
    const calls = [...source.matchAll(/applyCompletionUnreadPolicy\(\{/g)]
    // 2026-10-16 集成会话：新增 runtime headless 入口（runAgentRuntimeHeadless）的终态未读调用，
    // 使 manual 模式下经新入口完成的一轮也产生未读（原为缺口 B-5）。
    expect(calls).toHaveLength(5)
    for (const call of calls) {
      const blockEnd = source.indexOf('})', call.index!)
      expect(blockEnd).toBeGreaterThan(call.index!)
      expect(source.slice(call.index!, blockEnd)).toContain('started: runStarted')
    }
  })
})

describe('runtime coordinator stream restore ownership', () => {
  test('Given runtime coordinator owns a session When restoring streams Then it is rebound and reported active', async () => {
    const source = await readAgentService()
    const restoreBody = slice(source, 'export function restoreActiveAgentStreams(', 'function isMainRendererWindow(')
    expect(restoreBody).toContain('isAgentExecutionActive(sessionId)')
    expect(restoreBody).toContain('registerWebContents(sessionId, webContents)')
    expect(restoreBody).toContain('const active = isAgentExecutionActive(sessionId)')
    expect(restoreBody).toContain('active,')
  })

  test('Given runtime lifecycle completion When preserving a backlog Then it is treated as terminal', async () => {
    const source = await readAgentService()
    const terminalPredicate = slice(source, 'function isTerminalBacklogEvent(', 'function preserveCompletedBacklog(')
    expect(terminalPredicate).toContain("payload.event.type === 'run_completed'")
    const headless = slice(source, 'export async function runAgentRuntimeHeadless(', 'export async function stopAgentRuntime(')
    expect(headless).toContain('beginActiveStreamBacklog(input.sessionId)')
    expect(headless).toContain('finishActiveStreamBacklog(input.sessionId)')
  })
})

describe('runtime coordinator run-start projection', () => {
  test('Given a runtime-owned headless run When onRunStarted fires Then service applies the same unread and draft projection path', async () => {
    const source = await readAgentService()
    const runtimeBody = slice(source, 'export async function runAgentRuntimeHeadless(', 'export async function stopAgentRuntime(')
    expect(runtimeBody).toContain('const runtimeCallbacks: AgentRuntimeCallbacks')
    expect(runtimeBody).toContain('onRunStarted: async (input, startedAt) => {')
    expect(runtimeBody).toContain('applyRunStartUnreadPolicy(input.sessionId, input.initiator)')
    expect(runtimeBody).toContain('updateAgentSessionMeta(input.sessionId, { draft: false })')
    expect(runtimeBody).toContain('publishAgentSessionProjection(session)')
  })
  test('Given a runtime-owned headless terminal When the runtime settles Then the desktop renderer receives the legacy terminal channels too', async () => {
    const source = await readAgentService()
    const runtimeBody = slice(source, 'export async function runAgentRuntimeHeadless(', 'export async function stopAgentRuntime(')
    expect(runtimeBody).toContain("eventBus.emit(input.sessionId, { kind: 'run_error', error })")
    expect(runtimeBody).toContain("currentWc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: input.sessionId, error })")
    expect(runtimeBody).toContain("eventBus.emit(input.sessionId, { kind: 'run_complete', completion })")
    expect(runtimeBody).toContain("currentWc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, completion)")
    expect(runtimeBody).toContain('resultErrors: fields.resultErrors ?? (runtimeError ? [runtimeError] : undefined)')
    expect(runtimeBody).toContain('initiator,')
  })
})

describe('IR-D1：桌面 runtime 链与旧链都在请求入口清未读', () => {
  test('Given 桌面 runtime 入口 When 检查 runDesktopRuntimeAgent Then 在守卫与 claim 之前无条件清未读', async () => {
    const source = (await Bun.file(join(import.meta.dir, 'agent-runtime-desktop-entry.ts')).text()).replace(/\r\n/g, '\n')
    const body = source.slice(source.indexOf('export async function runDesktopRuntimeAgent('))
    const registerAt = body.indexOf('host.registerWebContents(sessionId, host.sender)')
    const clearAt = body.indexOf('host.clearUnreadOnRequestEntry(sessionId)')
    const guardAt = body.indexOf('host.checkEntryGuards(sessionId)')
    const claimAt = body.indexOf('await runRuntimeHeadlessEntry(')
    expect(registerAt).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(registerAt)
    expect(guardAt).toBeGreaterThan(clearAt)
    expect(claimAt).toBeGreaterThan(guardAt)
  })

  test('Given runAgent 接线 When 检查桌面分支 Then 开关判定在任何 await 之前，旧链入口清未读仍在旧分支', async () => {
    const source = await readAgentService()
    const runAgentBody = slice(source, 'export async function runAgent(', 'export async function runAgentHeadless(')
    const switchAt = runAgentBody.indexOf('resolveDesktopRunChain(input)')
    const oldRegisterAt = runAgentBody.indexOf('registerWebContents(input.sessionId, webContents)')
    expect(switchAt).toBeGreaterThan(-1)
    expect(oldRegisterAt).toBeGreaterThan(switchAt)
    expect(runAgentBody).toContain('clearUnreadOnRequestEntry: clearSessionUnreadOnRequestEntry,')
    expect(runAgentBody).toContain('checkEntryGuards: (sessionId) => orchestrator.checkEntryGuards(sessionId),')
  })
})

describe('流绑定归主进程仲裁', () => {
  test('Given 独立会话窗口正展示某会话 When 其它窗口带 sessionIds 认领 Then 拒绝抢占', async () => {
    const source = await readAgentService()
    const restoreBody = slice(source, 'export function restoreActiveAgentStreams(', 'function isMainRendererWindow(')
    const allowedBranch = slice(restoreBody, 'if (allowed) {', '} else {')
    // 回归：认领路径（带 sessionIds）此前只会按 sessionIds 过滤，不做归属判定，
    // 于是主窗口切 Tab 认领时会把独立会话窗口正在看的流抢走（对方向 SESSION_RELEASED），
    // 那个窗口随即冻结在快照上 —— 现象就是「过程区一直折叠、看不出在运行」。
    expect(allowedBranch).toContain('isSessionWindowContents(owner)')
    expect(allowedBranch).toContain('owner !== webContents')
    expect(allowedBranch).toContain('snapshots.delete(sessionId)')
  })

  test('Given headless 启动 When 该会话已有展示窗口 Then 不改绑到主窗口', async () => {
    const source = await readAgentService()
    const from = source.indexOf('export async function runAgentHeadless(')
    expect(from).toBeGreaterThan(-1)
    const legacyHeadless = source.slice(from, from + 4000)
    expect(legacyHeadless).toContain('getSessionWebContents(')
    expect(legacyHeadless).toContain('if (wc && !existingOwner)')
  })
})
