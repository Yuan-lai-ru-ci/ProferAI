import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AGENT_RUNTIME, isAgentRuntime, isProferPermissionMode, normalizeAgentPresetReference, type AgentSessionMeta } from '@profer/shared'
import type { CoreAgentRuntime } from './runtime'
import type { CoreConfig } from './config'
import { resolveCorePreset } from './preset-resources'

export interface CoreConfiguredSessionInput {
  title?: string
  workspaceId?: string
  channelId?: string
  modelId?: string
  runtime?: 'claude' | 'pi'
  presetId?: string
  permissionMode?: AgentSessionMeta['permissionMode']
}

/** 在所属Core内解析默认配置；显式错误选择拒绝，绝不从桌面默认值猜测。 */
export function configuredSessionInput(config: CoreConfig, runtime: Pick<CoreAgentRuntime, 'workspaces' | 'listChannelConfigs'>, input: CoreConfiguredSessionInput) {
  for (const field of ['title', 'workspaceId', 'channelId', 'modelId', 'presetId'] as const) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field]!.trim())) throw new Error(`会话创建字段无效：${field}`)
  }
  if (input.title && input.title.length > 200) throw new Error('会话标题过长')
  if (input.runtime !== undefined && !isAgentRuntime(input.runtime)) throw new Error('无效的Agent runtime')
  if (input.permissionMode !== undefined && !isProferPermissionMode(input.permissionMode)) throw new Error('无效的权限模式')
  const path = join(config.configDir, 'settings.json')
  const settings: { agentRuntime?: unknown; agentChannelId?: unknown; agentModelId?: unknown } = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const engine = input.runtime ?? (isAgentRuntime(settings.agentRuntime) ? settings.agentRuntime : DEFAULT_AGENT_RUNTIME)
  const workspace = input.workspaceId ? runtime.workspaces.list().find(item => item.id === input.workspaceId) : undefined
  if (input.workspaceId && !workspace) throw new Error('Core工作区不存在')
  const available = runtime.listChannelConfigs().filter(channel => channel.enabled !== false && (!channel.agentRuntimes || channel.agentRuntimes.includes(engine)))
  const preferred = input.channelId ?? (typeof settings.agentChannelId === 'string' ? settings.agentChannelId : undefined)
  const channel = available.find(item => item.id === preferred) ?? (input.channelId === undefined ? available[0] : undefined)
  if (!channel) throw new Error('Core没有可用的所属渠道，或所选渠道不支持当前runtime')
  const preferredModel = input.modelId ?? (typeof settings.agentModelId === 'string' ? settings.agentModelId : undefined)
  const models = channel.models?.filter(model => model.enabled)
  const modelId = models?.find(model => model.id === preferredModel)?.id
    ?? (input.modelId === undefined ? models?.[0]?.id : undefined)
  // 缺少模型catalog时只接受显式模型；不编造provider默认模型。
  const selectedModel = modelId ?? (channel.models === undefined ? input.modelId : undefined)
  if (!selectedModel) throw new Error('Core所选模型不存在、未启用或缺少模型配置')
  const candidate: AgentSessionMeta = { id: '', title: input.title?.trim() ?? '新 Agent 会话', agentRuntime: engine, workspaceId: input.workspaceId,
    presetId: input.presetId, permissionMode: input.permissionMode ?? 'auto', createdAt: 0, updatedAt: 0 }
  const resources = resolveCorePreset(config, candidate, workspace)
  return { title: candidate.title, runtime: engine, channelId: channel.id, modelId: selectedModel, workspaceId: input.workspaceId,
    presetId: resources.preset.id, presetReference: normalizeAgentPresetReference(resources.reference, workspace?.slug), permissionMode: resources.policy.permissionMode }
}
