import type { createStore } from 'jotai/vanilla'
import type { AgentRuntime, AgentWorkspace } from '@profer/shared'
import type { AppSettings } from '../../types/settings'
import { DEFAULT_AGENT_RUNTIME } from '../../types/settings'
import {
  agentChannelIdAtom, agentModelIdAtom, agentChannelIdsAtom, agentRuntimeAtom,
  agentThinkingAtom, agentEffortAtom, agentMaxBudgetUsdAtom, agentMaxTurnsAtom,
  agentSettingsReadyAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom,
} from '../atoms/agent-atoms'
import { coreTargetsAtom } from '../atoms/core-target-atoms'
import { channelsAtom, channelsLoadedAtom } from '../atoms/chat-atoms'
import { authStatusAtom } from '../atoms/identity-atoms'
import { resolveAgentRuntimeSelection } from './agent-channel-selection'
import { getVisibleAgentWorkspaces, isAgentWorkspaceVisible } from './product-feature-flags'

interface AgentSettingsInitializationDeps {
  getSettings: () => Promise<AppSettings>
  listWorkspaces: () => Promise<AgentWorkspace[]>
  onFailure: (error: unknown) => void
  /** 内核回退要落盘：主进程创建 Agent 会话时读 settings.agentRuntime。 */
  updateSettings?: (patch: { agentRuntime: AgentRuntime }) => Promise<unknown>
}

/** 启动水合只改变默认状态；目录和历史会话元数据均不由这里写回。 */
export function initializeAgentSettings(
  store: ReturnType<typeof createStore>, deps: AgentSettingsInitializationDeps,
): () => void {
  let active = true
  let generation = 0
  let settingsLoaded = false
  let reconciling = false
  let defaultsRevision = 0
  const reconcile = (): void => {
    if (!active || !settingsLoaded || !store.get(channelsLoadedAtom) || reconciling) return
    reconciling = true
    try {
      const channelId = store.get(agentChannelIdAtom)
      const modelId = store.get(agentModelIdAtom)
      const runtime = store.get(agentRuntimeAtom)
      // 当前内核没有可用渠道时回退到渠道支持的内核（配一个渠道就该能用）。
      const selection = resolveAgentRuntimeSelection(store.get(channelsAtom), runtime,
        store.get(agentChannelIdsAtom), channelId && modelId ? { channelId, modelId } : null)
      if (selection && selection.runtime !== runtime) {
        store.set(agentRuntimeAtom, selection.runtime)
        const persist = deps.updateSettings
        if (persist) void persist({ agentRuntime: selection.runtime }).catch(deps.onFailure)
      }
      if (channelId !== (selection?.channelId ?? null)) store.set(agentChannelIdAtom, selection?.channelId ?? null)
      if (modelId !== (selection?.modelId ?? null)) store.set(agentModelIdAtom, selection?.modelId ?? null)
      store.set(agentSettingsReadyAtom, true)
    } finally { reconciling = false }
  }
  const subscriptions = [agentChannelIdAtom, agentModelIdAtom, agentChannelIdsAtom, agentRuntimeAtom]
    .map((target) => store.sub(target, () => { defaultsRevision += 1 }))
  subscriptions.push(store.sub(channelsAtom, reconcile), store.sub(channelsLoadedAtom, reconcile),
    store.sub(agentRuntimeAtom, reconcile), store.sub(agentChannelIdsAtom, reconcile))
  const load = (): void => {
    const request = ++generation
    settingsLoaded = false
    store.set(agentSettingsReadyAtom, false)
    const revision = defaultsRevision
    const thinking = store.get(agentThinkingAtom)
    const effort = store.get(agentEffortAtom)
    const budget = store.get(agentMaxBudgetUsdAtom)
    const turns = store.get(agentMaxTurnsAtom)
    const workspaceId = store.get(currentAgentWorkspaceIdAtom)
    const workspaceSnapshot = store.get(agentWorkspacesAtom)
    const coreTarget = store.get(coreTargetsAtom)
    void Promise.all([deps.getSettings(), deps.listWorkspaces()]).then(([settings, workspaces]) => {
      if (!active || request !== generation) return
      // 启动读取期间已修改默认模型/内核时，旧设置回执不得覆盖用户选择。
      if (revision === defaultsRevision) {
        const runtime = settings.agentRuntime ?? DEFAULT_AGENT_RUNTIME
        store.set(agentRuntimeAtom, runtime)
        store.set(agentChannelIdAtom, settings.agentChannelId ?? null)
        store.set(agentModelIdAtom, settings.agentModelId ?? null)
        const configuredIds = settings.agentChannelIds ?? []
        store.set(agentChannelIdsAtom, runtime === 'claude' && settings.agentChannelId
          ? [...new Set([...configuredIds, settings.agentChannelId])] : configuredIds)
      }
      if (store.get(agentThinkingAtom) === thinking && settings.agentThinking !== undefined) store.set(agentThinkingAtom, settings.agentThinking)
      if (store.get(agentEffortAtom) === effort && settings.agentEffort !== undefined) store.set(agentEffortAtom, settings.agentEffort)
      if (store.get(agentMaxBudgetUsdAtom) === budget && settings.agentMaxBudgetUsd !== undefined) store.set(agentMaxBudgetUsdAtom, settings.agentMaxBudgetUsd)
      if (store.get(agentMaxTurnsAtom) === turns && settings.agentMaxTurns !== undefined) store.set(agentMaxTurnsAtom, settings.agentMaxTurns)
      const currentCore = store.get(coreTargetsAtom)
      const sameCore = currentCore.currentId === coreTarget.currentId && currentCore.generation === coreTarget.generation
      if (sameCore && store.get(agentWorkspacesAtom) === workspaceSnapshot) store.set(agentWorkspacesAtom, workspaces)
      if (sameCore && !settings.coreTabStates && store.get(currentAgentWorkspaceIdAtom) === workspaceId) {
        const currentWorkspaces = store.get(agentWorkspacesAtom)
        const saved = currentWorkspaces.find((workspace) => workspace.id === settings.agentWorkspaceId)
        store.set(currentAgentWorkspaceIdAtom, saved && isAgentWorkspaceVisible(saved)
          ? saved.id : getVisibleAgentWorkspaces(currentWorkspaces)[0]?.id ?? null)
      }
      settingsLoaded = true
      reconcile()
    }).catch((error: unknown) => {
      if (!active || request !== generation) return
      deps.onFailure(error)
      store.set(agentSettingsReadyAtom, true)
    })
  }
  subscriptions.push(store.sub(authStatusAtom, load))
  load()
  return () => {
    active = false
    generation += 1
    subscriptions.forEach((unsubscribe) => unsubscribe())
  }
}
