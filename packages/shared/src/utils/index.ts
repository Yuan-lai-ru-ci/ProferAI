/**
 * Shared utility functions for proma
 */

// Placeholder - will be expanded as needed
export function noop(): void {
  // no-op
}

export { diffCapabilities } from './capabilities-diff'
export type { CapabilityChange } from './capabilities-diff'
export {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  CODEX_GPT_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  supports1MContext,
  supportsVerified1MContext,
  isNextGeneration1MContextModel,
  inferContextWindow,
  normalizeContextModelId,
  isDeepSeekV4Model,
  resolveAgentSdkModelId,
  strip1MContextSuffix,
  resolveOneMillionContextDecision,
  resolveAgentSdk1MSelection,
  inferAgentSdkContextWindow,
  resolveContextWindowFromModelUsage,
} from './context-window'
export type { OneMillionContextSource, OneMillionContextDecision, AgentSdk1MSelection } from './context-window'
export { calculateContextUsageRatio } from './context-usage'
export {
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
  formatThinkingSignatureError,
  normalizeThinkingSignatureError,
} from './thinking-signature-error'
export { normalizePathForCompare } from './normalize-path'
export {
  DEFAULT_IMAGE_ATTACHMENT_PROMPT,
  resolveAgentAttachmentPrompt,
  isImageAttachmentMediaType,
} from './agent-image-attachment'
export type { AgentAttachmentKind } from './agent-image-attachment'
export { supportsProviderPlanQuota } from './channel-plan-quota'
export { promoteMru, removeMruId, selectMruFallbackId } from './tab-mru'
// Pi 自动压缩阈值（80% 占用触发）
export {
  PI_AUTO_COMPACTION_THRESHOLD_RATIO,
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
} from './pi-compaction'
// 定时任务触发时间展开（日历视图展示用，多值调度适配）
export {
  getAutomationOccurrencesByDay,
  AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY,
} from './automation-schedule'
export type {
  AutomationScheduleFields,
  AutomationOccurrenceDay,
} from './automation-schedule'
