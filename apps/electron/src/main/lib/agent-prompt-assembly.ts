/** 唯一的本轮 system prompt 装配入口。模块负责内容，编排器只传运行事实。 */
import { buildSystemPrompt, type SystemPromptContext } from './agent-prompt-builder'
import { buildLightSystemPrompt, type AgentPromptMode } from './agent-prompt-mode'
import { buildPiTaskPrompt } from './pi-task-prompt'
import type { AgentRuntime } from '@profer/shared'
import { resolveAgentRuntimeSystemPrompt, type AgentSystemPromptPolicy } from './agent-system-prompt-policy'

export interface AgentPromptAssemblyInput {
  mode: AgentPromptMode
  runtime: AgentRuntime
  policy: AgentSystemPromptPolicy
  context: SystemPromptContext
  userMessage: string
  toolNames: readonly string[]
  forceAutomation?: boolean
  skillCatalog?: string
  attachedDirectories?: string
  customSections?: readonly string[]
  automationContext?: string
}

export function assembleAgentSystemPrompt(input: AgentPromptAssemblyInput) {
  const core = input.mode === 'light'
    ? buildLightSystemPrompt({ presetName: input.context.presetName, epistemicMode: input.policy.epistemicMode })
    : buildSystemPrompt(input.context)
  const base = input.mode === 'standard' && input.runtime === 'pi'
    ? buildPiTaskPrompt({
        basePrompt: core,
        userMessage: input.userMessage,
        toolNames: input.toolNames,
        forceAutomation: input.forceAutomation,
        pptCapabilityActive: input.context.pptCapabilityActive,
      })
    : core
  const text = [
    base,
    ...(input.mode === 'standard' ? [input.skillCatalog, input.attachedDirectories] : []),
    ...(input.customSections ?? []),
    ...(input.automationContext ? [`## 定时任务执行上下文\n\n${input.automationContext}`] : []),
  ].filter(Boolean).join('\n\n')
  const policy = input.mode === 'light' ? { ...input.policy, useClaudeCodePreset: false } : input.policy
  return {
    text,
    systemPrompt: resolveAgentRuntimeSystemPrompt(input.runtime, policy, text),
    // 字符数是装配诊断，不冒充 provider tokenizer 的 token 统计。
    chars: text.length,
  }
}
