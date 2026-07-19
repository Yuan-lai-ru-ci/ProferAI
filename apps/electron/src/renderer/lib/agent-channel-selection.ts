import type { AgentRuntime } from '@profer/shared'

/** Pi can use every enabled channel without changing Claude's compatibility whitelist. */
export function nextAgentChannelIdsAfterModelSelect(
  currentChannelIds: string[],
  selectedChannelId: string,
  runtime: AgentRuntime,
): string[] {
  if (runtime !== 'claude') return currentChannelIds
  return currentChannelIds.includes(selectedChannelId)
    ? currentChannelIds
    : [...currentChannelIds, selectedChannelId]
}
