/**
 * IPC 处理器模块
 *
 * 负责注册主进程和渲染进程之间的通信处理器
 */

import { ipcMain, nativeTheme, shell, dialog, BrowserWindow, app, Notification } from 'electron'
import { isAbsolute, join, relative, resolve, sep, dirname, basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { IPC_CHANNELS, CHANNEL_IPC_CHANNELS, CHAT_IPC_CHANNELS, AGENT_IPC_CHANNELS, LARK_IPC_CHANNELS, AGENT_PRESET_IPC_CHANNELS, ENVIRONMENT_IPC_CHANNELS, INSTALLER_IPC_CHANNELS, PROXY_IPC_CHANNELS, GITHUB_RELEASE_IPC_CHANNELS, SYSTEM_PROMPT_IPC_CHANNELS, CHAT_TOOL_IPC_CHANNELS, FEISHU_IPC_CHANNELS, DINGTALK_IPC_CHANNELS, WECHAT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, PLANNING_IPC_CHANNELS, AUTH_IPC_CHANNELS, SYNC_IPC_CHANNELS, TEAM_IPC_CHANNELS, SKILL_MARKETPLACE_IPC_CHANNELS, SKILL_MASTER_IPC_CHANNELS, GLOBAL_SKILL_IPC_CHANNELS, TEAM_FILE_IPC_CHANNELS, TEAM_MEMORY_IPC_CHANNELS, isAgentRuntime, isProferPermissionMode, normalizePathForCompare, type AgentThinkingLevel, PLANNING_CONFLICT_ERROR, type Todo, type TodoListQuery, type CalendarEvent, type CalendarEventListQuery, type CreateTodoInput, type UpdateTodoInput, type CreateCalendarEventInput, type UpdateCalendarEventInput, type StartTodoAgentInput, type StartTodoAgentResult, type CreatePlanningGroupInput, type UpdatePlanningGroupInput, type PlanningGroup, type PlanningGroupScope, type PlanningTag, type PlanningReminder, type ActivePlanningReminder, type SnoozePlanningReminderInput, type TodoAgentSessionActivation, type ProviderType, type ReasoningCapability, type AgentPreset, type AgentPresetCreateInput, type AgentPresetUpdateInput, type AgentPresetImportResult, type OtherWorkspacePresetsGroup, type PresetReference, type PresetReferenceReport } from '@profer/shared'
import { USER_PROFILE_IPC_CHANNELS, SETTINGS_IPC_CHANNELS, SKIN_IPC_CHANNELS, SCRATCH_PAD_IPC_CHANNELS, QUICK_TASK_IPC_CHANNELS, VOICE_DICTATION_IPC_CHANNELS, APP_ICON_IPC_CHANNELS, DOCK_BADGE_IPC_CHANNELS, STORAGE_IPC_CHANNELS, NOTIFICATION_SOUND_IPC_CHANNELS, DESKTOP_NOTIFICATION_IPC_CHANNELS } from '../types'
import type { CustomNotificationSound } from '../types'
import {
  PPT_MATERIAL_IPC_CHANNELS,
  type PptMaterialDownloadInput,
  type PptMaterialDownloadResult,
  type PptMaterialSearchInput,
  type PptMaterialSearchResult,
} from '@profer/shared'
import { getBuildTarget } from './lib/build-target'
import { resolvePiReasoningCapability } from './lib/adapters/pi-model-registry'
import type {
  QuickTaskSubmitInput,
  VoiceDictationAudioChunkInput,
  VoiceDictationCommitInput,
  VoiceDictationCommitResult,
  VoiceDictationResizeInput,
  VoiceDictationSettings,
  VoiceDictationSettingsUpdate,
  VoiceDictationStartInput,
  VoiceDictationStopInput,
  VoiceDictationTestResult,
  MicPermissionResult,
} from '../types'
import type {
  RuntimeStatus,
  GitRepoStatus,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  FetchModelsInput,
  FetchModelsResult,
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
  EnvironmentCheckResult,
  InstallerManifest,
  InstallerDownloadRequest,
  InstallerDownloadResult,
  InstallerSource,
  ProxyConfig,
  SystemProxyDetectResult,
  GitHubRelease,
  GitHubReleaseListOptions,
  PermissionResponse,
  ProferPermissionMode,
  AskUserResponse,
  ExitPlanModeResponse,
  SystemPromptConfig,
  SystemPrompt,
  SystemPromptCreateInput,
  SystemPromptUpdateInput,
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
  FeishuConfigInput,
  FeishuConfig,
  FeishuBridgeState,
  FeishuTestResult,
  FeishuChatBinding,
  FeishuPresenceReport,
  FeishuUpdateBindingInput,
  FeishuRegisterAppQRCode,
  FeishuRegisterAppStatus,
  FeishuRegisterAppResult,
  DingTalkConfigInput,
  DingTalkConfig,
  DingTalkBridgeState,
  DingTalkTestResult,
  WeChatConfig,
  WeChatBridgeState,
  SDKMessage,
  GetFileDiffInput,
  DetachedPreviewWindowInput,
  RevertFileInput,
  FileAccessOptions,
  ResolvedFileUrl,
  Automation,
  CreateAutomationInput,
  UpdateAutomationInput,
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
import type { UserProfile, AppSettings } from '../types'
import { getRuntimeStatus, getGitRepoStatus, reinitializeRuntime } from './lib/runtime-init'
import { browserController } from './lib/browser-controller'
import { resolveBrowserProfileKey } from './lib/browser-profile-policy'
import { listBookmarks, addBookmark, removeBookmark, listHistory, clearHistory } from './lib/browser-start-page-store'
import { getUnstagedChanges, getFileDiff, getUntrackedContent, revertFile, getDiffContents, listWorktrees, getWorktreeChanges, getMainRepoRoot, invalidateGitDiffCache } from './lib/git-diff-service'
import { registerProferDirectoryPath, registerProferFilePath } from './lib/local-file-protocol'
import { registerUpdaterIpc } from './lib/updater/updater-ipc'
import {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  decryptApiKey,
  testChannel,
  testChannelDirect,
  fetchModels,
  getChannelPlanQuota,
  getChannelById,
  syncChannelsFromServer,
  isCommercialMode,
} from './lib/channel-manager'
import { listChannelsWithBackgroundSync } from './lib/local-first-channel-listing'
import {
  listConversations,
  createConversation,
  appendMessage,
  getConversationMessages,
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
import { sendMessage, stopGeneration, generateTitle } from './lib/chat-service'
import {
  saveAttachment,
  readAttachmentAsBase64,
  deleteAttachment,
  openFileDialog,
} from './lib/attachment-service'
import { extractTextFromAttachment } from './lib/document-parser'
import { getTutorialContent, createWelcomeConversation } from './lib/tutorial-service'
import { getUserProfile, updateUserProfile } from './lib/user-profile-service'
import { getSettings, updateSettings } from './lib/settings-service'
import { scanSkins, getSkinCss, getSkinPreview, invalidateSkinCache } from './lib/skin-service'
import { deleteUserSkin, installSkinFromFolder, installSkinFromZip, openSkinTemplateFolder, openUserSkinsFolder, selectSkinFolder, selectSkinZip } from './lib/skin-manager-service'
import { getRemoteServiceStatus, setRemoteServiceEnabled, restartRemoteService } from './lib/remote-service'
import { updateWindowFrameAppearance } from './lib/titlebar-overlay'
import { setDockBadgeCount } from './lib/dock-badge-service'

import { checkEnvironment } from './lib/environment-checker'
import { fetchInstallerManifest, findInstallerSource } from './lib/installer-manifest'
import {
  cancelInstallerDownload,
  downloadInstaller,
  launchInstaller,
} from './lib/installer-downloader'
import { getProxySettings, saveProxySettings } from './lib/proxy-settings-service'
import { detectSystemProxy } from './lib/system-proxy-detector'
import {
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
} from './lib/automation-manager'
import { runAutomationNow, broadcastChanged as broadcastAutomationsChanged } from './lib/automation-scheduler'
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
  updateAgentSessionMeta,
  deleteAgentSession,
  migrateChatToAgentSession,
  moveSessionToWorkspace,
  forkAgentSession,
  autoArchiveAgentSessions,
  cleanupStaleAttachedPaths,
  searchAgentSessionMessages,
  searchAgentSessionReferences,
  createDelegatedChildSessionMeta,
  findOrphanSessions,
  snapshotAgentRuntimeMeta,
  restoreAgentRuntimeMeta,
  countArchivedAgentSessions,
} from './lib/agent-session-manager'
import { listAgentPresets, listGlobalAgentPresets, getDefaultPresetId, setDefaultPresetId, setDefaultPresetReference, enableGlobalPresetInWorkspace, disableGlobalPresetInWorkspace, setWorkspacePresetEnabled, rebindAgentSessionPreset, rebindAutomationPreset, createAgentPreset, createGlobalAgentPreset, promoteWorkspacePresetToGlobal, copyAgentPreset, copyPresetToWorkspace, updateAgentPreset, updateGlobalAgentPreset, deleteAgentPreset, deleteGlobalAgentPreset, getAgentPreset, getPresetReferenceReport, serializeAgentPresetsForExport, importAgentPresets } from './lib/agent-preset-manager'
import { runAgent, stopAgent, stopAgentAndWait, beginAgentSessionDeletion, endAgentSessionDeletion, generateAgentTitle, saveFilesToAgentSession, saveFilesToWorkspaceFiles, isAgentSessionActive, queueAgentMessage, updateAgentPermissionMode, rewindAgentSession, restoreActiveAgentStreams, getAgentRuntimeCapabilities, getAgentTaskOutput, stopAgentTask } from './lib/agent-service'
import { mapSdkShellTasks, isSameProcess, terminateProcessTreeGracefully, type MonitoredProcess } from './lib/process-monitor'
import { listOwnedRuntimeProcesses, markOwnedRuntimeProcessExited, onRuntimeProcessRegistryChanged } from './lib/runtime-process-registry'
import { coordinateAgentSend } from './lib/agent-send-coordinator'
import { getAgentPresetByReference, presetReferenceForId } from './lib/agent-preset-manager'
import { AgentSessionDeletionCoordinator } from './lib/agent-session-deletion'
import { permissionService } from './lib/agent-permission-service'
import { askUserService } from './lib/agent-ask-user-service'
import { exitPlanService } from './lib/agent-exit-plan-service'
import { assertMainWindowSender } from './lib/ipc-sender-guard'
import type { MainWindowGetter } from './lib/ipc-sender-guard'
import { getMainWindow } from './lib/main-window-state'
import { getAgentSessionWorkspacePath, getAgentWorkspacesDir, getWorkspaceSkillsDir, getWorkspaceFilesDir, getScratchPadPath, getCustomSoundsDir, getAgentWorkspacePath } from './lib/config-paths'
import { calculateStorageStats, cleanupStorage, cleanupTempFiles } from './lib/storage-service'
import { listTeamMemories, readTeamMemory, createTeamMemory, updateTeamMemory, listTeamMemoryRevisions, archiveTeamMemory } from './lib/team-memory-service'
import type { CleanupOptions } from './lib/storage-service'
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
  readWorkspaceClaudeMd,
  writeWorkspaceClaudeMd,
  listWorkspaceAutoMemoryFiles,
  readWorkspaceAutoMemoryFile,
  writeWorkspaceAutoMemoryFile,
  listWorkspaceMemoryArchiveFiles,
  readWorkspaceMemoryArchiveFile,
  writeWorkspaceMemoryArchiveFile,
  getWorkspaceMemoryArchivePath,
  getWorkspaceAutoMemoryDir,
} from './lib/agent-workspace-manager'
import {
  listMasterSkills,
  readMasterSkillContent,
  listMasterSkillHistory,
  detectSkillConflict,
} from './lib/skill-master-manager'
// ===== 全局 Skill 体系（唯一可写入口） =====
// 旧 skillMaster 通道仅用于读取兼容数据；所有新写操作必须经过 global-skill 服务校验 scope。
import {
  listGlobalSkills,
  readGlobalSkillContent,
  readWorkspaceSkillCopyContent,
  saveWorkspaceSkillCopyContent,
  copyGlobalSkillToUserGlobal,
  createUserGlobalSkill,
  copyGlobalSkillToWorkspace,
  deleteUserGlobalSkill,
  setGlobalSkillEnabled,
  restoreGlobalSkill,
  getWorkspaceGlobalSkillOverrides,
  getGlobalSkillDeleteBlockers,
  editGlobalSkill,
} from './lib/global-skill-manager'
import { resolveMemoryWikilink, findMemoryBacklinks } from './lib/memory-wikilink-service'
import { assertSafeSkillSegment } from './lib/skill-path-security'
import { searchFileCandidate, type FileSearchResult as FileCandidateSearchResult } from './lib/file-search-service'
import { downloadPptMaterial, searchPptMaterials } from './lib/ppt-material-service'
import { createMemoryArchiveSearcher } from './lib/memory-archive-search'
import { cancelLarkLogin, detectLarkCli, installLarkCli, startLarkLogin, __setLarkLoginEventHandler } from './lib/lark-cli-service'
import { cancelLarkMcpLogin, disableLarkMcpForWorkspace, enableLarkMcpForWorkspace, getLarkMcpStatus, saveLarkMcpCredentials, startLarkMcpLogin, testLarkMcpConnection, __setLarkMcpLoginEventHandler } from './lib/lark-mcp-service'
import type { MemoryWikilinkTarget, MemoryBacklink } from '@profer/shared'
import { getAllToolInfos } from './lib/chat-tool-registry'
import { updateToolState, updateToolCredentials, getToolCredentials, addCustomTool, deleteCustomTool } from './lib/chat-tool-config'
import {
  getSystemPromptConfig,
  createSystemPrompt,
  updateSystemPrompt,
  deleteSystemPrompt,
  updateAppendSetting,
  setDefaultPrompt,
} from './lib/system-prompt-manager'
import {
  getLatestRelease,
  listReleases as listGitHubReleases,
  getReleaseByTag,
} from './lib/github-release-service'
import { watchAttachedDirectory, unwatchAttachedDirectory } from './lib/workspace-watcher'
import {
  getFeishuConfig,
  saveFeishuConfig,
  getDecryptedAppSecret,
  getFeishuMultiBotConfig,
  saveFeishuBotConfig,
  removeFeishuBot,
  getDecryptedBotAppSecret,
} from './lib/feishu-config'
import { feishuBridgeManager } from './lib/feishu-bridge-manager'
import { syncFeishuSyncSleepBlocker } from './lib/feishu-sleep-blocker'
import { presenceService } from './lib/feishu-presence'
import { getDingTalkConfig, saveDingTalkConfig, getDecryptedClientSecret, getDingTalkMultiBotConfig, saveDingTalkBotConfig, removeDingTalkBot, getDecryptedBotClientSecret } from './lib/dingtalk-config'
import { dingtalkBridgeManager } from './lib/dingtalk-bridge-manager'
import { getWeChatConfig } from './lib/wechat-config'
import { wechatBridge } from './lib/wechat-bridge'

/** 文件浏览器中需要隐藏的系统文件 */
const HIDDEN_FS_ENTRIES = new Set(['.DS_Store', 'Thumbs.db'])

/** 同一会话的并发删除合并为一条 stop-and-wait 生命周期。 */
const agentSessionDeletionCoordinator = new AgentSessionDeletionCoordinator()

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

/** 系统敏感目录——这些目录下的文件永远不允许被预览访问 */
const SYSTEM_SENSITIVE_ROOTS: string[] = (() => {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    return [systemRoot, programFiles, programFilesX86, programData]
  }
  return ['/etc', '/sys', '/proc', '/dev', '/boot', '/root', '/usr/lib', '/usr/lib64', '/usr/sbin', '/sbin', '/bin', '/usr/bin']
})()

function isSystemSensitivePath(resolvedPath: string): boolean {
  return SYSTEM_SENSITIVE_ROOTS.some((root) => {
    try {
      // realpathSync 确保 Windows 大小写一致（C:\Windows vs C:\WINDOWS）
      const normalized = realpathSync(root)
      return resolvedPath === normalized || resolvedPath.startsWith(normalized + sep)
    } catch {
      // 系统根目录不存在（不太可能），退回到 resolve
      const fallback = resolve(root)
      return resolvedPath === fallback || resolvedPath.startsWith(fallback + sep)
    }
  })
}

function isPathAllowed(filePath: string, options?: FileAccessOptions): boolean {
  // deny-by-default：渲染进程不可信，未提供访问选项时拒绝越权访问
  // 调用方必须显式传递 sessionId 或 workspaceSlug 来声明授权上下文
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

  // 2. 宽松 fallback：有 sessionId 时，允许访问工作区外任意位置的常规文件
  //    仅排除系统敏感目录（C:\Windows、/etc 等），防止误触系统文件
  if (options.sessionId) {
    try {
      const st = statSync(resolved)
      if (st.isFile() && !isSystemSensitivePath(resolved)) {
        return true
      }
    } catch {
      return false
    }
  }

  return false
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
export function resolveAppIconPath(variantId: string): string | null {
  const resourcesDir = getBundledResourcesDir()
  if (!variantId || variantId === 'default') {
    return join(resourcesDir, 'icon.png')
  }
  return join(resourcesDir, 'profer-logos', `profer-${variantId}.png`)
}

let _ipcHandlersRegistered = false

// 测试可注入主窗口 getter；生产默认使用 index.ts 持有的主窗口引用。
let mainWindowGetter: MainWindowGetter = getMainWindow

export function setIpcMainWindowGetter(getter: MainWindowGetter): void {
  mainWindowGetter = getter
}

function assertSensitiveAgentIpcSender(event: { sender: { isDestroyed(): boolean } }): void {
  assertMainWindowSender(event, mainWindowGetter)
}

let rendererReadyHandler: (() => void) | null = null

/** 向仍存活的 renderer 广播工作区列表变化；与 preload 监听保持同一契约。 */
function broadcastAgentWorkspacesChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
    }
  }
}

export function setRendererReadyHandler(handler: (() => void) | null): void {
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

  onRuntimeProcessRegistryChanged((sessionId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AGENT_IPC_CHANNELS.RUNTIME_PROCESSES_CHANGED, { sessionId })
      }
    }
  })

  console.log('[IPC] 正在注册 IPC 处理器...')

  // ===== 运行时相关 =====

  // renderer 完成首屏初始化后通知主进程，允许原生启动页退场。
  ipcMain.on(SETTINGS_IPC_CHANNELS.RENDERER_READY, () => {
    rendererReadyHandler?.()
  })

  // 获取运行时状态
  ipcMain.handle(
    IPC_CHANNELS.GET_RUNTIME_STATUS,
    async (): Promise<RuntimeStatus | null> => {
      return getRuntimeStatus()
    }
  )

  // 重新初始化运行时（用户安装完 Git/Node 后触发，Windows 场景常用）
  ipcMain.handle(
    IPC_CHANNELS.REINIT_RUNTIME,
    async (): Promise<RuntimeStatus> => {
      return reinitializeRuntime()
    }
  )

  // 获取指定目录的 Git 仓库状态
  ipcMain.handle(
    IPC_CHANNELS.GET_GIT_REPO_STATUS,
    async (_, dirPath: string): Promise<GitRepoStatus | null> => {
      if (!dirPath || typeof dirPath !== 'string') {
        console.warn('[IPC] git:get-repo-status 收到无效的目录路径')
        return null
      }

      return getGitRepoStatus(dirPath)
    }
  )

  // 获取未暂存的变更文件列表
  ipcMain.handle(
    IPC_CHANNELS.GET_UNSTAGED_CHANGES,
    async (_, dirPath: string, sessionPath?: string, workspaceFilesPath?: string, extraPaths?: string[], sessionId?: string) => {
      if (!dirPath || typeof dirPath !== 'string') {
        console.warn('[IPC] git:get-unstaged-changes 收到无效的目录路径')
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!ensurePathAllowed(dirPath, access)) {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const allowedSessionPath = sessionPath && isPathAllowed(sessionPath, access) ? sessionPath : undefined
      const allowedWorkspaceFilesPath = workspaceFilesPath && isPathAllowed(workspaceFilesPath, access) ? workspaceFilesPath : undefined
      const allowedExtraPaths = extraPaths?.filter((p) => isPathAllowed(p, access))
      return getUnstagedChanges(dirPath, allowedSessionPath, allowedWorkspaceFilesPath, allowedExtraPaths)
    }
  )

  // 获取单个文件的 diff
  ipcMain.handle(
    IPC_CHANNELS.GET_FILE_DIFF,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-file-diff 收到无效参数')
        return ''
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return ''
      return getFileDiff(dirPath, filePath, gitRoot)
    }
  )

  // 获取未追踪文件内容
  ipcMain.handle(
    IPC_CHANNELS.GET_UNTRACKED_CONTENT,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-untracked-content 收到无效参数')
        return ''
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return ''
      return getUntrackedContent(dirPath, filePath, gitRoot)
    }
  )

  // 还原文件变更
  ipcMain.handle(
    IPC_CHANNELS.REVERT_FILE,
    async (_, input: RevertFileInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:revert-file 收到无效参数')
        return
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return
      await revertFile(dirPath, filePath, gitRoot)
      // revert 是 git 突变，失效受影响仓库的缓存
      invalidateGitDiffCache(filePath)
    }
  )

  // 使 git diff 缓存失效（Agent 写文件/git 突变/窗口聚焦后调用）
  ipcMain.handle(
    IPC_CHANNELS.INVALIDATE_GIT_DIFF_CACHE,
    (_, changedPath?: string) => {
      invalidateGitDiffCache(changedPath)
    }
  )

  // 获取文件新旧版本内容
  ipcMain.handle(
    IPC_CHANNELS.GET_DIFF_CONTENTS,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-diff-contents 收到无效参数')
        return null
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return null
      return getDiffContents(dirPath, filePath, gitRoot, input.baseRef)
    }
  )

  // 列出 Git Worktree（只读取 worktree 元信息，不涉及文件内容，跳过路径安全检查）
  ipcMain.handle(
    IPC_CHANNELS.LIST_WORKTREES,
    async (_, repoPath: string, _sessionId: string) => {
      if (!repoPath || typeof repoPath !== 'string') return []
      return await listWorktrees(repoPath)
    }
  )

  // 获取 Worktree 相对于基准分支的全量变更
  ipcMain.handle(
    IPC_CHANNELS.GET_WORKTREE_CHANGES,
    async (_, worktreePath: string, baseBranch: string, sessionId: string) => {
      if (!worktreePath || typeof worktreePath !== 'string') {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(worktreePath, access))) {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      return getWorktreeChanges(worktreePath, baseBranch)
    }
  )

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
        const options = normalizeFileAccessOptions(access)
        if (options && !isPathAllowed(filePath, options)) {
          console.warn('[IPC] shell:get-default-app-for-file 拒绝越界路径:', filePath)
          return null
        }
        console.log('[IPC] get-default-app-for-file 收到请求:', filePath)
        const result = await getDefaultAppInfoForFile(filePath, options)
        console.log('[IPC] get-default-app-for-file 返回:', result ? `name=${result.name} appPath=${result.appPath} iconLen=${result.iconDataUrl?.length}` : 'null')
        return result
      } catch (err) {
        console.warn('[IPC] shell:get-default-app-for-file 失败:', err)
        return null
      }
    }
  )

  // ===== 渠道管理相关 =====

  // 获取所有渠道（apiKey 保持加密态）。本地缓存必须优先返回，
  // 不能因商业渠道认证/同步的网络等待阻塞对话模型选择器。
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.LIST,
    (): Channel[] => {
      const { getTeamAuthWithRefresh } = require('./lib/auth-service')
      return listChannelsWithBackgroundSync({
        listLocalChannels: listChannels,
        isCommercialMode,
        getTeamAuthWithRefresh,
        syncChannelsFromServer,
        onSyncFailure: (error) => {
          console.warn('[渠道管理] 后台同步渠道失败，继续使用本地缓存:', error)
        },
      })
    }
  )

  // 获取官方模型最近可用性
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.GET_OFFICIAL_HEALTH,
    async (): Promise<import('@profer/shared').OfficialChannelHealth[]> => {
      const auth = await require('./lib/auth-service').getTeamAuthWithRefresh()
      if (!auth) return []
      const response = await fetch(`${auth.baseUrl}/v1/account/channels/health`, {
        headers: { Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return []
      const data = await response.json() as { channels?: import('@profer/shared').OfficialChannelHealth[] }
      return data.channels || []
    }
  )

  // 创建渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.CREATE,
    async (_, input: ChannelCreateInput): Promise<Channel> => {
      return createChannel(input)
    }
  )

  // 更新渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.UPDATE,
    async (_, id: string, input: ChannelUpdateInput): Promise<Channel> => {
      return updateChannel(id, input)
    }
  )

  // 删除渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<void> => {
      return deleteChannel(id)
    }
  )

  // 解密 API Key（商业模式下仅自配用户可用）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.DECRYPT_KEY,
    async (_, channelId: string): Promise<string> => {
      const { isCommercialMode, canSelfConfig } = require('./lib/channel-manager')
      if (isCommercialMode() && !canSelfConfig()) throw new Error('商业模式下渠道由服务端统一管理')
      return decryptApiKey(channelId)
    }
  )

  // 测试渠道连接
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.TEST,
    async (_, channelId: string): Promise<ChannelTestResult> => {
      return testChannel(channelId)
    }
  )

  // 直接测试连接（无需已保存渠道，传入明文凭证）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.TEST_DIRECT,
    async (_, input: FetchModelsInput): Promise<ChannelTestResult> => {
      return testChannelDirect(input)
    }
  )

  // 从供应商拉取可用模型列表（直接传入凭证，无需已保存渠道）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.FETCH_MODELS,
    async (_, input: FetchModelsInput): Promise<FetchModelsResult> => {
      return fetchModels(input)
    }
  )

  // 查询订阅 Plan 额度
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.GET_PLAN_QUOTA,
    async (_, channelId: string): Promise<import('@profer/shared').ChannelPlanQuotaResult> => {
      return getChannelPlanQuota(channelId)
    }
  )

  // 从服务端同步渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.SYNC_FROM_SERVER,
    async (_, serverBaseUrl: string, accessToken: string): Promise<void> => {
      return syncChannelsFromServer(serverBaseUrl, accessToken)
    }
  )

  // 检查商业模式
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.GET_COMMERCIAL_MODE,
    async (): Promise<boolean> => {
      return isCommercialMode()
    }
  )

  // 获取账号能力（自配权限 + 账号类型）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.GET_ACCOUNT_CAPABILITIES,
    async (_, force?: boolean): Promise<{ commercialMode: boolean; canSelfConfig: boolean; membershipTier: string }> => {
      const { isCommercialMode } = require('./lib/channel-manager')
      const { isSelfConfigAllowed, getMembershipTier, refreshAuthToken } = require('./lib/auth-service')
      // force=true：先拉一次服务端刷新，让管理员刚开通的自配权限即时生效（无需重登）
      if (force) await refreshAuthToken().catch(() => {})
      return {
        commercialMode: isCommercialMode(),
        canSelfConfig: isSelfConfigAllowed(),
        membershipTier: getMembershipTier(),
      }
    }
  )

  // 获取构建目标
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.GET_BUILD_TARGET,
    async (): Promise<'oss' | 'commercial'> => {
      return getBuildTarget()
    }
  )

  // ===== 对话管理相关 =====

  // 获取对话列表
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

  // 更新对话标题
  ipcMain.handle(
    CHAT_IPC_CHANNELS.UPDATE_TITLE,
    async (_, id: string, title: string): Promise<ConversationMeta> => {
      return updateConversationMeta(id, { title })
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
      return updateConversationMeta(id, updates)
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
      return updateConversationMeta(id, updates)
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
      const message: ChatMessage = { id: randomUUID(), role: 'user', content: '', createdAt: Date.now(), knowledgeReferences: references }
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

  // 从指定消息开始截断（包含该消息）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM,
    async (
      _,
      conversationId: string,
      messageId: string,
      preserveFirstMessageAttachments?: boolean,
    ): Promise<ChatMessage[]> => {
      return truncateMessagesFrom(
        conversationId,
        messageId,
        preserveFirstMessageAttachments ?? false,
      )
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

  // ===== 开放许可 PPT 素材 =====
  ipcMain.handle(
    PPT_MATERIAL_IPC_CHANNELS.SEARCH,
    async (_, input: PptMaterialSearchInput): Promise<PptMaterialSearchResult> => searchPptMaterials(input),
  )
  ipcMain.handle(
    PPT_MATERIAL_IPC_CHANNELS.DOWNLOAD,
    async (_, input: PptMaterialDownloadInput): Promise<PptMaterialDownloadResult> => downloadPptMaterial(input),
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

  // 获取用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.GET,
    async (): Promise<UserProfile> => {
      return getUserProfile()
    }
  )

  // 更新用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.UPDATE,
    async (_, updates: Partial<UserProfile>): Promise<UserProfile> => {
      return updateUserProfile(updates)
    }
  )

  // ===== 皮肤相关 =====
  /** 皮肤注册表/CSS 变化后广播给所有窗口（排除发起者，发起者自己刷新） */
  const broadcastSkinChanged = (senderId: number, deletedId?: string): void => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (win.webContents.id === senderId) return
      win.webContents.send(SKIN_IPC_CHANNELS.ON_SKINS_CHANGED, { deletedId: deletedId ?? null })
    })
  }

  ipcMain.handle(SKIN_IPC_CHANNELS.GET_SKINS, async () => scanSkins())
  ipcMain.handle(SKIN_IPC_CHANNELS.GET_SKIN_CSS, async (_event, id: unknown) => typeof id === 'string' ? getSkinCss(id) : null)
  ipcMain.handle(SKIN_IPC_CHANNELS.GET_SKIN_PREVIEW, async (_event, id: unknown) => typeof id === 'string' ? getSkinPreview(id) : null)
  ipcMain.handle(SKIN_IPC_CHANNELS.SELECT_ZIP, async () => selectSkinZip())
  ipcMain.handle(SKIN_IPC_CHANNELS.SELECT_FOLDER, async () => selectSkinFolder())
  ipcMain.handle(SKIN_IPC_CHANNELS.INSTALL_ZIP, async (event, path: unknown, replace: unknown) => {
    const result = typeof path === 'string' ? installSkinFromZip(path, replace === true) : { ok: false, status: 'error', message: '无效 ZIP 路径' }
    if (result.ok) broadcastSkinChanged(event.sender.id)
    return result
  })
  ipcMain.handle(SKIN_IPC_CHANNELS.INSTALL_FOLDER, async (event, path: unknown, replace: unknown) => {
    const result = typeof path === 'string' ? installSkinFromFolder(path, replace === true) : { ok: false, status: 'error', message: '无效文件夹路径' }
    if (result.ok) broadcastSkinChanged(event.sender.id)
    return result
  })
  ipcMain.handle(SKIN_IPC_CHANNELS.DELETE_USER_SKIN, async (event, id: unknown) => {
    const result = typeof id === 'string' ? deleteUserSkin(id) : { ok: false, status: 'error', message: '无效皮肤 id' }
    if (result.ok) broadcastSkinChanged(event.sender.id, typeof id === 'string' ? id : undefined)
    return result
  })
  ipcMain.handle(SKIN_IPC_CHANNELS.OPEN_USER_FOLDER, async () => openUserSkinsFolder())
  ipcMain.handle(SKIN_IPC_CHANNELS.OPEN_TEMPLATE_FOLDER, async () => openSkinTemplateFolder())
  ipcMain.handle(SKIN_IPC_CHANNELS.REFRESH, async (event) => {
    invalidateSkinCache()
    const skins = scanSkins()
    broadcastSkinChanged(event.sender.id)
    return skins
  })

  // ===== 应用设置相关 =====

  // 获取应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET,
    async (): Promise<AppSettings> => {
      return getSettings()
    }
  )

  // 更新应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.UPDATE,
    async (event, updates: Partial<AppSettings>): Promise<AppSettings> => {
      const result = await updateSettings(updates)

      // 快速任务开关变化：实时创建/销毁预创建窗口，并重新注册全局快捷键
      if (updates.quickTaskEnabled !== undefined) {
        const { createQuickTaskWindow, destroyQuickTaskWindow } = await import('./lib/quick-task-window')
        if (updates.quickTaskEnabled === true) {
          createQuickTaskWindow()
        } else {
          destroyQuickTaskWindow()
        }
        const { reregisterAllGlobalShortcuts } = await import('./lib/global-shortcut-service')
        reregisterAllGlobalShortcuts()
      }

      if (updates.feishuSessionMirror !== undefined) {
        syncFeishuSyncSleepBlocker(result)
      }

      // 主题相关设置变化时，广播给所有窗口（跨窗口同步，如 Quick Task 面板）
      if (updates.themeMode !== undefined || updates.themeStyle !== undefined || updates.interfaceVariant !== undefined) {
        const payload = {
          themeMode: result.themeMode,
          themeStyle: result.themeStyle,
          interfaceVariant: result.interfaceVariant,
        }
        BrowserWindow.getAllWindows().forEach((win) => {
          updateWindowFrameAppearance(win)
          // 跳过发起者窗口，避免重复应用
          if (win.webContents.id !== event.sender.id) {
            win.webContents.send(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, payload)
          }
        })
      }

      return result
    }
  )

  // 获取移动模式服务状态。Token 只在服务实际监听后随状态返回。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_TABLET_MODE_STATUS,
    async () => getRemoteServiceStatus(),
  )

  // 设置移动模式（试验版）。开启后立即监听局域网，关闭后立即断开。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.SET_TABLET_MODE_ENABLED,
    async (_event, enabled: boolean) => {
      if (typeof enabled !== 'boolean') throw new Error('移动模式开关参数无效')
      if (!enabled) {
        const status = setRemoteServiceEnabled(false)
        updateSettings({ tabletModeEnabled: false })
        return status
      }

      setRemoteServiceEnabled(true)
      // listen 是异步的；状态会在 UI 随后刷新时带回地址和 Token。
      const status = getRemoteServiceStatus()
      updateSettings({ tabletModeEnabled: true })
      return status
    },
  )

  // 设置移动模式服务端口：保存并热应用（服务运行中自动重启）。
  // port=0 表示恢复默认端口（清除自定义值，回到正式版 7788 / 开发版 7789）。
  // 端口占用或非法时服务可能启动失败，状态由 UI 轮询刷新呈现。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.SET_TABLET_MODE_PORT,
    async (_event, port: unknown) => {
      const n = typeof port === 'number' ? port : Number(port)
      if (n === 0) {
        updateSettings({ tabletModePort: 0 })
        return restartRemoteService()
      }
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        throw new Error('端口必须是 1024-65535 之间的整数')
      }
      updateSettings({ tabletModePort: n })
      // 服务运行中则停掉旧端口并重启；未运行时新端口在下次启动时生效。
      return restartRemoteService()
    },
  )

  // 获取安卓版 APK 扫码下载信息（地址 + 二维码 + 文件名）。
  // 直接指向官网稳定域名 https://profer.cn/profer-mobile/，不依赖移动模式服务是否运行。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_APK_QR,
    async (): Promise<{ url: string; dataUrl: string; fileName: string }> => {
      const url = 'https://profer.cn/profer-mobile/Profer-移动版-android.apk'
      const fileName = 'Profer-移动版-android.apk'
      try {
        const QRCode = (await import('qrcode')).default
        const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
        return { url, dataUrl, fileName }
      } catch (err) {
        console.error('[移动模式] APK 二维码生成失败:', err)
        return { url, dataUrl: '', fileName }
      }
    },
  )

  // 同步更新应用设置（用于 beforeunload 场景）
  ipcMain.on(
    SETTINGS_IPC_CHANNELS.UPDATE_SYNC,
    (event, updates: Partial<AppSettings>) => {
      try {
        const result = updateSettings(updates)
        if (updates.feishuSessionMirror !== undefined) {
          syncFeishuSyncSleepBlocker(result)
        }
        event.returnValue = true
      } catch {
        event.returnValue = false
      }
    }
  )

  // 获取系统主题（是否深色模式）
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME,
    async (): Promise<boolean> => {
      return nativeTheme.shouldUseDarkColors
    }
  )

  // 获取开机自启动状态
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_AUTO_LAUNCH,
    async (): Promise<boolean> => {
      return app.getLoginItemSettings().openAtLogin
    }
  )

  // 设置开机自启动
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.SET_AUTO_LAUNCH,
    async (_event, enabled: boolean): Promise<void> => {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        // 开发模式下也允许设置，方便测试（正式版会自动使用应用路径）
        ...(app.isPackaged ? {} : { openAtLogin: enabled, path: process.execPath }),
      })
      // 同步持久化到 settings.json
      updateSettings({ autoLaunch: enabled })
      console.log(`[设置] 开机自启动: ${enabled ? '已开启' : '已关闭'}`)
    }
  )

  // 监听系统主题变化，推送给所有渲染进程窗口
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    console.log(`[设置] 系统主题变化: ${isDark ? '深色' : '浅色'}`)
    BrowserWindow.getAllWindows().forEach((win) => {
      updateWindowFrameAppearance(win)
      win.webContents.send(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, isDark)
    })
  })

  // ===== 自定义通知音效 =====

  /** 允许的音频文件扩展名 */
  const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.webm'])

  // 添加自定义音效
  ipcMain.handle(
    NOTIFICATION_SOUND_IPC_CHANNELS.ADD,
    async (_, sourcePath: string, label: string): Promise<CustomNotificationSound> => {
      const ext = extname(sourcePath).toLowerCase()
      if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
        throw new Error(`不支持的音频格式: ${ext}。支持: mp3, wav, ogg, aac, m4a, flac, webm`)
      }
      if (!existsSync(sourcePath)) {
        throw new Error('源文件不存在')
      }

      const soundsDir = getCustomSoundsDir()
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const fileName = `${randomUUID()}${ext}`
      const destPath = join(soundsDir, fileName)

      copyFileSync(sourcePath, destPath)

      const sound: CustomNotificationSound = {
        id,
        label: label.trim() || `自定义音效 ${new Date().toLocaleDateString()}`,
        fileName,
        addedAt: Date.now(),
      }

      const settings = getSettings()
      const customSounds = [...(settings.customNotificationSounds ?? []), sound]
      updateSettings({ customNotificationSounds: customSounds })

      console.log(`[IPC] 已添加自定义通知音效: ${label} → ${fileName}`)
      return sound
    }
  )

  // 删除自定义音效
  ipcMain.handle(
    NOTIFICATION_SOUND_IPC_CHANNELS.REMOVE,
    async (_, id: string): Promise<CustomNotificationSound[]> => {
      const settings = getSettings()
      const currentSounds = settings.customNotificationSounds ?? []
      const target = currentSounds.find((s) => s.id === id)
      if (!target) return currentSounds

      // 删除文件
      const soundsDir = getCustomSoundsDir()
      const filePath = join(soundsDir, target.fileName)
      try {
        if (existsSync(filePath)) rmSync(filePath)
      } catch (err) {
        console.warn(`[IPC] 删除自定义音效文件失败: ${filePath}`, err)
      }

      // 从 settings 中移除
      const updated = currentSounds.filter((s) => s.id !== id)
      updateSettings({ customNotificationSounds: updated })

      // 清理各场景中被删除音效的引用
      if (settings.notificationSounds) {
        const cleaned: typeof settings.notificationSounds = { ...settings.notificationSounds }
        let needsClean = false
        for (const key of ['taskComplete', 'permissionRequest', 'exitPlanMode'] as const) {
          if (cleaned[key] === id) {
            cleaned[key] = undefined
            needsClean = true
          }
        }
        if (needsClean) updateSettings({ notificationSounds: cleaned })
      }

      console.log(`[IPC] 已删除自定义通知音效: ${target.label} (${id})`)
      return updated
    }
  )

  // 获取自定义音效的文件 URL（使用 profer-file:// 协议，renderer 可安全加载）
  ipcMain.handle(
    NOTIFICATION_SOUND_IPC_CHANNELS.GET_URL,
    async (_, fileName: string): Promise<string> => {
      const soundsDir = getCustomSoundsDir()
      const filePath = join(soundsDir, fileName)
      if (!existsSync(filePath)) {
        throw new Error(`音效文件不存在: ${fileName}`)
      }
      const url = registerProferFilePath(filePath)
      console.log(`[IPC] 自定义音效 URL: ${filePath} → ${url}`)
      return url
    }
  )

  // ===== Scratch Pad 持久化 =====

  // 从磁盘加载 scratch-pad.md
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.LOAD,
    async (): Promise<string> => {
      const path = getScratchPadPath()
      try {
        if (!existsSync(path)) return ''
        return readFileSync(path, 'utf-8')
      } catch (err) {
        console.error('[ScratchPad] 加载失败:', err)
        return ''
      }
    }
  )

  // 异步保存 scratch-pad.md
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.SAVE,
    async (_, content: string): Promise<boolean> => {
      const path = getScratchPadPath()
      try {
        await writeFile(path, content, 'utf-8')
        return true
      } catch (err) {
        console.error('[ScratchPad] 保存失败:', err)
        return false
      }
    }
  )

  // 同步保存 scratch-pad.md（beforeunload 场景）
  ipcMain.on(
    SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC,
    (event, content: string) => {
      try {
        writeFileSync(getScratchPadPath(), content, 'utf-8')
        event.returnValue = true
      } catch (err) {
        console.error('[ScratchPad] 同步保存失败:', err)
        event.returnValue = false
      }
    }
  )

  // 导出为 Markdown 到指定目录
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.EXPORT,
    async (_, markdown: string, dirPath: string, filename: string): Promise<string> => {
      let filePath: string
      if (!filename) {
        // 完整文件路径模式（来自保存对话框）
        filePath = dirPath
        const dir = dirname(filePath)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
      } else {
        if (!existsSync(dirPath)) {
          mkdirSync(dirPath, { recursive: true })
        }
        filePath = join(dirPath, filename)
      }
      writeFileSync(filePath, markdown, 'utf-8')
      console.log('[ScratchPad] 已导出:', filePath)
      return filePath
    }
  )

  // 打开保存对话框，返回用户选择的路径
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.CHOOSE_EXPORT_PATH,
    async (_, defaultName: string): Promise<string | null> => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return null
      const result = await dialog.showSaveDialog(win, {
        title: '导出 Scratch Pad 为 Markdown',
        defaultPath: defaultName,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      return result.canceled ? null : result.filePath
    }
  )

  // ===== 应用图标切换 =====

  ipcMain.handle(
    APP_ICON_IPC_CHANNELS.SET,
    async (_, variantId: string): Promise<boolean> => {
      try {
        // 解析图标文件路径
        const iconPath = resolveAppIconPath(variantId)
        if (!iconPath || !existsSync(iconPath)) {
          console.warn('[图标] 图标文件不存在:', iconPath)
          return false
        }

        // macOS: 设置 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.setIcon(iconPath)
        }

        // 持久化到设置
        await updateSettings({ appIconVariant: variantId })
        console.log(`[图标] 已切换到: ${variantId}`)
        return true
      } catch (error) {
        console.error('[图标] 切换失败:', error)
        return false
      }
    }
  )

  // ===== Dock/Launcher 角标 =====

  ipcMain.handle(
    DOCK_BADGE_IPC_CHANNELS.SET_COUNT,
    async (_, count: number): Promise<boolean> => {
      return setDockBadgeCount(count)
    }
  )

  // ===== 环境检测相关 =====

  // 执行环境检测
  ipcMain.handle(
    ENVIRONMENT_IPC_CHANNELS.CHECK,
    async (): Promise<EnvironmentCheckResult> => {
      const result = await checkEnvironment()
      // 自动保存检测结果到设置
      await updateSettings({
        lastEnvironmentCheck: result,
      })
      return result
    }
  )

  // ===== 第三方安装包（Git / Node.js）相关 =====

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.MANIFEST,
    async (): Promise<InstallerManifest> => {
      return fetchInstallerManifest()
    }
  )

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.DOWNLOAD,
    async (event, req: InstallerDownloadRequest): Promise<InstallerDownloadResult> => {
      const manifest = await fetchInstallerManifest()
      const source = findInstallerSource(manifest, req.id, req.arch, req.platform ?? (process.platform as InstallerSource['platform']))
      if (!source) {
        throw new Error(`未找到安装包：id=${req.id}, arch=${req.arch}`)
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error('发起下载的窗口已关闭')
      }
      const key = `${req.id}:${req.arch}`
      return downloadInstaller(source, key, window)
    }
  )

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.CANCEL,
    async (_event, key: string): Promise<boolean> => {
      return cancelInstallerDownload(key)
    }
  )

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.LAUNCH,
    async (_event, filePath: string): Promise<void> => {
      await launchInstaller(filePath)
    }
  )

  // ===== 代理配置相关 =====

  // 获取代理配置
  ipcMain.handle(
    PROXY_IPC_CHANNELS.GET_SETTINGS,
    async (): Promise<ProxyConfig> => {
      return getProxySettings()
    }
  )

  // 更新代理配置
  ipcMain.handle(
    PROXY_IPC_CHANNELS.UPDATE_SETTINGS,
    async (_, config: ProxyConfig): Promise<void> => {
      await saveProxySettings(config)
    }
  )

  // 检测系统代理
  ipcMain.handle(
    PROXY_IPC_CHANNELS.DETECT_SYSTEM,
    async (): Promise<SystemProxyDetectResult> => {
      return detectSystemProxy()
    }
  )

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
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.SET_WORKSPACE_ENABLED, async (_, workspaceSlug: string, presetId: string, enabled: boolean): Promise<void> => setWorkspacePresetEnabled(workspaceSlug, presetId, enabled))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.REBIND_SESSION_REFERENCE, async (_, sessionId: string, reference: PresetReference): Promise<AgentSessionMeta> => rebindAgentSessionPreset(sessionId, reference))
  ipcMain.handle(AGENT_PRESET_IPC_CHANNELS.REBIND_AUTOMATION_REFERENCE, async (_, automationId: string, reference: PresetReference | null) => rebindAutomationPreset(automationId, reference))

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.GET_DEFAULT_PRESET,
    async (_, workspaceSlug?: string): Promise<string> => {
      return getDefaultPresetId(workspaceSlug)
    },
  )

  ipcMain.handle(
    AGENT_PRESET_IPC_CHANNELS.UPDATE_SESSION_PRESET,
    async (_, sessionId: string, presetId: string): Promise<AgentSessionMeta> => {
      const session = getAgentSessionMeta(sessionId)
      if (!session) throw new Error('会话不存在')
      // 按会话所属工作区解析；存在性校验：未知 ID 报错而非静默回退 standard
      const workspaceSlug = session.workspaceId ? getAgentWorkspace(session.workspaceId)?.slug : undefined
      const resolved = getAgentPreset(workspaceSlug, presetId)
      if (resolved.id !== presetId) throw new Error(`预设不存在: ${presetId}`)
      return updateAgentSessionMeta(sessionId, { presetId })
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
  const assertMainRenderer = async (senderId: number): Promise<void> => {
    const { getMainWindow } = await import('./index')
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) {
      throw new Error('仅主窗口可以操作受管浏览器。')
    }
  }
  const assertBrowserSessionAccess = async (senderId: number, sessionId: string): Promise<void> => {
    await assertMainRenderer(senderId)
    const session = getAgentSessionMeta(sessionId)
    if (!session) throw new Error('Agent 会话不存在。')
    // 自动任务与协作子会话同样可以使用受管浏览器；仅校验会话仍存在。
    browserController.configureSession(sessionId, {
      profileKey: resolveBrowserProfileKey(session.workspaceId, sessionId),
      executionSource: session.sourceDelegationId ? 'delegation' : session.sourceAutomationId ? 'automation' : 'user',
    })
  }

  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_BROWSER,
    async (event, sessionId: string): Promise<BrowserViewState> => {
      await assertBrowserSessionAccess(event.sender.id, sessionId)
      return browserController.open(sessionId)
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_BROWSER_STATE,
    async (event, sessionId: string): Promise<BrowserViewState | null> => {
      await assertBrowserSessionAccess(event.sender.id, sessionId)
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
      void assertBrowserSessionAccess(event.sender.id, layout.sessionId)
        .then(() => browserController.setLayout(layout))
        .catch(() => undefined)
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.NAVIGATE_BROWSER,
    async (event, input: BrowserNavigateInput): Promise<BrowserViewState> => {
      await assertBrowserSessionAccess(event.sender.id, input.sessionId)
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
  ipcMain.handle(AGENT_IPC_CHANNELS.HIDE_BROWSER, async (event, sessionId: string): Promise<void> => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    browserController.hide(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CLOSE_BROWSER, async (event, sessionId: string): Promise<void> => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    await browserController.close(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_BROWSER_TABS, async (event, sessionId: string): Promise<BrowserViewState> => {
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

  // renderer 刷新后重新绑定所有仍活跃的 Agent 流，并回放本轮实时事件。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RESTORE_ACTIVE_STREAMS,
    async (event): Promise<string[]> => restoreActiveAgentStreams(event.sender),
  )

  // 更新 Agent 会话标题
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_TITLE,
    async (_, id: string, title: string): Promise<AgentSessionMeta> => {
      return updateAgentSessionMeta(id, { title })
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
      return updateAgentSessionMeta(id, { channelId, modelId })
    }
  )

  // 生成 Agent 会话标题
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GENERATE_TITLE,
    async (_, input: AgentGenerateTitleInput): Promise<string | null> => {
      return generateAgentTitle(input)
    }
  )

  // 删除 Agent 会话：运行中时先中止并等待 finally 完整退出，避免删除后仍写入 JSONL/工作目录。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SESSION,
    async (_, id: string): Promise<void> => {
      return agentSessionDeletionCoordinator.delete(id, {
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
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 清除 Agent 会话完成状态（兼容清除旧版 manualWorking）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CLEAR_COMPLETION_STATE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions(true)
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      const updates: Partial<AgentSessionMeta> = {}
      if (current.manualWorking) updates.manualWorking = false
      if (current.completedButUnconfirmed) updates.completedButUnconfirmed = false
      if (Object.keys(updates).length === 0) return current
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 标记 Agent 会话为「未读」：持久化写入 completedButUnconfirmed = true（侧边栏「标记未读」入口）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_COMPLETION_STATE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const sessions = listAgentSessions(true)
      const current = sessions.find((s) => s.id === id)
      if (!current) throw new Error(`Agent session not found: ${id}`)
      return updateAgentSessionMeta(id, { completedButUnconfirmed: true })
    }
  )

  // 更新 Agent 会话中断说明状态（state 非 null 置位：点击中断记录行向 Agent 说明原因；null 清除：消费/移除输入框中断 chip 时调用，保证重启不复活已消费的中断）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_INTERRUPTION_STATE,
    (_e, input: UpdateAgentInterruptStateInput): AgentSessionMeta => {
      const { sessionId, state } = input
      return updateAgentSessionMeta(sessionId, state
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
      const newArchived = !current.archived
      // 归档时自动取消置顶
      const updates: Partial<AgentSessionMeta> = { archived: newArchived }
      if (newArchived && current.pinned) {
        updates.pinned = false
      }
      return updateAgentSessionMeta(id, updates)
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
        const key = record.pid ?? -Math.abs(record.launchedAt)
        results.set(key, {
          pid: record.pid,
          name: record.pid ? 'Pi service' : 'Pi launch observation',
          cmd: record.command,
          startTime: record.startTime,
          ports: record.ports,
          source: 'pi-owned',
          status: record.status === 'running' ? 'running' : 'pending',
          cwd: record.cwd,
          persistsAfterChat: Boolean(record.pid),
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
      const isOwned = owned.some((record) => record.pid === input.pid && record.startTime === input.startTime && record.status === 'running')
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
    async (_, id: string, updates: { name: string }): Promise<AgentWorkspace> => {
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

  // ===== 全局 Skill 体系 =====
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.LIST, async (_, workspaceSlug?: string) => {
    if (workspaceSlug !== undefined) assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return listGlobalSkills(workspaceSlug)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.READ, async (_, skillId: string) => readGlobalSkillContent(skillId))
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.READ_WORKSPACE_COPY, async (_, workspaceSlug: string, workspaceSkillId: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    assertSafeSkillSegment(workspaceSkillId, 'workspaceSkillId')
    return readWorkspaceSkillCopyContent(workspaceSlug, workspaceSkillId)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.SAVE_WORKSPACE_COPY, async (_, workspaceSlug: string, workspaceSkillId: string, content: string): Promise<void> => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    assertSafeSkillSegment(workspaceSkillId, 'workspaceSkillId')
    saveWorkspaceSkillCopyContent(workspaceSlug, workspaceSkillId, content)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.SAVE, async (_, skillId: string, content: string, workspaceSlug: string, scope: 'global' | 'workspace') => {
    if (scope !== 'global' && scope !== 'workspace') throw new Error('必须明确选择全局版本或当前工作区')
    if (scope === 'workspace') assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return editGlobalSkill(skillId, workspaceSlug, scope, content)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.COPY_TO_USER, async (_, skillId: string, slug?: string) => {
    if (slug !== undefined) assertSafeSkillSegment(slug.trim(), 'global Skill slug')
    return copyGlobalSkillToUserGlobal(skillId, slug)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.CREATE_USER, async (_, slug: string, name: string, description: string, content: string) => {
    assertSafeSkillSegment(slug.trim(), 'global Skill slug')
    return createUserGlobalSkill(slug, name, description, content)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.COPY_TO_WORKSPACE, async (_, skillId: string, workspaceSlug: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return copyGlobalSkillToWorkspace(skillId, workspaceSlug)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.GET_DELETE_BLOCKERS, async (_, skillId: string) => getGlobalSkillDeleteBlockers(skillId))
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.DELETE_USER, async (_, skillId: string, confirmationToken?: string) => deleteUserGlobalSkill(skillId, confirmationToken))
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.SET_ENABLED, async (_, workspaceSlug: string, skillId: string, enabled: boolean) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return setGlobalSkillEnabled(workspaceSlug, skillId, enabled)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.RESTORE, async (_, workspaceSlug: string, skillId: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return restoreGlobalSkill(workspaceSlug, skillId)
  })
  ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.GET_OVERRIDES, async (_, workspaceSlug: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return getWorkspaceGlobalSkillOverrides(workspaceSlug)
  })

  // ===== 全局元 Skill（master 库） =====
  ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.LIST, async (): Promise<MasterSkillMeta[]> => {
    return listMasterSkills()
  })
  ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.READ, async (_, slug: string): Promise<string> => {
    return readMasterSkillContent(slug)
  })
  // 旧 master 目录仅保留只读迁移兼容，禁止通过遗留 IPC 绕过 builtin-meta 的只读保护。
  ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.SAVE, async (): Promise<never> => {
    throw new Error('旧元 Skill 写接口已停用，请通过全局 Skill 体系复制后编辑')
  })
  ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.RENAME_META, async (): Promise<never> => {
    throw new Error('旧元 Skill 写接口已停用，请通过全局 Skill 体系复制后编辑')
  })
  ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.LIST_HISTORY, async (_, slug: string): Promise<MasterSkillVersion[]> => {
    return listMasterSkillHistory(slug)
  })
  ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.ROLLBACK, async (): Promise<never> => {
    throw new Error('旧元 Skill 写接口已停用，请通过全局 Skill 体系复制后编辑')
  })
  ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.SYNC_TO_WORKSPACES, async (): Promise<never> => {
    throw new Error('旧元 Skill 同步接口已停用，请使用全局 Skill 的工作区副本功能')
  })
  ipcMain.handle(
    SKILL_MASTER_IPC_CHANNELS.DETECT_CONFLICT,
    async (_, workspaceSlug: string, skillSlug: string): Promise<SkillConflict> => {
      return detectSkillConflict(workspaceSlug, skillSlug)
    }
  )


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
          const reference = session.presetReference ?? presetReferenceForId(workspaceSlug, session.presetId)
          if (!reference.presetId) throw new Error('AGENT_PRESET_REQUIRED: 请先选择一个 Agent 预设，然后再开始对话')
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
  ipcMain.handle(
    AGENT_IPC_CHANNELS.STOP_AGENT,
    async (event, sessionId: string): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      feishuBridgeManager.stopSessionMirrorRun(sessionId)
      await stopAgentAndWait(sessionId)
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
        event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: { kind: 'profer_event', event: { type: 'permission_resolved', requestId, behavior } },
        })
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
    async (_, sessionId: string, mode: ProferPermissionMode): Promise<void> => {
      if (!isProferPermissionMode(mode)) {
        throw new Error(`无效的权限模式: ${mode}`)
      }
      // 会话不存在时直接抛错（避免 updateAgentSessionMeta 的通用异常被降级为 warn）
      if (!getAgentSessionMeta(sessionId)) {
        throw new Error(`Agent 会话不存在: ${sessionId}`)
      }
      // 持久化到 session meta（重启后可恢复，即使 session 未运行也要写）。
      // 这里的 catch 仅用于兜底磁盘 I/O 类异常，不影响后续热切换。
      try {
        updateAgentSessionMeta(sessionId, { permissionMode: mode })
      } catch (err) {
        console.warn(`[IPC] 持久化 session 权限模式失败: sessionId=${sessionId}`, err)
      }
      // 若 session 正在跑，同步热切换运行时模式
      if (isAgentSessionActive(sessionId)) {
        await updateAgentPermissionMode(sessionId, mode).catch((err) => {
          console.warn(`[IPC] 运行中权限模式切换失败: sessionId=${sessionId}`, err)
          throw err
        })
      }
    }
  )

  // 空闲会话的 Codex Fast Mode：下一轮 Pi 请求读取持久化状态。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_CODEX_FAST_MODE,
    async (_, sessionId: string, enabled: boolean): Promise<AgentSessionMeta> => {
      if (typeof enabled !== 'boolean') throw new Error(`无效的 Codex Fast Mode 状态: ${String(enabled)}`)
      if (!getAgentSessionMeta(sessionId)) throw new Error(`Agent 会话不存在: ${sessionId}`)
      if (isAgentSessionActive(sessionId)) throw new Error('Agent 正在运行，完成后再切换快速模式')
      return updateAgentSessionMeta(sessionId, { codexFastMode: enabled })
    },
  )

  // Codex 推理档位跨会话记忆
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_OPENAI_THINKING,
    async (_, sessionId: string, level: AgentThinkingLevel | null): Promise<AgentSessionMeta> => {
      const validLevels: (AgentThinkingLevel | null)[] = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']
      // level 为 null 表示「使用全局默认」（清除会话级覆盖）
      if (level !== null && !validLevels.includes(level)) {
        throw new Error(`无效的推理档位: ${String(level)}`)
      }
      if (!getAgentSessionMeta(sessionId)) throw new Error(`Agent 会话不存在: ${sessionId}`)
      if (isAgentSessionActive(sessionId)) throw new Error('Agent 正在运行，完成后再切换推理档位')
      return updateAgentSessionMeta(sessionId, { openAIThinkingLevel: level })
    },
  )

  // 队列「自动发送」开关 per-session 持久化（手动切换 / 自动由开到关均经此写入 meta）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_QUEUE_AUTO_SEND,
    (_e, input: { sessionId: string; enabled: boolean }): AgentSessionMeta =>
      updateAgentSessionMeta(input.sessionId, { autoQueueSendEnabled: input.enabled }),
  )

  // 查询某 Pi 模型可用的推理档位能力（renderer 思考档位菜单动态展示）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_PI_REASONING_CAPABILITY,
    async (_, provider: ProviderType, modelId: string | undefined): Promise<ReasoningCapability | undefined> => {
      return resolvePiReasoningCapability(provider, modelId)
    },
  )

  // 空闲会话切换 runtime，并同步更新新会话默认值；跨 Claude/Pi 时绝不复用另一 runtime 的 SDK 会话 ID。
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
      if (isAgentSessionActive(sessionId)) throw new Error('Agent 正在运行，完成后再切换内核')

      // updateAgentSessionMeta 在跨 runtime 时会清理 SDK/fork/resume 字段；切换前必须保存完整快照。
      const previousRuntime = snapshotAgentRuntimeMeta(current)
      const updated = updateAgentSessionMeta(sessionId, { agentRuntime: runtime })
      try {
        updateSettings({ agentRuntime: runtime })
        return updated
      } catch (error) {
        // 不使用普通 update helper：它会把恢复 runtime 视为一次切换并再次清空快照字段。
        try { restoreAgentRuntimeMeta(sessionId, previousRuntime) } catch { /* 保留原始设置错误 */ }
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
    AGENT_IPC_CHANNELS.READ_WORKSPACE_CLAUDE_MD,
    async (_, workspaceSlug: string): Promise<SkillFileContent> => {
      return readWorkspaceClaudeMd(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_WORKSPACE_CLAUDE_MD,
    async (event, workspaceSlug: string, content: string): Promise<void> => {
      assertSensitiveAgentIpcSender(event)
      writeWorkspaceClaudeMd(workspaceSlug, content)
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
    async (_, toolId: string): Promise<Record<string, string>> => {
      return getToolCredentials(toolId)
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
      // GPT Image 生图工具测试
      if (toolId === 'nano-banana' || toolId === 'gpt-image') {
        const { getToolCredentials: getCredentials } = await import('./lib/chat-tool-config')
        const credentials = getCredentials(toolId)
        if (!credentials.apiKey) {
          return { success: false, message: '请先填写 OpenAI API Key' }
        }
        try {
          const baseUrl = credentials.baseUrl?.trim() || 'https://api.openai.com'
          const url = `${baseUrl}/v1/models`
          const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${credentials.apiKey}` },
          })
          if (!response.ok) {
            const errorText = await response.text()
            return { success: false, message: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }
          }
          return { success: true, message: `连接成功，OpenAI API 可用` }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return { success: false, message: `连接失败: ${msg}` }
        }
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
        event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: { kind: 'profer_event', event: { type: 'ask_user_resolved', requestId } },
        })
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
        event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: { kind: 'profer_event', event: { type: 'exit_plan_mode_resolved', requestId: response.requestId } },
        })

        // 如果用户选择了新的权限模式，通知渲染进程更新 UI
        if (targetMode) {
          const meta = getAgentSessionMeta(sessionId)
          // 持久化到 session meta，和 cycleMode 路径保持一致（重启后该 session 能恢复）
          if (meta) {
            try {
              updateAgentSessionMeta(sessionId, { permissionMode: targetMode })
            } catch (err) {
              console.warn(`[IPC] ExitPlanMode 持久化 session 权限模式失败: sessionId=${sessionId}`, err)
            }
          }
          event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            sessionId,
            payload: { kind: 'profer_event', event: { type: 'permission_mode_changed', mode: targetMode } },
          })
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
    async (_, dirPath: string): Promise<FileEntry[]> => {
      const { existsSync, readdirSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      // 安全校验：路径必须在 agent-workspaces 目录下
      const safePath = resolve(dirPath)
      assertInsideAgentWorkspaces(safePath)

      // 目录可能已被删除（如删除 Agent 会话后面板仍持有旧路径），优雅返回空列表
      if (!existsSync(safePath)) {
        return []
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
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:resolve-and-read 拒绝越界路径:', resolved ?? filePath)
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
      if (result && !isPathAllowed(result, options)) {
        console.warn('[IPC] file:resolve-path 拒绝越界路径:', result)
        return null
      }
      return result ? { url: registerProferFilePath(result), resolvedPath: result } : null
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
      if (!result || !isPathAllowed(result, options)) {
        console.warn('[IPC] file:resolve-html-preview-path 拒绝越界路径:', result ?? filePath)
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
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:prepare-pdf-preview 拒绝越界路径:', resolved ?? filePath)
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
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:docx-to-html 拒绝越界路径:', resolved ?? filePath)
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
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:office-to-html 拒绝越界路径:', resolved ?? filePath)
        return null
      }
      return convertOfficeToHtml(resolved)
    }
  )

  // 注册文件路径到 profer-file:// 协议
  // 路径必须在基础授权根目录内（工作区 + 用户常用目录）。
  // 兼容旧调用方：未传 access 时回退到基础授权根校验。
  ipcMain.handle(
    'file:register-preview-path',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<string | null> => {
      const { statSync } = await import('node:fs')
      const { registerProferFilePath } = await import('./lib/local-file-protocol')
      const options = normalizeFileAccessOptions(access)
      try {
        if (!statSync(filePath).isFile()) return null
        // 安全校验：有 options 走完整 isPathAllowed；无 options 回退到基础授权根
        const allowed = options
          ? isPathAllowed(filePath, options)
          : getAuthorizedRoots().some((root) => isUnderRoot(realpathOrResolve(filePath), root))
        if (!allowed) {
          console.warn('[IPC] file:register-preview-path 拒绝越界路径:', filePath)
          return null
        }
        return registerProferFilePath(filePath)
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
      if (!resolved || !isPathAllowed(resolved, options)) return null
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
      if (!isPathAllowed(safePath, options)) {
        console.warn('[IPC] show-attached-in-folder 拒绝越界路径:', safePath)
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

  // 获取系统提示词配置
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<SystemPromptConfig> => {
      return getSystemPromptConfig()
    }
  )

  // 创建提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.CREATE,
    async (_, input: SystemPromptCreateInput): Promise<SystemPrompt> => {
      return createSystemPrompt(input)
    }
  )

  // 更新提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.UPDATE,
    async (_, id: string, input: SystemPromptUpdateInput): Promise<SystemPrompt> => {
      return updateSystemPrompt(id, input)
    }
  )

  // 删除提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<void> => {
      return deleteSystemPrompt(id)
    }
  )

  // 更新追加日期时间和用户名开关
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING,
    async (_, enabled: boolean): Promise<void> => {
      return updateAppendSetting(enabled)
    }
  )

  // 设置默认提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT,
    async (_, id: string | null): Promise<void> => {
      return setDefaultPrompt(id)
    }
  )

  // ===== GitHub Release =====

  /** 商业版 releases.json 地址，可通过 PROFER_UPDATE_FEED_URL 环境变量覆盖 */
  const RELEASES_JSON_URL =
    (process.env.PROFER_UPDATE_FEED_URL || 'http://47.109.108.57/profer-updates/') + 'releases.json'

  /** 从服务器获取 releases 列表（商业版数据源） */
  async function fetchServerReleases(): Promise<GitHubRelease[]> {
    const resp = await fetch(RELEASES_JSON_URL)
    if (!resp.ok) throw new Error(`服务器返回 ${resp.status}`)
    const data = await resp.json() as GitHubRelease[]
    if (!Array.isArray(data)) throw new Error('服务器返回数据格式错误')
    return data
  }

  // 获取最新 Release
  ipcMain.handle(
    GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE,
    async (): Promise<GitHubRelease | null> => {
      if (getBuildTarget() === 'commercial') {
        try {
          const releases = await fetchServerReleases()
          return releases[0] ?? null
        } catch (err) {
          console.log('[版本历史] 服务器 releases 不可用:', err)
          return null
        }
      }
      return getLatestRelease()
    }
  )

  // 获取 Release 列表（商业版走服务器，oss 走 GitHub）
  ipcMain.handle(
    GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES,
    async (_, options?: GitHubReleaseListOptions): Promise<GitHubRelease[]> => {
      if (getBuildTarget() === 'commercial') {
        try {
          const releases = await fetchServerReleases()
          const perPage = options?.perPage ?? 3
          return releases.slice(0, perPage)
        } catch (err) {
          console.log('[版本历史] 服务器 releases 不可用:', err)
          return []
        }
      }
      return listGitHubReleases(options)
    }
  )

  // 获取指定版本的 Release
  ipcMain.handle(
    GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG,
    async (_, tag: string): Promise<GitHubRelease | null> => {
      if (getBuildTarget() === 'commercial') {
        try {
          const releases = await fetchServerReleases()
          return releases.find(r => r.tag_name === tag) ?? null
        } catch (err) {
          console.log('[版本历史] 服务器 releases 不可用:', err)
          return null
        }
      }
      return getReleaseByTag(tag)
    }
  )

  // ===== Lark CLI cloud capability =====
  __setLarkLoginEventHandler((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(LARK_IPC_CHANNELS.LOGIN_EVENT, payload)
    }
  })
  __setLarkMcpLoginEventHandler((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(LARK_IPC_CHANNELS.MCP_LOGIN_EVENT, payload)
    }
  })
  ipcMain.handle(LARK_IPC_CHANNELS.GET_STATUS, async () => detectLarkCli())
  ipcMain.handle(LARK_IPC_CHANNELS.REFRESH_STATUS, async () => detectLarkCli())
  ipcMain.handle(LARK_IPC_CHANNELS.GET_MCP_STATUS, async () => getLarkMcpStatus())
  ipcMain.handle(LARK_IPC_CHANNELS.SAVE_MCP_CREDENTIALS, async (_, input: import('@profer/shared').LarkMcpCredentialsInput) => saveLarkMcpCredentials(input))
  ipcMain.handle(LARK_IPC_CHANNELS.ENABLE_MCP_FOR_WORKSPACE, async (_, workspaceSlug: string) => enableLarkMcpForWorkspace(workspaceSlug))
  ipcMain.handle(LARK_IPC_CHANNELS.DISABLE_MCP_FOR_WORKSPACE, async (_, workspaceSlug: string) => disableLarkMcpForWorkspace(workspaceSlug))
  ipcMain.handle(LARK_IPC_CHANNELS.START_MCP_LOGIN, async () => startLarkMcpLogin())
  ipcMain.handle(LARK_IPC_CHANNELS.CANCEL_MCP_LOGIN, async () => { cancelLarkMcpLogin() })
  ipcMain.handle(LARK_IPC_CHANNELS.TEST_MCP_CONNECTION, async () => testLarkMcpConnection())
  ipcMain.handle(LARK_IPC_CHANNELS.INSTALL_CLI, async () => installLarkCli())
  ipcMain.handle(LARK_IPC_CHANNELS.START_LOGIN, async () => startLarkLogin())
  ipcMain.handle(LARK_IPC_CHANNELS.CANCEL_LOGIN, async () => { cancelLarkLogin() })

  // ===== 飞书集成 =====

  // --- 旧 API（向后兼容，操作 bots[0]）---

  // 获取飞书配置
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<FeishuConfig> => {
      return getFeishuConfig()
    }
  )

  // 获取解密后的 App Secret
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_DECRYPTED_SECRET,
    async (): Promise<string> => {
      return getDecryptedAppSecret()
    }
  )

  // 保存飞书配置（旧格式，操作 bots[0]）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.SAVE_CONFIG,
    async (_, input: FeishuConfigInput): Promise<FeishuConfig> => {
      const config = saveFeishuConfig(input)
      // 配置变更后，重启对应的 Bot
      const multi = getFeishuMultiBotConfig()
      const firstBot = multi.bots[0]
      if (firstBot) {
        if (input.enabled && input.appId && input.appSecret) {
          await feishuBridgeManager.restartBot(firstBot.id)
        } else if (!input.enabled) {
          feishuBridgeManager.stopBot(firstBot.id)
        }
      }
      return config
    }
  )

  // 启动飞书 Bridge（旧格式，启动所有 Bot）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await feishuBridgeManager.startAll()
    }
  )

  // 停止飞书 Bridge（旧格式，停止所有 Bot）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      feishuBridgeManager.stopAll()
    }
  )

  // 获取飞书 Bridge 状态（旧格式，返回第一个 Bot 状态）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_STATUS,
    async (): Promise<FeishuBridgeState> => {
      const states = feishuBridgeManager.getStates()
      const first = Object.values(states.bots)[0]
      return first ?? { status: 'disconnected', activeBindings: 0 }
    }
  )

  // --- 新 API（多 Bot v2）---

  // 获取多 Bot 配置
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_MULTI_CONFIG,
    async () => {
      return getFeishuMultiBotConfig()
    }
  )

  // 保存单个 Bot 配置
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.SAVE_BOT_CONFIG,
    async (_, input: import('@profer/shared').FeishuBotConfigInput) => {
      const saved = saveFeishuBotConfig(input)
      // 配置变更后自动重启或停止（不阻塞保存结果）
      if (saved.enabled && saved.appId && saved.appSecret) {
        feishuBridgeManager.restartBot(saved.id).catch((err) => {
          console.error(`[飞书 IPC] Bot "${saved.name}" 重启失败:`, err)
        })
      } else {
        feishuBridgeManager.stopBot(saved.id)
      }
      return saved
    }
  )

  // 删除 Bot
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REMOVE_BOT,
    async (_, botId: string) => {
      feishuBridgeManager.stopBot(botId)
      return removeFeishuBot(botId)
    }
  )

  // 获取单个 Bot 解密 Secret
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET,
    async (_, botId: string) => {
      return getDecryptedBotAppSecret(botId)
    }
  )

  // 启动单个 Bot
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.START_BOT,
    async (_, botId: string) => {
      await feishuBridgeManager.startBot(botId)
    }
  )

  // 停止单个 Bot
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.STOP_BOT,
    async (_, botId: string) => {
      feishuBridgeManager.stopBot(botId)
    }
  )

  // 获取多 Bot 状态
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_MULTI_STATUS,
    async () => {
      return feishuBridgeManager.getStates()
    }
  )

  // 测试飞书连接
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.TEST_CONNECTION,
    async (_, appId: string, appSecret: string): Promise<FeishuTestResult> => {
      return feishuBridgeManager.testConnection(appId, appSecret)
    }
  )

  // 获取活跃绑定列表
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.LIST_BINDINGS,
    async (): Promise<FeishuChatBinding[]> => {
      return feishuBridgeManager.listAllBindings()
    }
  )

  // 更新绑定（工作区/会话）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.UPDATE_BINDING,
    async (_, input: FeishuUpdateBindingInput): Promise<FeishuChatBinding | null> => {
      const bridge = feishuBridgeManager.findBridgeByChatId(input.chatId)
      return bridge?.updateBinding(input) ?? null
    }
  )

  // 移除绑定
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REMOVE_BINDING,
    async (_, chatId: string): Promise<boolean> => {
      const bridge = feishuBridgeManager.findBridgeByChatId(chatId)
      return bridge?.removeBinding(chatId) ?? false
    }
  )

  // 上报用户在场状态
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REPORT_PRESENCE,
    async (_, report: FeishuPresenceReport): Promise<void> => {
      presenceService.updatePresence(report)
    }
  )

  // ===== 飞书扫码注册 =====

  /** 当前进行中的注册流程的 AbortController（同一时间只允许一个） */
  let activeRegisterAbort: AbortController | null = null

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REGISTER_APP_START,
    async (event): Promise<FeishuRegisterAppResult> => {
      // 同一时间只允许一个注册流程
      if (activeRegisterAbort) {
        activeRegisterAbort.abort()
      }
      const abort = new AbortController()
      activeRegisterAbort = abort

      try {
        const lark = await import('@larksuiteoapi/node-sdk')
        const QRCode = (await import('qrcode')).default
        const result = await lark.registerApp({
          source: 'proma',
          signal: abort.signal,
          onQRCodeReady: async (info) => {
            if (event.sender.isDestroyed()) return
            try {
              const dataUrl = await QRCode.toDataURL(info.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
              if (event.sender.isDestroyed()) return
              const payload: FeishuRegisterAppQRCode = {
                url: info.url,
                dataUrl,
                expireIn: info.expireIn,
              }
              event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, payload)
            } catch (err) {
              console.error('[飞书扫码注册] QRCode 生成失败:', err)
              if (event.sender.isDestroyed()) return
              // 兜底：仍把 url 发过去，渲染层可用浏览器打开
              event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, {
                url: info.url,
                dataUrl: '',
                expireIn: info.expireIn,
              })
            }
          },
          onStatusChange: (info) => {
            if (event.sender.isDestroyed()) return
            const payload: FeishuRegisterAppStatus = {
              status: info.status,
              interval: info.interval,
            }
            event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_STATUS, payload)
          },
        })
        return {
          appId: result.client_id,
          appSecret: result.client_secret,
          tenantBrand: result.user_info?.tenant_brand,
          operatorOpenId: result.user_info?.open_id,
        }
      } finally {
        if (activeRegisterAbort === abort) {
          activeRegisterAbort = null
        }
      }
    }
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REGISTER_APP_CANCEL,
    async (): Promise<void> => {
      activeRegisterAbort?.abort()
      activeRegisterAbort = null
    }
  )

  // ===== 钉钉集成 =====

  // 获取钉钉配置（旧 API，向后兼容）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<DingTalkConfig> => {
      return getDingTalkConfig()
    }
  )

  // 获取解密后的 Client Secret（旧 API，向后兼容）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_DECRYPTED_SECRET,
    async (): Promise<string> => {
      return getDecryptedClientSecret()
    }
  )

  // 保存钉钉配置（旧 API，向后兼容）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.SAVE_CONFIG,
    async (_, input: DingTalkConfigInput): Promise<DingTalkConfig> => {
      return saveDingTalkConfig(input)
    }
  )

  // 测试钉钉连接
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.TEST_CONNECTION,
    async (_, clientId: string, clientSecret: string): Promise<DingTalkTestResult> => {
      return dingtalkBridgeManager.testConnection(clientId, clientSecret)
    }
  )

  // 启动钉钉 Bridge（旧 API，启动第一个 Bot）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await dingtalkBridgeManager.startAll()
    }
  )

  // 停止钉钉 Bridge（旧 API，停止所有 Bot）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      dingtalkBridgeManager.stopAll()
    }
  )

  // 获取钉钉 Bridge 状态（旧 API，返回第一个 Bot 状态）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_STATUS,
    async (): Promise<DingTalkBridgeState> => {
      const states = dingtalkBridgeManager.getStates()
      const first = Object.values(states.bots)[0]
      return first ?? { status: 'disconnected' }
    }
  )

  // --- 钉钉多 Bot v2 API ---

  // 获取多 Bot 配置
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_MULTI_CONFIG,
    async () => {
      return getDingTalkMultiBotConfig()
    }
  )

  // 保存单个 Bot 配置
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.SAVE_BOT_CONFIG,
    async (_, input: import('@profer/shared').DingTalkBotConfigInput) => {
      const saved = saveDingTalkBotConfig(input)
      // 配置变更后自动重启或停止（不阻塞保存结果）
      if (saved.enabled && saved.clientId && saved.clientSecret) {
        dingtalkBridgeManager.restartBot(saved.id).catch((err) => {
          console.error(`[钉钉 IPC] Bot "${saved.name}" 重启失败:`, err)
        })
      } else {
        dingtalkBridgeManager.stopBot(saved.id)
      }
      return saved
    }
  )

  // 删除 Bot
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.REMOVE_BOT,
    async (_, botId: string) => {
      dingtalkBridgeManager.stopBot(botId)
      return removeDingTalkBot(botId)
    }
  )

  // 获取单个 Bot 解密 Secret
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET,
    async (_, botId: string) => {
      return getDecryptedBotClientSecret(botId)
    }
  )

  // 启动单个 Bot
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.START_BOT,
    async (_, botId: string) => {
      await dingtalkBridgeManager.startBot(botId)
    }
  )

  // 停止单个 Bot
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.STOP_BOT,
    async (_, botId: string) => {
      dingtalkBridgeManager.stopBot(botId)
    }
  )

  // 获取多 Bot 状态
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_MULTI_STATUS,
    async () => {
      return dingtalkBridgeManager.getStates()
    }
  )

  // ===== 微信集成 =====

  // 获取微信配置
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<WeChatConfig> => {
      return getWeChatConfig()
    }
  )

  // 开始扫码登录
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_LOGIN,
    async (): Promise<void> => {
      await wechatBridge.startLogin()
    }
  )

  // 登出
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.LOGOUT,
    async (): Promise<void> => {
      wechatBridge.logout()
    }
  )

  // 启动 Bridge（用已有凭证）
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await wechatBridge.start()
    }
  )

  // 停止 Bridge
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      wechatBridge.stop()
    }
  )

  // 获取 Bridge 状态
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_STATUS,
    async (): Promise<WeChatBridgeState> => {
      return wechatBridge.getStatus()
    }
  )

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

  // 启动时自动归档 + 每 24 小时定期检查
  const runAutoArchive = (): void => {
    try {
      const settings = getSettings()
      const days = settings.archiveAfterDays ?? 7
      if (days > 0) {
        const archivedChats = autoArchiveConversations(days)
        const archivedSessions = autoArchiveAgentSessions(days)
        if (archivedChats + archivedSessions > 0) {
          console.log(`[自动归档] 已归档 ${archivedChats} 个对话, ${archivedSessions} 个 Agent 会话`)
        }
      }
    } catch (error) {
      console.error('[自动归档] 自动归档失败:', error)
    }
  }

  runAutoArchive()
  setInterval(runAutoArchive, 24 * 60 * 60 * 1000)

  // 启动时清理不存在的附加目录/文件（如已删除的 worktree）
  try {
    cleanupStaleAttachedPaths()
    cleanupStaleWorkspaceAttachedPaths()
  } catch (error) {
    console.error('[启动清理] 清理失效附加路径失败:', error)
  }

  // ===== 存储管理 =====

  ipcMain.handle(STORAGE_IPC_CHANNELS.GET_STATS, async () => {
    return calculateStorageStats()
  })

  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP, async (_, options: CleanupOptions) => {
    return cleanupStorage(options)
  })

  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP_TEMP, async () => {
    return cleanupTempFiles()
  })

  // ===== 工作区热力图 =====

  ipcMain.handle(AGENT_IPC_CHANNELS.GET_WORKSPACE_HEATMAP_DAILY, async (_, workspaceId: string) => {
    const { loadWorkspaceHeatmapDaily } = await import('./lib/workspace-heatmap-query')
    return loadWorkspaceHeatmapDaily(workspaceId)
  })

  // 迁移取消时清理临时解压目录
  ipcMain.handle('migration:cancelImport', async (_, tempDir: string) => {
    if (!tempDir || typeof tempDir !== 'string') return
    try {
      // 安全校验：解析真实路径，确保只清理 tmpdir 下的 profer-import-* 目录
      const resolved = realpathSync(resolve(tempDir))
      const tmpRoot = realpathSync(tmpdir())
      if (!resolved.startsWith(tmpRoot + sep)) {
        console.warn('[迁移] 拒绝清理非临时目录:', tempDir)
        return
      }
      const dirName = basename(resolved)
      if (!dirName.startsWith('profer-import-')) {
        console.warn('[迁移] 目录名不匹配，拒绝清理:', dirName)
        return
      }
      if (existsSync(resolved)) {
        rmSync(resolved, { recursive: true, force: true })
        console.log(`[迁移] 已清理临时目录: ${resolved}`)
      }
    } catch {
      // 目录不存在或无法解析，无需清理
    }
  })

  // 启动时自动清理临时文件
  const runStartupCleanup = async (): Promise<void> => {
    try {
      const settings = getSettings()
      if (settings.autoCleanupTempOnStart !== false) {
        const result = await cleanupTempFiles()
        if (result.freedBytes > 0) {
          console.log(`[存储清理] 启动时清理了 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB 临时文件`)
        }
      }
      const archiveDays = settings.autoCleanupArchivedDays ?? 0
      if (archiveDays > 0) {
        const result = await cleanupStorage({
          categories: ['agent-sessions', 'sdk-config'],
          orphansOnly: false,
          archivedBeforeDays: archiveDays,
        })
        if (result.freedBytes > 0) {
          console.log(`[存储清理] 启动时清理了 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB 归档数据`)
        }
      }
    } catch (e) {
      console.error('[存储清理] 启动时清理失败:', e)
    }
  }
  runStartupCleanup()

  // ===== 快速任务窗口 =====

  // 提交快速任务 → 隐藏窗口 + 转发到主窗口（由渲染进程创建会话并发送消息）
  ipcMain.handle(
    QUICK_TASK_IPC_CHANNELS.SUBMIT,
    async (_, input: QuickTaskSubmitInput): Promise<void> => {
      const { hideQuickTaskWindow } = await import('./lib/quick-task-window')
      const { getMainWindow } = await import('./index')
      hideQuickTaskWindow()

      const mainWin = getMainWindow()
      if (mainWin && !mainWin.isDestroyed()) {
        // 转发到主窗口渲染进程，由 GlobalShortcuts 创建会话并触发发送
        mainWin.webContents.send('quick-task:open-session', {
          mode: input.mode,
          text: input.text,
          files: input.files,
        })
        mainWin.show()
        mainWin.focus()
      }
    }
  )

  // 隐藏快速任务窗口
  ipcMain.handle(
    QUICK_TASK_IPC_CHANNELS.HIDE,
    async (): Promise<void> => {
      const { hideQuickTaskWindow } = await import('./lib/quick-task-window')
      hideQuickTaskWindow()
    }
  )

  // 重新注册全局快捷键（设置中修改快捷键后调用）
  ipcMain.handle(
    QUICK_TASK_IPC_CHANNELS.REREGISTER_GLOBAL_SHORTCUTS,
    async (): Promise<Record<string, boolean>> => {
      const { reregisterAllGlobalShortcuts } = await import('./lib/global-shortcut-service')
      return reregisterAllGlobalShortcuts()
    }
  )

  // ===== 语音输入 =====

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.GET_SETTINGS,
    async (): Promise<VoiceDictationSettings> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      return getVoiceDictationSettings()
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.UPDATE_SETTINGS,
    async (_, updates: VoiceDictationSettingsUpdate): Promise<VoiceDictationSettings> => {
      const { updateVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      return updateVoiceDictationSettings(updates)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.TEST_CONNECTION,
    async (_, updates?: VoiceDictationSettingsUpdate): Promise<VoiceDictationTestResult> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      const { testDoubaoAsrConnection } = await import('./lib/doubao-asr-service')
      const settings = { ...getVoiceDictationSettings(), ...(updates ?? {}) }
      return testDoubaoAsrConnection(settings)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.TOGGLE,
    async (event): Promise<void> => {
      const { toggleVoiceDictationWindow } = await import('./lib/voice-dictation-window')
      const sourceWindow = BrowserWindow.fromWebContents(event.sender)
      toggleVoiceDictationWindow({ targetIsProfer: !!sourceWindow })
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.START,
    async (event, input: VoiceDictationStartInput): Promise<void> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      const { startDoubaoAsrSession } = await import('./lib/doubao-asr-service')
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('语音输入窗口不存在')
      await startDoubaoAsrSession(input.sessionId, getVoiceDictationSettings(), win)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.SEND_AUDIO,
    async (_, input: VoiceDictationAudioChunkInput): Promise<void> => {
      const { sendDoubaoAsrAudio } = await import('./lib/doubao-asr-service')
      sendDoubaoAsrAudio(input.sessionId, input.data)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.STOP,
    async (_, input: VoiceDictationStopInput): Promise<void> => {
      const { stopDoubaoAsrSession } = await import('./lib/doubao-asr-service')
      await stopDoubaoAsrSession(input.sessionId)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.CANCEL,
    async (_, input: VoiceDictationStopInput): Promise<void> => {
      const { cancelDoubaoAsrSession } = await import('./lib/doubao-asr-service')
      cancelDoubaoAsrSession(input.sessionId)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.COMMIT,
    async (_, input: VoiceDictationCommitInput): Promise<VoiceDictationCommitResult> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      const { commitVoiceDictationText } = await import('./lib/text-output-service')
      return commitVoiceDictationText(input.text, getVoiceDictationSettings())
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.HIDE,
    async (): Promise<void> => {
      const { hideVoiceDictationWindow } = await import('./lib/voice-dictation-window')
      hideVoiceDictationWindow()
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.RESIZE,
    async (_, input: VoiceDictationResizeInput): Promise<void> => {
      const { resizeVoiceDictationWindow } = await import('./lib/voice-dictation-window')
      resizeVoiceDictationWindow(input.height)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.CHECK_MIC_PERMISSION,
    async (): Promise<MicPermissionResult> => {
      const { checkMicrophonePermission } = await import('./lib/microphone-permission-service')
      return checkMicrophonePermission()
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.REQUEST_MIC_PERMISSION,
    async (): Promise<MicPermissionResult> => {
      const { requestMicrophonePermission } = await import('./lib/microphone-permission-service')
      return requestMicrophonePermission()
    }
  )

  // ===== 数据迁移 =====

  ipcMain.handle('migration:getExportPreview', async (_, workspaceId: string) => {
    const { getExportPreview } = await import('./lib/migration-service')
    return getExportPreview(workspaceId)
  })

  ipcMain.handle('migration:getShareExportPreview', async () => {
    const { getShareExportPreview } = await import('./lib/migration-service')
    return getShareExportPreview()
  })

  ipcMain.handle('migration:export', async (_, options) => {
    const { exportData } = await import('./lib/migration-service')
    return exportData(options)
  })

  ipcMain.handle('migration:exportV2', async (_, options) => {
    const { exportDataV2 } = await import('./lib/migration-service')
    return exportDataV2(options)
  })

  ipcMain.handle('migration:parseImportFile', async (_, filePath: string) => {
    const { parseImportFile } = await import('./lib/migration-service')
    return parseImportFile(filePath)
  })

  ipcMain.handle('migration:confirmImport', async (_, options) => {
    const { confirmImport } = await import('./lib/migration-service')
    return confirmImport(options)
  })

  ipcMain.handle('migration:openFileDialog', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      title: '选择迁移文件',
      filters: [
        { name: 'Profer 迁移文件', extensions: ['profer-backup', 'profer-share'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('migration:saveFileDialog', async (_, mode: string) => {
    const { dialog } = await import('electron')
    const ext = mode === 'personal' ? 'profer-backup' : 'profer-share'
    const defaultName = `profer-migration-${new Date().toISOString().slice(0, 10)}.${ext}`
    const result = await dialog.showSaveDialog({
      title: '保存迁移文件',
      defaultPath: defaultName,
      filters: [
        { name: mode === 'personal' ? 'Profer 个人备份' : 'Profer 分享包', extensions: [ext] },
      ],
    })
    return result.canceled ? null : result.filePath
  })

  // ===== 窗口控制（Windows 自定义标题栏按钮）=====

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MINIMIZE,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.minimize()
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MAXIMIZE,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) {
        win.isMaximized() ? win.unmaximize() : win.maximize()
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_CLOSE,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.close()
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_IS_MAXIMIZED,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win && !win.isDestroyed() ? win.isMaximized() : false
    }
  )

  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_FULLSCREEN, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win.isFullScreen() : false
  })

  // ===== 任务 / 日程（Planning）=====

  const isPlanningTitle = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 500
  const isPlanningTimestamp = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
  const isTodoPriority = (value: unknown): value is 'low' | 'medium' | 'high' =>
    value === 'low' || value === 'medium' || value === 'high'
  const isTodoStatus = (value: unknown): value is 'open' | 'completed' =>
    value === 'open' || value === 'completed'
  const parseTodoListQuery = (input: unknown): TodoListQuery => {
    if (input === undefined) return {}
    if (!input || typeof input !== 'object') throw new Error('Todo 查询参数非法')
    const query = input as TodoListQuery
    if (query.status !== undefined && !isTodoStatus(query.status)) throw new Error('Todo status 非法')
    if (query.dueBefore !== undefined && !isPlanningTimestamp(query.dueBefore)) throw new Error('Todo dueBefore 非法')
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error('Todo limit 非法')
    return query
  }
  const parseCalendarEventListQuery = (input: unknown): CalendarEventListQuery => {
    if (input === undefined) return {}
    if (!input || typeof input !== 'object') throw new Error('日程查询参数非法')
    const query = input as CalendarEventListQuery
    if (query.from !== undefined && !isPlanningTimestamp(query.from)) throw new Error('日程 from 非法')
    if (query.to !== undefined && !isPlanningTimestamp(query.to)) throw new Error('日程 to 非法')
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error('日程范围非法')
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error('日程 limit 非法')
    return query
  }

  ipcMain.handle(PLANNING_IPC_CHANNELS.OPEN_WINDOW, async (): Promise<void> => {
    const { showPlanningWindow } = await import('./lib/planning-window')
    showPlanningWindow()
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_TODOS, async (_, input?: unknown): Promise<Todo[]> => {
    const workspaceId = typeof input === 'object' && input !== null && 'workspaceId' in input ? (input as { workspaceId?: unknown }).workspaceId : undefined
    if (typeof workspaceId === 'string' && workspaceId) {
      const { listTeamTodos } = await import('./lib/team-planning-service')
      return listTeamTodos(workspaceId)
    }
    return listTodos(parseTodoListQuery(input))
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_TODO, async (_, input: CreateTodoInput): Promise<Todo> => {
    if (!input || !isPlanningTitle(input.title)) throw new Error('Todo 标题不能为空且不能超过 500 字')
    if (input.priority !== undefined && !isTodoPriority(input.priority)) throw new Error('Todo priority 非法')
    if (input.dueAt !== undefined && !isPlanningTimestamp(input.dueAt)) throw new Error('Todo dueAt 非法')
    if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId.trim())) throw new Error('Todo sessionId 非法')
    if (input.workspaceId && getAgentWorkspace(input.workspaceId)?.type === 'team') {
      const { createTeamTodo } = await import('./lib/team-planning-service')
      return createTeamTodo(input.workspaceId, input)
    }
    const todo = createTodo(input)
    broadcastPlanningChanged(['todos', 'reminders'])
    return todo
  })
  // Todo 项目归属更新与 Agent 会话创建必须在一次主进程同步处理内完成，
  // 避免多个 Planning 窗口之间在校验、更新和创建会话的间隙发生 TOCTOU。
  ipcMain.handle(PLANNING_IPC_CHANNELS.START_TODO_AGENT, (event, input: StartTodoAgentInput): StartTodoAgentResult => {
    if (!input || typeof input.todoId !== 'string' || !input.todoId.trim()) throw new Error('Todo id 必填')
    if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('项目 id 必填')
    if (!isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('Todo expectedUpdatedAt 非法')
    if (typeof input.channelId !== 'string' || !input.channelId.trim()) throw new Error('Agent 渠道必填')
    if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !input.modelId.trim())) throw new Error('Agent 模型非法')
    if (!getAgentWorkspace(input.workspaceId)) throw new Error('所选项目已不可用，请重新选择')

    const existing = getTodo(input.todoId)
    if (!existing) throw new Error('Todo 不存在')
    if (existing.updatedAt !== input.expectedUpdatedAt) throw new Error(PLANNING_CONFLICT_ERROR)

    const todo = existing.workspaceId === input.workspaceId
      ? existing
      : updateTodo({
        id: existing.id,
        workspaceId: input.workspaceId,
        expectedUpdatedAt: existing.updatedAt,
      })
    if (!todo) throw new Error('Todo 不存在')
    if (todo !== existing) broadcastPlanningChanged(['todos', 'reminders'])

    const session = createAgentSession(
      `处理：${todo.title}`,
      input.channelId,
      input.workspaceId,
      input.modelId,
      getSettings().agentRuntime ?? 'pi',
    )
    feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
      console.error('[飞书 Session 镜像] Todo 启动会话建群失败:', error)
    })

    // 独立规划窗口没有 AgentView，需由主窗口接手打开会话并消费自动启动提示。
    try {
      const sourceWindowKind = new URL(event.sender.getURL()).searchParams.get('window')
      if (sourceWindowKind === 'planning') {
        const mainWindow = BrowserWindow.getAllWindows().find((win) => {
          if (win.isDestroyed() || win.webContents.id === event.sender.id) return false
          return new URL(win.webContents.getURL()).searchParams.get('window') === null
        })
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          const activation: TodoAgentSessionActivation = { todo, session }
          mainWindow.webContents.send(PLANNING_IPC_CHANNELS.TODO_AGENT_SESSION_READY, activation)
        }
      }
    } catch (error) {
      console.error('[任务/日程] 转交 Todo Agent 会话到主窗口失败:', error)
    }
    return { todo, session }
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_TODO, async (_, input: UpdateTodoInput): Promise<Todo | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id) throw new Error('Todo id 必填')
    if (input.title !== undefined && !isPlanningTitle(input.title)) throw new Error('Todo 标题不能为空且不能超过 500 字')
    if (input.priority !== undefined && !isTodoPriority(input.priority)) throw new Error('Todo priority 非法')
    if (input.status !== undefined && !isTodoStatus(input.status)) throw new Error('Todo status 非法')
    if (input.dueAt !== undefined && input.dueAt !== null && !isPlanningTimestamp(input.dueAt)) throw new Error('Todo dueAt 非法')
    if (input.expectedUpdatedAt !== undefined && !isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('Todo expectedUpdatedAt 非法')
    if (input.workspaceId && getAgentWorkspace(input.workspaceId)?.type === 'team') {
      const { updateTeamTodo } = await import('./lib/team-planning-service')
      return updateTeamTodo(input.workspaceId, input)
    }
    const todo = updateTodo(input)
    if (todo) broadcastPlanningChanged(['todos', 'reminders'])
    return todo
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_TODO, async (_, id: string, workspaceId?: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('Todo id 必填')
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { deleteTeamTodo } = await import('./lib/team-planning-service')
      await deleteTeamTodo(workspaceId, id)
      return true
    }
    const deleted = deleteTodo(id)
    if (deleted) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_CALENDAR_EVENTS, async (_, input?: unknown): Promise<CalendarEvent[]> => {
    const workspaceId = typeof input === 'object' && input !== null && 'workspaceId' in input ? (input as { workspaceId?: unknown }).workspaceId : undefined
    if (typeof workspaceId === 'string' && workspaceId) {
      const { listTeamCalendarEvents } = await import('./lib/team-planning-service')
      return listTeamCalendarEvents(workspaceId)
    }
    return listCalendarEvents(parseCalendarEventListQuery(input))
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_CALENDAR_EVENT, async (_, input: CreateCalendarEventInput): Promise<CalendarEvent> => {
    if (!input || !isPlanningTitle(input.title) || !isPlanningTimestamp(input.startAt)) throw new Error('日程标题和 startAt 必填')
    if (input.endAt !== undefined && (!isPlanningTimestamp(input.endAt) || input.endAt < input.startAt)) throw new Error('日程 endAt 非法')
    if (input.workspaceId && getAgentWorkspace(input.workspaceId)?.type === 'team') {
      const { createTeamCalendarEvent } = await import('./lib/team-planning-service')
      return createTeamCalendarEvent(input.workspaceId, input)
    }
    const event = createCalendarEvent(input)
    broadcastPlanningChanged(['calendar_events', 'reminders'])
    return event
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_CALENDAR_EVENT, async (_, input: UpdateCalendarEventInput): Promise<CalendarEvent | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id) throw new Error('日程 id 必填')
    if (input.title !== undefined && !isPlanningTitle(input.title)) throw new Error('日程标题不能为空且不能超过 500 字')
    if (input.startAt !== undefined && !isPlanningTimestamp(input.startAt)) throw new Error('日程 startAt 非法')
    if (input.endAt !== undefined && input.endAt !== null && !isPlanningTimestamp(input.endAt)) throw new Error('日程 endAt 非法')
    if (input.expectedUpdatedAt !== undefined && !isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('日程 expectedUpdatedAt 非法')
    if (input.workspaceId && getAgentWorkspace(input.workspaceId)?.type === 'team') {
      const { updateTeamCalendarEvent } = await import('./lib/team-planning-service')
      return updateTeamCalendarEvent(input.workspaceId, input)
    }
    const event = updateCalendarEvent(input)
    if (event) broadcastPlanningChanged(['calendar_events', 'reminders'])
    return event
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_CALENDAR_EVENT, async (_, id: string, workspaceId?: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('日程 id 必填')
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { deleteTeamCalendarEvent } = await import('./lib/team-planning-service')
      await deleteTeamCalendarEvent(workspaceId, id)
      return true
    }
    const deleted = deleteCalendarEvent(id)
    if (deleted) broadcastPlanningChanged(['calendar_events', 'reminders'])
    return deleted
  })

  const isPlanningShortName = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100
  const isPlanningGroupScope = (value: unknown): value is PlanningGroupScope => value === 'todo' || value === 'calendar'
  const isOptionalColor = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string'

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_GROUPS, async (_, scope: PlanningGroupScope, workspaceId?: string): Promise<PlanningGroup[]> => {
    if (!isPlanningGroupScope(scope)) throw new Error('分组范围非法')
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { listTeamPlanningGroups } = await import('./lib/team-planning-service')
      return listTeamPlanningGroups(workspaceId, scope)
    }
    return listPlanningGroups(scope)
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_GROUP, async (_, input: CreatePlanningGroupInput): Promise<PlanningGroup> => {
    if (!input || !isPlanningGroupScope(input.scope) || !isPlanningShortName(input.name) || !isOptionalColor(input.color)) throw new Error('分组参数非法')
    const workspaceId = (input as CreatePlanningGroupInput & { workspaceId?: string }).workspaceId
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { createTeamPlanningGroup } = await import('./lib/team-planning-service')
      return createTeamPlanningGroup(workspaceId, input)
    }
    const group = createPlanningGroup(input); broadcastPlanningChanged(input.scope === 'todo' ? ['todo_groups', 'todos', 'reminders'] : ['calendar_groups', 'calendar_events', 'reminders']); return group
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_GROUP, async (_, input: UpdatePlanningGroupInput): Promise<PlanningGroup | undefined> => {
    if (!input || !isPlanningGroupScope(input.scope) || typeof input.id !== 'string' || (input.name !== undefined && !isPlanningShortName(input.name)) || !isOptionalColor(input.color)) throw new Error('分组参数非法')
    const workspaceId = (input as UpdatePlanningGroupInput & { workspaceId?: string }).workspaceId
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { updateTeamPlanningGroup } = await import('./lib/team-planning-service')
      return updateTeamPlanningGroup(workspaceId, input)
    }
    const group = updatePlanningGroup(input); if (group) broadcastPlanningChanged(input.scope === 'todo' ? ['todo_groups', 'todos', 'reminders'] : ['calendar_groups', 'calendar_events', 'reminders']); return group
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_GROUP, async (_, scope: PlanningGroupScope, id: string, workspaceId?: string): Promise<boolean> => {
    if (!isPlanningGroupScope(scope) || !id || typeof id !== 'string') throw new Error('分组参数非法')
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { deleteTeamPlanningGroup } = await import('./lib/team-planning-service')
      await deleteTeamPlanningGroup(workspaceId, scope, id)
      return true
    }
    const deleted = deletePlanningGroup(scope, id); if (deleted) broadcastPlanningChanged(scope === 'todo' ? ['todo_groups', 'todos', 'reminders'] : ['calendar_groups', 'calendar_events', 'reminders']); return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_TAGS, async (_, workspaceId?: string): Promise<PlanningTag[]> => {
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { listTeamPlanningTags } = await import('./lib/team-planning-service')
      return listTeamPlanningTags(workspaceId)
    }
    return listPlanningTags()
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_TAG, async (_, input: import('@profer/shared').CreatePlanningTagInput): Promise<PlanningTag> => {
    if (!input || !isPlanningShortName(input.name) || !isOptionalColor(input.color)) throw new Error('标签参数非法')
    const workspaceId = (input as import('@profer/shared').CreatePlanningTagInput & { workspaceId?: string }).workspaceId
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { createTeamPlanningTag } = await import('./lib/team-planning-service')
      return createTeamPlanningTag(workspaceId, input)
    }
    const tag = createPlanningTag(input)
    broadcastPlanningChanged(['tags', 'todos', 'calendar_events', 'reminders'])
    return tag
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_TAG, async (_, input: import('@profer/shared').UpdatePlanningTagInput): Promise<PlanningTag | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id || (input.name !== undefined && !isPlanningShortName(input.name)) || !isOptionalColor(input.color)) throw new Error('标签参数非法')
    const workspaceId = (input as import('@profer/shared').UpdatePlanningTagInput & { workspaceId?: string }).workspaceId
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { updateTeamPlanningTag } = await import('./lib/team-planning-service')
      return updateTeamPlanningTag(workspaceId, input)
    }
    const tag = updatePlanningTag(input)
    if (tag) broadcastPlanningChanged(['tags', 'todos', 'calendar_events', 'reminders'])
    return tag
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_TAG, async (_, id: string, workspaceId?: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('标签 id 必填')
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { deleteTeamPlanningTag } = await import('./lib/team-planning-service')
      await deleteTeamPlanningTag(workspaceId, id)
      return true
    }
    const deleted = deletePlanningTag(id)
    if (deleted) broadcastPlanningChanged(['tags', 'todos', 'calendar_events', 'reminders'])
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_ACTIVE_REMINDERS, async (_, workspaceId?: string): Promise<ActivePlanningReminder[]> => {
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { listTeamActiveReminders } = await import('./lib/team-planning-service')
      return listTeamActiveReminders(workspaceId)
    }
    return listActivePlanningReminders()
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.ACKNOWLEDGE_REMINDER, async (_, id: string, workspaceId?: string): Promise<PlanningReminder | undefined> => {
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { acknowledgeTeamReminder } = await import('./lib/team-planning-service')
      await acknowledgeTeamReminder(workspaceId, id)
      return undefined
    }
    if (!id || typeof id !== 'string') throw new Error('提醒 id 必填')
    const reminder = acknowledgePlanningReminder(id); if (reminder) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders']); return reminder
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.SNOOZE_REMINDER, async (_, input: SnoozePlanningReminderInput, workspaceId?: string): Promise<PlanningReminder | undefined> => {
    if (workspaceId && getAgentWorkspace(workspaceId)?.type === 'team') {
      const { snoozeTeamReminder } = await import('./lib/team-planning-service')
      await snoozeTeamReminder(workspaceId, input)
      return undefined
    }
    if (!input || typeof input.id !== 'string' || !Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 10080) throw new Error('推迟分钟数非法')
    const reminder = snoozePlanningReminder(input.id, input.minutes); if (reminder) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders']); return reminder
  })

  // ===== 定时任务（Automation）=====

  // 渲染进程可能被注入内容污染（XSS via markdown / MCP tool output），主进程必须自己校验入参，
  // 否则 NaN / -Infinity / 越界值会污染 ~/.proma/automations.json，无法回滚。
  const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isNonBlankString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
  const isFiniteInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
  const validScheduleType = (v: unknown): v is 'interval' | 'daily' | 'weekly' | 'monthly' =>
    v === 'interval' || v === 'daily' || v === 'weekly' || v === 'monthly'
  const validPermissionMode = (v: unknown): v is 'auto' | 'bypassPermissions' =>
    v === 'auto' || v === 'bypassPermissions'
  const validAutomationNotificationTrigger = (v: unknown): v is 'always' | 'success' | 'error' =>
    v === 'always' || v === 'success' || v === 'error'
  const validTimeOfDay = (v: unknown): boolean => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)

  const validateAutomationNotificationTargets = (targets: unknown): void => {
    if (targets === undefined) return
    if (!Array.isArray(targets)) throw new Error('notificationTargets 必须是数组')
    if (targets.length > 5) throw new Error('notificationTargets 最多 5 个')

    for (const target of targets) {
      if (!target || typeof target !== 'object') throw new Error('notificationTargets 包含非法目标')
      const t = target as Record<string, unknown>
      if (t.type !== 'feishu') throw new Error(`不支持的通知目标: ${String(t.type)}`)
      if (typeof t.enabled !== 'boolean') throw new Error('notificationTargets.enabled 必须是 boolean')
      if (!validAutomationNotificationTrigger(t.trigger)) {
        throw new Error(`非法的 notificationTargets.trigger: ${String(t.trigger)}`)
      }
      if (!isNonEmptyString(t.botId)) throw new Error('notificationTargets.botId 必填')
      if (!isNonEmptyString(t.chatId)) throw new Error('notificationTargets.chatId 必填')
    }
  }

  /** 校验 timeOfDay：单个或数组，每个必须是 HH:MM。空数组合法（非 daily/weekly/monthly 不依赖该字段）。 */
  const validTimeOfDayArr = (v: unknown): boolean => {
    if (typeof v === 'string') return validTimeOfDay(v)
    if (Array.isArray(v)) return v.length <= 10 && v.every((t) => typeof t === 'string' && validTimeOfDay(t))
    return false
  }
  /** 校验 dayOfWeek：单个或数组，每个必须是 0-6。空数组合法（非 weekly 不依赖该字段）。 */
  const validDayOfWeekArr = (v: unknown): boolean => {
    if (typeof v === 'number') return isFiniteInt(v) && v >= 0 && v <= 6
    if (Array.isArray(v)) return v.length <= 7 && v.every((d) => typeof d === 'number' && isFiniteInt(d) && d >= 0 && d <= 6)
    return false
  }
  /** 校验 dayOfMonth：单个或数组，每个必须是 1-31。空数组合法（非 monthly 不依赖该字段）。 */
  const validDayOfMonthArr = (v: unknown): boolean => {
    if (typeof v === 'number') return isFiniteInt(v) && v >= 1 && v <= 31
    if (Array.isArray(v)) return v.length <= 31 && v.every((d) => typeof d === 'number' && isFiniteInt(d) && d >= 1 && d <= 31)
    return false
  }

  const validateAutomationFields = (i: Partial<CreateAutomationInput | UpdateAutomationInput>): void => {
    if (i.presetId !== undefined && (typeof i.presetId !== 'string' || i.presetId.length > 200)) {
      throw new Error(`非法的 presetId: ${String(i.presetId)}（应为预设 ID 字符串；空字符串恢复默认）`)
    }
    if (i.scheduleType !== undefined && !validScheduleType(i.scheduleType)) {
      throw new Error(`非法的 scheduleType: ${String(i.scheduleType)}`)
    }
    if (i.intervalMinutes !== undefined && (!isFiniteInt(i.intervalMinutes) || i.intervalMinutes < 1)) {
      throw new Error(`非法的 intervalMinutes: ${String(i.intervalMinutes)}`)
    }
    if (i.timeOfDay !== undefined && !validTimeOfDayArr(i.timeOfDay)) {
      throw new Error(`非法的 timeOfDay: ${JSON.stringify(i.timeOfDay)}（需为 HH:MM 或最多 10 个的数组）`)
    }
    if (i.dayOfWeek !== undefined && !validDayOfWeekArr(i.dayOfWeek)) {
      throw new Error(`非法的 dayOfWeek: ${JSON.stringify(i.dayOfWeek)}（需为 0-6 整数或数组）`)
    }
    if (i.dayOfMonth !== undefined && !validDayOfMonthArr(i.dayOfMonth)) {
      throw new Error(`非法的 dayOfMonth: ${JSON.stringify(i.dayOfMonth)}（需为 1-31 整数或数组）`)
    }
    if (i.permissionMode !== undefined && !validPermissionMode(i.permissionMode)) {
      throw new Error(`非法的 permissionMode: ${String(i.permissionMode)}`)
    }
    if (i.sessionMode !== undefined && i.sessionMode !== 'daily' && i.sessionMode !== 'reuse') {
      throw new Error(`非法的 sessionMode: ${String(i.sessionMode)}`)
    }
    validateAutomationNotificationTargets(i.notificationTargets)
  }

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.LIST,
    async (): Promise<Automation[]> => listAutomations()
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.CREATE,
    async (_, input: CreateAutomationInput): Promise<Automation> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.name)) throw new Error('name 必填')
      if (!isNonEmptyString(input.prompt)) throw new Error('prompt 必填')
      // channelId / workspaceId 允许为空（草稿态），但此时任务不能被启用
      validateAutomationFields(input)
      if (input.scheduleType === 'interval' && !isFiniteInt(input.intervalMinutes)) throw new Error('scheduleType=interval 时 intervalMinutes 必填')
      if ((input.scheduleType === 'daily' || input.scheduleType === 'weekly' || input.scheduleType === 'monthly') && !validTimeOfDayArr(input.timeOfDay)) throw new Error('scheduleType=daily/weekly/monthly 时 timeOfDay 必填（支持数组）')
      if (input.scheduleType === 'weekly' && !validDayOfWeekArr(input.dayOfWeek)) throw new Error('scheduleType=weekly 时 dayOfWeek 必填（支持数组）')
      if (input.scheduleType === 'monthly' && !validDayOfMonthArr(input.dayOfMonth)) throw new Error('scheduleType=monthly 时 dayOfMonth 必填（支持数组）')
      const a = createAutomation(input)
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.UPDATE,
    async (_, input: UpdateAutomationInput): Promise<Automation | undefined> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.id)) throw new Error('id 必填')
      if (input.name !== undefined && !isNonBlankString(input.name)) throw new Error('name 不能为空')
      if (input.prompt !== undefined && !isNonBlankString(input.prompt)) throw new Error('prompt 不能为空')
      validateAutomationFields(input)
      const a = updateAutomation(input)
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<boolean> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      const ok = deleteAutomation(id)
      broadcastAutomationsChanged()
      return ok
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.TOGGLE,
    async (_, id: string, active: boolean): Promise<Automation | undefined> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      if (typeof active !== 'boolean') throw new Error('active 必须是 boolean')
      const a = updateAutomation({ id, active })
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.RUN_NOW,
    async (_, id: string): Promise<void> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      await runAutomationNow(id)
    }
  )

  // ===== 身份认证 =====

  const { getOrCreateDeviceIdentity, getUserIdentity } = require('./lib/identity-service')
  const { login, register, logout, getAuthStatus, getServerInfoList, getTeamAuthWithRefresh, listRemoteDevices, revokeRemoteDevice } = require('./lib/auth-service')

  ipcMain.handle(
    AUTH_IPC_CHANNELS.GET_DEVICE_IDENTITY,
    async () => getOrCreateDeviceIdentity()
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.GET_USER_IDENTITY,
    async () => getUserIdentity()
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.UPDATE_PROFILE,
    async (_, updates: Record<string, unknown>) => {
      // Phase 3: 更新远程档案
      return getUserIdentity()
    }
  )

  /** 登录/注册成功后同步团队工作区到本地索引，并通知渲染进程刷新 */
  async function syncTeamWorkspacesToSidebar() {
    try {
      const { listTeamWorkspaces } = require('./lib/team-manager')
      const { syncTeamWorkspacesToIndex } = require('./lib/agent-workspace-manager')
      const teamWs = await listTeamWorkspaces()
      // 始终同步到本地索引（即使为空也更新，避免残留已删除的工作区）
      syncTeamWorkspacesToIndex(teamWs)
      // 通知所有窗口刷新工作区列表
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('team:workspaces-synced')
      }
    } catch (err) {
      console.error('[IPC] 同步团队工作区失败:', err)
    }
  }

  ipcMain.handle(
    AUTH_IPC_CHANNELS.LOGIN,
    async (_, credentials: { email: string; password: string; revokeSlotId?: string }) => {
      const result = await login(credentials.email, credentials.password, credentials.revokeSlotId)
      console.log('[AUTH IPC] login result:', JSON.stringify({ success: result.success, teamAccountId: result.teamAccountId, teamEmail: result.teamEmail }))
      if (result.success) {
        const { startSyncEngine } = require('./lib/sync-manager')
        startSyncEngine()
        // 同步团队工作区到侧边栏（await 确保渲染进程拿到结果前索引已更新）
        await syncTeamWorkspacesToSidebar()
      }
      return result
    }
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.LOGOUT,
    async () => { return await logout() }
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.GET_SERVER_INFO,
    async () => getServerInfoList()
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.REGISTER,
    async (_, credentials: { email: string; password: string; displayName: string; inviteCode?: string; otpToken?: string; emailOtp?: string }) => {
      const result = await register(credentials.email, credentials.password, credentials.displayName, credentials.inviteCode, undefined, undefined, credentials.otpToken, credentials.emailOtp)
      if (result.success) {
        const { startSyncEngine } = require('./lib/sync-manager')
        startSyncEngine()
        // 同步团队工作区到侧边栏（await 确保渲染进程拿到结果前索引已更新）
        await syncTeamWorkspacesToSidebar()
      }
      return result
    }
  )

  ipcMain.handle(AUTH_IPC_CHANNELS.GET_REGISTRATION_OPTIONS, async () => {
    const { getRegistrationOptions } = require('./lib/auth-service')
    return await getRegistrationOptions()
  })

  ipcMain.handle(AUTH_IPC_CHANNELS.SEND_REGISTRATION_OTP, async (_, email: string) => {
    const { sendRegistrationOtp } = require('./lib/auth-service')
    return await sendRegistrationOtp(email)
  })

  ipcMain.handle(AUTH_IPC_CHANNELS.VERIFY_REGISTRATION_OTP, async (_, email: string, otpToken: string, code: string) => {
    const { verifyRegistrationOtp } = require('./lib/auth-service')
    return await verifyRegistrationOtp(email, otpToken, code)
  })

  ipcMain.handle(
    AUTH_IPC_CHANNELS.GET_AUTH_STATUS,
    async () => getAuthStatus()
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.GET_TEAM_AUTH,
    async () => getTeamAuthWithRefresh()
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.LIST_DEVICES,
    async () => listRemoteDevices()
  )

  ipcMain.handle(
    AUTH_IPC_CHANNELS.REVOKE_DEVICE,
    async (_, slotId: string) => revokeRemoteDevice(slotId)
  )

  // ===== 同步 =====

  const {
    getSyncStatus,
    triggerSync,
    getPendingChanges,
    discardPendingChanges,
  } = require('./lib/sync-manager')

  ipcMain.handle(
    SYNC_IPC_CHANNELS.GET_STATUS,
    async () => getSyncStatus()
  )

  ipcMain.handle(
    SYNC_IPC_CHANNELS.TRIGGER_SYNC,
    async (_, workspaceId: string) => { await triggerSync(workspaceId) }
  )

  ipcMain.handle(
    SYNC_IPC_CHANNELS.GET_PENDING_CHANGES,
    async (_, workspaceId: string) => getPendingChanges(workspaceId)
  )

  ipcMain.handle(
    SYNC_IPC_CHANNELS.DISCARD_PENDING_CHANGES,
    async (_, workspaceId: string) => { discardPendingChanges(workspaceId) }
  )

  // ===== 团队管理 =====

  const {
    listTeamWorkspaces,
    createTeamWorkspace,
    deleteTeamWorkspace,
    getMembers,
    createInvitation,
    verifyInvitation,
    acceptInvitation,
    declineInvitation,
    listInvitations,
    cancelInvitation,
    getWorkspaceStats,
    updateMemberRole,
    removeMember,
    leaveWorkspace,
    transferOwnership,
    restoreTeamWorkspace,
  } = require('./lib/team-manager')

  ipcMain.handle(
    TEAM_IPC_CHANNELS.LIST_WORKSPACES,
    async () => listTeamWorkspaces()
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.CREATE_WORKSPACE,
    async (_, name: string) => {
      const result = await createTeamWorkspace(name)
      syncTeamWorkspacesToSidebar()
      return result
    }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.DELETE_WORKSPACE,
    async (_, workspaceId: string) => { await deleteTeamWorkspace(workspaceId) }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.GET_MEMBERS,
    async (_, workspaceId: string) => getMembers(workspaceId)
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.CREATE_INVITATION,
    async (_, input: { workspaceId: string; email: string; role: string }) =>
      createInvitation(input)
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.LIST_INVITATIONS,
    async (_, workspaceId: string) => listInvitations(workspaceId)
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.CANCEL_INVITATION,
    async (_, input: { workspaceId: string; invitationId: string }) =>
      cancelInvitation(input.workspaceId, input.invitationId)
  )

  // ===== 公告 =====

  const {
    getAnnouncements,
    createAnnouncement,
    deleteAnnouncement,
  } = require('./lib/team-manager')

  ipcMain.handle(
    'team:get-announcements',
    async (_, workspaceId: string) => getAnnouncements(workspaceId)
  )

  ipcMain.handle(
    'team:create-announcement',
    async (_, workspaceId: string, title: string, content: string, isPinned: boolean) =>
      createAnnouncement(workspaceId, title, content, isPinned)
  )

  ipcMain.handle(
    'team:delete-announcement',
    async (_, workspaceId: string, announcementId: string) =>
      deleteAnnouncement(workspaceId, announcementId)
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.GET_STATS,
    async (_, workspaceId: string) => getWorkspaceStats(workspaceId)
  )

  ipcMain.handle(
    'team:get-audit-logs',
    async (_, workspaceId: string, limit?: number, before?: number) => {
      const auth = getTeamAuth()
      if (!auth) throw new Error('未登录')
      const params = new URLSearchParams()
      if (limit) params.set('limit', String(limit))
      const url = `${auth.baseUrl}/v1/workspaces/${workspaceId}/audit-logs?${params.toString()}`
      const res = await (require('undici').fetch as unknown as typeof fetch)(url, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (!res.ok) return []
      const data = await res.json()
      // 如果传了 before，客户端侧过滤（服务端返回最新的 N 条）
      if (before && Array.isArray(data)) {
        return data.filter((e: { created_at: number }) => e.created_at < before)
      }
      return Array.isArray(data) ? data : []
    }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.VERIFY_INVITATION,
    async (_, token: string) => verifyInvitation(token)
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.ACCEPT_INVITATION,
    async (_, token: string) => {
      const result = await acceptInvitation(token)
      // 接受邀请后同步工作区到侧边栏
      syncTeamWorkspacesToSidebar()
      return result
    }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.DECLINE_INVITATION,
    async (_, token: string) => { await declineInvitation(token) }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.UPDATE_MEMBER_ROLE,
    async (_, input: { workspaceId: string; userId: string; role: string }) =>
      { await updateMemberRole(input.workspaceId, input.userId, input.role) }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.REMOVE_MEMBER,
    async (_, input: { workspaceId: string; userId: string }) =>
      { await removeMember(input.workspaceId, input.userId) }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.LEAVE_WORKSPACE,
    async (_, workspaceId: string) => { await leaveWorkspace(workspaceId) }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.TRANSFER_OWNERSHIP,
    async (_, input: { workspaceId: string; targetUserId: string }) =>
      { await transferOwnership(input.workspaceId, input.targetUserId) }
  )

  ipcMain.handle(
    TEAM_IPC_CHANNELS.RESTORE_WORKSPACE,
    async (_, workspaceId: string) => {
      await restoreTeamWorkspace(workspaceId)
      // 恢复后更新侧栏工作区列表
      syncTeamWorkspacesToSidebar()
    }
  )

  // ===== SSE 实时事件 =====

  const { sseClient } = require('./lib/sse-client')
  const { getTeamAuth } = require('./lib/auth-service')
  const { teamNotificationService } = require('./lib/team-notification-service')

  // 绑定通知服务到 SSE 事件
  sseClient.onEvent((workspaceId: string, event: import('./lib/sse-client').SSEEvent) => {
    teamNotificationService.handleSSEEvent(event)
  })

  // 设置当前用户 ID
  const authStatus = getTeamAuth()
  if (authStatus) {
    if (typeof authStatus === 'object' && 'teamAccountId' in authStatus) {
      teamNotificationService.setCurrentUserId((authStatus as { teamAccountId: string }).teamAccountId)
    }
  }

  ipcMain.handle(
    'sse:connect',
    async (_, workspaceId: string) => {
      const auth = getTeamAuth()
      if (!auth) throw new Error('未登录')
      sseClient.init()
      if (auth.teamAccountId) {
        teamNotificationService.setCurrentUserId(auth.teamAccountId)
      }
      await sseClient.connect(workspaceId, auth.baseUrl, auth.token)
    }
  )

  ipcMain.handle(
    'sse:disconnect',
    async (_, workspaceId: string) => {
      await sseClient.disconnect(workspaceId)
    }
  )

  ipcMain.handle(
    'sse:disconnect-all',
    async () => {
      sseClient.disconnectAll()
    }
  )

  ipcMain.handle(
    'team:get-notification-settings',
    async () => teamNotificationService.getSettings()
  )

  ipcMain.handle(
    'team:update-notification-settings',
    async (_, settings: Partial<import('./lib/team-notification-service').NotificationSettings>) => {
      teamNotificationService.updateSettings(settings)
    }
  )

  // ===== 技能市场（复用团队文件系统）=====

  ipcMain.handle(
    SKILL_MARKETPLACE_IPC_CHANNELS.PUBLISH,
    async (_, input: { workspaceId: string; workspaceSlug: string; skillSlug: string }) => {
      const { readWorkspaceSkillContent } = require('./lib/agent-workspace-manager')
      const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs')
      const { join } = require('node:path')
      const { getAgentWorkspacePath } = require('./lib/config-paths')

      const skillDir = join(getAgentWorkspacePath(input.workspaceSlug), 'skills', input.skillSlug)
      if (!existsSync(skillDir)) throw new Error(`技能目录不存在: ${skillDir}`)

      // 通过专用接口读取 SKILL.md
      const skillMdContent = readWorkspaceSkillContent(input.workspaceSlug, input.skillSlug)
      if (!skillMdContent) throw new Error('SKILL.md 不存在或为空')

      // 上传 SKILL.md
      const uploadResult = await uploadFile(
        input.workspaceId, input.workspaceSlug,
        `_skills/${input.skillSlug}/SKILL.md`,
        Buffer.from(skillMdContent, 'utf-8'),
      )
      if (!uploadResult.success) throw new Error(`上传失败: ${uploadResult.error}`)

      // 上传技能目录下其他文件（如图标、脚本等）
      if (existsSync(skillDir)) {
        const uploadDir = async (dir: string, base: string) => {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            const rel = join(base, entry).replace(/\\/g, '/')
            if (entry === 'SKILL.md') continue
            if (statSync(full).isDirectory()) { await uploadDir(full, rel); continue }
            await uploadFile(input.workspaceId, input.workspaceSlug,
              `_skills/${input.skillSlug}/${rel}`, readFileSync(full))
          }
        }
        await uploadDir(skillDir, '')
      }

      // 推送 sync envelope 通知团队
      const { enqueueChange } = require('./lib/sync-manager')
      enqueueChange(input.workspaceId, 'skill', input.skillSlug, 'publish',
        { workspaceId: input.workspaceId, skillSlug: input.skillSlug })

      return { success: true, skillSlug: input.skillSlug }
    }
  )

  ipcMain.handle(
    SKILL_MARKETPLACE_IPC_CHANNELS.UNPUBLISH,
    async (_, input: { workspaceId: string; workspaceSlug: string; skillSlug: string }) => {
      const manifest = await fetchFileManifest(input.workspaceId, input.workspaceSlug)
      if (!manifest) throw new Error('无法获取文件清单')

      const prefix = `_skills/${input.skillSlug}/`
      const skillFiles = manifest.filter((e: { path: string }) => e.path.startsWith(prefix))
      for (const f of skillFiles) {
        await deleteRemoteFile(input.workspaceId, input.workspaceSlug, f.path)
      }

      // 同步通知
      const { enqueueChange } = require('./lib/sync-manager')
      enqueueChange(input.workspaceId, 'skill', input.skillSlug, 'unpublish',
        { workspaceId: input.workspaceId, skillSlug: input.skillSlug })

      return { success: true, skillSlug: input.skillSlug }
    }
  )

  ipcMain.handle(
    SKILL_MARKETPLACE_IPC_CHANNELS.LIST_TEAM_SKILLS,
    async (_, workspaceId: string) => {
      const manifest = await fetchFileManifest(workspaceId)
      if (!manifest) return []

      // 解析 frontmatter 的简易实现
      const parseFrontmatter = (md: string) => {
        const m = md.match(/^---\n([\s\S]*?)\n---/)
        if (!m) return {}
        const fm: Record<string, string> = {}
        for (const line of (m[1] ?? '').split('\n')) {
          const kv = line.match(/^(\w+):\s*(.*)/)
          if (kv && kv[1]) fm[kv[1]] = (kv[2] ?? '').trim()
        }
        return fm
      }

      // 按 skillSlug 分组
      const skillMap = new Map<string, { name: string; description: string; version: string; files: string[]; uploadedBy: string; modifiedAt: number }>()
      for (const entry of manifest) {
        if (!entry.path.startsWith('_skills/')) continue
        const parts = entry.path.slice(8).split('/') // remove '_skills/' prefix
        const slug = parts[0]
        if (!slug) continue
        if (!skillMap.has(slug)) {
          skillMap.set(slug, { name: slug, description: '', version: '0.0.0', files: [], uploadedBy: '', modifiedAt: 0 })
        }
        const skill = skillMap.get(slug)!
        skill.files.push(entry.path)
        if (entry.uploadedBy) skill.uploadedBy = entry.uploadedBy
        if (entry.modifiedAt > skill.modifiedAt) skill.modifiedAt = entry.modifiedAt
      }

      // 为每个技能下载并解析 SKILL.md 获取元数据
      const result = []
      for (const [slug, skill] of skillMap) {
        const skillMdFile = manifest.find((e: { path: string }) => e.path === `_skills/${slug}/SKILL.md`)
        if (!skillMdFile) continue

        try {
          const { downloadFile } = require('./lib/team-file-service')
          // 临时下载到内存（通过 downloadFile 获取本地路径再读取）
          const localPath = await (async () => {
            const { default: tmp } = await import('node:os')
            const { writeFileSync, unlinkSync } = require('node:fs')
            const { join } = require('node:path')
            const { fetch: uFetch } = require('undici')
            const { getTeamAuth } = require('./lib/auth-service')
            const auth = getTeamAuth()
            if (!auth) return null
            const res = await (uFetch as unknown as typeof fetch)(`${auth.baseUrl}/v1/workspaces/${workspaceId}/files/download/${encodeURIComponent(`_skills/${slug}/SKILL.md`)}`, {
              headers: { Authorization: `Bearer ${auth.token}` },
            })
            if (!res.ok) return null
            const buf = Buffer.from(await res.arrayBuffer())
            const tmpPath = join(tmp.tmpdir(), `profer-skill-${slug}.md`)
            writeFileSync(tmpPath, buf)
            return tmpPath
          })()
          if (localPath) {
            const { readFileSync } = require('node:fs')
            const content = readFileSync(localPath, 'utf-8')
            const fm = parseFrontmatter(content)
            skill.name = fm.name || slug
            skill.description = fm.description || ''
            skill.version = fm.version || '0.0.0'
          }
        } catch { /* 解析失败用默认值 */ }

        result.push({
          slug,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          publishedBy: skill.uploadedBy,
          publishedAt: skill.modifiedAt,
        })
      }

      return result
    }
  )

  ipcMain.handle(
    SKILL_MARKETPLACE_IPC_CHANNELS.INSTALL_TEAM_SKILL,
    async (_, input: { workspaceId: string; skillSlug: string; targetWorkspaceSlug: string }) => {
      const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
      const { join } = require('node:path')
      const { getAgentWorkspacePath } = require('./lib/config-paths')

      const manifest = await fetchFileManifest(input.workspaceId)
      if (!manifest) throw new Error('无法获取文件清单')

      const prefix = `_skills/${input.skillSlug}/`
      const skillFiles = manifest.filter((e: { path: string }) => e.path.startsWith(prefix))
      if (skillFiles.length === 0) throw new Error('技能不存在于市场中')

      const targetDir = join(getAgentWorkspacePath(input.targetWorkspaceSlug), 'skills', input.skillSlug)
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })

      for (const f of skillFiles) {
        const relPath = f.path.slice(prefix.length) // 去掉 _skills/{slug}/ 前缀
        const localPath = await downloadFile(input.workspaceId, input.targetWorkspaceSlug, f.path, f.uploadedBy, f.sha256)
        if (!localPath) throw new Error(`下载失败: ${f.path}`)
        const { readFileSync } = require('node:fs')
        const destPath = join(targetDir, relPath || 'SKILL.md')
        const destDir = join(destPath, '..')
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
        writeFileSync(destPath, readFileSync(localPath))
      }

      // 触发重扫描
      const { scanSkillsInDir } = require('./lib/agent-workspace-manager')
      try { scanSkillsInDir(targetDir, input.targetWorkspaceSlug) } catch { /* 重扫描静默 */ }

      return { success: true, skillSlug: input.skillSlug }
    }
  )

  ipcMain.handle(
    SKILL_MARKETPLACE_IPC_CHANNELS.CHECK_FOR_UPDATES,
    async (_, workspaceSlug: string) => {
      const { getWorkspaceSkills } = require('./lib/agent-workspace-manager')
      const localSkills = getWorkspaceSkills(workspaceSlug) || []

      // 只检查有 sourceWorkspaceId 的技能（从市场安装的）
      const updates = []
      for (const skill of localSkills) {
        if (!skill.sourceWorkspaceId) continue
        try {
          const manifest = await fetchFileManifest(skill.sourceWorkspaceId)
          if (!manifest) continue
          const skillMdFile = manifest.find((e: { path: string }) => e.path === `_skills/${skill.slug}/SKILL.md`)
          if (!skillMdFile) continue

          // 简易版本解析（通过 download + parse）
          const { getTeamAuth } = require('./lib/auth-service')
          const auth = getTeamAuth()
          if (!auth) continue
          const { fetch: uFetch } = require('undici')
          const res = await (uFetch as unknown as typeof fetch)(`${auth.baseUrl}/v1/workspaces/${skill.sourceWorkspaceId}/files/download/${encodeURIComponent(`_skills/${skill.slug}/SKILL.md`)}`, {
            headers: { Authorization: `Bearer ${auth.token}` },
          })
          if (!res.ok) continue
          const content = await res.text()
          const m = content.match(/^---\n([\s\S]*?)\n---/)
          if (!m) continue
          const fm: Record<string, string> = {}
          for (const line of (m[1] ?? '').split('\n')) {
            const kv = line.match(/^(\w+):\s*(.*)/)
            if (kv && kv[1]) fm[kv[1]] = (kv[2] ?? '').trim()
          }
          const remoteVersion = fm.version || '0.0.0'

          // semver 简易比较
          const compareVersions = (a: string, b: string) => {
            const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
            for (let i = 0; i < 3; i++) {
              if ((pa[i] || 0) > (pb[i] || 0)) return 1
              if ((pa[i] || 0) < (pb[i] || 0)) return -1
            }
            return 0
          }
          if (compareVersions(remoteVersion, skill.version || '0.0.0') > 0) {
            updates.push({ ...skill, latestVersion: remoteVersion })
          }
        } catch { /* 网络错误跳过 */ }
      }

      return updates
    }
  )

  // ===== 团队文件操作 =====

  const {
    uploadFile,
    downloadFile,
    deleteRemoteFile,
    fetchFileManifest,
    createRemoteDirectory,
    moveRemoteFile,
    renameRemoteFile,
    searchFiles,
    getFileMetadata,
    patchFileMetadata,
    getFileTags,
    getFileStatuses,
    setFilePreference,
    getFileActivities,
    listTrashEntries,
    restoreTrashEntry,
    purgeTrashEntry,
  } = require('./lib/team-file-service')

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.CREATE_DIRECTORY,
    async (_, input: { workspaceId: string; dirPath: string }) =>
      createRemoteDirectory(input.workspaceId, input.dirPath)
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.UPLOAD,
    async (_, input: { workspaceId: string; workspaceSlug: string; fileName: string; fileData: Uint8Array; sourcePath?: string }) => {
      const buffer = Buffer.from(input.fileData)
      return uploadFile(input.workspaceId, input.workspaceSlug, input.fileName, buffer, input.sourcePath)
    }
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.DOWNLOAD,
    async (_, input: { workspaceId: string; workspaceSlug: string; filePath: string; uploadedBy?: string; sha256?: string }) =>
      downloadFile(input.workspaceId, input.workspaceSlug, input.filePath, input.uploadedBy, input.sha256)
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.DELETE,
    async (_, input: { workspaceId: string; workspaceSlug: string; filePath: string }) =>
      deleteRemoteFile(input.workspaceId, input.workspaceSlug, input.filePath)
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.GET_MANIFEST,
    async (_, workspaceId: string, workspaceSlug?: string) => fetchFileManifest(workspaceId, workspaceSlug)
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.MOVE,
    async (_, input: { workspaceId: string; workspaceSlug: string; fromPath: string; toDir: string }) =>
      moveRemoteFile(input.workspaceId, input.workspaceSlug, input.fromPath, input.toDir)
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.RENAME,
    async (_, input: { workspaceId: string; workspaceSlug: string; path: string; newName: string }) =>
      renameRemoteFile(input.workspaceId, input.workspaceSlug, input.path, input.newName)
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.SEARCH,
    async (_, workspaceId: string, options: { q: string; page?: number; limit?: number }) =>
      searchFiles(workspaceId, options)
  )
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_METADATA, async (_, workspaceId: string, fileId: string) => getFileMetadata(workspaceId, fileId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.PATCH_METADATA, async (_, workspaceId: string, fileId: string, body: Record<string, unknown>) => patchFileMetadata(workspaceId, fileId, body))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_TAGS, async (_, workspaceId: string) => getFileTags(workspaceId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_STATUSES, async (_, workspaceId: string) => getFileStatuses(workspaceId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.SET_PREFERENCE, async (_, workspaceId: string, fileId: string, body: Record<string, unknown>) => setFilePreference(workspaceId, fileId, body))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_ACTIVITIES, async (_, workspaceId: string, fileId: string, cursor?: string) => getFileActivities(workspaceId, fileId, cursor))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.LIST_TRASH, async (_, workspaceId: string) => listTrashEntries(workspaceId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.RESTORE_TRASH, async (_, workspaceId: string, entryId: string) => restoreTrashEntry(workspaceId, entryId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.PURGE_TRASH, async (_, workspaceId: string, entryId: string) => purgeTrashEntry(workspaceId, entryId))

  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.LIST, async (_, workspaceId: string, includeArchived?: boolean) => listTeamMemories(workspaceId, includeArchived))
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.READ, async (_, workspaceId: string, memoryId: string) => readTeamMemory(workspaceId, memoryId))
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.CREATE, async (event, workspaceId: string, input) => { assertSensitiveAgentIpcSender(event); return createTeamMemory(workspaceId, input) })
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.UPDATE, async (event, workspaceId: string, memoryId: string, input) => { assertSensitiveAgentIpcSender(event); return updateTeamMemory(workspaceId, memoryId, input) })
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.LIST_REVISIONS, async (_, workspaceId: string, memoryId: string) => listTeamMemoryRevisions(workspaceId, memoryId))
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.ARCHIVE, async (event, workspaceId: string, memoryId: string) => { assertSensitiveAgentIpcSender(event); return archiveTeamMemory(workspaceId, memoryId, true) })
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.UNARCHIVE, async (event, workspaceId: string, memoryId: string) => { assertSensitiveAgentIpcSender(event); return archiveTeamMemory(workspaceId, memoryId, false) })

  // ===== 通用个人资料库相关 =====

  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.IMPORT_ITEMS, async (_, filePaths: string[]) => {
    if (!Array.isArray(filePaths) || filePaths.length < 1 || filePaths.length > 10 || filePaths.some((path) => typeof path !== 'string' || !path.trim() || path.length > 4096)) {
      throw new Error('资料导入数量或路径无效')
    }
    const { importKnowledgeItems } = require('./lib/knowledge-item-service')
    return importKnowledgeItems(filePaths)
  })

  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.LIST_ITEMS, async () => {
    const { listKnowledgeItems } = require('./lib/knowledge-item-service')
    return listKnowledgeItems()
  })

  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.GET_LIBRARY_SNAPSHOT, async () => {
    const { getKnowledgeLibrarySnapshot } = require('./lib/knowledge-item-service')
    return getKnowledgeLibrarySnapshot()
  })

  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.GET_ITEM, async (_, itemId: string) => {
    if (typeof itemId !== 'string' || itemId.length > 160) throw new Error('资料标识无效')
    const { getKnowledgeItem } = require('./lib/knowledge-item-service')
    return getKnowledgeItem(itemId)
  })

  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.DELETE_ITEM, async (_, itemId: string) => {
    if (typeof itemId !== 'string' || itemId.length > 160) throw new Error('资料标识无效')
    const { deleteKnowledgeItem } = require('./lib/knowledge-item-service')
    return deleteKnowledgeItem(itemId)
  })

  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.SEARCH_ITEMS, async (_, query: string, itemIds?: string[], topK?: number) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('搜索关键词无效')
    if (itemIds !== undefined && (!Array.isArray(itemIds) || itemIds.length > 10 || itemIds.some((id) => typeof id !== 'string' || id.length > 160))) throw new Error('资料范围无效')
    if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > 20)) throw new Error('搜索数量无效')
    const { searchKnowledgeItems } = require('./lib/knowledge-item-service')
    return searchKnowledgeItems(query, itemIds, topK)
  })

  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, async (_, itemId: string): Promise<void> => {
    if (typeof itemId !== 'string' || itemId.length > 160) throw new Error('资料标识无效')
    const { getKnowledgeItemStoredFilePath } = require('./lib/knowledge-item-service')
    const storedPath = getKnowledgeItemStoredFilePath(itemId)
    if (!storedPath) throw new Error('该资料没有可显示的本地文件副本')
    shell.showItemInFolder(storedPath)
  })

  // ===== 桌面通知（主进程弹出原生 Notification，点击可靠） =====

  ipcMain.handle(
    DESKTOP_NOTIFICATION_IPC_CHANNELS.SHOW,
    async (event, payload: { title: string; body: string }) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (!senderWindow) return

      try {
        const notification = new Notification({
          title: payload.title,
          body: payload.body.slice(0, 200),
          silent: true,
        })

        notification.on('click', () => {
          // 聚焦窗口
          if (senderWindow.isMinimized()) senderWindow.restore()
          senderWindow.show()
          senderWindow.focus()

          // 回调渲染进程，触发导航
          if (!senderWindow.isDestroyed()) {
            senderWindow.webContents.send(DESKTOP_NOTIFICATION_IPC_CHANNELS.CLICKED)
          }
        })

        notification.show()
      } catch (err) {
        console.warn('[桌面通知] 弹出失败:', err)
      }
    },
  )
}
