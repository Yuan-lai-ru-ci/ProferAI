import type { AgentRuntime, AgentSessionMeta, Automation, CreateAutomationInput, UpdateAutomationInput } from '@profer/shared'
export interface AutomationAgentToolContext { sessionId: string; channelId: string; modelId?: string; agentRuntime?: AgentRuntime; workspaceId?: string; triggeredBy?: 'user' | 'automation' | 'delegation' | 'goal' }
export interface AutomationToolOperations {
 listAutomations(): Automation[]
 getAutomation(id: string): Automation | undefined
 createAutomation(input: CreateAutomationInput): Automation
 updateAutomation(input: UpdateAutomationInput): Automation | undefined
 deleteAutomation(id: string): boolean
 runAutomationNow(id: string): Promise<unknown>
 broadcastAutomationsChanged(): void
 getAgentSessionMeta(id: string): AgentSessionMeta | undefined
}
