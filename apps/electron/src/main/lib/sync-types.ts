/**
 * 同步类型定义
 *
 * 同步信封、同步状态、文件同步状态等类型。
 */

/** 同步操作类型 */
export type SyncOperation = 'create' | 'update' | 'delete'

/** 可同步的实体类型 */
export type SyncEntityType = 'workspace' | 'skill' | 'brand' | 'file'

/** 同步信封 */
export interface SyncEnvelope {
  /** 幂等键 */
  id: string
  /** 所属工作区 */
  workspaceId: string
  /** 实体类型 */
  entityType: SyncEntityType
  /** 实体 ID */
  entityId: string
  /** 操作 */
  operation: SyncOperation
  /** JSON 负载 */
  payload: unknown
  /** 变更发生时间 */
  occurredAt: number
  /** 重试次数 */
  retryCount: number
  /** 最后一次错误 */
  lastError?: string
}

/** 单个文件的同步状态 */
export type FileSyncStatus =
  | 'synced'
  | 'syncing'
  | 'cloud-only'
  | 'local-only'
  | 'conflict'

/** 文件清单条目 */
export interface FileManifestEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
  sha256: string
}

/** 同步后的文件条目（FileBrowser 使用） */
export interface SyncedFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
  syncStatus: FileSyncStatus
  remoteModifiedAt?: number
}

/** 工作区同步状态 */
export interface WorkspaceSyncState {
  workspaceId: string
  lastFullSyncAt: number | null
  lastIncrementalSyncAt: number | null
  pendingOutgoing: number
  pendingIncoming: number
  isSyncing: boolean
  conflictCount: number
  lastError?: string
}

/** 同步状态索引 */
export interface SyncStateIndex {
  version: number
  workspaces: WorkspaceSyncState[]
}
