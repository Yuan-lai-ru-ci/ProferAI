/**
 * 「Agent 提议交接对话」的静态接线契约。
 *
 * 这条链路横跨 shared 类型、两条 runtime 的工具注入、主进程事件/IPC、preload、
 * 渲染层投影与卡片挂载。任一登记点漏了，现象都是「模型调用了工具但用户看不到卡片」
 * 或「卡片出现了但点确认没反应」，运行时很难一眼定位，所以用源码断言钉住整条线。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../../../../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8')

const sharedTypes = read('packages/shared/src/types/agent.ts')
const sharedUtils = read('packages/shared/src/utils/index.ts')
const ipc = read('apps/electron/src/main/ipc.ts')
const orchestrator = read('apps/electron/src/main/lib/agent-orchestrator.ts')
const piTools = read('apps/electron/src/main/lib/adapters/pi-builtin-tools.ts')
const desktopSwitch = read('apps/electron/src/main/lib/agent-runtime-desktop-switch.ts')
const deletion = read('apps/electron/src/main/lib/agent-session-deletion-service.ts')
const preload = read('apps/electron/src/preload/index.ts')
const listeners = read('apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts')
const view = read('apps/electron/src/renderer/components/agent/AgentView.tsx')
const contentBlock = read('apps/electron/src/renderer/components/agent/ContentBlock.tsx')
const processGroup = read('apps/electron/src/renderer/components/agent/ProcessBlockGroup.tsx')
const banner = read('apps/electron/src/renderer/components/agent/HandoffProposalBanner.tsx')

describe('主进程：工具 → 提案 → 事件 → 确认', () => {
  test('Given 新工具 When 登记 Then shared 里有提案类型、两个事件分支与两个 IPC 通道', () => {
    expect(sharedTypes).toContain('export interface HandoffProposal')
    expect(sharedTypes).toContain("| { type: 'handoff_proposal'; proposal: HandoffProposal }")
    expect(sharedTypes).toContain("| { type: 'handoff_proposal_resolved'; proposalId: string; accepted: boolean }")
    expect(sharedTypes).toContain("LIST_HANDOFF_PROPOSALS: 'agent:handoff-proposals'")
    expect(sharedTypes).toContain("RESPOND_HANDOFF_PROPOSAL: 'agent:handoff-proposal-respond'")
    expect(sharedTypes).toContain('handoffProposal?:')
    expect(sharedUtils).toContain('isHandoffProposalToolName')
  })

  test('Given 用户轮次 When 发消息 Then 注入提议通道，且两条 runtime 都注册工具', () => {
    expect(ipc).toContain('handoffProposal: handoffProposalInputFor(input.sessionId)')
    expect(orchestrator).toContain('injectHandoffProposalMcpServer')
    expect(piTools).toContain('buildPiHandoffProposalTools')
    expect(desktopSwitch).toContain('!input.handoffProposal')
    expect(deletion).toContain('handoffProposalService.clearSession(sessionId)')
  })

  test('Given 用户点确认 When 主进程处理 Then 复用会话交接服务并返回结果；失败不出队', () => {
    // 源码是 CRLF，别用写死 \n 的跨行字符串。
    expect(ipc).toMatch(/ipcMain\.handle\(\s*AGENT_IPC_CHANNELS\.RESPOND_HANDOFF_PROPOSAL/)
    expect(ipc).toContain('await createHandoffSession(proposal.sessionId)')
    expect(ipc).toContain('handoffProposalService.peek(proposalId)')
    expect(ipc).toContain('handoffProposalService.remove(proposalId)')
    expect(ipc).toContain("type: 'handoff_proposal_resolved'")
    expect(ipc).toContain('handoffProposalResponsesInFlight')
    // 交接往同一份 JSONL 追加 headless run，本轮还在跑时必须拒绝并保留卡片。
    expect(ipc).toContain('isAgentSessionActive(proposal.sessionId)')
  })
})

describe('渲染层：事件 → 卡片 → 确认/叉掉', () => {
  test('Given 事件到达 When 投影 Then 两个类型都在 payloadToLegacyEvents 里登记', () => {
    expect(listeners).toContain("case 'handoff_proposal':")
    expect(listeners).toContain("case 'handoff_proposal_resolved':")
    expect(listeners).toContain('allPendingHandoffProposalsAtom')
    expect(listeners).toContain('listHandoffProposals()')
  })

  test('Given preload When 暴露桥 Then 列出与响应两个方法齐全', () => {
    expect(preload).toContain('listHandoffProposals:')
    expect(preload).toContain('respondHandoffProposal:')
    expect(preload).toContain('AGENT_IPC_CHANNELS.RESPOND_HANDOFF_PROPOSAL')
  })

  test('Given 卡片出现 When 用户操作 Then 确认走 applyHandoffResult，X / 忽略只丢弃', () => {
    expect(banner).toContain('respondHandoffProposal(target.id, accepted)')
    expect(banner).toContain('applyHandoffResult(result)')
    expect(banner).toContain('忽略这条建议')
    expect(banner).toContain('当前这一轮会继续跑')
    // 运行中不给出可点的确认按钮（主进程还有一道同样口径的门禁）。
    expect(banner).toContain('disabled={submitting !== null || running}')
  })

  test('Given 卡片挂载 When 检查输入框闸门 Then 不进 hasBannerOverlay（不锁输入框）', () => {
    expect(view).toContain('<HandoffProposalBanner sessionId={sessionId} />')
    // 只取这段声明开头的一小截：CRLF / 空行数变化都不该影响断言。
    const overlay = view.match(/const hasBannerOverlay =[\s\S]{0,180}/)?.[0] ?? ''
    expect(overlay).toContain('allAskUserRequests.get(sessionId)')
    expect(overlay).not.toContain('HandoffProposal')
    // AgentView 根本不订阅这个 atom：卡片自己读，闸门不可能被它影响。
    expect(view).not.toContain('allPendingHandoffProposalsAtom')
  })

  test('Given 工具调用块 When 渲染过程组 Then propose_handoff 不作为普通工具展示', () => {
    expect(contentBlock).toContain('isHandoffProposalToolName(toolBlock.name)')
    expect(processGroup).toContain('isHandoffProposalToolName(toolBlock.name)')
  })
})
