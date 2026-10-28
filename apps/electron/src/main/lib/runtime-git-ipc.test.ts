import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IPC_CHANNELS } from '@profer/shared'
import { SETTINGS_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'runtime-git-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Runtime/Git IPC 注册（结构检查）', () => {
  test('覆盖运行时和 Git 通道', () => {
    for (const key of ['GET_RUNTIME_STATUS', 'REINIT_RUNTIME', 'GET_GIT_REPO_STATUS', 'GET_UNSTAGED_CHANGES', 'GET_FILE_DIFF', 'GET_UNTRACKED_CONTENT', 'REVERT_FILE', 'INVALIDATE_GIT_DIFF_CACHE', 'GET_DIFF_CONTENTS', 'LIST_WORKTREES', 'GET_WORKTREE_CHANGES'] as const) {
      expect(source).toContain(`IPC_CHANNELS.${key}`)
      expect(IPC_CHANNELS[key]).toBeDefined()
    }
    expect(source).toContain(`SETTINGS_IPC_CHANNELS.${'RENDERER_READY'}`)
    expect(SETTINGS_IPC_CHANNELS.RENDERER_READY).toBeDefined()
  })
  test('保留安全回调、renderer ready 和 Git 缓存失效语义', () => {
    expect(source).toContain('RuntimeGitIpcContext')
    expect(source).toContain('context.ensurePathAllowedWithWorktree')
    expect(source).toContain('context.isPathAllowed')
    expect(source).toContain('context.onRendererReady(event.sender)')
    expect(source).toContain('invalidateGitDiffCache(filePath)')
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(ipc).toContain('registerRuntimeGitIpc({')
    expect(ipc).not.toContain('ipcMain.handle(\n    IPC_CHANNELS.GET_RUNTIME_STATUS')
    expect(ipc).not.toContain('ipcMain.handle(\n    IPC_CHANNELS.GET_FILE_DIFF')
  })
})
