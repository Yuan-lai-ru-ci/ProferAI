import type { AutomationAgentToolContext } from '@profer/agent-runtime/automation-tool-operations'
import { injectAutomationMcpServer as injectShared } from '@profer/agent-provider-claude/automation-tools'
import { createAutomation, deleteAutomation, getAutomation, listAutomations, updateAutomation } from './automation-manager'
import { broadcastChanged as broadcastAutomationsChanged, runAutomationNow } from './automation-scheduler'
import { getAgentSessionMeta } from './agent-session-manager'
export async function injectAutomationMcpServer(sdk: typeof import('@anthropic-ai/claude-agent-sdk'), mcpServers: Record<string, Record<string, unknown>>, ctx: AutomationAgentToolContext, disabledTools?: string[]): Promise<void> {
 return injectShared(sdk, mcpServers, ctx, disabledTools, { listAutomations, getAutomation, createAutomation, updateAutomation, deleteAutomation, runAutomationNow, broadcastAutomationsChanged, getAgentSessionMeta })
}
