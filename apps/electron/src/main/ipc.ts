/**
 * IPC 处理器模块
 *
 * 负责注册主进程和渲染进程之间的通信处理器
 */

import { ipcMain, nativeTheme, shell, dialog, BrowserWindow, app, Notification } from 'electron'
import type { WebContents } from 'electron'
import { isAbsolute, join, relative, resolve, sep, dirname, basename, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { IPC_CHANNELS, CHANNEL_IPC_CHANNELS, CHAT_IPC_CHANNELS, AGENT_IPC_CHANNELS, AGENT_PRESET_IPC_CHANNELS, INSTALLER_IPC_CHANNELS, CHAT_TOOL_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, RECOMMENDATION_IPC_CHANNELS, PLANNING_IPC_CHANNELS, AUTH_IPC_CHANNELS, canSelectAgentSessionRuntime, AGENT_SESSION_RUNTIME_LOCKED_MESSAGE, normalizeAgentRuntime, isAgentRuntime, isChannelEnabledForRuntime, isProferPermissionMode, normalizePathForCompare, DEFAULT_PRESET_ID, type AgentThinkingLevel, type AgentEffort, PLANNING_CONFLICT_ERROR, type Todo, type TodoListQuery, type CalendarEvent, type CalendarEventListQuery, type CreateTodoInput, type UpdateTodoInput, type CreateCalendarEventInput, type UpdateCalendarEventInput, type StartTodoAgentInput, type StartTodoAgentResult, type CreatePlanningGroupInput, type UpdatePlanningGroupInput, type PlanningGroup, type PlanningGroupScope, type PlanningTag, type PlanningReminder, type ActivePlanningReminder, type SnoozePlanningReminderInput, type TodoAgentSessionActivation, type ProviderType, type ReasoningCapability, type AgentPreset, type AgentPresetCreateInput, type AgentPresetUpdateInput, type AgentPresetImportResult, type OtherWorkspacePresetsGroup, type PresetReference, type PresetReferenceReport, type PresetScopeRebindResult } from '@profer/shared'
import { SETTINGS_IPC_CHANNELS, SKIN_IPC_CHANNELS } from '../types'
import { registerRuntimeGitIpc } from './lib/runtime-git-ipc'
import { getBuildTarget } from './lib/build-target'
import { agentFilePreviewSessionManager } from './lib/agent-file-preview-session'
import { resolvePiReasoningCapability } from './lib/adapters/pi-model-registry'
import type {
  RuntimeStatus,
  GitRepoStatus,
  Channel,
  ConversationMeta,
  ChatMessage,
  ChatSendInput,
  GenerateTitleInput,
  AttachmentSaveInput,
  AttachmentSaveResult,
  FileDialogResult,
  RecentMessagesResult,
  AgentSessionMeta,
  AgentRuntime,
  AgentSendInput,
  UpdateAgentInterruptStateInput,
  AgentWorkspace,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentAttachDirectoryInput,
  AgentAttachFileInput,
  WorkspaceAttachDirectoryInput,
  WorkspaceAttachFileInput,
  GetTaskOutputInput,
  GetTaskOutputResult,
  StopTaskInput,
  WorkspaceMcpConfig,
  SkillMeta,
  WorkspaceCapabilities,
  WorkspaceMemorySummary,
  SkillFileContent,
  SkillFileNode,
  MasterSkillMeta,
  MasterSkillVersion,
  SyncSkillResult,
  SkillConflict,
  FileEntry,
  FileSearchResult,
  InstallerManifest,
  InstallerSource,
  PermissionResponse,
  ProferPermissionMode,
  AskUserResponse,
  ExitPlanModeResponse,
  ChatToolInfo,
  ChatToolState,
  ChatToolMeta,
  MoveSessionToWorkspaceInput,
  ForkSessionInput,
  ListSessionProcessesInput,
  KillProcessInput,
  SessionProcessInfo,
  SDKBackgroundTaskSummary,
  RewindSessionInput,
  RewindSessionResult,
  AgentSessionReferenceSearchInput,
  SDKMessage,
  GetFileDiffInput,
  DetachedPreviewWindowInput,
  RevertFileInput,
  FileAccessOptions,
  ResolvedFileUrl,
  Automation,
  CreateAutomationInput,
  UpdateAutomationInput,
  BrowserTabListResult,
  BrowserViewState,
  BrowserViewLayout,
  BrowserNavigateInput,
  BrowserTabInput,
  BrowserCreateTabInput,
  BrowserTranslateResult,
  BrowserStartPageState,
  BrowserAddBookmarkInput,
} from '@profer/shared'
import { KNOWLEDGE_IPC_CHANNELS } from '@profer/shared'
import type { AppSettings } from '../types'
import { browserController } from './lib/browser-controller'
import { normalizeOfvThemePayload, type OfvThemeTokens } from '@profer/shared'
import type { ViewerPreviewTheme } from './lib/browser-preview-service'
import { resolveBrowserProfileKey } from './lib/browser-profile-policy'
import { listBookmarks, addBookmark, removeBookmark, listHistory, clearHistory } from './lib/browser-start-page-store'
import { getMainRepoRoot } from './lib/git-diff-service'
import { registerProferDirectoryPath, registerProferFilePath } from './lib/local-file-protocol'
import { isReadOnlyPreviewPathAllowed } from './lib/preview-path-policy'
import { registerUpdaterIpc } from './lib/updater/updater-ipc'
import { registerChannelIpc } from './lib/channel-ipc'
import { listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getChannelById,
} from './lib/channel-manager'
import { ChannelNetworkRequests } from './lib/channel-network-requests'
import { listChannelsWithBackgroundSync } from './lib/local-first-channel-listing'
import { cancelXaiOAuthLogin } from './lib/xai-oauth-service'
import { cancelCodexOAuthLogin } from './lib/codex-oauth-service'
import { listCodexModels, listXaiModels } from './lib/adapters/pi-model-registry'
import {
  listConversations,
  createConversation,
  appendMessage,
  getConversationMessages,
  getConversationBranch,
  setActivePath,
  getBranchTree,
  forkBranchAt,
  appendBranchTail,
  getMessageContent,
  getRecentMessages,
  updateConversationMeta,
  deleteConversation,
  deleteMessage,
  truncateMessagesFrom,
  updateContextDividers,
  autoArchiveConversations,
  searchConversationMessages,
  countArchivedConversations,
} from './lib/conversation-manager'
import { sendMessage, stopGeneration, generateTitle, autoTitleConversation, regenerateConversationTitle, type AutoTitleConversationInput } from './lib/chat-service'
import {
  saveAttachment,
  readAttachmentAsBase64,
  deleteAttachment,
  openFileDialog,
} from './lib/attachment-service'
import { extractTextFromAttachment } from './lib/document-parser'
import { getTutorialContent, createWelcomeConversation, getFrpGuideContent } from './lib/tutorial-service'
import { registerUserProfileIpc } from './lib/user-profile-ipc'
import { registerStorageIpc } from './lib/storage-ipc'
import { registerQuickTaskIpc } from './lib/quick-task-ipc'
import { registerVoiceDictationIpc } from './lib/voice-dictation-ipc'
import { registerMigrationIpc } from './lib/migration-ipc'
import { registerWindowIpc } from './lib/window-ipc'
import { registerPlanningIpc } from './lib/planning-ipc'
import { registerAccountIpc } from './lib/account-ipc'
import { registerLarkIpc } from './lib/lark-ipc'
import { registerWeChatIpc } from './lib/wechat-ipc'
import { registerDingTalkIpc } from './lib/dingtalk-ipc'
import { registerFeishuIpc } from './lib/feishu-ipc'
import { registerGlobalSkillIpc } from './lib/global-skill-ipc'
import { registerKnowledgeIpc } from './lib/knowledge-ipc'
import { registerDesktopNotificationIpc } from './lib/desktop-notification-ipc'
import { getSettings, updateSettings } from './lib/settings-service'
import { registerSkinIpc } from './lib/skin-ipc'
import { registerInstallerIpc } from './lib/installer-ipc'
import { registerProxyIpc } from './lib/proxy-ipc'
import { getRemoteServiceStatus, setRemoteServiceEnabled, restartRemoteService, getRemotePairingQr, getRemoteBindings, removeRemoteBinding, getRemoteProfile, getRemotePairingAudit, startRemoteFrp, rotateRemoteTls, getRemoteTlsCertificate } from './lib/remote-service'
import { getFrpStatus, saveFrpConfig, checkFrpReleases, installFrp, rollbackFrp, startFrp, stopFrp, exportFrpDeployment, copyFrpDeploymentInstructions, getFrpDeploymentInstructions, generateFrpMaterial, regenerateFrpMaterial, testFrpEndpoint, type FrpConfig } from './lib/remote-frp-service'
import { updateWindowFrameAppearance } from './lib/titlebar-overlay'

import { listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
} from './lib/automation-manager'
import { runAutomationNow, broadcastChanged as broadcastAutomationsChanged } from './lib/automation-scheduler'
import { applyRecommendationFeedback, listRecommendations } from './lib/recommendation-manager'
import { refreshAutomationRecommendations } from './lib/recommendation-engine'
import {
  listPlanningGroups,
  createPlanningGroup,
  updatePlanningGroup,
  deletePlanningGroup,
  listPlanningTags,
  createPlanningTag,
  updatePlanningTag,
  deletePlanningTag,
  listActivePlanningReminders,
  acknowledgePlanningReminder,
  snoozePlanningReminder,
  listTodos,
  createTodo,
  getTodo,
  updateTodo,
  deleteTodo,
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from './lib/planning-manager'
import { broadcastPlanningChanged } from './lib/planning-events'
import {
  listAgentSessions,
  createAgentSession,
  ensureProjectDraftAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  appendSDKMessages,
  updateAgentSessionMeta,
  deleteAgentSession,
  getAgentSessionDeletionOrder,
  migrateChatToAgentSession,
  moveSessionToWorkspace,
  forkAgentSession,
  searchAgentSessionMessages,
  searchAgentSessionReferences,
  createDelegatedChildSessionMeta,
  findOrphanSessions,
  snapshotAgentRuntimeMeta,
  restoreAgentRuntimeMeta,
  countArchivedAgentSessions,
} from './lib/agent-session-manager'
import { listAgentPresets, listGlobalAgentPresets, getDefaultPresetId, setDefaultPresetId, setDefaultPresetReference, enableGlobalPresetInWorkspace, disableGlobalPresetInWorkspace, rebindAndDisableGlobalPresetScope, setWorkspacePresetEnabled, rebindAgentSessionPreset, rebindAutomationPreset, createAgentPreset, createGlobalAgentPreset, promoteWorkspacePresetToGlobal, copyAgentPreset, copyPresetToWorkspace, updateAgentPreset, updateGlobalAgentPreset, deleteAgentPreset, deleteGlobalAgentPreset, getAgentPreset, getPresetReferenceReport, serializeAgentPresetsForExport, importAgentPresets } from './lib/agent-preset-manager'
import { getAgentSessionNavigationIndex } from './lib/agent-navigation-index'
import { onAgentRunComplete, runAgent, stopAgent, stopAgentAndWait, stopGoalRunAndWait, isGoalRunActive, beginAgentSessionDeletion, endAgentSessionDeletion, generateAgentTitle, regenerateAgentTitle, saveFilesToAgentSession, saveFilesToWorkspaceFiles, isAgentSessionActive, queueAgentMessage, updateAgentPermissionMode, rewindAgentSession, restoreActiveAgentStreams, registerWebContents, getSessionWebContents, getAgentRuntimeCapabilities, getAgentTaskOutput, stopAgentTask, emitSessionStreamEvent, agentCatalogInvalidationPublisher } from './lib/agent-service'
import { publishAgentSessionProjection, setAgentSessionUnread, updateAgentSessionUiMeta } from './lib/agent-session-ui-projection-publisher'
import { setQuoteableSelection } from './menu'
import { buildArchiveToggleUpdates } from './lib/agent-unread-policy'
import { getAgentUnreadPolicyMode } from './lib/agent-unread-mode'
import { mapSdkShellTasks, isSameProcess, terminateProcessTreeGracefully, type MonitoredProcess } from './lib/process-monitor'
import { listOwnedRuntimeProcesses, markOwnedRuntimeProcessExited, onRuntimeProcessRegistryChanged } from './lib/runtime-process-registry'
import { isProcessHandleOwnedBySession, processHandleFromRuntimeRecord } from './lib/process-handle'
import { coordinateAgentSend } from './lib/agent-send-coordinator'
import { GoalSessionService } from './lib/goal-session-service'
import { loadGoalStates, saveGoalStates, archiveGoalState, loadGoalHistory } from './lib/goal-store'
import { resolveEffectivePermissionMode } from '@profer/shared'
import type { AgentGoalContract, AgentGoalLimitsPatch, AgentGoalState } from '@profer/shared'
import { getAgentPresetByReference, presetReferenceForId } from './lib/agent-preset-manager'
import { AgentSessionDeletionCoordinator } from './lib/agent-session-deletion'
import { permissionService } from './lib/agent-permission-service'
import { askUserService } from './lib/agent-ask-user-service'
import { exitPlanService } from './lib/agent-exit-plan-service'
import { assertMainWindowSender } from './lib/ipc-sender-guard'
import { registerVisualizationIpc } from './lib/visualization-ipc'
import { registerAutomationIpc } from './lib/automation-ipc'
import { registerSettingsIpc } from './lib/settings-ipc'
import { registerHeatmapMigrationIpc } from './lib/heatmap-migration-ipc'
import type { MainWindowGetter } from './lib/ipc-sender-guard'
import { getMainWindow } from './lib/main-window-state'
import { isMainAppWindowSender } from './lib/main-app-windows'
import { registerAppIconIpc } from './lib/app-icon-ipc'
import { registerPenOcrIpc } from './lib/pen-ocr-ipc'
import { registerDockBadgeIpc } from './lib/dock-badge-ipc'
import { registerEnvironmentIpc } from './lib/environment-ipc'
import { registerNotificationSoundIpc } from './lib/notification-sound-ipc'
import { registerScratchPadIpc } from './lib/scratch-pad-ipc'
import { getAgentSessionWorkspacePath, getAgentWorkspacesDir, getWorkspaceSkillsDir, getWorkspaceFilesDir, getAgentWorkspacePath } from './lib/config-paths'
import {
  listAgentWorkspaces,
  createAgentWorkspace,
  updateAgentWorkspace,
  deleteAgentWorkspace,
  reorderAgentWorkspaces,
  ensureDefaultWorkspace,
  getWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
  getAllWorkspaceSkills,
  promoteWorkspaceSkillToGlobal,
  getOtherWorkspaceSkills,
  getOtherWorkspacePresets,
  importPresetFromWorkspace,
  getDefaultSkillSlugs,
  getWorkspaceCapabilities,
  getWorkspaceMemorySummary,
  getAgentWorkspace,
  createWorkspaceSkill,
  deleteWorkspaceSkill,
  importSkillFromWorkspace,
  updateSkillFromSource,
  readWorkspaceSkillContent,
  writeWorkspaceSkillContent,
  readWorkspaceSkillCard,
  writeWorkspaceSkillCard,
  toggleWorkspaceSkill,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  createSkillEntry,
  deleteSkillEntry,
  renameSkillEntry,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
  attachWorkspaceDirectory,
  attachWorkspaceFile,
  detachWorkspaceDirectory,
  detachWorkspaceFile,
  getWorktreeRepos,
  addWorktreeRepo,
  removeWorktreeRepo,
  cleanupStaleWorkspaceAttachedPaths,
  readWorkspaceProfile,
  writeWorkspaceProfile,
  listWorkspaceAutoMemoryFiles,
  readWorkspaceAutoMemoryFile,
  writeWorkspaceAutoMemoryFile,
  listWorkspaceMemoryArchiveFiles,
  readWorkspaceMemoryArchiveFile,
  writeWorkspaceMemoryArchiveFile,
  getWorkspaceMemoryArchivePath,
  getWorkspaceAutoMemoryDir,
} from './lib/agent-workspace-manager'
import { resolveMemoryWikilink, findMemoryBacklinks } from './lib/memory-wikilink-service'
import { assertSafeSkillSegment } from './lib/skill-path-security'
import { searchFileCandidate, type FileSearchResult as FileCandidateSearchResult } from './lib/file-search-service'
import { createMemoryArchiveSearcher } from './lib/memory-archive-search'
import type { MemoryWikilinkTarget, MemoryBacklink } from '@profer/shared'
import { getAllToolInfos } from './lib/chat-tool-registry'
import { updateToolState, updateToolCredentials, getToolCredentials, addCustomTool, deleteCustomTool } from './lib/chat-tool-config'
import { registerSystemPromptIpc } from './lib/system-prompt-ipc'
import { registerGitHubReleaseIpc } from './lib/github-release-ipc'
import { watchAttachedDirectory, unwatchAttachedDirectory } from './lib/workspace-watcher'
import { feishuBridgeManager } from './lib/feishu-bridge-manager'

/** 文件浏览器中需要隐藏的系统文件 */
const HIDDEN_FS_ENTRIES = new Set(['.DS_Store', 'Thumbs.db'])
const channelNetworkRequests = new ChannelNetworkRequests()

/** 同一会话的并发删除合并为一条 stop-and-wait 生命周期。 */
const agentSessionDeletionCoordinator = new AgentSessionDeletionCoordinator()

const GOAL_STORE_PATH = () => join(app.getPath('userData'), 'goals.json')

const goalSessionService = new GoalSessionService({
  getSession: (sessionId) => getAgentSessionMeta(sessionId),
  isSessionActive: isAgentSessionActive,
  isPlanMode: (sessionId) => {
    const session = getAgentSessionMeta(sessionId)
    const workspaceSlug = session?.workspaceId ? getAgentWorkspace(session.workspaceId)?.slug : undefined
    const reference = session?.presetReference ?? presetReferenceForId(workspaceSlug, session?.presetId)
    const preset = getAgentPresetByReference(reference, workspaceSlug)
    return resolveEffectivePermissionMode(preset.permissionMode, session?.permissionMode) === 'plan'
  },
  run: async (input) => {
    // 多窗口：优先把 Goal 本轮事件发给该会话当前绑定的窗口；
    // 没有绑定（例如从未在本进程跑过）时回退主窗口。
    const bound = getSessionWebContents(input.sessionId)
    const mainWindow = getMainWindow()
    const target = bound ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)
    if (!target) throw new Error('Profer 窗口不可用，Goal 已停止')
    await runAgent(input, target)
  },
  stopRun: stopGoalRunAndWait,
  readStates: () => loadGoalStates(GOAL_STORE_PATH()),
  saveStates: (states) => saveGoalStates(GOAL_STORE_PATH(), states),
  archive: (state) => archiveGoalState(GOAL_STORE_PATH(), state),
  history: (sessionId) => loadGoalHistory(GOAL_STORE_PATH(), sessionId),
  readMessages: getAgentSessionSDKMessages,
  appendMessages: appendSDKMessages,
  createBlockedTodo: (state, session) => createTodo({
    title: `[Goal 受阻] ${state.goal.slice(0, 60)}`,
    notes: `会话：${session?.title || state.sessionId}\n阻塞原因：${state.stopReason || state.lastSummary || '需要输入'}\n处理后可回到该会话执行 /goal resume 继续。`,
    priority: 'high',
    workspaceId: session?.workspaceId,
  }).id,
  updateBlockedTodo: (id, status, notes) => { updateTodo({ id, status, notes }) },
  publish: (state) => {
    // 多窗口：Goal 状态跟着会话绑定窗口走；未绑定时回退主窗口，
    // 避免向所有窗口广播导致每个窗口都弹一次完成/受阻提示。
    const target = getSessionWebContents(state.sessionId) ?? getMainWindow()?.webContents
    if (target && !target.isDestroyed()) {
      target.send(AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: state.sessionId, state })
    }
  },
  logError: (error) => { console.error('[goal] 会话状态同步失败', error) },
})

// 人发起的运行结束后，受阻 / 被中断的 Goal 自动续上（桌面、Pocket、IM 入口共用）。
onAgentRunComplete((sessionId, initiator) => { void goalSessionService.onRunFinished(sessionId, initiator) })

function restoreGoalStatesOnce(): void {
  try { goalSessionService.restore() } catch (error) { console.error('[goal] 状态恢复失败', error) }
}

/** 应用进程退出前暂停所有 Goal，并保存完整状态供下次恢复。 */
export function stopAllGoalsForProcessExit(): void {
  goalSessionService.stopAll()
}

/** 已知编辑器应用名称白名单（macOS） */
const KNOWN_EDITORS = [
  'Visual Studio Code', 'Cursor', 'Sublime Text', 'Windsurf',
  'Zed', 'CotEditor', 'IntelliJ IDEA', 'Xcode', 'TextEdit',
]

/**
 * 检查路径是否在允许的目录范围内（解析 symlink）
 *
 * extraAllowedPaths 来自 renderer 的 basePaths（用户通过 UI 附加的目录），
 * 虽然 renderer 不可信，但附加目录功能本身就允许用户授权 workspaces 外的路径访问。
 * 攻击者需要先控制 renderer 才能伪造 basePaths，此时已有更大的攻击面。
 */
function realpathOrResolve(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function getAuthorizedRoots(options?: FileAccessOptions): string[] {
  const roots: string[] = [
    getAgentWorkspacesDir(),
    join(tmpdir(), 'profer-preview'),
  ]

  // 添加用户常用目录授权（Desktop、Documents、Downloads 等）
  // 这些目录通常包含用户希望与 Agent 交互的文件
  // 注意：不包含用户主目录本身，防止 Agent 访问 ~/.ssh、~/.aws 等敏感目录
  const userHome = homedir()
  const commonUserDirs = [
    join(userHome, 'Desktop'),
    join(userHome, 'Documents'),
    join(userHome, 'Downloads'),
    join(userHome, 'Pictures'),
    join(userHome, 'Videos'),
  ]
  roots.push(...commonUserDirs)

  const workspaceSlugs = new Set<string>()

  if (options?.sessionId) {
    const meta = getAgentSessionMeta(options.sessionId)
    if (meta?.attachedDirectories) {
      roots.push(...meta.attachedDirectories)
    }
    if (meta?.attachedFiles) {
      roots.push(...meta.attachedFiles)
    }
    if (meta?.workspaceId) {
      const workspace = getAgentWorkspace(meta.workspaceId)
      if (workspace?.slug) workspaceSlugs.add(workspace.slug)
    }
  }

  if (options?.workspaceSlug) {
    workspaceSlugs.add(options.workspaceSlug)
  }

  for (const slug of workspaceSlugs) {
    roots.push(getWorkspaceFilesDir(slug))
    roots.push(...getWorkspaceAttachedDirectories(slug))
    roots.push(...getWorkspaceAttachedFiles(slug))
  }

  return roots
}

function isUnderRoot(resolvedPath: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root)
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep)
}

function isResolvedPathInsideRoot(targetPath: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(targetPath))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function assertInsideAgentWorkspaces(targetPath: string): void {
  if (!isResolvedPathInsideRoot(targetPath, getAgentWorkspacesDir())) {
    throw new Error('访问路径超出 Agent 工作区范围')
  }
}

/**
 * 通过 Windows Restart Manager (Rstrtmgr.dll) 查询占用指定文件/目录的进程名（友好名，如 "Microsoft Word"）。
 * 经 PowerShell P/Invoke 调用（零额外依赖），路径通过环境变量传入避免命令行引号转义。
 * 仅在删除/重命名失败（被占用）时触发，属低频操作。
 */
const RM_QUERY_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class RM {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
}
'@
Add-Type -TypeDefinition $src
$handle = [uint32]0
[void][RM]::RmStartSession([ref]$handle, 0, [Guid]::NewGuid().ToString('N'))
try {
  [void][RM]::RmRegisterResources($handle, 1, @($env:PROFER_QUERY_PATH), 0, $null, 0, $null)
  $needed = [uint32]0
  $count = [uint32]0
  $reboot = [uint32]0
  [void][RM]::RmGetList($handle, [ref]$needed, [ref]$count, $null, [ref]$reboot)
  if ($needed -gt 0) {
    $procs = New-Object 'RM+RM_PROCESS_INFO[]' $needed
    $count = $needed
    [void][RM]::RmGetList($handle, [ref]$needed, [ref]$count, $procs, [ref]$reboot)
    for ($i = 0; $i -lt $count; $i++) {
      $p = $procs[$i]
      Write-Output ("{0}|{1}" -f $p.Process.dwProcessId, $p.strAppName)
    }
  }
} finally {
  [void][RM]::RmEndSession($handle)
}
`

/** 查询占用指定文件/目录的进程名列表 */
function findLockingProcesses(filePath: string): Promise<string[]> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (names: string[]) => { if (!settled) { settled = true; resolve(names) } }
    const timer = setTimeout(() => finish([]), 3000)

    // -EncodedCommand 用 UTF-16LE Base64 传脚本，避免 here-string 换行/引号在命令行传参时被破坏
    const encoded = Buffer.from(RM_QUERY_SCRIPT, 'utf16le').toString('base64')

    let ps: ChildProcessWithoutNullStreams
    try {
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, PROFER_QUERY_PATH: filePath },
        windowsHide: true,
      })
    } catch {
      clearTimeout(timer)
      return finish([])
    }

    let out = ''
    ps.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    ps.stderr.on('data', () => {})
    ps.on('error', () => { clearTimeout(timer); finish([]) })
    ps.on('close', () => {
      clearTimeout(timer)
      const names: string[] = []
      for (const line of out.split(/\r?\n/)) {
        const name = line.trim().split('|')[1]
        if (name) names.push(name)
      }
      finish(names)
    })
  })
}

/**
 * 把删除/回收站/重命名的底层错误规整成人类可读、无路径乱码的文案。
 * 底层错误（如 rmSync 抛出的 EPERM）的 message 里带完整路径，经 Electron IPC 序列化后
 * 中文路径会乱码，code 字段也会丢失——所以必须在主进程端就转换成干净文案再抛给渲染层。
 */
async function toFsErrorMessage(
  err: unknown,
  action: '删除' | '移入回收站' | '重命名',
  filePath?: string,
): Promise<string> {
  const code = (err as { code?: string })?.code ?? ''
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY') {
    // 递归删除目录时 EPERM 通常指向具体被占用的子文件，用 err.path 更精确
    const failedPath = (err as { path?: string })?.path ?? filePath
    if (failedPath) {
      const names = await findLockingProcesses(failedPath)
      if (names.length > 0) {
        const unique = [...new Set(names)]
        return `文件或文件夹正被 ${unique.join('、')} 占用，请先关闭后再${action}`
      }
    }
    return '文件或文件夹正被其他程序占用，请先关闭占用它的程序后重试'
  }
  if (code === 'ENOENT') {
    return '文件或文件夹已不存在'
  }
  const raw = err instanceof Error ? err.message : String(err ?? '')
  // shell.trashItem 在文件被占用/操作被取消时抛 "Operation was aborted"
  if (/aborted|cancel/i.test(raw)) {
    if (filePath) {
      const names = await findLockingProcesses(filePath)
      if (names.length > 0) {
        const unique = [...new Set(names)]
        return `文件或文件夹正被 ${unique.join('、')} 占用，请先关闭后再${action}`
      }
    }
    return '操作被中止'
  }
  return `无法${action}`
}

function parseHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // SSRF 防护：阻止打开本地/私有网络地址，防止攻击者探测内网服务
    const hostname = parsed.hostname.toLowerCase()
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]' ||
      hostname === '[::]' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.startsWith('169.254.') ||
      hostname.endsWith('.local')
    ) {
      console.warn('[IPC] parseHttpUrl 拒绝本地/私有地址:', hostname)
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function isPathAllowed(filePath: string, options?: FileAccessOptions): boolean {
  // deny-by-default：渲染进程不可信，未提供访问选项时拒绝越权访问。
  // 调用方必须显式传递 sessionId 或 workspaceSlug 来声明授权上下文；即使有 sessionId，
  // 也只能访问该上下文的显式授权根，不能把“普通文件”当成授权凭证。
  if (!options) {
    console.warn('[IPC] isPathAllowed 拒绝：未提供 FileAccessOptions')
    return false
  }
  let resolved: string
  try {
    resolved = realpathSync(resolve(filePath))
  } catch {
    return false
  }

  // 1. 优先检查标准授权根目录（工作区 + 常用用户目录）
  if (getAuthorizedRoots(options).some((root) => isUnderRoot(resolved, root))) {
    return true
  }

  // 不再提供“有 sessionId 就放行工作区外任意普通文件”的 fallback。
  // sessionId 只用于解析会话/工作区的显式授权根；它本身不是任意本地路径的授权。
  return false
}

/**
 * 只读预览判定：授权根内的路径优先放行；授权根之外的路径放宽到「真实存在且非系统/凭据敏感」。
 *
 * 会话里的文件链接来自 Agent 输出，路径常落在工作区之外（皮肤目录、/tmp 日志、~/Library 等），
 * 这些路径用户已在对话里看见，点开预览不应再被授权根拦住。边界说明见 preview-path-policy.ts。
 *
 * 只用于只读预览类 handler；写操作与「用默认应用打开文件」必须继续使用 isPathAllowed。
 */
function isPreviewPathAllowed(filePath: string, options?: FileAccessOptions): boolean {
  if (options && isPathAllowed(filePath, options)) return true
  return isReadOnlyPreviewPathAllowed(filePath)
}

function normalizeFileAccessOptions(value?: FileAccessOptions | string[]): FileAccessOptions | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined
  return {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    workspaceSlug: typeof value.workspaceSlug === 'string' ? value.workspaceSlug : undefined,
    candidateBasePaths: Array.isArray(value.candidateBasePaths)
      ? value.candidateBasePaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : undefined,
    preflight: typeof value.preflight === 'boolean' ? value.preflight : undefined,
  }
}

const activeFileSearches = new Map<string, AbortController>()

function getFileSearchRoots(sessionId: string): string[] {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) return []
  const roots: string[] = []
  const seen = new Set<string>()
  const addRoot = (root: string | undefined): void => {
    if (!root) return
    const normalized = resolve(root)
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (!seen.has(key)) {
      seen.add(key)
      roots.push(normalized)
    }
  }

  const workspace = meta.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (workspace?.slug) {
    addRoot(getAgentSessionWorkspacePath(workspace.slug, sessionId))
    // 不加入整个 workspace 根目录，避免把其他 session 的 cwd/文件纳入搜索范围。
    addRoot(getWorkspaceFilesDir(workspace.slug))
    for (const directory of getWorkspaceAttachedDirectories(workspace.slug)) addRoot(directory)
  }
  for (const directory of meta.attachedDirectories ?? []) addRoot(directory)
  return roots
}

function getWorkspaceSlugsForAccess(options?: FileAccessOptions): string[] {
  const workspaceSlugs = new Set<string>()
  if (options?.sessionId) {
    const meta = getAgentSessionMeta(options.sessionId)
    if (meta?.workspaceId) {
      const workspace = getAgentWorkspace(meta.workspaceId)
      if (workspace?.slug) workspaceSlugs.add(workspace.slug)
    }
  }
  if (options?.workspaceSlug) {
    workspaceSlugs.add(options.workspaceSlug)
  }
  return Array.from(workspaceSlugs)
}

function getAllowedCandidateBasePaths(options?: FileAccessOptions): string[] | undefined {
  const allowed = options?.candidateBasePaths?.filter((p) => isPathAllowed(p, options)) ?? []
  return allowed.length > 0 ? allowed : undefined
}

async function getAccessRootMainRepo(root: string): Promise<string | null> {
  if (!existsSync(root)) return null
  let probePath = root
  try {
    const stats = statSync(probePath)
    if (stats.isFile()) probePath = dirname(probePath)
  } catch {
    return null
  }
  return getMainRepoRoot(probePath)
}

function ensurePathAllowed(filePath: string, options?: FileAccessOptions): boolean {
  if (isPathAllowed(filePath, options)) return true
  console.warn('[IPC] 拒绝越界路径:', filePath)
  return false
}

/**
 * 在 ensurePathAllowed 基础上，额外放行「已授权仓库的 worktree」。
 *
 * worktree 常被放在主仓库之外（如 ~/profer-dev/worktrees/xxx），其路径不在任何
 * 授权根下，会被 ensurePathAllowed 拒绝。但只要它回溯到的主仓库已被授权，就应放行。
 * 用 git 自身背书（--git-common-dir），避免粗暴跳过安全检查。
 */
async function ensurePathAllowedWithWorktree(filePath: string, options?: FileAccessOptions): Promise<boolean> {
  if (isPathAllowed(filePath, options)) return true
  const mainRepo = await getMainRepoRoot(filePath)
  if (mainRepo && isPathAllowed(mainRepo, options)) return true
  if (mainRepo) {
    const targetMainRepo = normalizePathForCompare(realpathOrResolve(mainRepo))
    for (const root of getAuthorizedRoots(options)) {
      const authorizedMainRepo = await getAccessRootMainRepo(root)
      if (!authorizedMainRepo) continue
      const authorizedRoot = normalizePathForCompare(realpathOrResolve(authorizedMainRepo))
      if (authorizedRoot === targetMainRepo) return true
    }
    for (const workspaceSlug of getWorkspaceSlugsForAccess(options)) {
      let repos: import('@profer/shared').WorkspaceWorktreeRepo[]
      try {
        repos = await getWorktreeRepos(workspaceSlug)
      } catch {
        continue
      }
      for (const repo of repos) {
        const repoMain = await getMainRepoRoot(repo.repoPath)
        const repoRoot = normalizePathForCompare(realpathOrResolve(repoMain ?? repo.repoPath))
        if (repoRoot === targetMainRepo) return true
      }
    }
  }
  console.warn('[IPC] 拒绝越界路径:', filePath)
  return false
}

/**
 * 注册 IPC 处理器
 *
 * 注册的通道：
 * - runtime:get-status: 获取运行时状态
 * - git:get-repo-status: 获取指定目录的 Git 仓库状态
 * - channel:*: 渠道管理相关
 * - chat:*: 对话管理 + 消息发送 + 流式事件
 */
/**
 * 打包内置资源目录
 * dev: __dirname/resources（build:resources 阶段拷贝）
 * prod: process.resourcesPath（electron-builder extraResources 产物）
 */
function getBundledResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
}

/**
 * 默认 App 探测结果按文件后缀缓存（含 null 负缓存），避免反复 spawn osascript / 注册表查询。
 * 进程级别一次会话足够，无需失效策略——用户切换默认 App 是低频行为，下次重启生效即可。
 */
const defaultAppCache = new Map<string, import('@profer/shared').DefaultAppInfo | null>()

function extOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

async function getAppIconDataUrl(appPath: string): Promise<string> {
  // macOS: 用 sips 把 App bundle 的 .icns 转成 64×64 PNG 再读。
  // 不要用 nativeImage.createFromPath(.icns) + resize ——某些 Electron 版本对多分辨率 .icns
  // resize 时会 SIGTRAP 直接崩主进程。
  if (process.platform === 'darwin' && appPath.endsWith('.app')) {
    const dataUrl = await getMacAppIconViaSips(appPath)
    if (dataUrl) return dataUrl
  }

  const icon = await app.getFileIcon(appPath, { size: 'large' })
  if (icon.isEmpty()) return ''
  return icon.toDataURL()
}

async function getMacAppIconViaSips(appPath: string): Promise<string> {
  const { existsSync, readFileSync, unlinkSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  // 找 .icns 文件
  const resourcesDir = join(appPath, 'Contents', 'Resources')
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  let iconName: string | null = null
  if (existsSync(plistPath)) {
    const r = await runCmd('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', plistPath], { timeoutMs: 2000 })
    if (r.status === 0) iconName = r.stdout.trim()
  }
  const candidates: string[] = []
  if (iconName) candidates.push(join(resourcesDir, iconName.endsWith('.icns') ? iconName : `${iconName}.icns`))
  candidates.push(join(resourcesDir, 'AppIcon.icns'), join(resourcesDir, 'app.icns'), join(resourcesDir, 'icon.icns'))
  const icnsPath = candidates.find((p) => existsSync(p))
  if (!icnsPath) return ''

  const tmp = mkdtempSync(join(tmpdir(), 'profer-icon-'))
  const outPath = join(tmp, 'icon.png')
  try {
    const r = await runCmd('sips', ['-s', 'format', 'png', '-Z', '64', icnsPath, '--out', outPath], { timeoutMs: 4000 })
    if (r.status !== 0 || !existsSync(outPath)) return ''
    const buf = readFileSync(outPath)
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    try { if (existsSync(outPath)) unlinkSync(outPath) } catch { /* ignore */ }
  }
}

/** 异步执行外部命令，超时即 kill；不经 shell，避免 shell 元字符注入。 */
async function runCmd(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<{ status: number | null; stdout: string }> {
  const { spawn } = await import('node:child_process')
  const { timeoutMs = 4000, stdin } = opts
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    let settled = false
    const finish = (status: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ status, stdout })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      finish(null)
    }, timeoutMs)
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
    }
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin)
    }
  })
}

function parseWindowsRegistryValue(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/\s+REG_\w+\s+(.+)$/)
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

function expandWindowsEnvPath(filePath: string): string {
  return filePath.replace(/%([^%]+)%/g, (token, name: string) => {
    const foundKey = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase())
    return foundKey ? process.env[foundKey] ?? token : token
  })
}

function parseWindowsExecutablePath(command: string): string {
  const match = command.match(/"([^"]+\.exe)"|([^\s"]+\.exe)/i)
  return expandWindowsEnvPath((match?.[1] || match?.[2] || '').trim())
}

function isSafeWindowsProgId(progId: string): boolean {
  return /^[a-zA-Z0-9_.+-]+$/.test(progId)
}

async function getWindowsDefaultAppCommand(progId: string): Promise<string> {
  if (!isSafeWindowsProgId(progId)) return ''

  const registryResult = await runCmd('reg', [
    'query',
    `HKCR\\${progId}\\shell\\open\\command`,
    '/ve',
  ])
  const registryCommand = parseWindowsRegistryValue(registryResult.stdout)
  if (registryCommand) return registryCommand

  const ftypeResult = await runCmd('cmd', ['/c', `ftype ${progId}`])
  return (ftypeResult.stdout || '').split('=').slice(1).join('=').trim()
}

async function getWindowsDefaultAppInfo(filePath: string): Promise<{ appPath: string; appName: string; isUwp?: boolean } | null> {
  const ext = extOf(filePath)
  // ext 来自渲染进程的 filePath，必须严格校验：cmd /c "assoc ${ext}" 中 & | > < 等会触发命令链
  if (!/^\.[a-zA-Z0-9]+$/.test(ext)) {
    console.log('[DefaultApp] ext 校验失败:', ext)
    return null
  }

  const userChoiceResult = await runCmd('reg', [
    'query',
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
    '/v',
    'ProgId',
  ])
  let progId = parseWindowsRegistryValue(userChoiceResult.stdout)
  console.log('[DefaultApp] ext=%s UserChoice progId=%s', ext, progId)

  if (!progId) {
    const assoc = await runCmd('cmd', ['/c', `assoc ${ext}`])
    progId = (assoc.stdout || '').split('=').slice(1).join('=').trim()
    console.log('[DefaultApp] assoc fallback progId=%s', progId)
  }
  // 第三 fallback：HKCU OpenWithList MRU（取最近使用的 exe，与 Windows 设置显示一致）
  if (!progId) {
    const mruResult = await runCmd('reg', [
      'query',
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithList`,
    ])
    const mruLine = mruResult.stdout.split(/\r?\n/).find((l) => /\s+MRUList\s+REG_SZ\s+/.test(l))
    const mruOrder = mruLine?.split(/\s+REG_SZ\s+/)[1]?.trim() ?? ''
    if (mruOrder) {
      const firstKey = mruOrder[0]
      const exeLine = mruResult.stdout.split(/\r?\n/).find((l) => new RegExp(`\\s+${firstKey}\\s+REG_SZ\\s+`).test(l))
      const exeName = exeLine?.split(/\s+REG_SZ\s+/)[1]?.trim() ?? ''
      if (exeName && /^[a-zA-Z0-9 _.+()-]+\.exe$/i.test(exeName)) {
        // 从 App Paths 把 exe 名转成 progId（取 exe 对应的 HKCR 下注册的 ProgId）
        // 直接用 exe 名（去掉 .exe）当 appName，appPath 从 App Paths 查
        const appName = exeName.replace(/\.exe$/i, '')
        const apResult = await runCmd('reg', [
          'query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, '/ve',
        ])
        let exePath = parseWindowsRegistryValue(apResult.stdout)
        if (!exePath) {
          const apResult2 = await runCmd('reg', [
            'query', `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, '/ve',
          ])
          exePath = parseWindowsRegistryValue(apResult2.stdout)
        }
        console.log('[DefaultApp] OpenWithList MRU fallback: exe=%s path=%s', exeName, exePath)
        if (exePath) return { appPath: exePath, appName }
      }
    }
  }
  // 第四 fallback：HKCU OpenWithProgids（无 UserChoice 但有文件类型关联时）
  if (!progId) {
    const owpResult = await runCmd('reg', [
      'query',
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithProgids`,
    ])
    // 取第一个非空值名（跳过空行和路径行）
    for (const line of owpResult.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_/)
      if (m && m[1] && isSafeWindowsProgId(m[1])) {
        progId = m[1]
        console.log('[DefaultApp] OpenWithProgids fallback progId=%s', progId)
        break
      }
    }
  }
  if (!progId || !isSafeWindowsProgId(progId)) {
    console.log('[DefaultApp] progId 无效或不安全:', progId)
    return null
  }

  // UWP 应用：shell\open\command 下只有 DelegateExecute，没有传统 exe 路径
  // 从 Application 子键读 ApplicationName 作为 appName
  if (progId.startsWith('AppX')) {
    const nameResult = await runCmd('reg', [
      'query', `HKCR\\${progId}\\Application`, '/v', 'ApplicationName',
    ])
    let appName = parseWindowsRegistryValue(nameResult.stdout)
    // ApplicationName 通常是资源引用 "@{...?ms-resource://...}"，取最后一段
    if (appName.startsWith('@{')) {
      const appIdResult = await runCmd('reg', [
        'query', `HKCR\\${progId}\\Application`, '/v', 'AppUserModelId',
      ])
      const appUserModelId = parseWindowsRegistryValue(appIdResult.stdout)
      // AppUserModelId 形如 "Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo"
      // 取 ! 之后的部分作为名字，再去掉前缀
      const parts = appUserModelId.split('!')
      appName = (parts[1] ?? parts[0] ?? '').replace(/^Microsoft\./, '').replace(/^Windows\./, '') || 'UWP App'
    }
    console.log('[DefaultApp] UWP app, appName=%s', appName)
    return { appPath: '', appName, isUwp: true }
  }

  const command = await getWindowsDefaultAppCommand(progId)
  console.log('[DefaultApp] open command:', command)
  const appPath = parseWindowsExecutablePath(command)
  console.log('[DefaultApp] parsed appPath:', appPath)
  if (!appPath) {
    // Fallback：从 HKCR\<progId> 默认值取 app 名，从 App Paths 找 exe
    const rootResult = await runCmd('reg', ['query', `HKCR\\${progId}`, '/ve'])
    const rootName = parseWindowsRegistryValue(rootResult.stdout)
    // AppUserModelId 字段（非 UWP 也可能有，如 Quark）
    const appModelResult = await runCmd('reg', ['query', `HKCR\\${progId}`, '/v', 'AppUserModelId'])
    const appModelId = parseWindowsRegistryValue(appModelResult.stdout)
    const candidateAppName = (appModelId || rootName || '').replace(/\s+(HTML?\s+)?(Document|File)$/i, '').trim()
    if (!candidateAppName || !/^[a-zA-Z0-9 _.+-]+$/.test(candidateAppName)) return null
    // 从 App Paths 找 exe（应用注册了 App Paths 就能找到）
    const appPathsResult = await runCmd('reg', [
      'query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${candidateAppName}.exe`, '/ve',
    ])
    let exePath = parseWindowsRegistryValue(appPathsResult.stdout)
    if (!exePath) {
      const appPathsResult2 = await runCmd('reg', [
        'query', `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${candidateAppName}.exe`, '/ve',
      ])
      exePath = parseWindowsRegistryValue(appPathsResult2.stdout)
    }
    console.log('[DefaultApp] App Paths fallback: candidateAppName=%s exePath=%s', candidateAppName, exePath)
    if (!exePath) return null
    const base = exePath.split(/[\\/]/).pop() || ''
    return { appPath: exePath, appName: base.replace(/\.exe$/i, '') }
  }

  const base = appPath.split(/[\\/]/).pop() || ''
  return { appPath, appName: base.replace(/\.exe$/i, '') }
}

async function getDefaultAppInfoForFile(
  filePath: string,
  _options?: FileAccessOptions,
): Promise<import('@profer/shared').DefaultAppInfo | null> {
  const { resolve } = await import('node:path')
  const absPath = resolve(filePath)

  const cacheKey = `${process.platform}:${extOf(filePath) || filePath}`
  if (defaultAppCache.has(cacheKey)) return defaultAppCache.get(cacheKey) ?? null

  let appPath = ''
  let appName = ''

  if (process.platform === 'darwin') {
    // 通过 swift + AppKit/NSWorkspace.urlForApplication(toOpen:) 调 LaunchServices。
    // 比 AppleScript 的 `default application of (file as alias)` 稳得多——后者在 macOS 14+
    // 经常返回 -1700（无法转 alias），即便文件存在、默认 App 已正确设置。
    // swift 通过 stdin 接收脚本，文件路径作为 argv[1]，杜绝任何字符串拼接注入。
    const swiftSrc = `import Foundation
import AppKit
let path = CommandLine.arguments.dropFirst().first ?? ""
let url = URL(fileURLWithPath: path)
if let appUrl = NSWorkspace.shared.urlForApplication(toOpen: url) {
  print(appUrl.path)
} else {
  exit(1)
}`
    const r = await runCmd('swift', ['-', absPath], { stdin: swiftSrc, timeoutMs: 6000 })
    if (r.status === 0) {
      appPath = r.stdout.trim().replace(/\/$/, '')
    }
    if (appPath.endsWith('.app')) {
      const base = appPath.split('/').pop() || ''
      appName = base.replace(/\.app$/, '')
    }
  } else if (process.platform === 'win32') {
    const info = await getWindowsDefaultAppInfo(filePath)
    console.log('[DefaultApp] win32 getWindowsDefaultAppInfo 结果:', info)
    if (!info) return cacheNull(cacheKey)
    appPath = info.isUwp ? absPath : info.appPath
    appName = info.appName
  } else {
    const mimeRes = await runCmd('xdg-mime', ['query', 'filetype', absPath])
    const mime = mimeRes.stdout.trim()
    if (!mime) return cacheNull(cacheKey)
    const defRes = await runCmd('xdg-mime', ['query', 'default', mime])
    const desktop = defRes.stdout.trim()
    if (!desktop) return cacheNull(cacheKey)
    const { homedir } = await import('node:os')
    const candidates = [
      `${homedir()}/.local/share/applications/${desktop}`,
      `/usr/share/applications/${desktop}`,
      `/usr/local/share/applications/${desktop}`,
    ]
    const { existsSync, readFileSync } = await import('node:fs')
    const desktopPath = candidates.find((p) => existsSync(p))
    if (!desktopPath) return cacheNull(cacheKey)
    const text = readFileSync(desktopPath, 'utf8')
    const execLine = text.split('\n').find((l) => l.startsWith('Exec='))?.slice(5) || ''
    const nameLine = text.split('\n').find((l) => l.startsWith('Name='))?.slice(5) || ''
    appPath = execLine.split(/\s+/)[0] || ''
    appName = nameLine || (appPath.split('/').pop() ?? '')
  }

  if (!appPath || !appName) {
    console.log('[DefaultApp] appPath 或 appName 为空，返回 null. appPath=%s appName=%s', appPath, appName)
    return cacheNull(cacheKey)
  }

  const iconDataUrl = await getAppIconDataUrl(appPath).catch((e) => { console.warn('[DefaultApp] getAppIconDataUrl 失败:', e); return '' })
  console.log('[DefaultApp] iconDataUrl 长度:', iconDataUrl?.length)
  if (!iconDataUrl) return cacheNull(cacheKey)

  const info: import('@profer/shared').DefaultAppInfo = { name: appName, appPath, iconDataUrl }
  defaultAppCache.set(cacheKey, info)
  return info
}

function cacheNull(key: string): null {
  defaultAppCache.set(key, null)
  return null
}

/**
 * 解析应用图标变体的文件路径
 */
export { resolveAppIconPath } from './lib/app-icon-service'

let _ipcHandlersRegistered = false

// 测试可注入主窗口 getter；生产默认使用 index.ts 持有的主窗口引用。
let mainWindowGetter: MainWindowGetter = getMainWindow

export function setIpcMainWindowGetter(getter: MainWindowGetter): void {
  mainWindowGetter = getter
}

function assertSensitiveAgentIpcSender(event: { sender: { isDestroyed(): boolean } }): void {
  // 多窗口：任意已注册的主应用窗口都是合法来源；
  // 保留 getter 兼容测试注入与单窗口降级路径。
  if (isMainAppWindowSender(event.sender as import('electron').WebContents)) return
  assertMainWindowSender(event, mainWindowGetter)
}

let rendererReadyHandler: ((sender: WebContents) => void) | null = null

/** 向仍存活的 renderer 广播工作区列表变化；与 preload 监听保持同一契约。 */
function broadcastAgentWorkspacesChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
    }
  }
}

export function setRendererReadyHandler(handler: ((sender: WebContents) => void) | null): void {
  rendererReadyHandler = handler
}

export function registerIpcHandlers(): void {
  // 幂等守卫：正常启动与启动失败降级路径（index.ts:520 / index.ts:748）都会调用本函数。
  // ipcMain.handle 会按 channel 去重覆盖，但 ipcMain.on / nativeTheme.on / setInterval 等副作用
  // 不会去重，重复调用会累积监听器和定时器（内存泄露）。此守卫确保只注册一次。
  if (_ipcHandlersRegistered) {
    console.log('[IPC] IPC 处理器已注册，跳过重复注册')
    return
  }
  _ipcHandlersRegistered = true

  registerVisualizationIpc({
    getMainWindow: mainWindowGetter,
    isAllowedSender: (sender) => isMainAppWindowSender(sender),
  })

  restoreGoalStatesOnce()

  onRuntimeProcessRegistryChanged((sessionId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AGENT_IPC_CHANNELS.RUNTIME_PROCESSES_CHANGED, { sessionId })
      }
    }
  })

  console.log('[IPC] 正在注册 IPC 处理器...')

  // ===== 运行时 / Git 相关 =====
  registerRuntimeGitIpc({
    normalizeFileAccessOptions,
    ensurePathAllowed,
    isPathAllowed,
    ensurePathAllowedWithWorktree,
    onRendererReady: (sender) => rendererReadyHandler?.(sender),
  })

  // 打开独立预览窗口
  ipcMain.handle(
    IPC_CHANNELS.OPEN_DETACHED_PREVIEW,
    async (event, input: DetachedPreviewWindowInput): Promise<string | null> => {
      if (!input || typeof input.sessionId !== 'string' || typeof input.filePath !== 'string' || typeof input.dirPath !== 'string') {
        console.warn('[IPC] preview:open-detached 收到无效参数')
        return null
      }
      const { openDetachedPreviewWindow } = await import('./lib/detached-preview-window')
      const sourceWindow = BrowserWindow.fromWebContents(event.sender)
      return openDetachedPreviewWindow(input, sourceWindow)
    }
  )

  // 获取独立预览窗口数据
  ipcMain.handle(
    IPC_CHANNELS.GET_DETACHED_PREVIEW_DATA,
    async (_, previewId: string) => {
      if (!previewId || typeof previewId !== 'string') return null
      const { getDetachedPreviewWindowData } = await import('./lib/detached-preview-window')
      return getDetachedPreviewWindowData(previewId)
    }
  )

  // 截图导出
  ipcMain.handle(
    IPC_CHANNELS.SCREENSHOT_CAPTURE,
    async (_, input: { html: string; isDark: boolean; width?: number; mode: 'clipboard' | 'file'; css?: string; themeClass?: string }) => {
      const { captureScreenshot } = await import('./lib/screenshot-service')
      return captureScreenshot(input)
    }
  )

  // 在系统默认浏览器中打开外部链接
  ipcMain.handle(
    IPC_CHANNELS.OPEN_EXTERNAL,
    async (_, url: string): Promise<void> => {
      if (!url || typeof url !== 'string') {
        console.warn('[IPC] shell:open-external 收到无效的 URL')
        return
      }
      // 仅允许标准 http/https URL，防止畸形协议被交给系统处理。
      const safeUrl = parseHttpUrl(url)
      if (!safeUrl) {
        console.warn('[IPC] shell:open-external 仅支持 http/https 协议:', url)
        return
      }
      await shell.openExternal(safeUrl)
    }
  )

  // 用系统默认应用打开任意文件（appName 需在 KNOWN_EDITORS 白名单内）
  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_OPEN_FILE,
    async (_, filePath: string, appName?: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const options = normalizeFileAccessOptions(access)
      const candidateBasePaths = options?.candidateBasePaths
      // 相对路径从候选基础目录解析（匹配工作区路径），而非 process.cwd()
      const { resolveTargetPath } = await import('./lib/file-preview-service')
      const absPath = resolveTargetPath(filePath, candidateBasePaths?.length ? candidateBasePaths : undefined)
      if (!isPathAllowed(absPath, options)) {
        console.warn('[IPC] shell:system-open-file 拒绝越界路径:', absPath)
        return
      }
      if (process.platform === 'darwin') {
        const { spawnSync } = await import('node:child_process')
        if (appName) {
          if (!KNOWN_EDITORS.includes(appName)) {
            console.warn('[IPC] shell:system-open-file 拒绝未知应用:', appName)
            return
          }
          spawnSync('open', ['-a', appName, absPath], { timeout: 5000 })
        } else {
          spawnSync('open', [absPath], { timeout: 5000 })
        }
      } else {
        const errMsg = await shell.openPath(absPath)
        if (errMsg) console.warn('[IPC] shell:system-open-file 打开失败:', errMsg)
      }
    }
  )

  // 扫描系统中的编辑器应用（仅 macOS）
  ipcMain.handle(
    IPC_CHANNELS.SCAN_EDITORS,
    async (): Promise<import('@profer/shared').EditorApp[]> => {
      if (process.platform !== 'darwin') return []
      const { existsSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const home = homedir()

      const editors = KNOWN_EDITORS.map((name) => {
        const searchPaths = name === 'Xcode' || name === 'TextEdit'
          ? [`/Applications/${name}.app`]
          : [`/Applications/${name}.app`, `${home}/Applications/${name}.app`]
        return { name, paths: searchPaths }
      })

      return editors
        .filter((e) => e.paths.some((p) => existsSync(p)))
        .map((e) => ({ name: e.name, path: e.paths.find((p) => existsSync(p))! }))
    }
  )

  // 查询某个文件在本机的默认打开应用信息（带图标）
  ipcMain.handle(
    IPC_CHANNELS.GET_DEFAULT_APP_FOR_FILE,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<import('@profer/shared').DefaultAppInfo | null> => {
      if (!filePath || typeof filePath !== 'string') return null
      try {
        const { expandHomeDirectory } = await import('./lib/file-preview-service')
        const options = normalizeFileAccessOptions(access)
        // Agent 输出常用 `~/...` 写法；LaunchServices 查询需要真实路径
        const targetPath = expandHomeDirectory(filePath)
        if (options && !isPreviewPathAllowed(targetPath, options)) {
          console.warn('[IPC] shell:get-default-app-for-file 拒绝系统/凭据敏感路径:', targetPath)
          return null
        }
        console.log('[IPC] get-default-app-for-file 收到请求:', targetPath)
        const result = await getDefaultAppInfoForFile(targetPath, options)
        console.log('[IPC] get-default-app-for-file 返回:', result ? `name=${result.name} appPath=${result.appPath} iconLen=${result.iconDataUrl?.length}` : 'null')
        return result
      } catch (err) {
        console.warn('[IPC] shell:get-default-app-for-file 失败:', err)
        return null
      }
    }
  )

  // ===== 渠道管理相关 =====
  registerChannelIpc({
    channelNetworkRequests,
    invalidateCatalog: (catalog) => agentCatalogInvalidationPublisher.invalidate(catalog),
  })

  // ===== 对话管理相关 =====
  ipcMain.handle(
    CHAT_IPC_CHANNELS.LIST_CONVERSATIONS,
    async (_, includeArchived?: boolean): Promise<ConversationMeta[]> => {
      return listConversations(includeArchived ?? false)
    }
  )

  // 创建对话
  ipcMain.handle(
    CHAT_IPC_CHANNELS.CREATE_CONVERSATION,
    async (_, title?: string, modelId?: string, channelId?: string): Promise<ConversationMeta> => {
      return createConversation(title, modelId, channelId)
    }
  )

  // 获取对话消息
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_MESSAGES,
    async (_, id: string): Promise<ChatMessage[]> => {
      return getConversationMessages(id)
    }
  )

  // 获取对话最近 N 条消息（分页加载）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES,
    async (_, id: string, limit: number): Promise<RecentMessagesResult> => {
      return getRecentMessages(id, limit)
    }
  )

  // 更新对话标题（用户手动命名：同时定稿锁定，自动命名窗口永久退让）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.UPDATE_TITLE,
    async (_, id: string, title: string): Promise<ConversationMeta> => {
      return updateConversationMeta(id, { title, titleLockedAt: Date.now() })
    }
  )

  // 自动命名窗口（Chat）：流结束后由主进程按前几轮有效用户消息生成/精修标题
  ipcMain.handle(
    CHAT_IPC_CHANNELS.AUTO_TITLE,
    async (_, input: AutoTitleConversationInput): Promise<ConversationMeta | null> => {
      if (!input || typeof input.conversationId !== 'string' || !input.conversationId.trim()) return null
      return autoTitleConversation(input)
    }
  )

  // 手动重新生成对话标题：绕过定稿锁定，用前几轮有效消息重命名并重新锁定
  ipcMain.handle(
    CHAT_IPC_CHANNELS.REGENERATE_TITLE,
    async (_, id: string, channelId?: string, modelId?: string): Promise<ConversationMeta | null> => {
      return regenerateConversationTitle(id, channelId, modelId)
    }
  )

  // 更新对话使用的模型/渠道
  ipcMain.handle(
    CHAT_IPC_CHANNELS.UPDATE_MODEL,
    async (_, id: string, modelId?: string, channelId?: string): Promise<ConversationMeta> => {
      return updateConversationMeta(id, { modelId, channelId })
    }
  )

  // 删除对话
  ipcMain.handle(
    CHAT_IPC_CHANNELS.DELETE_CONVERSATION,
    async (_, id: string): Promise<void> => {
      return deleteConversation(id)
    }
  )

  // 切换对话置顶状态
  ipcMain.handle(
    CHAT_IPC_CHANNELS.TOGGLE_PIN,
    async (_, id: string): Promise<ConversationMeta> => {
      const conversations = listConversations(true)
      const current = conversations.find((c) => c.id === id)
      if (!current) throw new Error(`对话不存在: ${id}`)
      const newPinned = !current.pinned
      // 置顶时自动取消归档
      const updates: Partial<ConversationMeta> = { pinned: newPinned }
      if (newPinned && current.archived) {
        updates.archived = false
      }
      // 置顶是展示状态切换，不算对话活跃：不刷新 updatedAt，避免置顶把旧对话顶成「刚刚」
      return updateConversationMeta(id, updates, { touchUpdatedAt: false })
    }
  )

  // 切换对话归档状态
  ipcMain.handle(
    CHAT_IPC_CHANNELS.TOGGLE_ARCHIVE,
    async (_, id: string): Promise<ConversationMeta> => {
      const conversations = listConversations(true)
      const current = conversations.find((c) => c.id === id)
      if (!current) throw new Error(`对话不存在: ${id}`)
      const newArchived = !current.archived
      // 归档时自动取消置顶
      const updates: Partial<ConversationMeta> = { archived: newArchived }
      if (newArchived && current.pinned) {
        updates.pinned = false
      }
      // 归档是展示状态切换，不算对话活跃：不刷新 updatedAt（取消归档不会把旧对话顶成「刚刚」）
      return updateConversationMeta(id, updates, { touchUpdatedAt: false })
    }
  )

  // 搜索对话消息内容
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SEARCH_MESSAGES,
    async (_, query: string) => {
      return searchConversationMessages(query)
    }
  )

  // 获取教程内容
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_TUTORIAL_CONTENT,
    async (): Promise<string | null> => {
      return getTutorialContent()
    }
  )

  // 创建欢迎对话（含教程附件）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.CREATE_WELCOME_CONVERSATION,
    async (): Promise<ConversationMeta | null> => {
      return createWelcomeConversation()
    }
  )

  // 获取“自建 FRP 服务器”教程内容
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_FRP_GUIDE_CONTENT,
    async (): Promise<string | null> => {
      return getFrpGuideContent()
    }
  )

  // 发送消息（触发 AI 流式响应）
  // 注意：通过 event.sender 获取 webContents 用于推送流式事件
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SEND_MESSAGE,
    async (event, input: ChatSendInput): Promise<void> => {
      await sendMessage(input, event.sender)
    }
  )

  // 资料引用是独立消息，不能伪装为附件，否则删除/截断会误删资料实体。
  ipcMain.handle(
    CHAT_IPC_CHANNELS.ADD_KNOWLEDGE_REFERENCES,
    async (_, conversationId: string, itemIds: string[]): Promise<ChatMessage> => {
      if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('对话标识无效')
      if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 10 || itemIds.some((id) => typeof id !== 'string' || id.length > 160)) throw new Error('资料引用数量或标识无效')
      const { resolveKnowledgeReferences } = require('./lib/knowledge-item-service')
      const references = resolveKnowledgeReferences(itemIds)
      const message: ChatMessage = { id: randomUUID(), parentId: null, role: 'user', content: '', createdAt: Date.now(), knowledgeReferences: references }
      appendMessage(conversationId, message)
      return message
    },
  )

  // 中止生成
  ipcMain.handle(
    CHAT_IPC_CHANNELS.STOP_GENERATION,
    async (_, conversationId: string): Promise<void> => {
      stopGeneration(conversationId)
    }
  )

  // 删除消息
  ipcMain.handle(
    CHAT_IPC_CHANNELS.DELETE_MESSAGE,
    async (_, conversationId: string, messageId: string): Promise<ChatMessage[]> => {
      return deleteMessage(conversationId, messageId)
    }
  )

  // 从指定消息开始截断（包含该消息）— 已废弃，仅保留兼容入口
  ipcMain.handle(
    CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM,
    async (
      _,
      conversationId: string,
      messageId: string,
      preserveFirstMessageAttachments?: boolean,
    ): Promise<ChatMessage[]> => {
      console.warn('[IPC] TRUNCATE_MESSAGES_FROM 已废弃，请改用 forkBranchAt + setActivePath。')
      return truncateMessagesFrom(
        conversationId,
        messageId,
        preserveFirstMessageAttachments ?? false,
      )
    }
  )

  // 获取当前激活分支（线性消息流）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_BRANCH,
    async (_, conversationId: string): Promise<ChatMessage[]> => {
      return getConversationBranch(conversationId)
    }
  )

  // 设置激活分支
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SET_ACTIVE_PATH,
    async (_, conversationId: string, path: string[]) => {
      setActivePath(conversationId, path)
      return getConversationBranch(conversationId)
    }
  )

  // 获取全量分支树快照
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_BRANCH_TREE,
    async (_, conversationId: string) => {
      return getBranchTree(conversationId)
    }
  )

  // 在 anchorId 的兄弟位置 fork 一条新 user message（用于重发/编辑重发）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.FORK_BRANCH_AT,
    async (
      _,
      conversationId: string,
      anchorId: string,
      payload: { role: 'user'; content: string; attachments?: ChatMessage['attachments']; knowledgeReferences?: ChatMessage['knowledgeReferences'] },
    ): Promise<ChatMessage> => {
      return forkBranchAt(conversationId, anchorId, payload)
    }
  )

  // 按 ID 取单条消息的完整 content（BranchTreeView hover popover 用）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_MESSAGE_CONTENT,
    async (_, conversationId: string, messageId: string): Promise<string | null> => {
      return getMessageContent(conversationId, messageId)
    }
  )

  // 更新上下文分隔线
  ipcMain.handle(
    CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS,
    async (_, conversationId: string, dividers: string[]): Promise<ConversationMeta> => {
      return updateContextDividers(conversationId, dividers)
    }
  )

  // 生成对话标题
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GENERATE_TITLE,
    async (_, input: GenerateTitleInput): Promise<string | null> => {
      return generateTitle(input)
    }
  )

  // ===== 附件管理相关 =====

  // 保存附件到本地
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SAVE_ATTACHMENT,
    async (_, input: AttachmentSaveInput): Promise<AttachmentSaveResult> => {
      return saveAttachment(input)
    }
  )

  // 读取附件（返回 base64）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.READ_ATTACHMENT,
    async (_, localPath: string): Promise<string> => {
      return readAttachmentAsBase64(localPath)
    }
  )

  // 复制图片到系统剪贴板。
  // 走主进程 clipboard.writeImage 而非渲染层 navigator.clipboard.write：后者依赖窗口聚焦
  // 与剪贴板权限，Electron 里窗口失焦时静默失败；主进程没有这个限制。
  // 复用 readAttachmentAsBase64 的安全目录校验，非法路径直接抛错由渲染层提示。
  ipcMain.handle(
    CHAT_IPC_CHANNELS.COPY_IMAGE,
    async (_, localPath: string): Promise<boolean> => {
      const base64 = readAttachmentAsBase64(localPath)
      const { clipboard, nativeImage } = await import('electron')
      const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
      if (image.isEmpty()) return false
      clipboard.writeImage(image)
      return true
    }
  )

  // 另存图片到用户选择的位置（原生 Save As 对话框）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SAVE_IMAGE_AS,
    async (event, localPath: string, defaultFilename: string): Promise<boolean> => {
      const { dialog, BrowserWindow } = await import('electron')
      const { writeFileSync } = await import('node:fs')
      const { extname: pathExtname } = await import('node:path')

      const win = BrowserWindow.fromWebContents(event.sender)
      const ext = pathExtname(defaultFilename).replace('.', '').toLowerCase()
      const filterMap: Record<string, string> = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', bmp: 'BMP' }
      const filterName = filterMap[ext] ?? 'Image'

      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
        defaultPath: defaultFilename,
        filters: [
          { name: `${filterName} 图片`, extensions: [ext || 'png'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) return false

      const base64 = readAttachmentAsBase64(localPath)
      writeFileSync(result.filePath, Buffer.from(base64, 'base64'))
      return true
    }
  )

  // 保存应用内置资源文件到用户选择的位置（原生 Save As 对话框）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SAVE_RESOURCE_FILE_AS,
    async (event, resourceRelativePath: string, defaultFilename: string): Promise<boolean> => {
      const { dialog, BrowserWindow } = await import('electron')
      const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
      const { join, normalize, sep, extname: pathExtname } = await import('node:path')

      // 解析到应用内置 resources 目录（dev 用 __dirname/resources，prod 用 process.resourcesPath）
      const resourcesDir = normalize(getBundledResourcesDir())
      const fullPath = normalize(join(resourcesDir, resourceRelativePath))

      // 安全校验：防止路径穿越（追加 sep 防止 resources-evil 绕过）
      if (!fullPath.startsWith(resourcesDir + sep)) {
        throw new Error('Path traversal not allowed')
      }
      if (!existsSync(fullPath)) {
        throw new Error(`Resource not found: ${resourceRelativePath}`)
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      const ext = pathExtname(defaultFilename).replace('.', '').toLowerCase()
      const filterMap: Record<string, string> = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP' }
      const filterName = filterMap[ext] ?? 'Image'

      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
        defaultPath: defaultFilename,
        filters: [
          { name: `${filterName} 图片`, extensions: [ext || 'png'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) return false

      writeFileSync(result.filePath, readFileSync(fullPath))
      return true
    }
  )

  // 删除附件
  ipcMain.handle(
    CHAT_IPC_CHANNELS.DELETE_ATTACHMENT,
    async (_, localPath: string): Promise<void> => {
      deleteAttachment(localPath)
    }
  )

  // 打开文件选择对话框
  ipcMain.handle(
    CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG,
    async (): Promise<FileDialogResult> => {
      return openFileDialog()
    }
  )

  // 提取附件文档的文本内容
  ipcMain.handle(
    CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT,
    async (_, localPath: string): Promise<string> => {
      return extractTextFromAttachment(localPath)
    }
  )

  // ===== 用户档案相关 =====
  registerUserProfileIpc()

  // ===== 皮肤相关 =====
  registerSkinIpc()

  // ===== 应用设置相关 =====
  registerSettingsIpc()

  // ===== 远程连接（配对 / FRP）相关 =====
  ipcMain.handle('remote:pairing-qr', async () => getRemotePairingQr())
  ipcMain.handle('remote:pairing-audit', async () => getRemotePairingAudit())
  ipcMain.handle('remote:bindings', async () => getRemoteBindings())
  ipcMain.handle('remote:revoke', async (_event, id: string) => { if (typeof id !== 'string') throw new Error('设备ID无效'); removeRemoteBinding(id) })
  ipcMain.handle('remote:frp', async (_event, action: string, input?: FrpConfig | string) => {
    const remote = getRemoteServiceStatus()
    switch (action) {
      case 'status': return getFrpStatus()
      case 'save': if (!input || typeof input !== 'object') throw new Error('配置无效'); return saveFrpConfig(input, remote.token)
      case 'check': return checkFrpReleases()
      case 'install': if (typeof input !== 'string') throw new Error('版本无效'); return installFrp(input)
      case 'rollback': return rollbackFrp()
      case 'start': if (!remote.running) throw new Error('请先开启移动模式'); if (input && typeof input === 'object') await saveFrpConfig(input, remote.token); return startRemoteFrp()
      case 'rotate-tls': return rotateRemoteTls()
      case 'generate': if (input && typeof input === 'object') await saveFrpConfig(input, remote.token); return generateFrpMaterial()
      case 'regenerate': if (input && typeof input === 'object') await saveFrpConfig(input, remote.token); return regenerateFrpMaterial()
      case 'deployment-instructions': return copyFrpDeploymentInstructions()
      case 'deployment-instructions-text': if (input && typeof input === 'object') await saveFrpConfig(input, remote.token); return getFrpDeploymentInstructions()
      case 'stop': await stopFrp(); return getFrpStatus()
      case 'export': if (input && typeof input === 'object') await saveFrpConfig(input, remote.token); return exportFrpDeployment()
      case 'test': if (!remote.token) throw new Error('请先开启移动模式'); return testFrpEndpoint(getRemoteProfile(), remote.token, getRemoteTlsCertificate())
      default: throw new Error('未知 FRP 操作')
    }
  })

  // ===== 自定义通知音效 =====
  registerNotificationSoundIpc()

  // ===== Scratch Pad 持久化 =====
  registerScratchPadIpc()

  // ===== 应用图标切换 =====
  registerAppIconIpc()

  // ===== Dock/Launcher 角标 =====
  registerDockBadgeIpc()

  // ===== 环境检测相关 =====
  registerEnvironmentIpc()

  // ===== 第三方安装包（Git / Node.js）相关 =====
  registerInstallerIpc()

  // ===== 代理配置相关 =====
  registerProxyIpc()

  // ===== Agent 会话管理相关 =====

  // 获取 Agent 会话列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_SESSIONS,
    async (_, includeArchived?: boolean): Promise<AgentSessionMeta[]> => {
      const sessions = listAgentSessions(includeArchived ?? false)
      // 启动所有已有附加目录的文件监听
      for (const session of sessions) {
        if (session.attachedDirectories) {
          for (const dir of session.attachedDirectories) {
            watchAttachedDirectory(dir)
          }
        }
      }
      return sessions
    }
  )

  // 轻量：对话 + Agent 会话的归档计数（不传输 meta 列表）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_ARCHIVED_COUNTS,
    async (): Promise<{ conversations: number; agentSessions: number }> => {
      return {
        conversations: countArchivedConversations(),
        agentSessions: countArchivedAgentSessions(),
      }
    }
  )

  // 单个 Agent 会话 meta（归档会话打开时兜底读取；不存在返回 null）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SESSION_META,
    async (_, id: string): Promise<AgentSessionMeta | null> => {
      if (typeof id !== 'string' || !id.trim()) return null
      return getAgentSessionMeta(id) ?? null
    }
  )

  // 渲染进程上报「当前选区是否可引用」：只用于右键菜单是否出现「引用到输入框」。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_QUOTEABLE_SELECTION,
    async (event, enabled: boolean): Promise<void> => {
      setQuoteableSelection(event.sender.id, Boolean(enabled))
    }
  )

  // 更新会话队列自动发送开关。该设置与 Agent 是否运行无关，停止按钮必须始终能完成。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_QUEUE_AUTO_SEND,
    async (event, sessionId: string, enabled: boolean): Promise<AgentSessionMeta> => {
      assertSensitiveAgentIpcSender(event)
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) {
        throw new Error('Agent 会话标识无效')
      }
      if (typeof enabled !== 'boolean') {
        throw new Error(`无效的队列自动发送状态: ${String(enabled)}`)
      }
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      return updateAgentSessionUiMeta(sessionId, { autoQueueSendEnabled: enabled })
    }
  )

  // 创建 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_SESSION,
    async (_, title?: string, channelId?: string, workspaceId?: string, modelId?: string, presetId?: string): Promise<AgentSessionMeta> => {
      // 未显式指定预设时继承该工作区默认预设，保证快捷新建/协作子会话/机器人桥等入口统一行为
      const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
      const effectivePresetId = presetId ?? getDefaultPresetId(workspaceSlug)
      const session = createAgentSession(title, channelId, workspaceId, modelId, getSettings().agentRuntime ?? 'claude', false, effectivePresetId)
      feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
        console.error('[飞书 Session 镜像] 新会话建群失败:', error)
      })
      return session
    }
  )

  // Agent 预设
  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.LIST_PRESETS,
    async (_, workspaceSlug?: string, includeInactiveGlobal = false): Promise<AgentPreset[]> => {
      return listAgentPresets(workspaceSlug, includeInactiveGlobal)
    },
  )

  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.LIST_GLOBAL_PRESETS, async (): Promise<AgentPreset[]> => listGlobalAgentPresets())

  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.GET_REFERENCE_REPORT, async (_, reference: PresetReference): Promise<PresetReferenceReport> => {
    return getPresetReferenceReport(reference)
  })

  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.DELETE_GLOBAL_PRESET, async (_, reference: PresetReference): Promise<void> => {
    return deleteGlobalAgentPreset(reference)
  })

  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.COPY_TO_WORKSPACE, async (_, reference: PresetReference, workspaceSlug: string, name?: string): Promise<AgentPreset> => {
    return copyPresetToWorkspace(reference, workspaceSlug, name)
  })

  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.CREATE_GLOBAL_PRESET, async (_, input: AgentPresetCreateInput): Promise<AgentPreset> => createGlobalAgentPreset(input))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.PROMOTE_WORKSPACE_PRESET_TO_GLOBAL, async (_, workspaceSlug: string, presetId: string, targetWorkspaceSlugs: string[], keepWorkspaceCopy = true): Promise<AgentPreset> => promoteWorkspacePresetToGlobal(workspaceSlug, presetId, targetWorkspaceSlugs, keepWorkspaceCopy))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.UPDATE_GLOBAL_PRESET, async (_, presetId: string, updates: AgentPresetUpdateInput): Promise<AgentPreset> => updateGlobalAgentPreset(presetId, updates))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.SET_DEFAULT_REFERENCE, async (_, workspaceSlug: string, reference: PresetReference): Promise<PresetReference> => setDefaultPresetReference(workspaceSlug, reference))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.ENABLE_GLOBAL_IN_WORKSPACE, async (_, workspaceSlug: string, reference: PresetReference): Promise<void> => enableGlobalPresetInWorkspace(workspaceSlug, reference))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.DISABLE_GLOBAL_IN_WORKSPACE, async (_, workspaceSlug: string, reference: PresetReference): Promise<void> => disableGlobalPresetInWorkspace(workspaceSlug, reference))
  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.REBIND_AND_DISABLE_GLOBAL_SCOPE,
    async (_, workspaceSlug: string, source: PresetReference, replacement?: PresetReference): Promise<PresetScopeRebindResult> =>
      rebindAndDisableGlobalPresetScope(workspaceSlug, source, replacement),
  )
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.SET_WORKSPACE_ENABLED, async (_, workspaceSlug: string, presetId: string, enabled: boolean): Promise<void> => setWorkspacePresetEnabled(workspaceSlug, presetId, enabled))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.REBIND_SESSION_REFERENCE, async (_, sessionId: string, reference: PresetReference, expectedRevision?: number): Promise<AgentSessionMeta> => {
    const session = getAgentSessionMeta(sessionId)
    if (!session) throw new Error('会话不存在')
    if (expectedRevision !== undefined && (session.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT: 会话状态已更新，请刷新后重试')
    const updated = rebindAgentSessionPreset(sessionId, reference)
    publishAgentSessionProjection(updated)
    return updated
  })
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.REBIND_AUTOMATION_REFERENCE, async (_, automationId: string, reference: PresetReference | null) => rebindAutomationPreset(automationId, reference))

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.GET_DEFAULT_PRESET,
    async (_, workspaceSlug?: string): Promise<string> => {
      return getDefaultPresetId(workspaceSlug)
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.UPDATE_SESSION_PRESET,
    async (_, sessionId: string, presetId: string, expectedRevision?: number): Promise<AgentSessionMeta> => {
      const session = getAgentSessionMeta(sessionId)
      if (!session) throw new Error('会话不存在')
      if (expectedRevision !== undefined && (session.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT: 会话状态已更新，请刷新后重试')
      // 按会话所属工作区解析；存在性校验：未知 ID 报错而非静默回退 standard
      const workspaceSlug = session.workspaceId ? getAgentWorkspace(session.workspaceId)?.slug : undefined
      const resolved = getAgentPreset(workspaceSlug, presetId)
      if (resolved.id !== presetId) throw new Error(`预设不存在: ${presetId}`)
      const updated = updateAgentSessionUiMeta(sessionId, { presetId, presetReference: presetReferenceForId(workspaceSlug, presetId) })
      publishAgentSessionProjection(updated)
      return updated
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.SET_DEFAULT_PRESET,
    async (_, workspaceSlug: string, presetId: string): Promise<string> => {
      return setDefaultPresetId(workspaceSlug, presetId)
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.CREATE_PRESET,
    async (_, workspaceSlug: string, input: AgentPresetCreateInput): Promise<AgentPreset> => {
      return createAgentPreset(workspaceSlug, input)
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.COPY_PRESET,
    async (_, workspaceSlug: string, fromId: string, name?: string): Promise<AgentPreset> => {
      return copyAgentPreset(workspaceSlug, fromId, name)
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.UPDATE_PRESET,
    async (_, workspaceSlug: string, presetId: string, updates: AgentPresetUpdateInput): Promise<AgentPreset> => {
      return updateAgentPreset(workspaceSlug, presetId, updates)
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.DELETE_PRESET,
    async (_, workspaceSlug: string, presetId: string): Promise<void> => {
      return deleteAgentPreset(workspaceSlug, presetId)
    },
  )

  // 跨工作区预设导入（与 Skill 导入同构）
  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.GET_OTHER_WORKSPACE_PRESETS,
    async (_, currentSlug: string): Promise<OtherWorkspacePresetsGroup[]> => {
      return getOtherWorkspacePresets(currentSlug)
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.IMPORT_PRESET_FROM_WORKSPACE,
    async (_, targetSlug: string, sourceSlug: string, presetId: string): Promise<AgentPreset> => {
      return importPresetFromWorkspace(targetSlug, sourceSlug, presetId)
    },
  )

  // 预设导出为 JSON 文件（跨机器分享）；返回 null 表示用户取消保存对话框
  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.EXPORT_PRESETS,
    async (_, workspaceSlug: string, presetIds?: string[]): Promise<{ filePath: string; count: number } | null> => {
      // 未指定则导出全部可用预设（内置 + 自定义）；指定时忽略未知 ID
      const available = listAgentPresets(workspaceSlug)
      const selected = presetIds?.length
        ? available.filter((p) => presetIds.includes(p.id))
        : available
      if (selected.length === 0) throw new Error('没有可导出的预设')

      const defaultFileName = `profer-agent-presets-${new Date().toISOString().slice(0, 10)}.json`
      const result = await dialog.showSaveDialog({
        title: '导出 Agent 预设',
        defaultPath: defaultFileName,
        filters: [{ name: 'Profer 预设文件', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return null

      writeFileSync(result.filePath, serializeAgentPresetsForExport(selected), 'utf-8')
      console.log(`[Agent 预设] 已导出 ${selected.length} 个预设到 ${result.filePath}`)
      return { filePath: result.filePath, count: selected.length }
    },
  )

  // 从 JSON 文件导入预设；返回 null 表示用户取消打开对话框；格式非法抛错（渲染层展示）
  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.IMPORT_PRESETS,
    async (_, workspaceSlug: string): Promise<AgentPresetImportResult | null> => {
      const result = await dialog.showOpenDialog({
        title: '导入 Agent 预设',
        properties: ['openFile'],
        filters: [{ name: 'Profer 预设文件', extensions: ['json'] }],
      })
      if (result.canceled || result.filePaths.length === 0) return null

      const text = readFileSync(result.filePaths[0]!, 'utf-8')
      return importAgentPresets(workspaceSlug, text)
    },
  )

  // 为项目创建或复用隐藏草稿会话。草稿禁止创建飞书镜像，直到首条消息落盘晋升。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ENSURE_PROJECT_DRAFT_SESSION,
    async (_, workspaceId: string, channelId?: string, modelId?: string): Promise<AgentSessionMeta> => {
      if (!getAgentWorkspace(workspaceId)) throw new Error('项目不存在')
      return ensureProjectDraftAgentSession(workspaceId, channelId, modelId, getSettings().agentRuntime ?? 'claude')
    },
  )

  // 受管浏览器：renderer 只能投影状态和更新 slot 布局，不能取得 WebContents/CDP。
  // 浏览器前台声明必须同步完成：布局 IPC 紧随其后，不能让异步鉴权把新布局
  // 排在旧 foregroundSessionId 后面，否则切换会话后原生页面会停在空白背景。
  const assertMainRenderer = (senderId: number): void => {
    const mainWindow = mainWindowGetter()
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      throw new Error('仅主窗口可以操作受管浏览器。')
    }
    const webContents = mainWindow.webContents as typeof mainWindow.webContents & { id: number }
    if (webContents.id !== senderId) throw new Error('仅主窗口可以操作受管浏览器。')
  }
  const assertBrowserSessionAccess = (senderId: number, sessionId: string): void => {
    assertMainRenderer(senderId)
    const session = getAgentSessionMeta(sessionId)
    if (!session) throw new Error('Agent 会话不存在。')
    // 自动任务与协作子会话同样可以使用受管浏览器；仅校验会话仍存在。
    browserController.configureSession(sessionId, {
      profileKey: resolveBrowserProfileKey(session.workspaceId, sessionId),
      executionSource: session.sourceDelegationId ? 'delegation' : session.sourceAutomationId ? 'automation' : 'user',
    })
  }

  ipcMain.on(
    AGENT_IPC_CHANNELS.SET_BROWSER_FOREGROUND,
    (event, sessionId: unknown): void => {
      const targetSessionId = sessionId === null ? null : typeof sessionId === 'string' ? sessionId : undefined
      if (targetSessionId === undefined) return
      try {
        if (targetSessionId === null) assertMainRenderer(event.sender.id)
        else assertBrowserSessionAccess(event.sender.id, targetSessionId)
        browserController.setForegroundSession(targetSessionId)
      } catch {
        // 单向 IPC 没有调用方可接收错误；非法或过期声明直接丢弃。
      }
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_BROWSER,
    async (event, sessionId: string): Promise<BrowserViewState> => {
      assertBrowserSessionAccess(event.sender.id, sessionId)
      return browserController.open(sessionId)
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_BROWSER_STATE,
    async (event, sessionId: string): Promise<BrowserViewState | null> => {
      assertBrowserSessionAccess(event.sender.id, sessionId)
      return browserController.getState(sessionId)
    },
  )
  ipcMain.on(
    AGENT_IPC_CHANNELS.SET_BROWSER_LAYOUT,
    (event, layout: BrowserViewLayout): void => {
      if (
        !layout ||
        typeof layout.sessionId !== 'string' ||
        !layout.viewportBounds ||
        !layout.pageBounds ||
        typeof layout.rendererInstanceId !== 'string' ||
        layout.rendererInstanceId.length === 0 ||
        !Number.isSafeInteger(layout.layoutSourceRevision) ||
        !Number.isSafeInteger(layout.revision)
      )
        return
      // 保留原有主窗口/session 校验；布局通道单向发送，但不牺牲 IPC 鉴权。
      try {
        assertBrowserSessionAccess(event.sender.id, layout.sessionId)
        browserController.setLayout(layout)
      } catch {
        // 单向 IPC 没有调用方可接收错误；非法或过期布局直接丢弃。
      }
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.NAVIGATE_BROWSER,
    async (event, input: BrowserNavigateInput): Promise<BrowserViewState> => {
      assertBrowserSessionAccess(event.sender.id, input.sessionId)
      return browserController.navigateDisplay(input.sessionId, input.url, input.tabId)
    },
  )
  ipcMain.handle(AGENT_IPC_CHANNELS.GO_BACK_BROWSER, async (event, sessionId: string) => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.goBackDisplay(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.GO_FORWARD_BROWSER, async (event, sessionId: string) => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.goForwardDisplay(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.RELOAD_BROWSER, async (event, sessionId: string) => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.reloadDisplay(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.TRANSLATE_BROWSER, async (event, input: BrowserTabInput): Promise<BrowserTranslateResult> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    return browserController.translatePage(input.sessionId, input.tabId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.PASTE_BROWSER_CLIPBOARD, async (event, input: BrowserTabInput): Promise<BrowserTranslateResult> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    return browserController.pasteClipboard(input.sessionId, input.tabId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.SET_BROWSER_ZOOM, async (event, input: BrowserTabInput & { zoomFactor: number }): Promise<BrowserViewState> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    if (!input.tabId || typeof input.zoomFactor !== 'number') throw new Error('tabId 和 zoomFactor 必填。')
    return browserController.setZoom(input.sessionId, input.tabId, input.zoomFactor)
  })
  // 用户侧：把已授权文件在受管浏览器里打开（HTML 直接加载；其它扩展名走内置 viewer 页 → Open File Viewer）。
  // 主题由渲染进程算好一起送来（viewer 页无 preload，主题只能烘进 URL）：
  // theme = 明暗，tokens = app 文档上真实生效的 token 值（皮肤配色由此到达预览页）。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FILE_IN_BROWSER,
    async (
      event,
      input: {
        sessionId: string
        filePath: string
        theme?: 'light' | 'dark'
        tokens?: OfvThemeTokens
        access?: FileAccessOptions
      },
    ): Promise<import('@profer/shared').BrowserViewState> => {
      if (
        !input
        || typeof input.sessionId !== 'string'
        || input.sessionId.length === 0
        || typeof input.filePath !== 'string'
        || input.filePath.trim().length === 0
      ) {
        throw new Error('文件预览参数无效。')
      }
      await assertBrowserSessionAccess(event.sender.id, input.sessionId)
      const options = normalizeFileAccessOptions(input.access)
      // getAllowedCandidateBasePaths 在没有候选根时返回 undefined；浏览器侧要求 string[]。
      const allowedRoots = getAllowedCandidateBasePaths(options) ?? []
      return browserController.previewOpen(
        input.sessionId,
        input.filePath,
        undefined,
        allowedRoots,
        undefined,
        undefined,
        // IPC 边界收口（未知 token / 可疑值在这里被丢掉，见 shared 的 ofv-theme-bridge）
        normalizeOfvThemePayload(input) ?? undefined,
      )
    },
  )

  ipcMain.handle(AGENT_IPC_CHANNELS.HIDE_BROWSER, async (event, sessionId: string): Promise<void> => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    browserController.hide(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CLOSE_BROWSER, async (event, sessionId: string): Promise<void> => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    await browserController.close(sessionId)
  })
  // 皮肤切换：viewer 页的主题烘在 URL 里（那页无 preload），只能按新主题重载本地预览。
  // 全局生效且只影响本地预览标签 —— 普通网页永远不跟随 app 皮肤。
  // 除了重载已打开的预览，主进程还会记住这次的主题，供之后由 Agent 打开、没有主题来源的预览使用。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REFRESH_BROWSER_PREVIEW_THEME,
    async (event, input: { theme?: unknown; tokens?: unknown }): Promise<number> => {
      assertMainRenderer(event.sender.id)
      const previewTheme = normalizeOfvThemePayload(input)
      if (!previewTheme) return 0
      return browserController.refreshLocalPreviewThemes(previewTheme)
    },
  )
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_BROWSER_TABS, async (event, sessionId: string): Promise<BrowserTabListResult> => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.listTabs(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CREATE_BROWSER_TAB, async (event, input: BrowserCreateTabInput): Promise<BrowserViewState> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    return browserController.createDisplayTab(input.sessionId, input.url)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.SELECT_BROWSER_TAB, async (event, input: BrowserTabInput): Promise<BrowserViewState> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    if (!input.tabId) throw new Error('tabId 必填。')
    return browserController.selectTab(input.sessionId, input.tabId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CLOSE_BROWSER_TAB, async (event, input: BrowserTabInput): Promise<BrowserViewState | null> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    if (!input.tabId) throw new Error('tabId 必填。')
    return browserController.closeTab(input.sessionId, input.tabId)
  })

  // 新标签页起始页：书签 + 最近访问 + 可配置默认首页（用户级全局，不分工作区）。
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_BROWSER_START_PAGE, async (): Promise<BrowserStartPageState> => {
    return {
      bookmarks: listBookmarks(),
      recentHistory: listHistory(),
      defaultHomeUrl: getSettings().browserHomeUrl ?? null,
    }
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.ADD_BROWSER_BOOKMARK, async (_, input: BrowserAddBookmarkInput): Promise<BrowserStartPageState> => {
    if (!input?.url?.trim()) throw new Error('书签 URL 必填。')
    addBookmark(input.title ?? '', input.url.trim(), '')
    return { bookmarks: listBookmarks(), recentHistory: listHistory(), defaultHomeUrl: getSettings().browserHomeUrl ?? null }
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.REMOVE_BROWSER_BOOKMARK, async (_, id: string): Promise<BrowserStartPageState> => {
    if (!id) throw new Error('书签 id 必填。')
    removeBookmark(id)
    return { bookmarks: listBookmarks(), recentHistory: listHistory(), defaultHomeUrl: getSettings().browserHomeUrl ?? null }
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.UPDATE_BROWSER_HOME_URL, async (_, url: string): Promise<BrowserStartPageState> => {
    updateSettings({ browserHomeUrl: (url ?? '').trim() })
    return { bookmarks: listBookmarks(), recentHistory: listHistory(), defaultHomeUrl: getSettings().browserHomeUrl ?? null }
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CLEAR_BROWSER_HISTORY, async (): Promise<BrowserStartPageState> => {
    clearHistory()
    return { bookmarks: listBookmarks(), recentHistory: listHistory(), defaultHomeUrl: getSettings().browserHomeUrl ?? null }
  })

  // 获取 Agent 会话 SDKMessage（Phase 4 新格式）
  // opts.tail/before 传参时返回分页结果（桌面懒加载：首次只取尾部一页，触顶/按钮补更早）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SDK_MESSAGES,
    async (_, id: string, opts?: { tail?: number; before?: number }): Promise<SDKMessage[] | import('./lib/agent-session-manager').SDKMessagePage> => {
      return opts ? getAgentSessionSDKMessages(id, opts) : getAgentSessionSDKMessages(id)
    }
  )

  // 获取会话「消息导航」全量轮次索引（只读）
  // 渲染层只加载尾部一页消息；导航总数必须来自全会话，否则会话越长总数越小。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_NAVIGATION_INDEX,
    async (_, id: string): Promise<import('./lib/agent-navigation-index').NavigationIndex> => {
      return getAgentSessionNavigationIndex(id)
    }
  )

  // renderer 刷新后重新绑定所有仍活跃的 Agent 流，并回放本轮实时事件。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RESTORE_ACTIVE_STREAMS,
    async (event, sessionIds?: unknown): Promise<import('@profer/shared').AgentRuntimeRestoreSnapshot[]> => {
      // 次级窗口只恢复自己标签页上的会话；主窗口不传参数，保持刷新恢复全部活跃流的旧行为。
      const ids = Array.isArray(sessionIds)
        ? sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 100)
        : undefined
      return restoreActiveAgentStreams(event.sender, ids)
    },
  )
  ipcMain.handle(AGENT_IPC_CHANNELS.FILE_PREVIEW_REVISION, async (event, filePath: string, access?: FileAccessOptions | string[]): Promise<string | null> => {
    assertSensitiveAgentIpcSender(event)
    const { resolveFilePath } = await import('./lib/file-preview-service')
    const options = normalizeFileAccessOptions(access)
    const resolved = resolveFilePath(filePath, getAllowedCandidateBasePaths(options), { skipGlobalSearch: true })
    if (!resolved || !isPreviewPathAllowed(resolved, options) || extname(resolved).toLowerCase() !== '.pptx') return null
    return `sha256:${createHash('sha256').update(readFileSync(resolved)).digest('hex')}`
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.FILE_PREVIEW_REPORT, async (event, report: import('@profer/shared').AgentFilePreviewReport): Promise<boolean> => {
    assertSensitiveAgentIpcSender(event)
    return agentFilePreviewSessionManager.reportReady(report)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.FILE_PREVIEW_INSPECTION_RESULT, async (event, result: import('@profer/shared').AgentFilePreviewInspectResult): Promise<boolean> => {
    assertSensitiveAgentIpcSender(event)
    return agentFilePreviewSessionManager.reportInspection(result)
  })

  // 更新 Agent 会话标题（用户手动命名：同时定稿锁定，自动命名窗口永久退让）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_TITLE,
    async (_, id: string, title: string): Promise<AgentSessionMeta> => {
      return updateAgentSessionUiMeta(id, { title, titleLockedAt: Date.now() })
    }
  )

  // 空闲会话更新渠道与模型；运行中及 background waiting 均由 active 状态保护。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_MODEL,
    async (event, id: string, channelId?: string, modelId?: string): Promise<AgentSessionMeta> => {
      assertSensitiveAgentIpcSender(event)
      if (isAgentSessionActive(id)) {
        throw new Error('Agent 正在运行，完成后再切换模型')
      }
      return updateAgentSessionUiMeta(id, { channelId, modelId })
    }
  )

  // 生成 Agent 会话标题
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GENERATE_TITLE,
    async (_, input: AgentGenerateTitleInput): Promise<string | null> => {
      return generateAgentTitle(input)
    }
  )

  // 手动重新生成 Agent 会话标题：绕过定稿锁定，用前几轮有效消息重命名并重新锁定
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REGENERATE_TITLE,
    async (_, id: string, channelId?: string, modelId?: string): Promise<AgentSessionMeta | null> => {
      const result = await regenerateAgentTitle(id, channelId, modelId)
      return result?.session ?? null
    }
  )

  // 删除 Agent 会话：运行中时先中止并等待 finally 完整退出，避免删除后仍写入 JSONL/工作目录。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SESSION,
    async (_, id: string): Promise<void> => {
      return agentSessionDeletionCoordinator.delete(id, {
        getDeletionOrder: getAgentSessionDeletionOrder,
        beginDeletion: beginAgentSessionDeletion,
        endDeletion: endAgentSessionDeletion,
        stopAndWait: stopAgentAndWait,
        // 运行已完全结束后再撤销交互状态并删除持久化数据。
        clearState: (sessionId) => {
          permissionService.clearSessionWhitelist(sessionId)
          permissionService.clearSessionPending(sessionId)
          askUserService.clearSessionPending(sessionId)
          exitPlanService.clearSessionPending(sessionId)
          void browserController.close(sessionId)
        },
        deleteSession: deleteAgentSession,
      })
    }
  )

  // 迁移 Chat 对话记录到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT,
    async (_, conversationId: string, agentSessionId: string): Promise<void> => {
      migrateChatToAgentSession(conversationId, agentSessionId)
    }
  )

  // 切换 Agent 会话置顶状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_PIN,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions(true)
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      const newPinned = !current.pinned
      // 置顶时自动取消归档
      const updates: Partial<AgentSessionMeta> = { pinned: newPinned }
      if (newPinned && current.archived) {
        updates.archived = false
      }
      // 置顶是展示状态切换，不算会话活跃：不刷新 updatedAt，否则侧栏「最近」排序
      // 会把整个项目因为这个动作顶到最前面。
      return updateAgentSessionUiMeta(id, updates, { touchUpdatedAt: false })
    }
  )

  // 清除 Agent 会话完成状态（兼容清除旧版 manualWorking）——「确认已读」的宿主写入口
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CLEAR_COMPLETION_STATE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions(true)
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      // 幂等：本来就没有未读也没有旧版 manualWorking 时直接返回，不产生多余 revision / projection。
      if (!current.completedButUnconfirmed && !current.manualWorking) return current
      return setAgentSessionUnread(id, false, current.manualWorking ? { manualWorking: false } : undefined)
        ?? current
    }
  )

  // 标记 Agent 会话为「未读」：持久化写入 completedButUnconfirmed = true（侧边栏「标记未读」入口）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_COMPLETION_STATE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions(true)
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      return setAgentSessionUnread(id, true) ?? current
    }
  )

  // 更新 Agent 会话中断说明状态（state 非 null 置位：点击中断记录行向 Agent 说明原因；null 清除：消费/移除输入框中断 chip 时调用，保证重启不复活已消费的中断）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_INTERRUPTION_STATE,
    (_e, input: UpdateAgentInterruptStateInput): AgentSessionMeta => {
      const { sessionId, state } = input
      return updateAgentSessionUiMeta(sessionId, state
        ? { lastInterruptReason: state.reason, lastInterruptLabel: state.label, lastInterruptAt: state.at }
        : { lastInterruptReason: undefined, lastInterruptLabel: undefined, lastInterruptAt: undefined })
    }
  )

  // 切换 Agent 会话归档状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions(true)
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      // 归档视作已读（仅开启态追加清未读）；关闭态保持原行为：只切 archived + 取消置顶。
      // 归档是展示状态切换，不算会话活跃：不刷新 updatedAt，取消归档不会把旧会话顶成「刚刚」。
      return updateAgentSessionUiMeta(id, buildArchiveToggleUpdates({
        archived: current.archived ?? false,
        pinned: current.pinned ?? false,
        completedButUnconfirmed: current.completedButUnconfirmed ?? false,
      }, getAgentUnreadPolicyMode()), { touchUpdatedAt: false })
    }
  )

  // 搜索 Agent 会话消息内容
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_MESSAGES,
    async (_, query: string) => {
      return searchAgentSessionMessages(query)
    }
  )

  // 搜索当前工作区可引用的 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_SESSION_REFERENCES,
    async (_, input: AgentSessionReferenceSearchInput) => {
      return searchAgentSessionReferences(input)
    }
  )

  // 迁移 Agent 会话到另一个工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_SESSION_TO_WORKSPACE,
    async (_, input: MoveSessionToWorkspaceInput): Promise<AgentSessionMeta> => {
      // 渲染进程的 running 状态可能比主进程 activeSessions 清理更早变为 false
      // （STREAM_COMPLETE 在 finally 之前发送），短暂等待后重试一次
      if (isAgentSessionActive(input.sessionId)) {
        await new Promise((r) => setTimeout(r, 500))
        if (isAgentSessionActive(input.sessionId)) {
          throw new Error('会话正在运行中，请停止后再迁移')
        }
      }
      return moveSessionToWorkspace(input.sessionId, input.targetWorkspaceId)
    }
  )

  // 轻量查询：会话当前可展示为服务进程的数量。为了与 `LIST_SESSION_PROCESSES`
  // 展开时完全同源（避免折叠/展开数字跳变），这里直接复用 `listOwnedRuntimeProcesses`
  // 并按与 IPC 相同的 key（pid ?? launchedAt）去重。listOwnedRuntimeProcesses 本身
  // 只对该会话有登记记录时才派 OS 扫描确认 pid，普通会话零扫描、直接读盘返回。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SESSION_PROCESS_COUNT,
    async (event, sessionId: string): Promise<number> => {
      assertSensitiveAgentIpcSender(event)
      const owned = await listOwnedRuntimeProcesses(sessionId)
      const keys = new Set<number>()
      for (const record of owned) {
        keys.add(record.pid ?? -Math.abs(record.launchedAt))
      }
      return keys.size
    }
  )

  // 列出会话关联的运行中真实 OS 进程（进程视图）。
  // 权威来源是 Pi 在 shell 启动点写入的 ownership registry；SDK 后台任务仅作补充。
  // 不再按 renderer 提供的 sessionPath 扫描，避免把会话临时目录误作项目工作目录。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_SESSION_PROCESSES,
    async (event, input: ListSessionProcessesInput): Promise<SessionProcessInfo[]> => {
      assertSensitiveAgentIpcSender(event)
      const results = new Map<number, SessionProcessInfo>()
      const owned = await listOwnedRuntimeProcesses(input.sessionId)
      for (const record of owned) {
        const handle = processHandleFromRuntimeRecord(record)
        if (!isProcessHandleOwnedBySession(handle, input.sessionId)) continue
        const key = handle.pid ?? -Math.abs(handle.startedAt)
        results.set(key, {
          pid: handle.pid,
          name: handle.pid ? 'Pi service' : 'Pi launch observation',
          cmd: handle.command,
          startTime: handle.startTime,
          ports: record.ports,
          source: 'pi-owned',
          status: handle.status === 'running' ? 'running' : 'pending',
          cwd: handle.cwd,
          persistsAfterChat: Boolean(handle.pid),
        })
      }
      const bySdk = await mapSdkShellTasks(input.sessionId, input.sdkShellTasks ?? [])
      for (const p of bySdk) {
        if (!results.has(p.pid)) {
          results.set(p.pid, {
            pid: p.pid, name: p.name, cmd: p.cmd, startTime: p.startTime, ports: p.ports,
            sdkTaskId: p.sdkTaskId, source: 'sdk',
          })
        }
      }
      return [...results.values()]
    }
  )

  // 结束会话关联进程树（kill）
  // 破坏性操作：鉴权 + {pid,startTime} 双因子防 PID 转世 + 仅允许 kill 归属该会话的 pid。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.KILL_PROCESS,
    async (event, input: KillProcessInput): Promise<{ ok: boolean; message: string }> => {
      assertSensitiveAgentIpcSender(event)
      if (!input || typeof input.pid !== 'number') {
        throw new Error('无效的 kill 目标')
      }
      // 仅允许结束本会话在启动点登记过的进程，防止 renderer 借 IPC 杀任意 PID。
      const owned = await listOwnedRuntimeProcesses(input.sessionId)
      const isOwned = owned.some((record) => {
        const handle = processHandleFromRuntimeRecord(record)
        return isProcessHandleOwnedBySession(handle, input.sessionId)
          && handle.pid === input.pid
          && handle.startTime === input.startTime
          && handle.status === 'running'
      })
      if (!isOwned) {
        throw new Error('该进程不属于本会话或已失效，拒绝结束')
      }
      if (!input.startTime) {
        throw new Error('缺少进程启动时间戳，拒绝 kill（防 PID 转世）')
      }
      // PID + startTime 双因子校验：确认 PID 未被系统转世复用
      const same = await isSameProcess(input.pid, input.startTime)
      if (!same) {
        throw new Error('进程已变化或已退出（PID 可能被复用），拒绝 kill，请刷新后重试')
      }
      const res = await terminateProcessTreeGracefully(input.pid, input.startTime)
      if (!res.ok) {
        throw new Error(`结束失败: ${res.message}`)
      }
      markOwnedRuntimeProcessExited(input.sessionId, input.pid, input.startTime)
      return { ok: true, message: res.message }
    }
  )

  // 分叉 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.FORK_SESSION,
    async (_, input: ForkSessionInput): Promise<AgentSessionMeta> => {
      const session = await forkAgentSession(input)
      // Fork 直接在 session manager 内创建元数据，绕过 CREATE_SESSION 的镜像生命周期。
      // 将它作为新的桌面会话处理，确保 Pi fork 也会立即获得可双向续聊的飞书群。
      feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
        console.error('[飞书 Session 镜像] 分叉会话建群失败:', error)
      })
      return session
    }
  )

  // 快照回退（同一会话内回退到指定点）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REWIND_SESSION,
    async (_, input: RewindSessionInput): Promise<RewindSessionResult> => {
      return rewindAgentSession(
        input.sessionId,
        input.assistantMessageUuid,
      )
    }
  )

  // 会话健康检查：扫描孤儿记录和文件系统不一致
  ipcMain.handle(
    AGENT_IPC_CHANNELS.FIND_ORPHAN_SESSIONS,
    async () => {
      return findOrphanSessions()
    }
  )

  // ===== Agent 工作区管理相关 =====

  // 确保默认工作区存在
  ensureDefaultWorkspace()

  // 获取 Agent 工作区列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_WORKSPACES,
    async (): Promise<AgentWorkspace[]> => {
      return listAgentWorkspaces()
    }
  )

  // 创建 Agent 工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_WORKSPACE,
    async (_, name: string): Promise<AgentWorkspace> => {
      const workspace = createAgentWorkspace(name)
      broadcastAgentWorkspacesChanged()
      return workspace
    }
  )

  // 更新 Agent 工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_WORKSPACE,
    async (_, id: string, updates: { name?: string; archived?: boolean }): Promise<AgentWorkspace> => {
      const workspace = updateAgentWorkspace(id, updates)
      broadcastAgentWorkspacesChanged()
      return workspace
    }
  )

  // 删除 Agent 工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_WORKSPACE,
    async (_, id: string): Promise<void> => {
      const deletingWorkspace = getAgentWorkspace(id)
      if (!deletingWorkspace) {
        return deleteAgentWorkspace(id)
      }

      // 守卫前置：在删除任何会话/自动任务前就拦截不可删除的工作区，
      // 否则会先把绑定数据删光、再由 deleteAgentWorkspace 抛错，造成数据丢失与状态不一致
      if (deletingWorkspace.slug === 'default') {
        throw new Error('默认项目不能删除')
      }
      if (listAgentWorkspaces().length <= 1) {
        throw new Error('至少需要保留一个项目')
      }

      const affectedSessionIds = listAgentSessions(true)
        .filter((session) => session.workspaceId === id)
        .map((session) => session.id)
      const affectedAutomationIds = listAutomations()
        .filter((automation) => automation.workspaceId === id)
        .map((automation) => automation.id)

      for (const sessionId of affectedSessionIds) {
        await agentSessionDeletionCoordinator.delete(sessionId, {
          getDeletionOrder: getAgentSessionDeletionOrder,
          beginDeletion: beginAgentSessionDeletion,
          endDeletion: endAgentSessionDeletion,
          stopAndWait: stopAgentAndWait,
          clearState: (id) => {
            permissionService.clearSessionWhitelist(id)
            permissionService.clearSessionPending(id)
            askUserService.clearSessionPending(id)
            exitPlanService.clearSessionPending(id)
            void browserController.close(id)
          },
          deleteSession: deleteAgentSession,
        })
      }
      for (const automationId of affectedAutomationIds) {
        deleteAutomation(automationId)
      }
      if (affectedAutomationIds.length > 0) {
        broadcastAutomationsChanged()
      }
      deleteAgentWorkspace(id)
      broadcastAgentWorkspacesChanged()
    }
  )

  // 重排工作区顺序
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REORDER_WORKSPACES,
    async (_, orderedIds: string[]): Promise<AgentWorkspace[]> => {
      const workspaces = reorderAgentWorkspaces(orderedIds)
      broadcastAgentWorkspacesChanged()
      return workspaces
    }
  )

  // ===== 工作区能力（MCP + Skill） =====

  // 获取工作区能力摘要
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_CAPABILITIES,
    async (_, workspaceSlug: string): Promise<WorkspaceCapabilities> => {
      return getWorkspaceCapabilities(workspaceSlug)
    }
  )

  // 获取工作区 MCP 配置
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_MCP_CONFIG,
    async (_, workspaceSlug: string): Promise<WorkspaceMcpConfig> => {
      return getWorkspaceMcpConfig(workspaceSlug)
    }
  )

  // 保存工作区 MCP 配置
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG,
    async (_, workspaceSlug: string, config: WorkspaceMcpConfig): Promise<void> => {
      return saveWorkspaceMcpConfig(workspaceSlug, config)
    }
  )

  // 测试 MCP 服务器连接
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TEST_MCP_SERVER,
    async (_, name: string, entry: import('@profer/shared').McpServerEntry): Promise<{ success: boolean; message: string }> => {
      const { validateMcpServer } = await import('./lib/mcp-validator')
      const result = await validateMcpServer(name, entry)
      return {
        success: result.valid,
        message: result.valid ? '连接成功' : (result.reason || '连接失败'),
      }
    }
  )

  ipcMain.handle(AGENT_IPC_CHANNELS.PROMOTE_SKILL_TO_GLOBAL, async (_, workspaceSlug: string, skillSlug: string, targetWorkspaceSlugs: string[], keepWorkspaceCopy = true): Promise<import('@profer/shared').GlobalSkillManifest> => {
    return promoteWorkspaceSkillToGlobal(workspaceSlug, skillSlug, targetWorkspaceSlugs, keepWorkspaceCopy)
  })

  // 获取工作区 Skill 列表（含活跃和不活跃，设置页 UI 用）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SKILLS,
    async (_, workspaceSlug: string): Promise<SkillMeta[]> => {
      return getAllWorkspaceSkills(workspaceSlug, true)
    }
  )

  // 获取工作区 Skills 目录绝对路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SKILLS_DIR,
    async (_, workspaceSlug: string): Promise<string> => {
      return getWorkspaceSkillsDir(workspaceSlug)
    }
  )

  // 创建工作区 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_SKILL,
    async (_, workspaceSlug: string, skillSlug: string, name: string, description: string, content: string): Promise<void> => {
      createWorkspaceSkill(workspaceSlug, skillSlug, name, description, content)
    },
  )

  // 删除工作区 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SKILL,
    async (_, workspaceSlug: string, skillSlug: string): Promise<void> => {
      return deleteWorkspaceSkill(workspaceSlug, skillSlug)
    }
  )

  // 切换工作区 Skill 启用/禁用
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_SKILL,
    async (_, workspaceSlug: string, skillSlug: string, enabled: boolean, sourceSkillId?: string): Promise<void> => {
      assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
      assertSafeSkillSegment(skillSlug, 'Skill slug')
      // sourceSkillId 三态：非空为全局 ID，空字符串明确选择工作区副本，未传为兼容 fallback。
      if (sourceSkillId !== undefined && sourceSkillId !== '') assertSafeSkillSegment(sourceSkillId, 'sourceSkillId')
      return toggleWorkspaceSkill(workspaceSlug, skillSlug, enabled, sourceSkillId)
    }
  )

  // 获取其他工作区的 Skill 列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_OTHER_WORKSPACE_SKILLS,
    async (_, currentSlug: string) => {
      return getOtherWorkspaceSkills(currentSlug)
    }
  )

  // 获取默认 Skills 的 slug 列表（来自 ~/.proma/default-skills/）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_DEFAULT_SKILL_SLUGS,
    async () => {
      return getDefaultSkillSlugs()
    }
  )

  // 从其他工作区导入 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.IMPORT_SKILL_FROM_WORKSPACE,
    async (_, targetSlug: string, sourceSlug: string, skillSlug: string): Promise<SkillMeta> => {
      assertSafeSkillSegment(targetSlug, 'target workspaceSlug')
      assertSafeSkillSegment(sourceSlug, 'source workspaceSlug')
      assertSafeSkillSegment(skillSlug, 'Skill slug')
      return importSkillFromWorkspace(targetSlug, sourceSlug, skillSlug)
    }
  )

  // 从源工作区同步更新已导入的 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SKILL_FROM_SOURCE,
    async (_, targetSlug: string, skillSlug: string): Promise<SkillMeta> => {
      return updateSkillFromSource(targetSlug, skillSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_SKILL_CONTENT,
    async (_, workspaceSlug: string, skillSlug: string): Promise<string> => {
      return readWorkspaceSkillContent(workspaceSlug, skillSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_SKILL_CONTENT,
    async (_, workspaceSlug: string, skillSlug: string, content: string): Promise<void> => {
      writeWorkspaceSkillContent(workspaceSlug, skillSlug, content)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_SKILL_CARD,
    async (_, workspaceSlug: string, skillSlug: string) => {
      return readWorkspaceSkillCard(workspaceSlug, skillSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_SKILL_CARD,
    async (_, workspaceSlug: string, skillSlug: string, patch: import('@profer/shared').SkillManifestPatch) => {
      return writeWorkspaceSkillCard(workspaceSlug, skillSlug, patch)
    }
  )

  // ===== Skill 子文件管理 =====

  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_SKILL_FILES,
    async (_, workspaceSlug: string, skillSlug: string) => {
      return listSkillFiles(workspaceSlug, skillSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_SKILL_FILE,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string) => {
      return readSkillFile(workspaceSlug, skillSlug, relativePath)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_SKILL_FILE,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string, content: string): Promise<void> => {
      writeSkillFile(workspaceSlug, skillSlug, relativePath, content)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_SKILL_ENTRY,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string, type: 'file' | 'directory'): Promise<void> => {
      createSkillEntry(workspaceSlug, skillSlug, relativePath, type)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SKILL_ENTRY,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string): Promise<void> => {
      deleteSkillEntry(workspaceSlug, skillSlug, relativePath)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_SKILL_ENTRY,
    async (_, workspaceSlug: string, skillSlug: string, fromRelative: string, toRelative: string): Promise<void> => {
      renameSkillEntry(workspaceSlug, skillSlug, fromRelative, toRelative)
    }
  )

  // ===== 全局 Skill 体系与元 Skill 兼容读取 =====
  registerGlobalSkillIpc()

  // 发送 Agent 消息（触发 Agent SDK 流式响应）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEND_MESSAGE,
    async (event, input: AgentSendInput): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      await coordinateAgentSend(input, {
        getSession: getAgentSessionMeta,
        workspaceExists: (workspaceId) => Boolean(getAgentWorkspace(workspaceId)),
        getChannel: getChannelById,
        validatePreset: (session) => {
          const workspaceSlug = session.workspaceId ? getAgentWorkspace(session.workspaceId)?.slug : undefined
          // 兼容作用域引用上线前/回归期间产生的脏会话：若引用缺失或为空，
          // 按会话 ID 重新解析；连 presetId 也缺失时使用内置 standard。
          const reference = session.presetReference?.presetId
            ? session.presetReference
            : presetReferenceForId(workspaceSlug, session.presetId || DEFAULT_PRESET_ID)
          if (!reference.presetId) throw new Error('AGENT_PRESET_REQUIRED: 请先选择一个 Agent 预设，然后再开始对话')
          // 不能只在这里使用兜底引用：编排器会重新读取 session meta。
          // 将旧会话/回归期间生成的空引用自愈为正确引用，避免下一阶段再次失败。
          if (!session.presetReference?.presetId || session.presetId !== reference.presetId) {
            updateAgentSessionUiMeta(session.id, { presetId: reference.presetId, presetReference: reference })
          }
          getAgentPresetByReference(reference, workspaceSlug)
        },
        startMirror: (session) => feishuBridgeManager.startSessionMirrorRun(session),
        startAgent: () => runAgent(input, event.sender, async (session) => {
          try {
            await feishuBridgeManager.startSessionMirrorRun(session)
          } catch (error) {
            console.error('[飞书 Session 镜像] 草稿会话晋升后流式卡片初始化失败:', error)
          }
        }),
        onMirrorError: (error) => console.error('[飞书 Session 镜像] 流式卡片初始化失败:', error),
      })
    }
  )


  // 中止 Agent 执行。必须等待底层 run 的 finally 完成后才向渲染层返回，
  // 否则用户刚点击「停止」就发送下一条消息时，编排器仍持有 active session，
  // 新消息会被并发保护拒绝，造成必须重复发送一次的体验问题。
  ipcMain.handle(AGENT_IPC_CHANNELS.START_GOAL, async (event, sessionId: string, goal: string, contract?: AgentGoalContract): Promise<AgentGoalState> => {
    assertSensitiveAgentIpcSender(event)
    if (typeof sessionId !== 'string' || typeof goal !== 'string' || !goal.trim()) throw new Error('Goal 不能为空')
    // 从哪个窗口发起，Goal 本轮事件就回到哪个窗口（多窗口下不能固定发主窗口）。
    registerWebContents(sessionId, event.sender)
    return goalSessionService.start(sessionId, goal, contract)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_GOAL, async (event, sessionId: string): Promise<AgentGoalState | null> => {
    assertSensitiveAgentIpcSender(event)
    return goalSessionService.get(sessionId) ?? null
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_GOALS, async (event): Promise<AgentGoalState[]> => {
    assertSensitiveAgentIpcSender(event)
    return goalSessionService.list()
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.PAUSE_GOAL, async (event, sessionId: string): Promise<AgentGoalState> => {
    assertSensitiveAgentIpcSender(event)
    return goalSessionService.pause(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.RESUME_GOAL, async (event, sessionId: string): Promise<AgentGoalState> => {
    assertSensitiveAgentIpcSender(event)
    registerWebContents(sessionId, event.sender)
    return goalSessionService.resume(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.STOP_GOAL, async (event, sessionId: string): Promise<AgentGoalState> => {
    assertSensitiveAgentIpcSender(event)
    return goalSessionService.stop(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CLEAR_GOAL, async (event, sessionId: string): Promise<void> => {
    assertSensitiveAgentIpcSender(event)
    goalSessionService.clear(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.UPDATE_GOAL, async (event, sessionId: string, patch: { goal?: string; contract?: AgentGoalContract; limits?: AgentGoalLimitsPatch }): Promise<AgentGoalState> => {
    assertSensitiveAgentIpcSender(event)
    if (typeof sessionId !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的 Goal 更新参数')
    return goalSessionService.update(sessionId, patch)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_GOAL_HISTORY, async (event, sessionId: string): Promise<AgentGoalState[]> => {
    assertSensitiveAgentIpcSender(event)
    if (typeof sessionId !== 'string') throw new Error('无效的 Goal 会话标识')
    return goalSessionService.history(sessionId)
  })

  ipcMain.handle(
    AGENT_IPC_CHANNELS.STOP_AGENT,
    async (event, sessionId: string): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      feishuBridgeManager.stopSessionMirrorRun(sessionId)
      const goal = goalSessionService.get(sessionId)
      const ownedByGoal = isGoalRunActive(sessionId, goal?.activeRunId)
      const ordinaryStop = ownedByGoal ? Promise.resolve() : stopAgentAndWait(sessionId)
      // 中断只暂停 Goal（对齐 Codex），用户再发消息即可续上；真停止走 /goal stop。
      const goalStop = goal?.status === 'active'
        ? goalSessionService.pauseForInterrupt(sessionId)
        : Promise.resolve()
      // 点击当刻就请求停止普通 owner；不在另一个 await 后按 sessionId 停掉新运行。
      await Promise.all([ordinaryStop, goalStop])
    }
  )

  // ===== Agent 队列消息 =====

  // 排队发送消息
  ipcMain.handle(
    AGENT_IPC_CHANNELS.QUEUE_MESSAGE,
    async (event, input: import('@profer/shared').AgentQueueMessageInput): Promise<string> => {
      assertSensitiveAgentIpcSender(event)
      return queueAgentMessage(input, event.sender)
    }
  )

  // ===== Agent 后台任务管理 =====

  // 获取任务输出。任务归属和输出路径由主进程 adapter 决定，renderer 只能提供会话/任务标识。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_TASK_OUTPUT,
    async (event, input: GetTaskOutputInput): Promise<GetTaskOutputResult> => {
      assertSensitiveAgentIpcSender(event)
      if (!input || typeof input !== 'object') throw new Error('无效的后台任务查询参数')
      if (typeof input.sessionId !== 'string' || !input.sessionId.trim() || input.sessionId.length > 200) {
        throw new Error('无效的后台任务会话标识')
      }
      if (typeof input.taskId !== 'string' || !input.taskId.trim() || input.taskId.length > 200) {
        throw new Error('无效的后台任务标识')
      }
      if (input.block !== undefined && typeof input.block !== 'boolean') {
        throw new Error('无效的后台任务阻塞参数')
      }
      if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 30_000)) {
        throw new Error('无效的后台任务超时时间')
      }
      return getAgentTaskOutput(input.sessionId, input.taskId, {
        block: input.block,
        timeoutMs: input.timeoutMs,
      })
    }
  )

  // 查询 runtime 能力。只读快照由主进程适配器提供，renderer 不自行推断。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_RUNTIME_CAPABILITIES,
    async (event, runtime: unknown): Promise<import('@profer/shared').AgentRuntimeCapabilities> => {
      assertSensitiveAgentIpcSender(event)
      if (!isAgentRuntime(runtime)) throw new Error(`无效的 Agent runtime: ${String(runtime)}`)
      return getAgentRuntimeCapabilities(runtime)
    },
  )

  // ===== Agent 权限系统 =====

  // 响应权限请求
  ipcMain.handle(
    AGENT_IPC_CHANNELS.PERMISSION_RESPOND,
    async (event, response: PermissionResponse): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      const { requestId, behavior, alwaysAllow } = response
      const sessionId = permissionService.respondToPermission(requestId, behavior, alwaysAllow)

      // 发送 permission_resolved 事件给渲染进程
      if (sessionId) {
        const payload: import('@profer/shared').AgentStreamPayload = {
          kind: 'profer_event',
          event: { type: 'permission_resolved', requestId, behavior },
        }
        // 必须进事件总线：remote-service 订阅 agentEventBus 后广播给所有 Pocket 客户端，
        // 并写入 WS 事件重放日志。若只走 event.sender.send，桌面端作答后移动端横幅不会消失
        //（与 WS 路径 respond_permission 的事件名/载荷保持一致）。
        // 统一出口仅在“该 session 未绑定 / 绑定已销毁 / 绑定不是本窗口”时补一次直发；
        // 已绑定时中间件已送达，不再直发，避免同一窗口渲染层收到两份同事件。
        emitSessionStreamEvent(sessionId, payload, event.sender)
      }
    }
  )

  // 停止任务。Agent 任务交给 runtime adapter；Pi 的 owned Shell 服务走 registry 的安全停止路径。
  // 不支持或无法确认归属时明确抛错，禁止静默成功。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.STOP_TASK,
    async (event, input: StopTaskInput): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      if (!input || typeof input !== 'object') throw new Error('无效的后台任务停止参数')
      if (typeof input.sessionId !== 'string' || !input.sessionId.trim() || input.sessionId.length > 200) {
        throw new Error('无效的后台任务会话标识')
      }
      if (typeof input.taskId !== 'string' || !input.taskId.trim() || input.taskId.length > 200) {
        throw new Error('无效的后台任务标识')
      }
      if (input.type !== 'agent' && input.type !== 'shell') {
        throw new Error('无效的后台任务类型')
      }
      await stopAgentTask(input.sessionId, input.taskId, input.type)
    }
  )

  // 热切换指定会话的权限模式（运行中生效，不广播）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE,
    async (_, sessionId: string, mode: ProferPermissionMode, expectedRevision?: number): Promise<AgentSessionMeta> => {
      if (!isProferPermissionMode(mode)) {
        throw new Error(`无效的权限模式: ${mode}`)
      }
      // 会话不存在时直接抛错（避免 updateAgentSessionMeta 的通用异常被降级为 warn）
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      const current = getAgentSessionMeta(sessionId)!
      if (expectedRevision !== undefined && (current.revision ?? 0) !== expectedRevision) {
        throw new Error('REVISION_CONFLICT: 会话状态已更新，请刷新后重试')
      }
      const updated = updateAgentSessionMeta(sessionId, { permissionMode: mode })
      // 若 session 正在跑，同步热切换运行时模式；失败时广播回滚后的权威状态。
      if (isAgentSessionActive(sessionId)) {
        await updateAgentPermissionMode(sessionId, mode).catch((err) => {
          const restored = updateAgentSessionMeta(sessionId, { permissionMode: current.permissionMode })
          publishAgentSessionProjection(restored)
          throw err
        })
      }
      publishAgentSessionProjection(updated)
      // 计划模式下等待的 Goal 在切换为可执行模式后立即继续。
      goalSessionService.nudge(sessionId)
      return updated
    }
  )

  // 空闲会话的 Codex Fast Mode：下一轮 Pi 请求读取持久化状态。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_CODEX_FAST_MODE,
    async (_, sessionId: string, enabled: boolean): Promise<AgentSessionMeta> => {
      if (typeof enabled !== 'boolean') throw new Error(`无效的 Codex Fast Mode 状态: ${String(enabled)}`)
      if (!getAgentSessionMeta(sessionId)) throw new Error(`Agent 会话不存在: ${sessionId}`)
      if (isAgentSessionActive(sessionId)) throw new Error('Agent 正在运行，完成后再切换快速模式')
      return updateAgentSessionUiMeta(sessionId, { codexFastMode: enabled })
    },
  )

  // Codex 推理档位跨会话记忆
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_OPENAI_THINKING,
    async (_, sessionId: string, level: AgentThinkingLevel | null): Promise<AgentSessionMeta> => {
      const validLevels: (AgentThinkingLevel | null)[] = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      // level 为 null 表示「使用全局默认」（清除会话级覆盖）
      if (level !== null && !validLevels.includes(level)) {
        throw new Error(`无效的推理档位: ${String(level)}`)
      }
      if (!getAgentSessionMeta(sessionId)) throw new Error(`Agent 会话不存在: ${sessionId}`)
      if (isAgentSessionActive(sessionId)) throw new Error('Agent 正在运行，完成后再切换推理档位')
      return updateAgentSessionUiMeta(sessionId, { openAIThinkingLevel: level })
    },
  )

  // 会话级推理强度覆盖（Claude/Pi 通用）：手动切换优先于预设/全局，null=清除覆盖。
  // 与 OpenAI 档位一致：运行中拒绝切换，只在本轮结束后（下一轮 query）生效。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_AGENT_EFFORT,
    async (_, sessionId: string, effort: AgentEffort | null): Promise<AgentSessionMeta> => {
      const validEfforts: (AgentEffort | null)[] = [null, 'low', 'medium', 'high', 'max']
      if (effort !== null && !validEfforts.includes(effort)) {
        throw new Error(`无效的推理强度: ${String(effort)}`)
      }
      if (!getAgentSessionMeta(sessionId)) throw new Error(`Agent 会话不存在: ${sessionId}`)
      if (isAgentSessionActive(sessionId)) throw new Error('Agent 正在运行，完成后再切换思考强度')
      return updateAgentSessionUiMeta(sessionId, { agentEffort: effort })
    },
  )

  // 查询某 Pi 模型可用的推理档位能力（renderer 思考档位菜单动态展示）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_PI_REASONING_CAPABILITY,
    async (_, provider: ProviderType, modelId: string | undefined, baseUrl?: string): Promise<ReasoningCapability | undefined> => {
      return resolvePiReasoningCapability(provider, modelId, baseUrl)
    },
  )

  // 首次发送前选择 runtime；正式会话永久绑定，旧会话及原生恢复资产不迁移。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_AGENT_RUNTIME,
    async (event, sessionId: string, runtime: AgentRuntime): Promise<AgentSessionMeta> => {
      assertSensitiveAgentIpcSender(event)
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) {
        throw new Error('Agent 会话标识无效')
      }
      if (!isAgentRuntime(runtime)) throw new Error(`无效的 Agent runtime: ${String(runtime)}`)
      const current = getAgentSessionMeta(sessionId)
      if (!current) throw new Error(`Agent 会话不存在: ${sessionId}`)
      if (normalizeAgentRuntime(current.agentRuntime) === runtime) return current
      if (!canSelectAgentSessionRuntime(current)) throw new Error(AGENT_SESSION_RUNTIME_LOCKED_MESSAGE)
      if (isAgentSessionActive(sessionId)) throw new Error('Agent 已开始运行，内核选择已固定')

      // 仅空会话可选内核；设置写入失败时还原选择，保持 revision 单调。
      const previousRuntime = snapshotAgentRuntimeMeta(current)
      const updated = updateAgentSessionMeta(sessionId, { agentRuntime: runtime })
      try {
        updateSettings({ agentRuntime: runtime })
        publishAgentSessionProjection(updated)
        return updated
      } catch (error) {
        // 回滚空会话的内核选择，主进程 guard 不允许回滚已经开始运行的会话。
        try {
          const restored = restoreAgentRuntimeMeta(sessionId, previousRuntime)
          publishAgentSessionProjection(restored)
        } catch { /* 保留原始设置错误 */ }
        throw error
      }
    },
  )

  // ===== 工作区记忆文件管理 =====

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_MEMORY_SUMMARY,
    async (_, workspaceSlug: string): Promise<WorkspaceMemorySummary> => {
      return getWorkspaceMemorySummary(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_WORKSPACE_PROFILE,
    async (_, workspaceSlug: string): Promise<SkillFileContent> => {
      return readWorkspaceProfile(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_WORKSPACE_PROFILE,
    async (event, workspaceSlug: string, content: string): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      writeWorkspaceProfile(workspaceSlug, content)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_WORKSPACE_AUTO_MEMORY_FILES,
    async (_, workspaceSlug: string) => {
      return listWorkspaceAutoMemoryFiles(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_WORKSPACE_AUTO_MEMORY_FILE,
    async (_, workspaceSlug: string, relativePath: string): Promise<SkillFileContent> => {
      return readWorkspaceAutoMemoryFile(workspaceSlug, relativePath)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_WORKSPACE_AUTO_MEMORY_FILE,
    async (event, workspaceSlug: string, relativePath: string, content: string): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      writeWorkspaceAutoMemoryFile(workspaceSlug, relativePath, content)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_WORKSPACE_MEMORY_ARCHIVE_FILES,
    async (_, workspaceSlug: string) => {
      return listWorkspaceMemoryArchiveFiles(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_WORKSPACE_MEMORY_ARCHIVE_FILE,
    async (_, workspaceSlug: string, relativePath: string): Promise<SkillFileContent> => {
      return readWorkspaceMemoryArchiveFile(workspaceSlug, relativePath)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_WORKSPACE_MEMORY_ARCHIVE_FILE,
    async (event, workspaceSlug: string, relativePath: string, content: string): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      writeWorkspaceMemoryArchiveFile(workspaceSlug, relativePath, content)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_MEMORY_ARCHIVE,
    async (_event, workspaceSlug: string, query: string, topK?: number) => {
      const searcher = createMemoryArchiveSearcher(getWorkspaceMemoryArchivePath(workspaceSlug))
      try {
        return searcher.search(query, topK ?? 20)
      } finally {
        searcher.close()
      }
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.RESOLVE_MEMORY_WIKILINK,
    async (_event, workspaceSlug: string, name: string): Promise<MemoryWikilinkTarget | null> => {
      const archiveDir = getWorkspaceMemoryArchivePath(workspaceSlug)
      const autoDir = getWorkspaceAutoMemoryDir(workspaceSlug)
      return resolveMemoryWikilink(archiveDir, autoDir, name)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_MEMORY_BACKLINKS,
    async (_event, workspaceSlug: string, currentAbsolutePath: string, currentLinkName: string): Promise<MemoryBacklink[]> => {
      const archiveDir = getWorkspaceMemoryArchivePath(workspaceSlug)
      const autoDir = getWorkspaceAutoMemoryDir(workspaceSlug)
      return findMemoryBacklinks(archiveDir, autoDir, currentAbsolutePath, currentLinkName)
    }
  )

  // ===== Chat 工具管理 =====

  // 获取所有工具信息
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS,
    async (): Promise<ChatToolInfo[]> => {
      return getAllToolInfos()
    }
  )

  // 获取工具凭据
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS,
    async (_, toolId: string, provider?: string): Promise<Record<string, string>> => {
      return getToolCredentials(toolId, provider)
    }
  )

  // 更新工具开关状态
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE,
    async (_, toolId: string, state: ChatToolState): Promise<void> => {
      updateToolState(toolId, state)
    }
  )

  // 更新工具凭据
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS,
    async (_, toolId: string, credentials: Record<string, string>): Promise<void> => {
      updateToolCredentials(toolId, credentials)
    }
  )

  // 创建自定义工具
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL,
    async (_, meta: ChatToolMeta): Promise<void> => {
      addCustomTool(meta)
    }
  )

  // 删除自定义工具
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL,
    async (_, toolId: string): Promise<void> => {
      deleteCustomTool(toolId)
    }
  )

  // 测试工具连接
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.TEST_TOOL,
    async (_, toolId: string): Promise<{ success: boolean; message: string }> => {
      // 记忆工具：本地文件记忆，无需测试连接
      if (toolId === 'memory') {
        return { success: true, message: '本地文件记忆已就绪' }
      }
      // 联网搜索工具测试
      if (toolId === 'web-search') {
        const { getToolCredentials: getCredentials } = await import('./lib/chat-tool-config')
        const credentials = getCredentials('web-search')
        if (!credentials.apiKey) {
          return { success: false, message: '请先填写 Tavily API Key' }
        }
        try {
          const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: credentials.apiKey,
              query: 'test connection',
              search_depth: 'basic',
              max_results: 1,
            }),
          })
          if (!response.ok) {
            const errorText = await response.text()
            return { success: false, message: `API 请求失败 (${response.status}): ${errorText}` }
          }
          return { success: true, message: '连接成功，Tavily 搜索 API 可用' }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return { success: false, message: `连接失败: ${msg}` }
        }
      }
      // AI 图片生成工具测试：官方模式走 Profer 登录态，自带 Key 模式按所选 provider 测试。
      if (toolId === 'gpt-image') {
        const { testGptImageConnection } = await import('./lib/gpt-image-connection')
        return testGptImageConnection()
      }
      if (toolId === 'nano-banana') {
        const { testLegacyImageToolConnection } = await import('./lib/gpt-image-connection')
        return testLegacyImageToolConnection(toolId)
      }
      return { success: false, message: `工具 ${toolId} 不支持测试` }
    }
  )

  // ===== AskUserQuestion 交互式问答 =====

  // 响应 AskUser 请求
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ASK_USER_RESPOND,
    async (event, response: AskUserResponse): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      const { requestId, answers } = response
      const sessionId = await askUserService.respondToAskUser(requestId, answers)

      if (sessionId) {
        const payload: import('@profer/shared').AgentStreamPayload = {
          kind: 'profer_event',
          event: { type: 'ask_user_resolved', requestId },
        }
        // 同步进事件总线（广播给 Pocket + 写重放日志），与 WS 路径 respond_ask_user 一致；
        // 统一出口只在未绑定/绑定已销毁/绑定非本窗口时补直发，避免重复投递。
        emitSessionStreamEvent(sessionId, payload, event.sender)
      }
    }
  )

  // ===== ExitPlanMode 计划审批 =====

  // 响应 ExitPlanMode 请求
  ipcMain.handle(
    AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND,
    async (event, response: ExitPlanModeResponse): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      const result = exitPlanService.respondToExitPlanMode(response)

      if (result) {
        const { sessionId, targetMode } = result

        // 通知渲染进程请求已处理
        const resolvedPayload: import('@profer/shared').AgentStreamPayload = {
          kind: 'profer_event',
          event: { type: 'exit_plan_mode_resolved', requestId: response.requestId },
        }
        // 同步进事件总线（广播给 Pocket + 写重放日志），与 WS 路径 respond_exit_plan_mode 一致；
        // 统一出口只在未绑定/绑定已销毁/绑定非本窗口时补直发，避免重复投递。
        emitSessionStreamEvent(sessionId, resolvedPayload, event.sender)

        // 如果用户选择了新的权限模式，通知渲染进程更新 UI
        if (targetMode) {
          const meta = getAgentSessionMeta(sessionId)
          // 持久化到 session meta，和 cycleMode 路径保持一致（重启后该 session 能恢复）
          if (meta) {
            try {
              const updated = updateAgentSessionMeta(sessionId, { permissionMode: targetMode })
              publishAgentSessionProjection(updated)
            } catch (err) {
              console.warn(`[IPC] ExitPlanMode 持久化 session 权限模式失败: sessionId=${sessionId}`, err)
            }
          }
          const modePayload: import('@profer/shared').AgentStreamPayload = {
            kind: 'profer_event',
            event: { type: 'permission_mode_changed', mode: targetMode },
          }
          // 与 WS 路径同样广播，否则桌面端完成计划审批后 Pocket 侧权限模式仍会滞后；
          // 统一出口只在未绑定/绑定已销毁/绑定非本窗口时补直发，避免重复投递。
          emitSessionStreamEvent(sessionId, modePayload, event.sender)
          console.log(`[IPC] ExitPlanMode 权限模式切换: ${targetMode}`)
        }
      }
    }
  )

  // ===== 待处理请求恢复 =====

  // 获取所有待处理的交互请求快照（渲染进程重载后恢复状态）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_PENDING_REQUESTS,
    async (event): Promise<import('@profer/shared').PendingRequestsSnapshot> => {
      assertSensitiveAgentIpcSender(event)
      return {
        permissions: permissionService.getPendingRequests(),
        askUsers: askUserService.getPendingRequests(),
        exitPlans: exitPlanService.getPendingRequests(),
      }
    }
  )

  // ===== Project Graph =====
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_GRAPH,
    async (event, sessionId: string) => {
      assertSensitiveAgentIpcSender(event)
      if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
        throw new Error('无效的会话标识')
      }
      const { loadGraph } = await import('./lib/project-graph-service')
      return loadGraph(sessionId)
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_GRAPH_SUMMARY,
    async (event, sessionId: string) => {
      assertSensitiveAgentIpcSender(event)
      if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
        throw new Error('无效的会话标识')
      }
      const { getGraphSummary } = await import('./lib/project-graph-service')
      return getGraphSummary(sessionId)
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.APPEND_GRAPH_EVENT,
    async (event, sessionId: string, graphEvent: import('@profer/project-core').GraphEvent) => {
      assertSensitiveAgentIpcSender(event)
      if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
        throw new Error('无效的会话标识')
      }
      if (!graphEvent || typeof graphEvent !== 'object' || !graphEvent.type) {
        throw new Error('无效的图事件')
      }
      const { appendGraphEvent } = await import('./lib/project-graph-service')
      appendGraphEvent(sessionId, graphEvent)
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.RUN_RETROSPECTIVE,
    async (_event, sessionId: string) => {
      const { runRetrospective } = await import('./lib/retrospective-service')
      return runRetrospective(sessionId)
    },
  )

  // ===== Agent 附件 =====

  // 保存文件到 Agent session 工作目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION,
    async (_, input: AgentSaveFilesInput): Promise<AgentSavedFile[]> => {
      return saveFilesToAgentSession(input)
    }
  )

  // 保存文件到工作区文件目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE,
    async (_, input: AgentSaveWorkspaceFilesInput): Promise<AgentSavedFile[]> => {
      return saveFilesToWorkspaceFiles(input)
    }
  )

  // 获取工作区文件目录路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_FILES_PATH,
    async (_, workspaceSlug: string): Promise<string> => {
      return getWorkspaceFilesDir(workspaceSlug)
    }
  )

  // 打开文件夹选择对话框
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FOLDER_DIALOG,
    async (): Promise<{ path: string; name: string } | null> => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return null

      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择文件夹',
      })

      if (result.canceled || result.filePaths.length === 0) return null

      const folderPath = result.filePaths[0]!
      const name = folderPath.split('/').filter(Boolean).pop() || 'folder'
      return { path: folderPath, name }
    }
  )

  // 附加外部目录到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_DIRECTORY,
    async (_, input: AgentAttachDirectoryInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

      const existing = meta.attachedDirectories ?? []
      if (existing.includes(input.directoryPath)) return existing

      const updated = [...existing, input.directoryPath]
      updateAgentSessionMeta(input.sessionId, { attachedDirectories: updated })
      // 启动附加目录文件监听
      watchAttachedDirectory(input.directoryPath)
      return updated
    }
  )

  // 移除会话的附加目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_DIRECTORY,
    async (_, input: AgentAttachDirectoryInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

      const existing = meta.attachedDirectories ?? []
      const updated = existing.filter((d) => d !== input.directoryPath)
      updateAgentSessionMeta(input.sessionId, { attachedDirectories: updated })
      // 停止附加目录文件监听
      unwatchAttachedDirectory(input.directoryPath)
      return updated
    }
  )

  // 附加外部文件到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_FILE,
    async (_, input: AgentAttachFileInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

      const { realpathSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const safePath = realpathSync(resolve(input.filePath))
      const stats = statSync(safePath)
      if (!stats.isFile()) throw new Error('只能附加文件')

      const existing = meta.attachedFiles ?? []
      if (existing.includes(safePath)) return existing

      const updated = [...existing, safePath]
      updateAgentSessionMeta(input.sessionId, { attachedFiles: updated })
      return updated
    }
  )

  // 移除会话的附加文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_FILE,
    async (_, input: AgentAttachFileInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

      const existing = meta.attachedFiles ?? []
      const updated = existing.filter((f) => f !== input.filePath)
      updateAgentSessionMeta(input.sessionId, { attachedFiles: updated })
      return updated
    }
  )

  // 附加外部目录到工作区（所有会话可访问）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_DIRECTORY,
    async (_, input: WorkspaceAttachDirectoryInput): Promise<string[]> => {
      const updated = attachWorkspaceDirectory(input.workspaceSlug, input.directoryPath)
      watchAttachedDirectory(input.directoryPath)
      return updated
    }
  )

  // 移除工作区的附加目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_WORKSPACE_DIRECTORY,
    async (_, input: WorkspaceAttachDirectoryInput): Promise<string[]> => {
      const updated = detachWorkspaceDirectory(input.workspaceSlug, input.directoryPath)
      unwatchAttachedDirectory(input.directoryPath)
      return updated
    }
  )

  // 附加外部文件到工作区（所有会话可访问）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_FILE,
    async (_, input: WorkspaceAttachFileInput): Promise<string[]> => {
      const { realpathSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const safePath = realpathSync(resolve(input.filePath))
      const stats = statSync(safePath)
      if (!stats.isFile()) throw new Error('只能附加文件')

      return attachWorkspaceFile(input.workspaceSlug, safePath)
    }
  )

  // 移除工作区的附加文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_WORKSPACE_FILE,
    async (_, input: WorkspaceAttachFileInput): Promise<string[]> => {
      return detachWorkspaceFile(input.workspaceSlug, input.filePath)
    }
  )

  // 获取工作区附加目录列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_DIRECTORIES,
    async (_, workspaceSlug: string): Promise<string[]> => {
      return getWorkspaceAttachedDirectories(workspaceSlug)
    }
  )

  // 获取工作区附加文件列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_ATTACHED_FILES,
    async (_, workspaceSlug: string): Promise<string[]> => {
      return getWorkspaceAttachedFiles(workspaceSlug)
    }
  )

  // ===== Worktree 仓库配置管理 =====

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKTREE_REPOS,
    async (_, workspaceSlug: string) => {
      return await getWorktreeRepos(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.ADD_WORKTREE_REPO,
    async (_, workspaceSlug: string, repo: import('@profer/shared').WorkspaceWorktreeRepo) => {
      return addWorktreeRepo(workspaceSlug, repo)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.REMOVE_WORKTREE_REPO,
    async (_, workspaceSlug: string, repoPath: string) => {
      return removeWorktreeRepo(workspaceSlug, repoPath)
    }
  )

  // ===== Agent 文件系统操作 =====

  // 获取 session 工作路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SESSION_PATH,
    async (_, workspaceId: string, sessionId: string): Promise<string | null> => {
      const ws = getAgentWorkspace(workspaceId)
      if (!ws) return null
      return getAgentSessionWorkspacePath(ws.slug, sessionId)
    }
  )

  // 列出目录内容（浅层，安全校验）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_DIRECTORY,
    async (_, dirPath: string, access?: FileAccessOptions | string[]): Promise<FileEntry[]> => {
      const { existsSync, readdirSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const { expandHomeDirectory } = await import('./lib/file-preview-service')

      const options = normalizeFileAccessOptions(access)
      const safePath = resolve(expandHomeDirectory(String(dirPath ?? '')))

      // 目录可能已被删除（如删除 Agent 会话后面板仍持有旧路径），优雅返回空列表
      if (!existsSync(safePath)) {
        return []
      }
      // 列出目录内容属只读预览：授权根内直接放行，根外按只读策略（系统/凭据敏感位置仍拒绝）。
      // 预览面板的目录视图依赖它列工作区外的目录。
      if (!isPreviewPathAllowed(safePath, options)) {
        throw new Error('路径不在允许预览的范围内')
      }
      if (!statSync(safePath).isDirectory()) {
        throw new Error('路径不是目录')
      }

      const entries: FileEntry[] = []
      const items = readdirSync(safePath, { withFileTypes: true })

      for (const item of items) {
        if (HIDDEN_FS_ENTRIES.has(item.name)) continue
        const fullPath = resolve(safePath, item.name)
        const isDirectory = item.isDirectory()
        const size = isDirectory ? undefined : statSync(fullPath).size
        entries.push({
          name: item.name,
          path: fullPath,
          isDirectory,
          size,
        })
      }

      // 目录在前，文件在后；隐藏文件（.开头）排在同类末尾，各自按名称排序
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        const aHidden = a.name.startsWith('.')
        const bHidden = b.name.startsWith('.')
        if (aHidden !== bHidden) return aHidden ? 1 : -1
        return a.name.localeCompare(b.name)
      })

      return entries
    }
  )

  // 删除文件或目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_FILE,
    async (_, filePath: string): Promise<void> => {
      const { rmSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      // 安全校验：路径必须在 agent-workspaces 目录下
      const safePath = resolve(filePath)
      assertInsideAgentWorkspaces(safePath)

      try {
        // maxRetries/retryDelay 处理 Windows 下目录被占用/未清空的瞬态错误（EBUSY/ENOTEMPTY 等）
        rmSync(safePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        console.log(`[Agent 文件] 已删除: ${safePath}`)
      } catch (err) {
        throw new Error(await toFsErrorMessage(err, '删除', safePath))
      }
    }
  )

  // 移动文件或目录到系统回收站（可恢复）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_TO_TRASH,
    async (_, filePath: string): Promise<void> => {
      const { resolve } = await import('node:path')

      // 安全校验：路径必须在 agent-workspaces 目录下
      const safePath = resolve(filePath)
      assertInsideAgentWorkspaces(safePath)

      try {
        await shell.trashItem(safePath)
        console.log(`[Agent 文件] 已移入回收站: ${safePath}`)
      } catch (err) {
        throw new Error(await toFsErrorMessage(err, '移入回收站', safePath))
      }
    }
  )

  // 递归读取目录中所有文件（用于文件夹上传）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_DIRECTORY_RECURSIVE,
    async (_, dirPath: string): Promise<Array<{ relativePath: string; data: Uint8Array }>> => {
      const { readdirSync, statSync, readFileSync } = await import('node:fs')
      const { resolve, relative, join } = await import('node:path')

      const safePath = resolve(dirPath)
      assertInsideAgentWorkspaces(safePath)

      const results: Array<{ relativePath: string; data: Uint8Array }> = []
      const walk = (currentDir: string) => {
        const items = readdirSync(currentDir, { withFileTypes: true })
        for (const item of items) {
          const full = join(currentDir, item.name)
          if (item.isDirectory()) {
            walk(full)
          } else {
            const relPath = relative(safePath, full)
            const buffer = readFileSync(full)
            results.push({ relativePath: relPath, data: new Uint8Array(buffer) })
          }
        }
      }
      walk(safePath)
      return results
    }
  )

  // 打开原生文件夹选择对话框，递归读取所有文件内容
  ipcMain.handle(
    'agent:select-and-upload-folder',
    async (): Promise<Array<{ relativePath: string; data: Uint8Array; sourcePath: string }> | null> => {
      const { readdirSync, readFileSync, statSync } = await import('node:fs')
      const { resolve, relative, join, basename } = await import('node:path')
      const { BrowserWindow, dialog } = await import('electron')

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return null

      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择要上传的文件夹',
      })
      if (result.canceled || result.filePaths.length === 0) return null

      const dirPath = resolve(result.filePaths[0]!)
      const results: Array<{ relativePath: string; data: Uint8Array; sourcePath: string }> = []

      // 限制：最多 1000 个文件、单文件最大 50MB、跳过敏感文件名
      const MAX_FILES = 1000
      const MAX_FILE_SIZE = 50 * 1024 * 1024
      const SENSITIVE_NAMES = new Set([
        '.env', '.env.local', '.env.production',
        'credentials.json', 'secrets.json', 'secret.key',
        'id_rsa', 'id_ed25519', 'id_ecdsa',
      ])
      const SENSITIVE_EXTENSIONS = new Set(['.pem', '.pfx', '.p12', '.key', '.keystore', '.jks'])
      const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])

      let fileCount = 0
      const walk = (currentDir: string) => {
        const items = readdirSync(currentDir, { withFileTypes: true })
        for (const item of items) {
          if (fileCount >= MAX_FILES) break
          if (SKIP_DIRS.has(item.name)) continue
          const full = join(currentDir, item.name)
          if (item.isDirectory()) {
            walk(full)
          } else {
            // 跳过敏感文件
            const lowerName = item.name.toLowerCase()
            if (SENSITIVE_NAMES.has(item.name) || SENSITIVE_EXTENSIONS.has(lowerName.slice(lowerName.lastIndexOf('.')))) continue
            try {
              const st = statSync(full)
              if (st.size > MAX_FILE_SIZE) continue
              const buffer = readFileSync(full)
              fileCount++
              const relPath = relative(dirPath, full)
              results.push({ relativePath: relPath, data: new Uint8Array(buffer), sourcePath: full })
            } catch {
              // 跳过无法读取的文件
            }
          }
        }
      }
      walk(dirPath)
      return results
    }
  )

  // 用系统默认应用打开文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FILE,
    async (_, filePath: string): Promise<void> => {
      const { resolve } = await import('node:path')

      const safePath = resolve(filePath)
      assertInsideAgentWorkspaces(safePath)

      const errMsg = await shell.openPath(safePath)
      if (errMsg) console.warn('[IPC] agent:open-file 打开失败:', errMsg)
    }
  )

  // 将剪贴板文本写入临时预览文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_CLIPBOARD_PREVIEW,
    async (_, filename: string, content: string): Promise<string> => {
      if (typeof filename !== 'string' || !filename) {
        throw new Error('filename 必须是非空字符串')
      }
      if (typeof content !== 'string') {
        throw new Error('content 必须是字符串')
      }

      const { isAbsolute, join, relative, resolve } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { existsSync, mkdirSync } = await import('node:fs')
      const { writeFile } = await import('node:fs/promises')

      const tmpDir = join(tmpdir(), 'profer-preview')
      if (!existsSync(tmpDir)) {
        mkdirSync(tmpDir, { recursive: true })
      }

      // 安全文件名：替换路径分隔符和特殊字符，防止目录穿越
      const safeFilename = filename.replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '_')
      const tmpPath = resolve(tmpDir, safeFilename)

      // 确保 resolve 后的路径仍在 tmpDir 内，兼容 Windows 路径分隔符
      const relativePath = relative(tmpDir, tmpPath)
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('文件名越界')
      }

      await writeFile(tmpPath, content, 'utf-8')
      console.log(`[IPC] clipboard 预览文件已写入: ${tmpPath}`)
      return tmpPath
    }
  )

  // 在系统文件管理器中显示文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SHOW_IN_FOLDER,
    async (_, filePath: string): Promise<void> => {
      const { resolve } = await import('node:path')

      const safePath = resolve(filePath)
      assertInsideAgentWorkspaces(safePath)

      shell.showItemInFolder(safePath)
    }
  )

  // 在系统文件管理器中显示任意路径（无工作区限制，用户主动点击触发）
  ipcMain.handle(
    IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    async (_, filePath: string, candidateBasePaths?: string[]): Promise<boolean> => {
      const { resolve } = await import('node:path')
      const { existsSync } = await import('node:fs')
      const { resolveTargetPath } = await import('./lib/file-preview-service')

      const resolvedPath = resolveTargetPath(filePath, candidateBasePaths?.length ? candidateBasePaths : undefined)
      if (!existsSync(resolvedPath)) {
        console.warn('[IPC] shell:show-item-in-folder 路径不存在:', resolvedPath)
        return false
      }
      shell.showItemInFolder(resolve(resolvedPath))
      return true
    }
  )

  // 解析文件路径并读取内容（供内联预览使用）
  ipcMain.handle(
    'file:resolve-and-read',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ resolvedPath: string; content: string } | null> => {
      const { resolveAndReadFile, resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const allowedBasePaths = getAllowedCandidateBasePaths(options)
      const resolved = resolveFilePath(filePath, allowedBasePaths)
      if (!resolved || !isPreviewPathAllowed(resolved, options)) {
        console.warn('[IPC] file:resolve-and-read 拒绝系统/凭据敏感路径:', resolved ?? filePath)
        return null
      }
      const result = resolveAndReadFile(resolved)
      return result
    }
  )

  // 写入文本文件（供 Markdown 内联编辑使用）
  ipcMain.handle(
    'file:write-text',
    async (_, filePath: string, content: string, access?: FileAccessOptions | string[]): Promise<boolean> => {
      if (typeof content !== 'string') return false
      const { writeFileSync } = await import('node:fs')
      const { resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const allowedBasePaths = getAllowedCandidateBasePaths(options)
      const resolved = resolveFilePath(filePath, allowedBasePaths)
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:write-text 拒绝越界路径:', resolved ?? filePath)
        return false
      }
      writeFileSync(resolved, content, 'utf-8')
      return true
    }
  )

  // 文件路径 chip 的后台候选搜索：根目录只由主进程按会话元数据构造。
  ipcMain.handle(
    'file:search-candidate',
    async (_, input: import('@profer/shared').FileSearchCandidateRequest): Promise<import('@profer/shared').FileSearchCandidateResult> => {
      if (!input || typeof input.sessionId !== 'string' || typeof input.requestId !== 'string' || typeof input.targetName !== 'string') {
        throw new Error('文件搜索请求无效')
      }
      const roots = getFileSearchRoots(input.sessionId)
      if (roots.length === 0) throw new Error('Agent 会话不存在或没有授权搜索目录')
      if (activeFileSearches.has(input.requestId)) {
        return { requestId: input.requestId, done: true, cancelled: true, error: '搜索请求已在进行中' }
      }
      const controller = new AbortController()
      activeFileSearches.set(input.requestId, controller)
      try {
        const result: FileCandidateSearchResult = await searchFileCandidate({
          requestId: input.requestId,
          targetName: input.targetName,
          roots,
          maxDepth: input.mode === 'deep' ? 12 : 3,
          maxResults: input.mode === 'deep' ? 50 : 1,
          alreadyFound: input.alreadyFound,
          signal: controller.signal,
        })
        return result
      } catch (error) {
        return {
          requestId: input.requestId,
          done: true,
          cancelled: controller.signal.aborted,
          error: error instanceof Error ? error.message : '文件搜索失败',
        }
      } finally {
        activeFileSearches.delete(input.requestId)
      }
    },
  )

  ipcMain.handle(
    'file:cancel-search',
    async (_, requestId: string): Promise<boolean> => {
      const controller = activeFileSearches.get(requestId)
      if (!controller) return false
      controller.abort()
      return true
    },
  )

  // 仅解析文件路径（供 PDF/图片等用 profer-file:// 加载）
  ipcMain.handle(
    'file:resolve-path',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<ResolvedFileUrl | null> => {
      const { resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      // 预检模式（preflight=true）下跳过全局递归搜索，只做快速查找，避免批量预检阻塞主进程
      const result = resolveFilePath(filePath, getAllowedCandidateBasePaths(options), { skipGlobalSearch: options?.preflight })
      if (result && !isPreviewPathAllowed(result, options)) {
        console.warn('[IPC] file:resolve-path 拒绝系统/凭据敏感路径:', result)
        return null
      }
      return result ? { url: registerProferFilePath(result), resolvedPath: result } : null
    }
  )

  // 判断一个路径是文件、目录、不存在，还是存在但不可预览。
  // 预览面板用它区分「目录链接」与「真不存在」，也给拒绝场景一个准确提示。
  ipcMain.handle(
    'file:describe-path',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ kind: 'file' | 'directory' | 'missing' | 'denied' }> => {
      const { existsSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const { expandHomeDirectory } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const safePath = resolve(expandHomeDirectory(String(filePath ?? '')))
      if (!filePath || !existsSync(safePath)) return { kind: 'missing' }
      if (!isPreviewPathAllowed(safePath, options)) {
        console.warn('[IPC] file:describe-path 拒绝系统/凭据敏感路径:', safePath)
        return { kind: 'denied' }
      }
      try {
        return { kind: statSync(safePath).isDirectory() ? 'directory' : 'file' }
      } catch {
        return { kind: 'missing' }
      }
    }
  )

  // 为 HTML 预览注册所在目录，使相对 CSS、脚本和图片资源保持可加载。
  // 返回的仍是 token-gated profer-file URL，不向渲染进程泄露本机绝对路径。
  ipcMain.handle(
    'file:resolve-html-preview-path',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<ResolvedFileUrl | null> => {
      const { resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const result = resolveFilePath(filePath, getAllowedCandidateBasePaths(options))
      if (!result || !isPreviewPathAllowed(result, options)) {
        console.warn('[IPC] file:resolve-html-preview-path 拒绝系统/凭据敏感路径:', result ?? filePath)
        return null
      }
      try {
        const directoryUrl = registerProferDirectoryPath(dirname(result))
        return { url: `${directoryUrl}/${encodeURIComponent(basename(result))}` }
      } catch (err) {
        console.warn('[IPC] file:resolve-html-preview-path 无法注册预览目录，跳过:', result, err instanceof Error ? err.message : err)
        return null
      }
    }
  )

  // 为内联 PDF 预览生成临时 HTML 文件，返回文件路径
  ipcMain.handle(
    'file:prepare-pdf-preview',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ tmpHtmlUrl: string } | null> => {
      const { preparePdfPreview, resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const allowedBasePaths = getAllowedCandidateBasePaths(options)
      const resolved = resolveFilePath(filePath, allowedBasePaths)
      if (!resolved || !isPreviewPathAllowed(resolved, options)) {
        console.warn('[IPC] file:prepare-pdf-preview 拒绝系统/凭据敏感路径:', resolved ?? filePath)
        return null
      }
      const result = await preparePdfPreview(resolved)
      return result ? { tmpHtmlUrl: result.tmpHtmlUrl } : null
    }
  )

  // DOCX 转 HTML（内联预览使用 mammoth）
  ipcMain.handle(
    'file:docx-to-html',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ resolvedPath: string; html: string } | null> => {
      const { convertDocxToHtml, resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const allowedBasePaths = getAllowedCandidateBasePaths(options)
      const resolved = resolveFilePath(filePath, allowedBasePaths)
      if (!resolved || !isPreviewPathAllowed(resolved, options)) {
        console.warn('[IPC] file:docx-to-html 拒绝系统/凭据敏感路径:', resolved ?? filePath)
        return null
      }
      const result = await convertDocxToHtml(resolved)
      return result
    }
  )

  // XLSX/PPTX 转 HTML（内联预览使用 OOXML 解析）
  ipcMain.handle(
    'file:office-to-html',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<import('@profer/shared').OfficePreviewResult | null> => {
      const { convertOfficeToHtml, resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const allowedBasePaths = getAllowedCandidateBasePaths(options)
      const resolved = resolveFilePath(filePath, allowedBasePaths)
      if (!resolved || !isPreviewPathAllowed(resolved, options)) {
        console.warn('[IPC] file:office-to-html 拒绝系统/凭据敏感路径:', resolved ?? filePath)
        return null
      }
      return convertOfficeToHtml(resolved)
    }
  )

  // 注册文件路径到 profer-file:// 协议（只读预览）
  // 授权根内直接放行；根外按只读预览策略校验（系统/凭据敏感位置仍拒绝）。
  ipcMain.handle(
    'file:register-preview-path',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<string | null> => {
      const { statSync } = await import('node:fs')
      const { registerProferFilePath } = await import('./lib/local-file-protocol')
      const { expandHomeDirectory } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      try {
        // Agent 输出常用 `~/...` 写法；statSync / 协议注册都需要真实路径
        const targetPath = expandHomeDirectory(filePath)
        if (!statSync(targetPath).isFile()) return null
        if (!isPreviewPathAllowed(targetPath, options)) {
          console.warn('[IPC] file:register-preview-path 拒绝系统/凭据敏感路径:', targetPath)
          return null
        }
        return registerProferFilePath(targetPath)
      } catch { return null }
    }
  )

  // 读取文件为 base64（带路径校验，供内联图片预览等使用）
  ipcMain.handle(
    'file:read-binary-base64',
    async (_, filePath: string, access?: FileAccessOptions | string[], maxSize?: number): Promise<string | null> => {
      const { readFileSync, statSync } = await import('node:fs')
      const { resolveFilePath } = await import('./lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const resolved = resolveFilePath(filePath, getAllowedCandidateBasePaths(options))
      if (!resolved || !isPreviewPathAllowed(resolved, options)) return null
      const st = statSync(resolved)
      if (maxSize && st.size > maxSize) return null
      return readFileSync(resolved).toString('base64')
    }
  )

  // 重命名文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_FILE,
    async (_, filePath: string, newName: string): Promise<void> => {
      const { renameSync } = await import('node:fs')
      const { resolve, dirname, join, sep } = await import('node:path')

      if (newName.includes('/') || newName.includes('\\') || newName.includes('..') || newName.includes(sep)) {
        throw new Error('文件名不能包含路径分隔符或 ".."')
      }

      const safePath = resolve(filePath)
      assertInsideAgentWorkspaces(safePath)

      const newPath = join(dirname(safePath), newName)
      try {
        renameSync(safePath, newPath)
        console.log(`[Agent 文件] 已重命名: ${safePath} → ${newPath}`)
      } catch (err) {
        throw new Error(await toFsErrorMessage(err, '重命名', safePath))
      }
    }
  )

  // 移动文件/目录到目标目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_FILE,
    async (_, filePath: string, targetDir: string): Promise<void> => {
      const { renameSync } = await import('node:fs')
      const { resolve, basename, join } = await import('node:path')

      const safePath = resolve(filePath)
      const safeTarget = resolve(targetDir)
      assertInsideAgentWorkspaces(safePath)
      assertInsideAgentWorkspaces(safeTarget)

      const newPath = join(safeTarget, basename(safePath))
      renameSync(safePath, newPath)
      console.log(`[Agent 文件] 已移动: ${safePath} → ${newPath}`)
    }
  )

  // 列出附加目录内容
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY,
    async (_, dirPath: string, access?: FileAccessOptions | string[]): Promise<FileEntry[]> => {
      const { readdirSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      const safePath = resolve(dirPath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      const entries: FileEntry[] = []
      const items = readdirSync(safePath, { withFileTypes: true })

      for (const item of items) {
        if (HIDDEN_FS_ENTRIES.has(item.name)) continue
        const fullPath = resolve(safePath, item.name)
        const isDirectory = item.isDirectory()
        const size = isDirectory ? undefined : statSync(fullPath).size
        entries.push({
          name: item.name,
          path: fullPath,
          isDirectory,
          size,
        })
      }

      // 目录在前，文件在后；隐藏文件（.开头）排在同类末尾
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        const aHidden = a.name.startsWith('.')
        const bHidden = b.name.startsWith('.')
        if (aHidden !== bHidden) return aHidden ? 1 : -1
        return a.name.localeCompare(b.name)
      })

      return entries
    }
  )

  // 读取附加目录文件内容为 base64（限制在已附加目录范围内，用于侧面板添加到聊天）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_ATTACHED_FILE,
    async (_, filePath: string, sessionId?: string, workspaceSlug?: string): Promise<string> => {
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('无效的文件路径')
      }

      const { resolve, sep } = await import('node:path')
      const { readFile, stat, realpath } = await import('node:fs/promises')

      // 使用 realpath 解析符号链接，防止 symlink 绕过路径检查
      const safePath = await realpath(resolve(filePath)).catch(() => {
        throw new Error(`文件不存在: ${filePath}`)
      })

      // 收集所有允许的路径：会话/工作区附加目录、附加文件 + 工作区文件目录
      const allowedDirs: string[] = []
      const allowedFiles: string[] = []

      if (sessionId) {
        const meta = getAgentSessionMeta(sessionId)
        if (meta?.attachedDirectories) {
          allowedDirs.push(...meta.attachedDirectories)
        }
        if (meta?.attachedFiles) {
          allowedFiles.push(...meta.attachedFiles)
        }
      }
      if (workspaceSlug) {
        allowedDirs.push(...getWorkspaceAttachedDirectories(workspaceSlug))
        allowedFiles.push(...getWorkspaceAttachedFiles(workspaceSlug))
        allowedDirs.push(getWorkspaceFilesDir(workspaceSlug))
      }

      // 还允许访问 agent-workspaces 根目录下的文件（session 文件等）
      allowedDirs.push(getAgentWorkspacesDir())

      const resolvedAllowedDirs = await Promise.all(
        allowedDirs.map((dir) => realpath(resolve(dir)).catch(() => resolve(dir)))
      )
      const resolvedAllowedFiles = await Promise.all(
        allowedFiles.map((file) => realpath(resolve(file)).catch(() => resolve(file)))
      )
      const isAllowed = resolvedAllowedDirs.some((dir) => safePath.startsWith(dir + sep) || safePath === dir)
        || resolvedAllowedFiles.some((file) => safePath === file)
      if (!isAllowed) {
        throw new Error('访问路径不在允许范围内')
      }

      const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
      const fileStat = await stat(safePath).catch(() => null)
      if (!fileStat) {
        throw new Error(`文件不存在: ${filePath}`)
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        throw new Error(`文件过大（${Math.round(fileStat.size / 1024 / 1024)}MB），最大支持 20MB`)
      }

      const buffer = await readFile(safePath)
      return buffer.toString('base64')
    }
  )

  // 在文件管理器中显示附加目录文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { resolve } = await import('node:path')
      const safePath = resolve(filePath)
      const options = normalizeFileAccessOptions(access)
      if (!isPreviewPathAllowed(safePath, options)) {
        console.warn('[IPC] show-attached-in-folder 拒绝系统/凭据敏感路径:', safePath)
        return
      }
      shell.showItemInFolder(safePath)
    }
  )

  // 重命名附加目录文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE,
    async (_, filePath: string, newName: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { renameSync } = await import('node:fs')
      const { resolve, dirname, join, sep } = await import('node:path')

      if (newName.includes('/') || newName.includes('\\') || newName.includes('..') || newName.includes(sep)) {
        throw new Error('文件名不能包含路径分隔符或 ".."')
      }
      const safePath = resolve(filePath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      const newPath = join(dirname(safePath), newName)
      renameSync(safePath, newPath)
      console.log(`[附加目录] 已重命名: ${safePath} → ${newPath}`)
    }
  )

  // 移动附加目录文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE,
    async (_, filePath: string, targetDir: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { renameSync } = await import('node:fs')
      const { resolve, basename, join } = await import('node:path')

      const safePath = resolve(filePath)
      const safeTarget = resolve(targetDir)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options) || !isPathAllowed(safeTarget, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      const newPath = join(safeTarget, basename(safePath))
      renameSync(safePath, newPath)
      console.log(`[附加目录] 已移动: ${safePath} → ${newPath}`)
    }
  )

  // 删除附加目录文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_ATTACHED_FILE,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { rmSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      const safePath = resolve(filePath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      try {
        rmSync(safePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        console.log(`[附加目录] 已删除: ${safePath}`)
      } catch (err) {
        throw new Error(await toFsErrorMessage(err, '删除', safePath))
      }
    }
  )

  // 将附加目录文件/目录移入系统回收站
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_ATTACHED_TO_TRASH,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { resolve } = await import('node:path')
      const safePath = resolve(filePath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      try {
        await shell.trashItem(safePath)
        console.log(`[附加目录] 已移入回收站: ${safePath}`)
      } catch (err) {
        throw new Error(await toFsErrorMessage(err, '移入回收站', safePath))
      }
    }
  )

  // 检查路径类型（文件 or 目录），用于拖拽检测
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CHECK_PATHS_TYPE,
    async (_, paths: string[]): Promise<{ directories: string[]; files: string[] }> => {
      const { statSync } = await import('node:fs')
      const directories: string[] = []
      const files: string[] = []
      for (const p of paths) {
        try {
          const stat = statSync(p)
          if (stat.isDirectory()) {
            directories.push(p)
          } else {
            files.push(p)
          }
        } catch {
          // 无法访问的路径忽略
        }
      }
      return { directories, files }
    }
  )

  // 搜索工作区文件（用于 @ 引用，递归扫描，支持附加目录）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES,
    async (_, rootPath: string, query: string, limit = 20, additionalPaths?: string[], sessionPaths?: string[]): Promise<FileSearchResult> => {
      const { readdirSync, statSync } = await import('node:fs')
      const { resolve, relative, basename } = await import('node:path')

      const safeRoot = resolve(rootPath)
      const ignoreDirs = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'build', '.cache'])
      const ignoreFiles = new Set(['.DS_Store', '.Spotlight-V100', '.Trashes', 'Thumbs.db', 'desktop.ini'])
      const BROWSE_LIMIT_PER_GROUP = 2000
      const BROWSE_TOTAL_CAP = 3000

      // 按来源分组收集文件
      type Entry = { name: string; path: string; type: 'file' | 'dir'; source: 'session' | 'workspace' }
      const rootEntries: Entry[] = []
      const workspaceEntries: Entry[] = []

      function scan(
        dir: string,
        depth: number,
        baseRoot: string,
        target: Entry[],
        useAbsPath: boolean,
        source: 'session' | 'workspace',
      ): void {
        if (depth > 10) return
        try {
          const items = readdirSync(dir, { withFileTypes: true })
          for (const item of items) {
            if (ignoreFiles.has(item.name)) continue
            if (item.isDirectory() && ignoreDirs.has(item.name)) continue

            const fullPath = resolve(dir, item.name)
            const entryPath = useAbsPath ? fullPath : relative(baseRoot, fullPath)
            target.push({
              name: item.name,
              path: entryPath,
              type: item.isDirectory() ? 'dir' : 'file',
              source,
            })

            if (item.isDirectory()) {
              scan(fullPath, depth + 1, baseRoot, target, useAbsPath, source)
            }
          }
        } catch {
          // 忽略无权限的目录
        }
      }

      function addAttachedPath(pathValue: string, target: Entry[], source: 'session' | 'workspace'): void {
        try {
          const attachedPath = resolve(pathValue)
          const name = basename(attachedPath)
          if (ignoreFiles.has(name)) return

          const stats = statSync(attachedPath)
          if (stats.isFile()) {
            target.push({
              name,
              path: attachedPath,
              type: 'file',
              source,
            })
            return
          }

          if (!stats.isDirectory()) return
          if (ignoreDirs.has(name)) return

          target.push({
            name: name === 'workspace-files' ? '工作文件' : name,
            path: attachedPath,
            type: 'dir',
            source,
          })
          scan(attachedPath, 0, attachedPath, target, true, source)
        } catch {
          // 忽略不存在或无权限的附加路径
        }
      }

      // session 目录：相对路径
      scan(safeRoot, 0, safeRoot, rootEntries, false, 'session')

      // 会话级附加路径：绝对路径，标记为 session（归入会话文件分组）
      if (sessionPaths && sessionPaths.length > 0) {
        for (const sp of sessionPaths) {
          addAttachedPath(sp, rootEntries, 'session')
        }
      }

      // 工作区文件 + 工作区级附加路径：绝对路径，标记为 workspace
      if (additionalPaths && additionalPaths.length > 0) {
        for (const addPath of additionalPaths) {
          addAttachedPath(addPath, workspaceEntries, 'workspace')
        }
      }

      // 组内排序：目录优先，前缀匹配优先，路径短优先
      function sortGroup(entries: Entry[], q: string): void {
        entries.sort((a, b) => {
          const aStartsWith = a.name.toLowerCase().startsWith(q) ? 0 : 1
          const bStartsWith = b.name.toLowerCase().startsWith(q) ? 0 : 1
          if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith
          if (a.type === 'dir' && b.type !== 'dir') return -1
          if (a.type !== 'dir' && b.type === 'dir') return 1
          return a.path.length - b.path.length
        })
      }

      function matchEntries(entries: Entry[], q: string): Entry[] {
        return entries.filter((entry) => {
          const nameLower = entry.name.toLowerCase()
          const pathLower = entry.path.toLowerCase()
          if (nameLower.startsWith(q)) return true
          if (nameLower.includes(q) || pathLower.includes(q)) return true
          let qi = 0
          for (let i = 0; i < nameLower.length && qi < q.length; i++) {
            if (nameLower[i] === q[qi]) qi++
          }
          return qi === q.length
        })
      }

      // 目录优先排序：确保截断前所有目录（特别是顶层目录）排在前面
      function sortDirsFirst(entries: Entry[]): void {
        entries.sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1
          if (a.type !== 'dir' && b.type === 'dir') return 1
          return a.path.length - b.path.length || a.name.localeCompare(b.name)
        })
      }

      const q = query.toLowerCase()

      if (!q) {
        // 空 query：目录优先排序后再截断，保证文件夹结构完整可见
        sortDirsFirst(rootEntries)
        sortDirsFirst(workspaceEntries)
        const maxPerGroup = Math.max(limit, BROWSE_LIMIT_PER_GROUP)
        const sessionSlice = rootEntries.slice(0, maxPerGroup)
        const workspaceSlice = workspaceEntries.slice(0, maxPerGroup)
        const combined = [...sessionSlice, ...workspaceSlice]
        const capped = combined.length > BROWSE_TOTAL_CAP ? combined.slice(0, BROWSE_TOTAL_CAP) : combined
        return {
          entries: capped,
          total: rootEntries.length + workspaceEntries.length,
          sessionEntries: sessionSlice,
          workspaceEntries: workspaceSlice,
        }
      }

      const sessionMatched = matchEntries(rootEntries, q)
      const workspaceMatched = matchEntries(workspaceEntries, q)
      sortGroup(sessionMatched, q)
      sortGroup(workspaceMatched, q)

      const totalMatched = sessionMatched.length + workspaceMatched.length
      let sessionSlice: Entry[]
      let workspaceSlice: Entry[]
      if (totalMatched <= limit) {
        sessionSlice = sessionMatched
        workspaceSlice = workspaceMatched
      } else {
        const sessionQuota = Math.max(
          sessionMatched.length > 0 ? 1 : 0,
          Math.round(limit * sessionMatched.length / totalMatched),
        )
        const workspaceQuota = Math.max(
          workspaceMatched.length > 0 ? 1 : 0,
          limit - sessionQuota,
        )
        sessionSlice = sessionMatched.slice(0, sessionQuota)
        workspaceSlice = workspaceMatched.slice(0, workspaceQuota)
      }

      return {
        entries: [...sessionSlice, ...workspaceSlice],
        total: sessionMatched.length + workspaceMatched.length,
        sessionEntries: sessionSlice,
        workspaceEntries: workspaceSlice,
      }
    }
  )

  // ===== 系统提示词管理 =====
  registerSystemPromptIpc()

  // ===== GitHub Release =====
  registerGitHubReleaseIpc()

  // ===== Lark CLI cloud capability ===== =====
  registerLarkIpc()

  // ===== 飞书集成 =====
  registerFeishuIpc()

  // ===== 钉钉集成 =====
  registerDingTalkIpc()

  // ===== 微信集成 =====
  registerWeChatIpc()

  // 同步协作委派子会话到 agent-sessions.json（桥接平台层 → 侧栏）
  ipcMain.handle(
    'agent:sync-delegation-session',
    async (
      _event,
      params: {
        childSessionId: string
        parentSessionId: string
        sourceDelegationId: string
        title: string
        channelId?: string
        modelId?: string
        workspaceId?: string
        delegationRole?: string
        delegationGoal?: string
        permissionMode?: import('@profer/shared').ProferPermissionMode
      }
    ): Promise<AgentSessionMeta> => {
      return createDelegatedChildSessionMeta(params)
    }
  )

  console.log('[IPC] IPC 处理器注册完成')

  // 注册更新 IPC 处理器
  registerUpdaterIpc()

  // ===== 存储管理 =====
  registerStorageIpc()

  // ===== 工作区热力图 =====
  registerHeatmapMigrationIpc()

  // ===== 快速任务窗口 =====
  registerQuickTaskIpc()

  // ===== 语音输入 =====
  registerVoiceDictationIpc()

  // ===== 数据迁移 =====
  registerMigrationIpc()

  // ===== 窗口控制（Windows 自定义标题栏按钮）=====
  registerWindowIpc()

  // ===== 任务 / 日程（Planning）=====
  registerPlanningIpc()

  // ===== 定时任务（Automation）=====
  registerAutomationIpc()

  // ===== 手写笔墨迹识别（macOS Vision）=====
  registerPenOcrIpc()

  // ===== 身份认证 =====
  registerAccountIpc()

  // ===== 通用个人资料库相关 =====
  registerKnowledgeIpc()

  // ===== 桌面通知（主进程弹出原生 Notification，点击可靠） =====
  registerDesktopNotificationIpc()
}
