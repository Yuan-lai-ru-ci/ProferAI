/** 提示词装配模式：只给无上下文的新会话短问候减负，不以消息长短猜任务意图。 */
import type { AgentSendInput, ProferPermissionMode } from '@profer/shared'
export { buildLightSystemPrompt } from './agent-prompt-core'

export type AgentPromptMode = 'light' | 'standard'

export interface AgentPromptModeInput {
  message: string
  hasRuntimeSession: boolean
  hasHistory?: boolean
  hasBrowserContext?: boolean
  hasAttachedResources?: boolean
  hasPresetInstructions?: boolean
  permissionMode: ProferPermissionMode
  request: Pick<AgentSendInput,
    'triggeredBy' | 'internalPrompt' | 'isolatedRuntimeSession' | 'automationContext'
    | 'goalRunId' | 'piHarnessManualContinuationTicket' | 'additionalDirectories'
    | 'customMcpServers' | 'permissionModeOverride' | 'mentionedSkills'
    | 'mentionedMcpServers' | 'mentionedSessionIds'>
}

// 锚定整条消息：带附件、引用、命令或任务内容的「你好」不会误命中。
const SIMPLE_CONVERSATION = /^(?:你好(?:呀|啊|哦|吗)?|您好|嗨|哈[喽啰]|早(?:上)?好|晚上好|下午好|谢谢(?:你)?|多谢|再见|晚安|你是谁|你是什么|hello|hi|hey|thanks|thank you|good morning|good evening|bye)[\s!！?？。,.，~～]*$/iu

export function selectAgentPromptMode(input: AgentPromptModeInput): AgentPromptMode {
  const { request } = input
  if (input.hasRuntimeSession || input.hasHistory || input.hasBrowserContext || input.hasAttachedResources || input.hasPresetInstructions || input.permissionMode === 'plan') return 'standard'
  // permissionMode 已由冻结预设策略解析。桌面每次都传 override，字段存在不代表执行任务。
  if (request.triggeredBy && request.triggeredBy !== 'user') return 'standard'
  if (request.internalPrompt !== undefined || request.isolatedRuntimeSession || request.automationContext
    || request.goalRunId || request.piHarnessManualContinuationTicket
    || request.additionalDirectories?.length || Object.keys(request.customMcpServers ?? {}).length
    || request.mentionedSkills?.length || request.mentionedMcpServers?.length || request.mentionedSessionIds?.length) return 'standard'
  return SIMPLE_CONVERSATION.test(input.message.trim()) ? 'light' : 'standard'
}
