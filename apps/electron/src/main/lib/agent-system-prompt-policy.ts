import type { AgentRuntime } from '@profer/shared'
import type { AppSettings } from '../../types'
import type { AgentEpistemicMode } from './agent-prompt-builder'

export interface AgentSystemPromptPolicy {
  epistemicMode: AgentEpistemicMode
  useClaudeCodePreset: boolean
}

export type AgentRuntimeSystemPrompt = string | {
  type: 'preset'
  preset: 'claude_code'
  append: string
}

/**
 * 开放认识论属于开发者实验能力；任一门禁未开启时都保持默认 grounded 姿态。
 */
export function resolveAgentSystemPromptPolicy(settings: Pick<AppSettings, 'developerModeEnabled' | 'openEpistemicModeEnabled'>): AgentSystemPromptPolicy {
  const open = settings.developerModeEnabled === true && settings.openEpistemicModeEnabled === true
  return {
    epistemicMode: open ? 'open' : 'grounded',
    useClaudeCodePreset: !open,
  }
}

/** 根据 runtime 与本轮冻结的策略生成最终 system prompt 形态。 */
export function resolveAgentRuntimeSystemPrompt(
  runtime: AgentRuntime,
  policy: AgentSystemPromptPolicy,
  systemPrompt: string,
): AgentRuntimeSystemPrompt {
  if (runtime === 'pi' || !policy.useClaudeCodePreset) return systemPrompt
  return {
    type: 'preset',
    preset: 'claude_code',
    append: systemPrompt,
  }
}
