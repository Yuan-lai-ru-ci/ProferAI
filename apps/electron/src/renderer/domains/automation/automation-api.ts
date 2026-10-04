import type { AgentPreset, AgentSessionMeta, Automation, CreateAutomationInput, FeishuChatBinding, Recommendation, RecommendationFeedbackInput, UpdateAutomationInput } from '@profer/shared'

/** Automation renderer domain 需要的最小宿主契约。页面不再直接依赖完整 electronAPI。 */
export type AutomationApi = Pick<Window['electronAPI'],
  | 'listAutomations'
  | 'createAutomation'
  | 'updateAutomation'
  | 'deleteAutomation'
  | 'toggleAutomation'
  | 'runAutomationNow'
  | 'listFeishuBindings'
  | 'listAgentPresets'
  | 'getDefaultAgentPreset'
  | 'listAgentSessions'
  | 'refreshRecommendations'
  | 'respondToRecommendation'
  | 'onRecommendationsChanged'
>

function host(): AutomationApi {
  return window.electronAPI
}

export function listAutomations(): Promise<Automation[]> {
  return host().listAutomations()
}

export function createAutomation(input: CreateAutomationInput): Promise<Automation> {
  return host().createAutomation(input)
}

export function updateAutomation(input: UpdateAutomationInput): Promise<Automation | undefined> {
  return host().updateAutomation(input)
}

export function deleteAutomation(id: string): Promise<boolean> {
  return host().deleteAutomation(id)
}

export function toggleAutomation(id: string, active: boolean): Promise<Automation | undefined> {
  return host().toggleAutomation(id, active)
}

export function runAutomationNow(id: string): Promise<void> {
  return host().runAutomationNow(id)
}

export function listFeishuBindings(): Promise<FeishuChatBinding[]> {
  return host().listFeishuBindings()
}

export function listAgentPresets(workspaceSlug?: string): Promise<AgentPreset[]> {
  return host().listAgentPresets(workspaceSlug)
}

export function getDefaultAgentPreset(workspaceSlug?: string): Promise<string> {
  return host().getDefaultAgentPreset(workspaceSlug)
}

export function listAgentSessions(includeArchived?: boolean): Promise<AgentSessionMeta[]> {
  return host().listAgentSessions(includeArchived)
}

export function refreshRecommendations(): Promise<Recommendation[]> {
  return host().refreshRecommendations()
}

export function respondToRecommendation(input: RecommendationFeedbackInput): Promise<Recommendation> {
  return host().respondToRecommendation(input)
}

export function onRecommendationsChanged(callback: () => void): () => void {
  return host().onRecommendationsChanged(callback)
}
