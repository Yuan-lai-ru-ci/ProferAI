/**
 * Pi propose_handoff execute 调用契约。
 *
 * Pi SDK 的 execute 签名是 (toolCallId, params, signal?, onUpdate?)：
 * 第一个实参是字符串 toolCallId，参数对象在第二个位置。
 * 曾写成单参 execute(params)，导致 reason 永远读不到、稳定返回「reason 不能为空」。
 * 编译期拦不住（形参更少合法 + 末尾 as unknown 断言），只能靠这条运行时契约守住。
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { HANDOFF_PROPOSE_TOOL_NAME } from '@profer/shared'
import { buildPiHandoffProposalTools } from './pi-builtin-tools'
import { handoffProposalService } from '../handoff-proposal-service'

interface CapturedTool {
  name: string
  parameters: Record<string, unknown>
  execute?: (...args: unknown[]) => Promise<unknown>
}

function createPiSdkStub(): { sdk: never; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const sdk = {
    defineTool(tool: CapturedTool) {
      tools.push(tool)
      return tool
    },
  }
  return { sdk: sdk as never, tools }
}

describe('Pi propose_handoff execute 调用契约', () => {
  const sessionId = 'pi-propose-handoff-execute-contract'

  beforeEach(() => handoffProposalService.clearSession(sessionId))
  afterEach(() => handoffProposalService.clearSession(sessionId))

  function buildTool(captured: unknown[]): CapturedTool {
    const { sdk, tools } = createPiSdkStub()
    buildPiHandoffProposalTools(sdk, {
      sessionId,
      handoffProposal: {
        policy: 'alwaysAsk',
        planMode: false,
        onPropose: (proposal) => { captured.push(proposal) },
      },
    })
    return tools.find((tool) => tool.name === HANDOFF_PROPOSE_TOOL_NAME)!
  }

  test('Given 模型给出交接理由 When 按 (toolCallId, params) 调用 Then 登记成功且字段不丢失', async () => {
    const captured: unknown[] = []
    const tool = buildTool(captured)
    const reason = '上下文已经很脏，一个阶段刚做完'
    const nextSteps = '先读交接文档，确认再动手'

    // 按 SDK 真实签名调用：第一个参数是 toolCallId，params 在第二个位置。
    const result = await tool.execute!('tool-call-1', { reason, nextSteps }) as { details?: Record<string, unknown> }

    expect(result.details?.accepted).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ reason, nextSteps })
  })

  test('Given reason 为空白 When 调用 execute Then 拒绝且不登记', async () => {
    const captured: unknown[] = []
    const tool = buildTool(captured)

    const result = await tool.execute!('tool-call-2', { reason: '   ' }) as { details?: Record<string, unknown> }

    expect(result.details).toMatchObject({ accepted: false, reason: 'reason 不能为空' })
    expect(captured).toHaveLength(0)
  })

  test('Given 同会话已有待确认提议 When 再次调用 Then 拒绝重复入队', async () => {
    const captured: unknown[] = []
    const tool = buildTool(captured)
    await tool.execute!('tool-call-3', { reason: '第一次提议' })

    const result = await tool.execute!('tool-call-4', { reason: '第二次提议' }) as { details?: Record<string, unknown> }

    expect(result.details?.accepted).toBe(false)
    expect(result.details?.reason).toContain('已有待确认')
    expect(captured).toHaveLength(1)
  })

  test('Given 计划模式 When 构建工具 Then 不注入 propose_handoff', () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiHandoffProposalTools(sdk, {
      sessionId,
      handoffProposal: { policy: 'alwaysAsk', planMode: true, onPropose: () => {} },
    })
    expect(tools).toHaveLength(0)
  })

  test('Given 工具 schema When 检查 parameters Then 是合法 JSON Schema 且 reason 必填', () => {
    const tool = buildTool([])
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.required).toEqual(['reason'])
    const properties = tool.parameters.properties as Record<string, { type?: string }>
    expect(Object.keys(properties).sort()).toEqual(['nextSteps', 'reason'])
    for (const property of Object.values(properties)) expect(property.type).toBe('string')
  })
})
