import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { IPC_CHANNELS } from '@profer/shared'
import type { FileAccessOptions, GetFileDiffInput, GitRepoStatus, RuntimeStatus, RevertFileInput } from '@profer/shared'
import { SETTINGS_IPC_CHANNELS } from '../../types'
import { getRuntimeStatus, getGitRepoStatus, reinitializeRuntime } from './runtime-init'
import { getUnstagedChanges, getFileDiff, getUntrackedContent, revertFile, getDiffContents, listWorktrees, getWorktreeChanges, invalidateGitDiffCache } from './git-diff-service'

export interface RuntimeGitIpcContext {
  normalizeFileAccessOptions: (value?: FileAccessOptions | string[]) => FileAccessOptions | undefined
  ensurePathAllowed: (filePath: string, options?: FileAccessOptions) => boolean
  isPathAllowed: (filePath: string, options?: FileAccessOptions) => boolean
  ensurePathAllowedWithWorktree: (filePath: string, options?: FileAccessOptions) => Promise<boolean>
  onRendererReady: (sender: WebContents) => void
}

export function registerRuntimeGitIpc(context: RuntimeGitIpcContext): void {
  ipcMain.on(SETTINGS_IPC_CHANNELS.RENDERER_READY, (event) => {
    context.onRendererReady(event.sender)
  })

  ipcMain.handle(IPC_CHANNELS.GET_RUNTIME_STATUS, async (): Promise<RuntimeStatus | null> => getRuntimeStatus())
  ipcMain.handle(IPC_CHANNELS.REINIT_RUNTIME, async (): Promise<RuntimeStatus> => reinitializeRuntime())

  ipcMain.handle(IPC_CHANNELS.GET_GIT_REPO_STATUS, async (_, dirPath: string): Promise<GitRepoStatus | null> => {
    if (!dirPath || typeof dirPath !== 'string') {
      console.warn('[IPC] git:get-repo-status 收到无效的目录路径')
      return null
    }
    return getGitRepoStatus(dirPath)
  })

  ipcMain.handle(IPC_CHANNELS.GET_UNSTAGED_CHANGES, async (_, dirPath: string, sessionPath?: string, workspaceFilesPath?: string, extraPaths?: string[], sessionId?: string) => {
    if (!dirPath || typeof dirPath !== 'string') {
      console.warn('[IPC] git:get-unstaged-changes 收到无效的目录路径')
      return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
    }
    const access = context.normalizeFileAccessOptions({ sessionId })
    if (!context.ensurePathAllowed(dirPath, access)) return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
    const allowedSessionPath = sessionPath && context.isPathAllowed(sessionPath, access) ? sessionPath : undefined
    const allowedWorkspaceFilesPath = workspaceFilesPath && context.isPathAllowed(workspaceFilesPath, access) ? workspaceFilesPath : undefined
    const allowedExtraPaths = extraPaths?.filter((path) => context.isPathAllowed(path, access))
    return getUnstagedChanges(dirPath, allowedSessionPath, allowedWorkspaceFilesPath, allowedExtraPaths)
  })

  ipcMain.handle(IPC_CHANNELS.GET_FILE_DIFF, async (_, input: GetFileDiffInput) => {
    const { dirPath, filePath, gitRoot, sessionId } = input
    if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
      console.warn('[IPC] git:get-file-diff 收到无效参数')
      return ''
    }
    const access = context.normalizeFileAccessOptions({ sessionId })
    if (!(await context.ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await context.ensurePathAllowedWithWorktree(gitRoot, access)))) return ''
    return getFileDiff(dirPath, filePath, gitRoot)
  })

  ipcMain.handle(IPC_CHANNELS.GET_UNTRACKED_CONTENT, async (_, input: GetFileDiffInput) => {
    const { dirPath, filePath, gitRoot, sessionId } = input
    if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
      console.warn('[IPC] git:get-untracked-content 收到无效参数')
      return ''
    }
    const access = context.normalizeFileAccessOptions({ sessionId })
    if (!(await context.ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await context.ensurePathAllowedWithWorktree(gitRoot, access)))) return ''
    return getUntrackedContent(dirPath, filePath, gitRoot)
  })

  ipcMain.handle(IPC_CHANNELS.REVERT_FILE, async (_, input: RevertFileInput) => {
    const { dirPath, filePath, gitRoot, sessionId } = input
    if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
      console.warn('[IPC] git:revert-file 收到无效参数')
      return
    }
    const access = context.normalizeFileAccessOptions({ sessionId })
    if (!(await context.ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await context.ensurePathAllowedWithWorktree(gitRoot, access)))) return
    await revertFile(dirPath, filePath, gitRoot)
    invalidateGitDiffCache(filePath)
  })

  ipcMain.handle(IPC_CHANNELS.INVALIDATE_GIT_DIFF_CACHE, (_, changedPath?: string) => {
    invalidateGitDiffCache(changedPath)
  })

  ipcMain.handle(IPC_CHANNELS.GET_DIFF_CONTENTS, async (_, input: GetFileDiffInput) => {
    const { dirPath, filePath, gitRoot, sessionId } = input
    if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
      console.warn('[IPC] git:get-diff-contents 收到无效参数')
      return null
    }
    const access = context.normalizeFileAccessOptions({ sessionId })
    if (!(await context.ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await context.ensurePathAllowedWithWorktree(gitRoot, access)))) return null
    return getDiffContents(dirPath, filePath, gitRoot, input.baseRef)
  })

  ipcMain.handle(IPC_CHANNELS.LIST_WORKTREES, async (_, repoPath: string, _sessionId: string) => {
    if (!repoPath || typeof repoPath !== 'string') return []
    return listWorktrees(repoPath)
  })

  ipcMain.handle(IPC_CHANNELS.GET_WORKTREE_CHANGES, async (_, worktreePath: string, baseBranch: string, sessionId: string) => {
    if (!worktreePath || typeof worktreePath !== 'string') return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
    const access = context.normalizeFileAccessOptions({ sessionId })
    if (!(await context.ensurePathAllowedWithWorktree(worktreePath, access))) return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
    return getWorktreeChanges(worktreePath, baseBranch)
  })
}
