import type { CommandExecutionResult } from './command-execution'

/**
 * Keeps one structured command result per Pi tool call until its tool_result
 * arrives. The orchestrator owns the lifecycle and deletes entries after merge.
 */
export interface CommandExecutionLedger {
  set(toolCallId: string, result: CommandExecutionResult): void
  get(toolCallId: string): CommandExecutionResult | undefined
  delete(toolCallId: string): void
}

export function createCommandExecutionLedger(): CommandExecutionLedger {
  const results = new Map<string, CommandExecutionResult>()
  return {
    set(toolCallId, result) {
      results.set(toolCallId, result)
    },
    get(toolCallId) {
      return results.get(toolCallId)
    },
    delete(toolCallId) {
      results.delete(toolCallId)
    },
  }
}
