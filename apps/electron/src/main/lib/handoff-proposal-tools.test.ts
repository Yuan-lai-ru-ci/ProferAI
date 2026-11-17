import { describe, expect, test } from 'bun:test'
import { HANDOFF_PROPOSE_TOOL_NAME, isHandoffProposalToolName } from '@profer/shared'
import { shouldInjectHandoffProposalTool } from './handoff-proposal-tools'

describe('交接提议工具注入条件', () => {
  test('Given 普通用户轮次 When 判定 Then 注入工具（模型可自主提议）', () => {
    expect(shouldInjectHandoffProposalTool({ planMode: false })).toBe(true)
  })

  test('Given 计划模式 When 判定 Then 不注入（用户还没确认要做什么）', () => {
    expect(shouldInjectHandoffProposalTool({ planMode: true })).toBe(false)
  })
})

describe('交接提议工具名', () => {
  test('Given Claude 的 MCP 全名或裸名 When 判定 Then 都不作为普通过程块展示', () => {
    expect(HANDOFF_PROPOSE_TOOL_NAME).toBe('propose_handoff')
    expect(isHandoffProposalToolName('propose_handoff')).toBe(true)
    expect(isHandoffProposalToolName('mcp__handoff_proposal__propose_handoff')).toBe(true)
    expect(isHandoffProposalToolName('Read')).toBe(false)
    expect(isHandoffProposalToolName(undefined)).toBe(false)
  })
})
