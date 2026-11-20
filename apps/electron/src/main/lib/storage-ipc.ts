import { ipcMain } from 'electron'
import type { SDKMessage } from '@profer/shared'
import { STORAGE_IPC_CHANNELS } from '../../types'
import { getSettings } from './settings-service'
import { calculateStorageStats, cleanupStorage, cleanupTempFiles, type CleanupOptions } from './storage-service'
import { compactAgentSessionStorage, previewAgentSessionCompaction } from './agent-session-compaction'
import { autoArchiveAgentSessions, cleanupStaleAttachedPaths, DEFAULT_ARCHIVE_KEEP_PER_WORKSPACE, resolveMessageBlobs } from './agent-session-manager'
import { localCoreOwnsBusinessData } from './core-business-ownership'
import { autoArchiveConversations } from './conversation-manager'
import { cleanupStaleWorkspaceAttachedPaths } from './agent-workspace-manager'

export function registerStorageIpc(): void {
  const runAutoArchive = (): void => {
    try {
      const settings = getSettings()
      const days = settings.archiveAfterDays ?? 7
      const keepRecent = settings.archiveKeepRecentPerWorkspace ?? DEFAULT_ARCHIVE_KEEP_PER_WORKSPACE
      if (days > 0) {
        const archivedChats = localCoreOwnsBusinessData() ? 0 : autoArchiveConversations(days)
        const archivedSessions = localCoreOwnsBusinessData() ? 0 : autoArchiveAgentSessions(days, keepRecent)
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

  try {
    cleanupStaleAttachedPaths()
    cleanupStaleWorkspaceAttachedPaths()
  } catch (error) {
    console.error('[启动清理] 清理失效附加路径失败:', error)
  }

  ipcMain.handle(STORAGE_IPC_CHANNELS.GET_STATS, async () => calculateStorageStats())
  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP, async (_, options: CleanupOptions) => cleanupStorage(options))
  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP_TEMP, async () => cleanupTempFiles())
  ipcMain.handle(STORAGE_IPC_CHANNELS.SESSION_COMPACTION_PREVIEW, async () => previewAgentSessionCompaction())
  ipcMain.handle(STORAGE_IPC_CHANNELS.SESSION_COMPACTION_APPLY, async () => compactAgentSessionStorage())
  ipcMain.handle(STORAGE_IPC_CHANNELS.SESSION_RESOLVE_BLOBS, async (_, message: SDKMessage) => resolveMessageBlobs(message))

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
    } catch (error) {
      console.error('[存储清理] 启动时清理失败:', error)
    }
  }
  void runStartupCleanup()
}
