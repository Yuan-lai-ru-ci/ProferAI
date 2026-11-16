/** 导出任务的共享状态模型：跨页面存活的状态、进度过滤与格式化。 */

export type MigrationExportPhase = 'preparing' | 'packing' | 'finalizing' | 'encrypting'

export interface MigrationExportProgress {
  phase: MigrationExportPhase
  percent: number
  bytesWritten: number
  totalBytes: number
}

export interface MigrationExportResult {
  success: boolean
  filePath?: string
  error?: string
  warnings?: string[]
  bytes?: number
  encrypted?: boolean
  cancelled?: boolean
}

export type MigrationExportStatus = 'idle' | 'running' | 'cancelling' | 'finished'

export interface MigrationExportState {
  status: MigrationExportStatus
  /** 当前任务 ID；仅在运行/取消阶段存在，用于过滤过期进度事件 */
  taskId: string | null
  progress: MigrationExportProgress | null
  result: MigrationExportResult | null
}

/** 主进程 migration:progress 推送的原始形状 */
export interface MigrationExportProgressEvent {
  taskId?: string
  phase: string
  percent: number
  bytesWritten: number
  totalBytes: number
}

export const MIGRATION_EXPORT_PHASE_LABELS: Record<MigrationExportPhase, string> = {
  preparing: '准备中',
  packing: '打包中',
  finalizing: '收尾中',
  encrypting: '加密中',
}

export const IDLE_MIGRATION_EXPORT_STATE: MigrationExportState = {
  status: 'idle',
  taskId: null,
  progress: null,
  result: null,
}

export function isMigrationExportActive(state: MigrationExportState): boolean {
  return state.status === 'running' || state.status === 'cancelling'
}

/** 只接受当前任务的进度；任务已结束或 ID 不匹配时保持原状态引用。 */
export function applyMigrationExportProgress(
  state: MigrationExportState,
  event: MigrationExportProgressEvent,
): MigrationExportState {
  if (!isMigrationExportActive(state) || !state.taskId || event.taskId !== state.taskId) return state
  return {
    ...state,
    progress: {
      phase: event.phase as MigrationExportPhase,
      percent: event.percent,
      bytesWritten: event.bytesWritten,
      totalBytes: event.totalBytes,
    },
  }
}
