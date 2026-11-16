import { atom } from 'jotai'
import { IDLE_MIGRATION_EXPORT_STATE, type MigrationExportState } from '@/lib/migration-export'

export const migrationImportDialogOpenAtom = atom(false)

export const migrationImportInitialFilePathAtom = atom<string | null>(null)

/** 导出任务的全局状态：设置页切走再切回仍保留进度与结果。 */
export const migrationExportStateAtom = atom<MigrationExportState>(IDLE_MIGRATION_EXPORT_STATE)

/** 请求取消当前导出；主进程未受理时恢复运行态，允许用户再次点击。 */
export const cancelMigrationExportAtom = atom(null, async (get, set) => {
  const state = get(migrationExportStateAtom)
  if (state.status !== 'running' || !state.taskId) return
  const taskId = state.taskId
  set(migrationExportStateAtom, { ...state, status: 'cancelling' })

  const restoreRunning = (): void => {
    set(migrationExportStateAtom, (current) =>
      current.status === 'cancelling' && current.taskId === taskId
        ? { ...current, status: 'running' }
        : current,
    )
  }

  try {
    // false 表示主进程尚未注册该任务（或已结束）：恢复运行态，允许再次点击取消。
    if (!(await window.electronAPI.migrationCancelExport(taskId))) restoreRunning()
  } catch (error) {
    console.error('[导出] 取消请求失败:', error)
    restoreRunning()
  }
})
