/** 自动任务表单纯逻辑：校验、保存字段映射与通知目标，不依赖 React 或宿主。 */
import type { AutomationDraft } from './automation-draft'
import type {
  AutomationFeishuNotificationTarget,
  AutomationNotificationTarget,
  CreateAutomationInput,
  FeishuChatBinding,
  UpdateAutomationInput,
} from '@profer/shared'

export function canPersistDraft(draft: AutomationDraft): boolean {
  // 草稿保存门槛：只要有任务名和任务描述就保存为草稿（缺 channelId / workspaceId 会被强制不启用）
  return !!(draft.name.trim() && draft.prompt.trim())
}

/** 任务是否具备运行 / 启用所需的最小完整度（模型 + 工作区） */
export function isReadyToRun(draft: AutomationDraft): boolean {
  return canPersistDraft(draft) && !!draft.channelId && !!draft.workspaceId
}

/** 列出当前还缺哪些必填项（用于"运行一次" Tooltip 与关闭时的 toast 提示） */
export function listMissingFields(draft: AutomationDraft): string[] {
  const missing: string[] = []
  if (!draft.name.trim()) missing.push('任务名称')
  if (!draft.prompt.trim()) missing.push('任务描述')
  if (!draft.channelId) missing.push('模型')
  if (!draft.workspaceId) missing.push('工作区')
  return missing
}

export function getDraftSignature(draft: AutomationDraft): string {
  return JSON.stringify({
    id: draft.id ?? '',
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    scheduleType: draft.scheduleType,
    intervalMinutes: draft.intervalMinutes,
    timeOfDay: draft.timeOfDay,
    dayOfWeek: draft.dayOfWeek,
    dayOfMonth: draft.dayOfMonth,
    channelId: draft.channelId,
    modelId: draft.modelId ?? '',
    agentRuntime: draft.agentRuntime,
    workspaceId: draft.workspaceId ?? '',
    permissionMode: draft.permissionMode,
    presetId: draft.presetId ?? '',
    sessionMode: draft.sessionMode,
    notificationTargets: draft.notificationTargets ?? [],
    active: draft.active,
  })
}

export function draftToCreateInput(draft: AutomationDraft): CreateAutomationInput {
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    scheduleType: draft.scheduleType,
    intervalMinutes: draft.intervalMinutes,
    timeOfDay: draft.timeOfDay,
    dayOfWeek: draft.dayOfWeek,
    dayOfMonth: draft.dayOfMonth,
    channelId: draft.channelId,
    modelId: draft.modelId,
    agentRuntime: draft.agentRuntime,
    workspaceId: draft.workspaceId,
    permissionMode: draft.permissionMode,
    presetId: draft.presetId,
    sessionMode: draft.sessionMode,
    notificationTargets: draft.notificationTargets,
    sourceSessionId: draft.sourceSessionId,
    active: draft.active,
  }
}

export function draftToUpdateInput(draft: AutomationDraft): UpdateAutomationInput {
  return {
    id: draft.id ?? '',
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    scheduleType: draft.scheduleType,
    intervalMinutes: draft.intervalMinutes,
    timeOfDay: draft.timeOfDay,
    dayOfWeek: draft.dayOfWeek,
    dayOfMonth: draft.dayOfMonth,
    channelId: draft.channelId,
    modelId: draft.modelId,
    agentRuntime: draft.agentRuntime,
    workspaceId: draft.workspaceId ?? '',
    permissionMode: draft.permissionMode,
    presetId: draft.presetId ?? '',
    sessionMode: draft.sessionMode,
    notificationTargets: draft.notificationTargets ?? [],
    active: draft.active,
  }
}

export function getFeishuTarget(targets?: AutomationNotificationTarget[]): AutomationFeishuNotificationTarget | undefined {
  return targets?.find((target): target is AutomationFeishuNotificationTarget => target.type === 'feishu')
}

export function getFeishuBindingValue(binding: FeishuChatBinding): string {
  return `${binding.botId}::${binding.chatId}`
}

export function formatFeishuBinding(binding: FeishuChatBinding): string {
  const name = binding.chatType === 'group'
    ? binding.groupName || '未命名群聊'
    : '飞书单聊'
  return `${name} · ${binding.botId.slice(0, 8)}`
}

export function createFeishuTarget(binding: FeishuChatBinding): AutomationFeishuNotificationTarget {
  return {
    type: 'feishu',
    enabled: true,
    trigger: 'always',
    botId: binding.botId,
    chatId: binding.chatId,
  }
}
