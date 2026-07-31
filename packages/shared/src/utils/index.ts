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
  supports1MContext,
  inferContextWindow,
  normalizeContextModelId,
  isDeepSeekV4Model,
  resolveAgentSdkModelId,
  resolveContextWindowFromModelUsage,
} from './context-window'
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
export { supportsProviderPlanQuota } from './channel-plan-quota'
// 定时任务触发时间展开（日历视图展示用，多值调度适配）
export {
  getAutomationOccurrencesByDay,
  AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY,
} from './automation-schedule'
export type {
  AutomationScheduleFields,
  AutomationOccurrenceDay,
} from './automation-schedule'
