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

  test('Given 终态策略有 4 个调用点（两个 onComplete + 两个异常兜底） When 逐个检查 Then 全部传 started', async () => {
    const source = await readAgentService()
    const calls = [...source.matchAll(/applyCompletionUnreadPolicy\(\{/g)]
    expect(calls).toHaveLength(4)
    for (const call of calls) {
      const blockEnd = source.indexOf('})', call.index!)
      expect(blockEnd).toBeGreaterThan(call.index!)
      expect(source.slice(call.index!, blockEnd)).toContain('started: runStarted')
    }
  })
})
