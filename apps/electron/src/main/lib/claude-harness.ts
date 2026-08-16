/**
 * Claude runtime 的 harness 追踪器（B1-5：Claude 侧验证兜底对齐）。
 *
 * 复用运行时中立的 harness 判定引擎（pi-harness.ts），从 Claude SDK 消息流喂入工具事实：
 * - assistant 消息的 tool_use 块登记 {name, input}（按 tool_use_id 建映射）；
 * - user 消息的 tool_result 块回填 outcome（is_error → failed）：失败的写入不计入变更，
 *   验证命令（Bash/PowerShell）无论成败都视为「已尝试验证」；
 * - resume 回放的 replay 消息一律忽略，保证只跟踪当前 turn 的真实工具活动；
 * - 用户软中断（aborted_streaming / aborted_tools）与 Pi 对齐：markBlocked，本轮 query
 *   生命周期内不再追加验证续轮；
 * - 终态 result 评估：错误类结果（subtype error_* / max_turns / prompt_too_long）标记终态
 *   失败；正常结束且存在未验证写入时产出 follow-up 提示，由 adapter 注入下一轮并保持通道开启。
 *
 * 权限与风险控制仍完全归编排层负责；本模块只产出「只做验证」的续轮提示。
 */

import type { SDKMessage } from '@profer/shared'
import {
  createAgentHarness,
  type AgentHarnessDecision,
  type AgentHarnessToolCall,
} from './pi-harness'

/** 用户软中断类 terminal_reason：出现即按 Pi 语义 markBlocked（本 query 不再兜底续轮）。 */
const INTERRUPT_TERMINAL_REASONS: ReadonlySet<string> = new Set(['aborted_streaming', 'aborted_tools'])

/** 明确属于失败终态的 terminal_reason（无错误 subtype 时的兜底判定）。 */
const FAILURE_TERMINAL_REASONS: ReadonlySet<string> = new Set(['max_turns', 'prompt_too_long'])

export interface ClaudeHarnessTracker {
  /** 观察一条 SDK 消息：喂入工具事实 / 登记中断 / 忽略 replay。 */
  observeMessage(message: SDKMessage): void
  /** 终态 result 处置：返回 follow-up 提示（应续轮）或 undefined（应正常收束）。 */
  evaluateTerminalResult(message: SDKMessage): string | undefined
  /** 本轮决策（诊断落盘用；幂等，不消耗 follow-up 状态）。 */
  createDecision(): AgentHarnessDecision
}

export function createClaudeHarnessTracker(options: { userPrompt: string; cwd?: string }): ClaudeHarnessTracker {
  const harness = createAgentHarness(options)
  /** tool_use_id → 待回填结果的工具调用（Claude 的 tool_result 块不携带 name/input）。 */
  const pendingToolUses = new Map<string, AgentHarnessToolCall>()

  function observeMessage(message: SDKMessage): void {
    if ((message as { isReplay?: boolean }).isReplay) return

    if (message.type === 'assistant') {
      const assistant = message as import('@profer/shared').SDKAssistantMessage
      for (const block of assistant.message?.content ?? []) {
        if (block.type !== 'tool_use') continue
        const use = block as { id?: string; name?: string; input?: unknown }
        if (typeof use.id === 'string' && typeof use.name === 'string') {
          pendingToolUses.set(use.id, {
            name: use.name,
            input: isRecord(use.input) ? use.input : {},
          })
        }
      }
      return
    }

    if (message.type === 'user') {
      const user = message as import('@profer/shared').SDKUserMessage
      for (const block of user.message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        const result = block as { tool_use_id?: string; is_error?: boolean }
        if (typeof result.tool_use_id !== 'string') continue
        const call = pendingToolUses.get(result.tool_use_id)
        if (!call) continue
        pendingToolUses.delete(result.tool_use_id)
        harness.recordToolResult({
          name: call.name,
          input: call.input,
          outcome: result.is_error ? 'failed' : 'succeeded',
        })
      }
      return
    }

    if (message.type === 'result') {
      const result = message as { terminal_reason?: string }
      if (result.terminal_reason && INTERRUPT_TERMINAL_REASONS.has(result.terminal_reason)) {
        // 与 Pi 对齐：用户软中断后不再自动追加验证续轮，避免打扰用户的新指令。
        harness.markBlocked()
      }
    }
  }

  function evaluateTerminalResult(message: SDKMessage): string | undefined {
    if (message.type !== 'result') return undefined
    const result = message as { subtype?: string; terminal_reason?: string }
    // 错误类结果 / 达到轮次上限 / prompt 过长：属于失败终态，不追加验证续轮。
    const failedSubtype = typeof result.subtype === 'string' && result.subtype.startsWith('error')
    const failedTerminalReason = result.terminal_reason != null && FAILURE_TERMINAL_REASONS.has(result.terminal_reason)
    if (failedSubtype || failedTerminalReason) {
      harness.markTerminalFailure()
      return undefined
    }
    return harness.createFollowUpPrompt()
  }

  return {
    observeMessage,
    evaluateTerminalResult,
    createDecision: () => harness.createDecision(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
