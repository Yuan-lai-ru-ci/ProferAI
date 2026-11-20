import type { IpcRenderer } from 'electron'
import {
  AGENT_IPC_CHANNELS,
  AGENT_PRESET_IPC_CHANNELS,
  CHAT_IPC_CHANNELS,
  CHAT_TOOL_IPC_CHANNELS,
  KNOWLEDGE_IPC_CHANNELS,
} from '@profer/shared'
import { SETTINGS_IPC_CHANNELS, VOICE_DICTATION_IPC_CHANNELS } from '../types'
import type {
  AgentEffort,
  AgentPreset,
  AgentSessionMeta,
  AgentThinkingLevel,
  AgentAttachDirectoryInput,
  AgentRuntime,
  AgentRuntime as Runtime,
  ChatToolInfo,
  ChatToolState,
  ConversationMeta,
  FileDialogResult,
  KnowledgeItem,
  PresetReference,
  ProferPermissionMode,
  ProviderType,
  ReasoningCapability,
} from '@profer/shared'
import type { AppSettings, VoiceDictationSettings } from '../types'

export interface ComposerPreloadApi {
  chat: {
    updateModel: (id: string, modelId?: string, channelId?: string) => Promise<ConversationMeta>
    openFileDialog: () => Promise<FileDialogResult>
    listKnowledgeItems: () => Promise<KnowledgeItem[]>
  }
  agent: {
    updateModel: (id: string, channelId?: string, modelId?: string) => Promise<AgentSessionMeta>
    updatePermissionMode: (sessionId: string, mode: ProferPermissionMode, expectedRevision?: number) => Promise<AgentSessionMeta>
    updateOpenAIThinkingLevel: (sessionId: string, level: AgentThinkingLevel | null) => Promise<AgentSessionMeta>
    updateEffort: (sessionId: string, effort: AgentEffort | null) => Promise<AgentSessionMeta>
    updateRuntime: (sessionId: string, runtime: AgentRuntime) => Promise<AgentSessionMeta>
    listPresets: (workspaceSlug?: string, includeInactiveGlobal?: boolean) => Promise<AgentPreset[]>
    rebindPreset: (sessionId: string, reference: PresetReference, expectedRevision?: number) => Promise<AgentSessionMeta>
    openFileDialog: () => Promise<FileDialogResult>
    openFolderDialog: () => Promise<{ path: string; name: string } | null>
    getReasoningCapability: (provider: ProviderType, modelId: string | undefined, baseUrl?: string) => Promise<ReasoningCapability | undefined>
    getGraphSummary: (sessionId: string) => Promise<import('@profer/project-core').GraphSummary>
    attachDirectory: (input: AgentAttachDirectoryInput) => Promise<string[]>
  }
  tools: {
    list: () => Promise<ChatToolInfo[]>
    updateState: (toolId: string, state: ChatToolState) => Promise<void>
  }
  voice: {
    getSettings: () => Promise<VoiceDictationSettings>
    toggle: () => Promise<void>
  }
  settings: {
    update: (updates: Partial<AppSettings>) => Promise<AppSettings>
  }
}

/** 输入区工具栏的 preload 适配器；只编排既有业务 channel，不新增旁路协议。 */
export function createComposerApi(ipcRenderer: Pick<IpcRenderer, 'invoke'>, invokeResource: IpcRenderer['invoke'] = ipcRenderer.invoke.bind(ipcRenderer)): ComposerPreloadApi {
  return {
    chat: {
      updateModel: (id, modelId, channelId) => invokeResource(CHAT_IPC_CHANNELS.UPDATE_MODEL, id, modelId, channelId),
      openFileDialog: () => invokeResource(CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG),
      listKnowledgeItems: () => ipcRenderer.invoke(KNOWLEDGE_IPC_CHANNELS.LIST_ITEMS),
    },
    agent: {
      updateModel: (id, channelId, modelId) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_MODEL, id, channelId, modelId),
      updatePermissionMode: (sessionId, mode, expectedRevision) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE, sessionId, mode, expectedRevision),
      updateOpenAIThinkingLevel: (sessionId, level) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_OPENAI_THINKING, sessionId, level),
      updateEffort: (sessionId, effort) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_AGENT_EFFORT, sessionId, effort),
      updateRuntime: (sessionId, runtime) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_AGENT_RUNTIME, sessionId, runtime),
      listPresets: (workspaceSlug, includeInactiveGlobal) => invokeResource(AGENT_PRESET_IPC_CHANNELS.LIST_PRESETS, workspaceSlug, includeInactiveGlobal),
      rebindPreset: (sessionId, reference, expectedRevision) => ipcRenderer.invoke(AGENT_PRESET_IPC_CHANNELS.REBIND_SESSION_REFERENCE, sessionId, reference, expectedRevision),
      openFileDialog: () => invokeResource(CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG),
      openFolderDialog: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FOLDER_DIALOG),
      getReasoningCapability: (provider, modelId, baseUrl) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_PI_REASONING_CAPABILITY, provider, modelId, baseUrl),
      getGraphSummary: (sessionId) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_GRAPH_SUMMARY, sessionId),
      attachDirectory: (input) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_DIRECTORY, input),
    },
    tools: {
      list: () => ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS),
      updateState: (toolId, state) => ipcRenderer.invoke(CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE, toolId, state),
    },
    voice: {
      getSettings: () => ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.GET_SETTINGS),
      toggle: () => ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.TOGGLE),
    },
    settings: {
      update: (updates) => ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.UPDATE, updates),
    },
  }
}
