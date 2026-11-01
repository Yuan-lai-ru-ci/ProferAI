/** 本轮提示词装配入口：稳定 system 与随新用户消息追加的任务指导分开返回。 */
import { buildSystemPrompt, type SystemPromptContext } from './agent-prompt-builder'
import { buildLightSystemPrompt, type AgentPromptMode } from './agent-prompt-mode'
import { splitPiTaskPrompt } from './pi-task-prompt'
export { appendAgentTaskPrompt } from '@profer/shared'
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
    ? buildLightSystemPrompt({ presetName: input.context.presetName })
    : buildSystemPrompt({
      ...input.context,
      ...(input.runtime === 'pi' ? {
        collaborationToolNames: input.toolNames
          .filter((name) => name.startsWith('mcp__collaboration__'))
          .map((name) => name.split('__').at(-1)!),
      } : {}),
    })
  const taskPromptOptions = {
    basePrompt: core,
    toolNames: [...input.toolNames],
    forceAutomation: input.forceAutomation,
    pptCapabilityActive: input.context.pptCapabilityActive,
  }
  const useTaskPrompt = input.mode === 'standard' && input.runtime === 'pi'
  const taskPromptForMessage = (userMessage: string): string => useTaskPrompt
    ? splitPiTaskPrompt({ ...taskPromptOptions, userMessage }).taskPrompt
    : ''
  const piPrompt = useTaskPrompt
    ? splitPiTaskPrompt({ ...taskPromptOptions, userMessage: input.userMessage })
    : { systemPrompt: core, taskPrompt: '' }
  const text = [
    piPrompt.systemPrompt,
    ...(input.mode === 'standard' ? [input.skillCatalog, input.attachedDirectories] : []),
    ...(input.customSections ?? []),
    ...(input.automationContext ? [`## 定时任务执行上下文\n\n${input.automationContext}`] : []),
  ].filter(Boolean).join('\n\n')
  const policy = input.mode === 'light' ? { ...input.policy, useClaudeCodePreset: false } : input.policy
  return {
    text,
    systemPrompt: resolveAgentRuntimeSystemPrompt(input.runtime, policy, text),
    taskPrompt: piPrompt.taskPrompt,
    // 运行中追加消息复用同一份 core 与工具快照，不重算权限或把动态指导写回 system。
    taskPromptForMessage,
    // 字符数是装配诊断，不冒充 provider tokenizer 的 token 统计。
    chars: text.length,
  }
}
