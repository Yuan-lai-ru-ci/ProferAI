import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'

/** 进度事件与窗口解耦：窗口已关闭时静默放弃。 */
function forwardProgress(event: IpcMainInvokeEvent, taskId: unknown, progress: unknown): void {
  try {
    if (event.sender.isDestroyed()) return
    event.sender.send('migration:progress', { taskId, ...(progress as Record<string, unknown>) })
  } catch {
    // 窗口关闭/渲染进程崩溃时忽略
  }
}

/** 正在进行的导出任务：taskId → AbortController，供用户取消。 */
const exportControllers = new Map<string, AbortController>()

export function registerMigrationIpc(): void {
  ipcMain.handle('migration:getExportPreview', async (_, workspaceId: string) => {
    const { getExportPreview } = await import('./migration-service')
    return getExportPreview(workspaceId)
  })
  ipcMain.handle('migration:getShareExportPreview', async () => {
    const { getShareExportPreview } = await import('./migration-service')
    return getShareExportPreview()
  })
  ipcMain.handle('migration:inspectImportFile', async (_, filePath: string) => {
    const { inspectImportFile } = await import('./migration-service')
    return inspectImportFile(filePath)
  })
  ipcMain.handle('migration:export', async (event, options) => {
    const { exportData } = await import('./migration-service')
    const { taskId, ...rest } = options ?? {}
    return exportData({
      ...rest,
      onProgress: (progress) => forwardProgress(event, taskId, progress),
    })
  })
  ipcMain.handle('migration:exportV2', async (event, options) => {
    const { exportDataV2 } = await import('./migration-service')
    const { taskId: rawTaskId, ...rest } = options ?? {}
    const taskId = typeof rawTaskId === 'string' && rawTaskId ? rawTaskId : null
    const controller = taskId ? new AbortController() : null
    if (controller && taskId) exportControllers.set(taskId, controller)
    try {
      return await exportDataV2({
        ...rest,
        signal: controller?.signal,
        onProgress: (progress) => forwardProgress(event, taskId, progress),
      })
    } finally {
      if (taskId) exportControllers.delete(taskId)
    }
  })
  ipcMain.handle('migration:cancelExport', (_, taskId: unknown) => {
    if (typeof taskId !== 'string') return false
    const controller = exportControllers.get(taskId)
    if (!controller) return false
    controller.abort()
    return true
  })
  ipcMain.handle('migration:parseImportFile', async (_, filePath: string, passphrase?: string) => {
    const { parseImportFile } = await import('./migration-service')
    return parseImportFile(filePath, passphrase)
  })
  ipcMain.handle('migration:confirmImport', async (_, options) => {
    const { confirmImport } = await import('./migration-service')
    return confirmImport(options)
  })
  ipcMain.handle('migration:openFileDialog', async () => {
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
    const ext = mode === 'personal' ? 'profer-backup' : 'profer-share'
    const defaultName = `profer-migration-${new Date().toISOString().slice(0, 10)}.${ext}`
    const result = await dialog.showSaveDialog({
      title: '保存迁移文件',
      defaultPath: defaultName,
      filters: [{ name: mode === 'personal' ? 'Profer 个人备份' : 'Profer 分享包', extensions: [ext] }],
    })
    return result.canceled ? null : result.filePath
  })
}
