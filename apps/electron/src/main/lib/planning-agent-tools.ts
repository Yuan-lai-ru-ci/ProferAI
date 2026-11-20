/** Desktop adapter for the shared Claude Planning tool definitions. */
import { injectClaudePlanningMcpServer } from '@profer/agent-provider-claude'
import * as operations from './planning-agent-operations'
import type { PlanningAgentToolContext } from './planning-agent-operations'
export interface PlanningMcpToolContext extends PlanningAgentToolContext { disabledTools?: string[] }
export async function injectPlanningMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: PlanningMcpToolContext,
): Promise<void> {
  return injectClaudePlanningMcpServer(sdk, mcpServers, ctx, operations)
}
