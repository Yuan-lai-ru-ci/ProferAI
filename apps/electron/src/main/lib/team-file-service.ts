/**
 * 团队文件服务
 *
 * 用户主动上传/下载/删除团队工作区文件。无后台同步。
 */

import { existsSync, writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { fetch as undiciFetch } from 'undici'
import { getConfigDir, getWorkspaceFilesDir } from './config-paths'
import { getTeamAuth, getAuthStatus, refreshAuthToken } from './auth-service'

export interface TeamFileManifestEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
  sha256: string
  uploadedBy: string
  uploadedByName: string
  localExists?: boolean
  syncStatus?: 'synced' | 'cloud-only'
}

interface TeamFileLocalSourceEntry {
  workspaceId: string
  workspaceSlug: string
  remotePath: string
  sourcePath: string
  uploadedBy: string
  uploadedAt: number
}

type TeamFileLocalSourceStore = Record<string, TeamFileLocalSourceEntry>

function getLocalSourcesPath(): string {
  return join(getConfigDir(), 'team-file-local-sources.json')
}

function getLocalSourceKey(workspaceId: string, remotePath: string): string {
  return `${workspaceId}:${remotePath}`
}

function readLocalSources(): TeamFileLocalSourceStore {
  const storePath = getLocalSourcesPath()
  if (!existsSync(storePath)) return {}
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8')) as TeamFileLocalSourceStore
  } catch (err) {
    console.warn('[team-file] 读取本地来源映射失败:', err)
    return {}
  }
}

function writeLocalSources(store: TeamFileLocalSourceStore): void {
  writeFileSync(getLocalSourcesPath(), JSON.stringify(store, null, 2), 'utf-8')
}

function forgetLocalSource(workspaceId: string, remotePath: string): void {
  const store = readLocalSources()
  const key = getLocalSourceKey(workspaceId, remotePath)
  if (!store[key]) return
  delete store[key]
  writeLocalSources(store)
}

function forgetLocalSourceTree(workspaceId: string, remotePath: string): void {
  const store = readLocalSources()
  const prefix = `${workspaceId}:${remotePath}/`
  const exactKey = getLocalSourceKey(workspaceId, remotePath)
  let changed = false
  for (const key of Object.keys(store)) {
    if (key === exactKey || key.startsWith(prefix)) {
      delete store[key]
      changed = true
    }
  }
  if (changed) writeLocalSources(store)
}

function moveLocalSourceTree(workspaceId: string, fromPath: string, toPath: string): void {
  const store = readLocalSources()
  const exactKey = getLocalSourceKey(workspaceId, fromPath)
  const prefix = `${workspaceId}:${fromPath}/`
  const moved: TeamFileLocalSourceStore = {}
  let changed = false

  for (const [key, entry] of Object.entries(store)) {
    if (key === exactKey || key.startsWith(prefix)) {
      const suffix = key === exactKey ? '' : entry.remotePath.slice(fromPath.length)
      const nextRemotePath = `${toPath}${suffix}`
      moved[getLocalSourceKey(workspaceId, nextRemotePath)] = {
        ...entry,
        remotePath: nextRemotePath,
      }
      delete store[key]
      changed = true
    }
  }

  if (changed) writeLocalSources({ ...store, ...moved })
}

function getSafeWorkspaceFilePath(workspaceSlug: string, filePath: string): string | null {
  const filesDir = resolve(getWorkspaceFilesDir(workspaceSlug))
  const targetPath = resolve(filesDir, filePath)
  const relativePath = relative(filesDir, targetPath)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null
  return targetPath
}

function getExistingLocalFile(workspaceSlug: string, filePath: string): string | null {
  const localPath = getSafeWorkspaceFilePath(workspaceSlug, filePath)
  if (!localPath || !existsSync(localPath)) return null
  try {
    const stats = statSync(localPath)
    return stats.isFile() ? localPath : null
  } catch {
    return null
  }
}

function getExistingFile(filePath: string): string | null {
  if (!filePath) return null
  try {
    const resolvedPath = resolve(filePath)
    if (!existsSync(resolvedPath)) return null
    return statSync(resolvedPath).isFile() ? resolvedPath : null
  } catch {
    return null
  }
}

function getOriginalLocalFile(workspaceId: string, filePath: string, uploadedBy?: string): string | null {
  const authStatus = getAuthStatus()
  if (!authStatus.teamAccountId) return null
  if (uploadedBy && uploadedBy !== authStatus.teamAccountId) return null

  const entry = readLocalSources()[getLocalSourceKey(workspaceId, filePath)]
  if (!entry || entry.uploadedBy !== authStatus.teamAccountId) return null

  return getExistingFile(entry.sourcePath)
}

function writeLocalCache(workspaceSlug: string, filePath: string, buffer: Buffer): string | null {
  const localPath = getSafeWorkspaceFilePath(workspaceSlug, filePath)
  if (!localPath) return null
  const parent = dirname(localPath)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  writeFileSync(localPath, buffer)
  return localPath
}

function rememberLocalSource(
  workspaceId: string,
  workspaceSlug: string,
  remotePath: string,
  sourcePath: string,
): boolean {
  const authStatus = getAuthStatus()
  if (!authStatus.teamAccountId) return false

  const existingFile = getExistingFile(sourcePath)
  if (!existingFile) return false

  const store = readLocalSources()
  store[getLocalSourceKey(workspaceId, remotePath)] = {
    workspaceId,
    workspaceSlug,
    remotePath,
    sourcePath: existingFile,
    uploadedBy: authStatus.teamAccountId,
    uploadedAt: Date.now(),
  }
  writeLocalSources(store)
  return true
}

/** 上传文件到团队服务器 */
export async function uploadFile(
  workspaceId: string,
  workspaceSlug: string,
  fileName: string,
  fileBuffer: Buffer,
  sourcePath?: string,
): Promise<{ success: boolean; path: string; size: number; error?: string }> {
  const auth = getTeamAuth()
  if (!auth) return { success: false, path: fileName, size: 0, error: '未登录' }

  try {
    console.log('[team-file] 上传文件:', fileName, 'size:', fileBuffer.length, 'to:', workspaceId)

    const res = await (undiciFetch as unknown as typeof fetch)(`${auth.baseUrl}/v1/workspaces/${workspaceId}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(fileName),
      },
      body: fileBuffer as unknown as RequestInit['body'],
    })

    if (!res.ok) {
      const txt = await res.text()
      console.error('[team-file] 上传失败:', res.status, txt.slice(0, 200))
      throw new Error(`HTTP ${res.status}`)
    }
    const result = (await res.json()) as { success: boolean; path: string; size: number }
    if (result.success) {
      if (sourcePath) {
        try {
          if (!rememberLocalSource(workspaceId, workspaceSlug, result.path, sourcePath)) {
            forgetLocalSource(workspaceId, result.path)
          }
        } catch (err) {
          forgetLocalSource(workspaceId, result.path)
          console.warn('[team-file] 记录本地来源失败，远端上传已成功:', result.path, err)
        }
      } else {
        forgetLocalSource(workspaceId, result.path)
        try {
          const localPath = writeLocalCache(workspaceSlug, result.path, fileBuffer)
          if (!localPath) {
            console.warn('[team-file] 本地缓存路径不合法，跳过写入:', result.path)
          }
        } catch (err) {
          console.warn('[team-file] 本地缓存写入失败，远端上传已成功:', result.path, err)
        }
      }
    }
    console.log('[team-file] 上传成功:', fileName, result)
    return result
  } catch (err) {
    console.error('[team-file] 上传异常:', fileName, err)
    return { success: false, path: fileName, size: 0, error: String(err) }
  }
}

/** 从团队服务器下载文件到本地工作区 */
export async function downloadFile(
  workspaceId: string,
  workspaceSlug: string,
  filePath: string,
  uploadedBy?: string,
): Promise<string | null> {
  const originalLocal = getOriginalLocalFile(workspaceId, filePath, uploadedBy)
  if (originalLocal) return originalLocal

  const existingLocal = getExistingLocalFile(workspaceSlug, filePath)
  if (existingLocal) return existingLocal

  const auth = getTeamAuth()
  if (!auth) return null

  try {
    const res = await (undiciFetch as unknown as typeof fetch)(
      `${auth.baseUrl}/v1/workspaces/${workspaceId}/files/download/${encodeURIComponent(filePath)}`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    )

    if (!res.ok) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    const localPath = writeLocalCache(workspaceSlug, filePath, buffer)
    if (!localPath) return null
    return localPath
  } catch {
    return null
  }
}

/** 删除服务器上的文件（保留本地副本） */
export async function deleteRemoteFile(
  workspaceId: string,
  workspaceSlug: string,
  filePath: string,
): Promise<boolean> {
  const auth = getTeamAuth()
  if (!auth) return false

  try {
    const res = await (undiciFetch as unknown as typeof fetch)(
      `${auth.baseUrl}/v1/workspaces/${workspaceId}/files/${encodeURIComponent(filePath)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` } },
    )
    if (res.ok) forgetLocalSourceTree(workspaceId, filePath)
    return res.ok
  } catch {
    return false
  }
}

/** 移动文件或文件夹到指定目录 */
export async function moveRemoteFile(
  workspaceId: string,
  fromPath: string,
  toDir: string,
): Promise<{ success: boolean; fromPath: string; toPath?: string; error?: string }> {
  const auth = getTeamAuth()
  if (!auth) return { success: false, fromPath, error: '未登录' }

  try {
    const res = await (undiciFetch as unknown as typeof fetch)(
      `${auth.baseUrl}/v1/workspaces/${workspaceId}/files/move`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fromPath, toDir }),
      },
    )
    if (!res.ok) {
      const txt = await res.text()
      return { success: false, fromPath, error: txt.slice(0, 200) }
    }
    const result = (await res.json()) as { success: boolean; fromPath: string; toPath: string }
    if (result.success && result.toPath) moveLocalSourceTree(workspaceId, fromPath, result.toPath)
    return result
  } catch (err) {
    return { success: false, fromPath, error: String(err) }
  }
}

/** 在远程团队服务器上创建文件夹 */
export async function createRemoteDirectory(
  workspaceId: string,
  dirPath: string,
): Promise<boolean> {
  const auth = getTeamAuth()
  if (!auth) return false

  try {
    const res = await (undiciFetch as unknown as typeof fetch)(
      `${auth.baseUrl}/v1/workspaces/${workspaceId}/files/mkdir`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: dirPath }),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

/** 获取远程文件清单 */
export async function fetchFileManifest(
  workspaceId: string,
  workspaceSlug?: string,
): Promise<TeamFileManifestEntry[]> {
  let auth = getTeamAuth()
  // token 过期时先尝试刷新
  if (!auth) {
    await refreshAuthToken().catch(() => {})
    auth = getTeamAuth()
  }
  if (!auth) return []

  try {
    const res = await (undiciFetch as unknown as typeof fetch)(
      `${auth.baseUrl}/v1/workspaces/${workspaceId}/files/manifest`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    )
    if (!res.ok) return []
    const manifest = (await res.json()) as TeamFileManifestEntry[]
    if (!workspaceSlug) return manifest

    return manifest.map((entry) => {
      const localPath = getSafeWorkspaceFilePath(workspaceSlug, entry.path)
      const localExists = !!localPath && existsSync(localPath)
      let matchesKind = false
      if (localExists) {
        try {
          const stats = statSync(localPath)
          matchesKind = entry.isDirectory ? stats.isDirectory() : stats.isFile()
        } catch {
          matchesKind = false
        }
      }
      const hasLocalCache = localExists && matchesKind
      const hasOriginalLocal = !entry.isDirectory && !!getOriginalLocalFile(workspaceId, entry.path, entry.uploadedBy)
      const hasLocalFile = hasLocalCache || hasOriginalLocal
      return {
        ...entry,
        localExists: hasLocalFile,
        syncStatus: hasLocalFile ? 'synced' : 'cloud-only',
      }
    })
  } catch {
    return []
  }
}

/** 检查文件是否在本地存在 */
export function isFileLocal(workspaceSlug: string, filePath: string): boolean {
  const localPath = getSafeWorkspaceFilePath(workspaceSlug, filePath)
  return !!localPath && existsSync(localPath)
}

/** 获取本地文件路径 */
export function getLocalFilePath(workspaceSlug: string, filePath: string): string {
  return getSafeWorkspaceFilePath(workspaceSlug, filePath) ?? join(getWorkspaceFilesDir(workspaceSlug), filePath)
}
