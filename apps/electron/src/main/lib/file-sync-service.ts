/**
 * 文件同步服务
 *
 * 负责团队工作区文件的同步：
 * - 文件清单拉取（不全量下载）
 * - 按需下载（用户打开时触发）
 * - 上传队列（自动推送本地变更）
 * - 冲突检测与备份
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fetch as undiciFetch } from 'undici'
import { createHash } from 'node:crypto'
import { getTeamAuth } from './auth-service'
import { getWorkspaceFilesDir } from './config-paths'
import type { FileManifestEntry, FileSyncStatus, SyncedFileEntry } from './sync-types'

/** 带认证的 fetch 封装 */
async function authedFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const auth = getTeamAuth()
  if (!auth) throw new Error('未登录')

  return (undiciFetch as unknown as typeof fetch)(`${auth.baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string>),
      Authorization: `Bearer ${auth.token}`,
    },
  })
}

/** 计算文件 SHA256 */
function sha256File(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash('sha256').update(content).digest('hex')
}

// ===== 文件清单管理 =====

/**
 * 从远程拉取文件清单
 * @returns 远程文件清单，失败返回空数组
 */
export async function fetchFileManifest(workspaceId: string): Promise<FileManifestEntry[]> {
  try {
    const res = await authedFetch(
      `/v1/workspaces/${workspaceId}/files/manifest`,
    )
    if (!res.ok) return []
    return (await res.json()) as FileManifestEntry[]
  } catch (err) {
    console.error('[文件同步] 拉取文件清单失败:', err)
    return []
  }
}

/**
 * 构建本地文件状态列表（对比远程清单）
 */
export function buildFileStatusList(
  workspaceSlug: string,
  remoteManifest: FileManifestEntry[],
): SyncedFileEntry[] {
  const filesDir = getWorkspaceFilesDir(workspaceSlug)
  const remoteByPath = new Map(remoteManifest.map((e) => [e.path, e]))
  const result: SyncedFileEntry[] = []

  // 本地文件
  const localFiles = walkDir(filesDir, '')
  const localByPath = new Map(localFiles.map((f) => [f.path, f]))

  // 合并本地和远程
  const allPaths = new Set([
    ...remoteByPath.keys(),
    ...localByPath.keys(),
  ])

  for (const path of allPaths) {
    const local = localByPath.get(path)
    const remote = remoteByPath.get(path)
    let status: FileSyncStatus

    if (local && remote) {
      try {
        const localHash = sha256File(join(filesDir, path))
        status = localHash === remote.sha256 ? 'synced' : 'conflict'
      } catch {
        status = 'conflict'
      }
    } else if (local && !remote) {
      status = 'local-only'
    } else {
      status = 'cloud-only'
    }

    result.push({
      name: local?.name ?? remote?.name ?? path.split('/').pop()!,
      path,
      isDirectory: local?.isDirectory ?? remote?.isDirectory ?? false,
      size: local?.size ?? remote?.size ?? 0,
      modifiedAt: local?.modifiedAt ?? remote?.modifiedAt ?? 0,
      syncStatus: status,
      remoteModifiedAt: remote?.modifiedAt,
    })
  }

  return result
}

/** 递归列出目录文件 */
function walkDir(
  root: string,
  relative: string,
): Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedAt: number }> {
  const full = join(root, relative)
  const result: Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedAt: number }> = []

  if (!existsSync(full)) return result

  const { readdirSync, statSync } = require('node:fs')
  try {
    const entries = readdirSync(full, { withFileTypes: true })
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.name.startsWith('.') && entry.name !== '.context') continue

      try {
        const stats = statSync(join(full, entry.name))
        result.push({
          name: entry.name,
          path: rel,
          isDirectory: entry.isDirectory(),
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        })
      } catch {
        // 跳过无法访问的文件
      }
    }
  } catch {
    // 目录无法读取
  }

  return result
}

// ===== 按需下载 =====

/**
 * 按需下载文件
 * @returns 下载后的本地文件路径
 */
export async function downloadFile(
  workspaceId: string,
  filePath: string,
  workspaceSlug: string,
): Promise<string> {
  const res = await authedFetch(
    `/v1/workspaces/${workspaceId}/files/download/${encodeURIComponent(filePath)}`,
  )

  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status}`)
  }

  const filesDir = getWorkspaceFilesDir(workspaceSlug)
  const localPath = join(filesDir, filePath)

  // 确保父目录存在
  const parent = dirname(localPath)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }

  // 写入文件
  const buffer = Buffer.from(await res.arrayBuffer())
  writeFileSync(localPath, buffer)

  console.log(`[文件同步] 已下载: ${filePath}`)
  return localPath
}

// ===== 上传 =====

/**
 * 上传文件到远程
 */
export async function uploadFile(
  workspaceId: string,
  workspaceSlug: string,
  filePath: string,
): Promise<void> {
  const filesDir = getWorkspaceFilesDir(workspaceSlug)
  const fullPath = join(filesDir, filePath)

  if (!existsSync(fullPath)) {
    throw new Error(`文件不存在: ${filePath}`)
  }

  const content = readFileSync(fullPath)
  const sha256 = createHash('sha256').update(content).digest('hex')

  const formData = new FormData()
  formData.append('file', new Blob([content]), filePath)
  formData.append('sha256', sha256)

  const auth = getTeamAuth()
  if (!auth) throw new Error('未登录')
  const res = await (undiciFetch as unknown as typeof fetch)(
    `${auth.baseUrl}/v1/workspaces/${workspaceId}/files/upload`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
      body: formData,
    },
  )

  if (!res.ok) {
    throw new Error(`上传失败: HTTP ${res.status}`)
  }

  console.log(`[文件同步] 已上传: ${filePath} (sha256: ${sha256.slice(0, 8)})`)
}

// ===== 冲突处理 =====

/**
 * 处理文件冲突（Phase 2: 备份旧版本 + 保留远程）
 */
export function backupConflictedFile(
  workspaceSlug: string,
  filePath: string,
): string | null {
  const filesDir = getWorkspaceFilesDir(workspaceSlug)
  const fullPath = join(filesDir, filePath)

  if (!existsSync(fullPath)) return null

  const backupPath = `${fullPath}.conflict-${Date.now()}`
  try {
    copyFileSync(fullPath, backupPath)
    console.log(`[文件同步] 冲突文件已备份: ${backupPath}`)
    return backupPath
  } catch (err) {
    console.error('[文件同步] 冲突备份失败:', err)
    return null
  }
}

/**
 * 解决冲突：选择保留本地或远程版本
 */
export async function resolveConflict(
  workspaceId: string,
  workspaceSlug: string,
  filePath: string,
  resolution: 'keep-local' | 'keep-remote',
): Promise<void> {
  if (resolution === 'keep-local') {
    // 上传本地版本覆盖远程
    await uploadFile(workspaceId, workspaceSlug, filePath)
  } else {
    // 备份本地，下载远程
    backupConflictedFile(workspaceSlug, filePath)
    await downloadFile(workspaceId, filePath, workspaceSlug)
  }
}

/**
 * 获取单个文件的同步状态
 */
export function getFileSyncStatus(
  workspaceSlug: string,
  filePath: string,
  remoteManifest?: FileManifestEntry[],
): FileSyncStatus {
  const filesDir = getWorkspaceFilesDir(workspaceSlug)
  const fullPath = join(filesDir, filePath)

  const localExists = existsSync(fullPath)
  const remoteExists = remoteManifest?.some((e) => e.path === filePath) ?? false

  if (!localExists && remoteExists) return 'cloud-only'
  if (localExists && !remoteExists) return 'local-only'
  if (!localExists && !remoteExists) return 'synced'

  // 两者都存在，比较 hash
  if (remoteManifest) {
    const remote = remoteManifest.find((e) => e.path === filePath)
    if (remote) {
      const localHash = sha256File(fullPath)
      return localHash === remote.sha256 ? 'synced' : 'conflict'
    }
  }

  return 'synced'
}
