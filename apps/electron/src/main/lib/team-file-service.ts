/**
 * 团队文件服务
 *
 * 用户主动上传/下载/删除团队工作区文件。无后台同步。
 */

import { existsSync, writeFileSync, mkdirSync, statSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
  /** 服务端稳定资料身份，路径移动/重命名/覆盖时保持不变。 */
  fileId?: string
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

/**
 * 清理由团队下载产生的缓存，但绝不删除用户登记的原始本地源文件。
 * 删除远端条目后必须清理同路径缓存，否则同路径重传会读取旧字节。
 */
function removeLocalCacheTree(workspaceId: string, workspaceSlug: string, remotePath: string): void {
  const protectedSources = new Set(Object.values(readLocalSources())
    .filter((entry) => entry.workspaceId === workspaceId && (entry.remotePath === remotePath || entry.remotePath.startsWith(`${remotePath}/`)))
    .map((entry) => resolve(entry.sourcePath)))
  const remove = (candidate: string): boolean => {
    const resolved = resolve(candidate)
    if (protectedSources.has(resolved)) return false
    const stats = statSync(resolved)
    if (!stats.isDirectory()) { rmSync(resolved, { force: true }); return true }
    for (const name of readdirSync(resolved)) remove(join(resolved, name))
    if (readdirSync(resolved).length === 0) { rmSync(resolved, { recursive: true, force: true }); return true }
    return false
  }
  for (const cacheRoot of [getSafeWorkspaceFilePath(workspaceSlug, remotePath), getSafePrivateCachePath(workspaceId, remotePath)]) {
    if (!cacheRoot || !existsSync(cacheRoot)) continue
    try { remove(cacheRoot) } catch (error) { console.warn('[team-file] 清理已删除资料缓存失败:', remotePath, error) }
  }
}

/** 物理移动本地缓存文件（目录则递归），配合远程 move/rename 保持 synced 状态 */
function moveLocalCache(workspaceSlug: string, fromPath: string, toPath: string): void {
  try {
    const { renameSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } = require('node:fs')
    const { join, dirname } = require('node:path')
    const filesDir = resolve(getWorkspaceFilesDir(workspaceSlug))
    const oldLocal = resolve(filesDir, fromPath)
    const newLocal = resolve(filesDir, toPath)
    // 安全检查：两者都必须在工作区目录内
    if (!oldLocal.startsWith(filesDir) || !newLocal.startsWith(filesDir)) return
    if (!existsSync(oldLocal)) return
    mkdirSync(dirname(newLocal), { recursive: true })
    renameSync(oldLocal, newLocal)
    // 清理空父目录
    let parent = dirname(oldLocal)
    while (parent.startsWith(filesDir) && parent !== filesDir) {
      try {
        const remaining = readdirSync(parent)
        if (remaining.length === 0) rmSync(parent, { recursive: true })
        else break
      } catch { break }
      parent = dirname(parent)
    }
  } catch (err) {
    console.warn('[team-file] 移动本地缓存失败:', fromPath, '→', toPath, err)
  }
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

function getSafePath(rootDir: string, filePath: string): string | null {
  const root = resolve(rootDir)
  const targetPath = resolve(root, filePath)
  const relativePath = relative(root, targetPath)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null
  return targetPath
}

function getSafeWorkspaceFilePath(workspaceSlug: string, filePath: string): string | null {
  return getSafePath(getWorkspaceFilesDir(workspaceSlug), filePath)
}

/** 私有下载缓存只用于不能安全写入工作区文件目录的少数同路径冲突场景。 */
function getSafePrivateCachePath(workspaceId: string, filePath: string): string | null {
  return getSafePath(join(getConfigDir(), 'team-file-download-cache', encodeURIComponent(workspaceId)), filePath)
}

function isExpectedSha256(value?: string): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)
}

function matchesExpectedSha256(filePath: string, expectedSha256?: string): boolean {
  if (!isExpectedSha256(expectedSha256)) return true
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex').toLowerCase() === expectedSha256.toLowerCase()
  } catch {
    return false
  }
}

function getExistingLocalFile(workspaceId: string, workspaceSlug: string, filePath: string, expectedSha256?: string): string | null {
  const candidates = [
    getSafeWorkspaceFilePath(workspaceSlug, filePath),
    getSafePrivateCachePath(workspaceId, filePath),
  ]
  for (const localPath of candidates) {
    if (!localPath || !existsSync(localPath)) continue
    try {
      if (statSync(localPath).isFile() && matchesExpectedSha256(localPath, expectedSha256)) return localPath
    } catch { /* 尝试下一个缓存位置 */ }
  }
  return null
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

function getOriginalLocalFile(workspaceId: string, filePath: string, uploadedBy?: string, expectedSha256?: string): string | null {
  const authStatus = getAuthStatus()
  if (!authStatus.teamAccountId) return null
  if (uploadedBy && uploadedBy !== authStatus.teamAccountId) return null

  const entry = readLocalSources()[getLocalSourceKey(workspaceId, filePath)]
  if (!entry || entry.uploadedBy !== authStatus.teamAccountId) return null

  const sourcePath = getExistingFile(entry.sourcePath)
  return sourcePath && matchesExpectedSha256(sourcePath, expectedSha256) ? sourcePath : null
}

function isProtectedLocalSource(workspaceId: string, candidatePath: string): boolean {
  const resolved = resolve(candidatePath)
  return Object.values(readLocalSources()).some((entry) => entry.workspaceId === workspaceId && resolve(entry.sourcePath) === resolved)
}

function writeLocalCache(workspaceId: string, workspaceSlug: string, filePath: string, buffer: Buffer): string | null {
  const workspacePath = getSafeWorkspaceFilePath(workspaceSlug, filePath)
  // 绝不覆盖用户作为上传来源登记的文件；遇到同路径冲突时隔离到私有缓存。
  const localPath = workspacePath && !isProtectedLocalSource(workspaceId, workspacePath)
    ? workspacePath
    : getSafePrivateCachePath(workspaceId, filePath)
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

/** 获取认证，token 过期时自动刷新 */
async function getOrRefreshAuth() {
  let auth = getTeamAuth()
  if (!auth) {
    await refreshAuthToken().catch(() => {})
    auth = getTeamAuth()
  }
  return auth
}

/**
 * 带认证的团队文件请求封装（token 过期或被服务端拒绝时自动刷新重试）。
 *
 * 与 team-manager.authedFetch 行为一致，但不强制 Content-Type，
 * 以兼容 octet-stream 上传和二进制下载。
 *
 * @returns Response；未登录或无法获取令牌时返回 null
 */
async function teamFileFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response | null> {
  const auth = await getOrRefreshAuth()
  if (!auth) return null

  const { baseUrl } = auth
  const doFetch = (token: string) =>
    (undiciFetch as unknown as typeof fetch)(`${baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.headers as Record<string, string>),
        Authorization: `Bearer ${token}`,
      },
    })

  const res = await doFetch(auth.token)
  // 仅本地时钟认为有效、但服务端已拒绝（401）时，刷新令牌后重试一次。
  if (res.status !== 401) return res

  const refreshed = await refreshAuthToken().catch(() => false)
  if (!refreshed) return res
  const auth2 = getTeamAuth()
  if (!auth2 || auth2.token === auth.token) return res
  return doFetch(auth2.token)
}

export async function uploadFile(
  workspaceId: string,
  workspaceSlug: string,
  fileName: string,
  fileBuffer: Buffer,
  sourcePath?: string,
): Promise<{ success: boolean; path: string; size: number; error?: string }> {
  try {
    console.log('[team-file] 上传文件:', fileName, 'size:', fileBuffer.length, 'to:', workspaceId)

    const res = await teamFileFetch(`/v1/workspaces/${workspaceId}/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(fileName),
      },
      body: fileBuffer as unknown as RequestInit['body'],
    })
    if (!res) return { success: false, path: fileName, size: 0, error: '未登录' }

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
          const localPath = writeLocalCache(workspaceId, workspaceSlug, result.path, fileBuffer)
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
  expectedSha256?: string,
): Promise<string | null> {
  const originalLocal = getOriginalLocalFile(workspaceId, filePath, uploadedBy, expectedSha256)
  if (originalLocal) return originalLocal

  const existingLocal = getExistingLocalFile(workspaceId, workspaceSlug, filePath, expectedSha256)
  if (existingLocal) return existingLocal

  try {
    const res = await teamFileFetch(
      `/v1/workspaces/${workspaceId}/files/download/${encodeURIComponent(filePath)}`,
    )
    if (!res || !res.ok) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    // 清单与下载请求间若远端再次变更，宁可让调用方刷新清单，也不缓存错误版本。
    if (isExpectedSha256(expectedSha256) && createHash('sha256').update(buffer).digest('hex').toLowerCase() !== expectedSha256.toLowerCase()) return null
    const localPath = writeLocalCache(workspaceId, workspaceSlug, filePath, buffer)
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
  try {
    const res = await teamFileFetch(
      `/v1/workspaces/${workspaceId}/files/${encodeURIComponent(filePath)}`,
      { method: 'DELETE' },
    )
    if (res?.ok) {
      removeLocalCacheTree(workspaceId, workspaceSlug, filePath)
      forgetLocalSourceTree(workspaceId, filePath)
    }
    return !!res?.ok
  } catch {
    return false
  }
}

/** 移动文件或文件夹到指定目录 */
export async function moveRemoteFile(
  workspaceId: string,
  workspaceSlug: string,
  fromPath: string,
  toDir: string,
): Promise<{ success: boolean; fromPath: string; toPath?: string; error?: string }> {
  try {
    const res = await teamFileFetch(
      `/v1/workspaces/${workspaceId}/files/move`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromPath, toDir }),
      },
    )
    if (!res) return { success: false, fromPath, error: '未登录' }
    if (!res.ok) {
      const txt = await res.text()
      return { success: false, fromPath, error: txt.slice(0, 200) }
    }
    const result = (await res.json()) as { success: boolean; fromPath: string; toPath: string }
    if (result.success && result.toPath) {
      moveLocalSourceTree(workspaceId, fromPath, result.toPath)
      // 同步移动本地缓存，避免文件从"已下载"变成"云端"
      moveLocalCache(workspaceSlug, fromPath, result.toPath)
    }
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
  try {
    const res = await teamFileFetch(
      `/v1/workspaces/${workspaceId}/files/mkdir`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      },
    )
    return !!res && res.ok
  } catch {
    return false
  }
}

/**
 * 获取远程文件清单。
 *
 * @returns 文件清单数组；当认证失败或网络错误导致无法确认远端状态时返回 null，
 *          以便调用方区分「真的没有文件（[]）」和「拉取失败（null）」，
 *          失败时保留本地已有列表而非清空。
 */
export async function fetchFileManifest(
  workspaceId: string,
  workspaceSlug?: string,
): Promise<TeamFileManifestEntry[] | null> {
  try {
    const res = await teamFileFetch(
      `/v1/workspaces/${workspaceId}/files/manifest`,
      { headers: { 'Content-Type': 'application/json' } },
    )
    if (!res) return null
    if (!res.ok) return null
    const manifest = (await res.json()) as TeamFileManifestEntry[]
    if (!workspaceSlug) return manifest

    return manifest.map((entry) => {
      const localPath = getSafeWorkspaceFilePath(workspaceSlug, entry.path)
      const localExists = !!localPath && existsSync(localPath)
      let hasLocalCache = false
      if (entry.isDirectory) {
        try { hasLocalCache = !!localPath && statSync(localPath).isDirectory() } catch { hasLocalCache = false }
      } else {
        // 私有缓存只能经 downloadFile 返回真实路径，不能标为已同步后让渲染层拼接工作区路径打开。
        try { hasLocalCache = !!localPath && statSync(localPath).isFile() && matchesExpectedSha256(localPath, entry.sha256) } catch { hasLocalCache = false }
      }
      const hasOriginalLocal = !entry.isDirectory && !!getOriginalLocalFile(workspaceId, entry.path, entry.uploadedBy, entry.sha256)
      const hasLocalFile = hasLocalCache || hasOriginalLocal
      return {
        ...entry,
        localExists: hasLocalFile,
        syncStatus: hasLocalFile ? 'synced' : 'cloud-only',
      }
    })
  } catch {
    return null
  }
}

export interface TeamFileApiResult<T> { ok: boolean; status?: number; data?: T; error?: string }
export interface TeamTrashEntry { id: string; fileId: string; originalPath: string; deletedBy: string | null; deletedAt: number; expiresAt: number }
async function metadataRequest<T>(path: string, options: RequestInit = {}): Promise<TeamFileApiResult<T>> {
  try { const res = await teamFileFetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) } }); if (!res) return { ok: false, error: '未登录' }; const data = await res.json().catch(() => ({})); return res.ok ? { ok: true, status: res.status, data } : { ok: false, status: res.status, error: data.error || '请求失败' } } catch { return { ok: false, error: '网络请求失败' } }
}
export const getFileMetadata = (workspaceId: string, fileId: string) => metadataRequest(`/v1/workspaces/${workspaceId}/files/${fileId}/metadata`)
export const patchFileMetadata = (workspaceId: string, fileId: string, body: Record<string, unknown>) => metadataRequest(`/v1/workspaces/${workspaceId}/files/${fileId}/metadata`, { method: 'PATCH', body: JSON.stringify(body) })
export const getFileTags = (workspaceId: string) => metadataRequest(`/v1/workspaces/${workspaceId}/file-tags`)
export const getFileStatuses = (workspaceId: string) => metadataRequest(`/v1/workspaces/${workspaceId}/file-statuses`)
export const setFilePreference = (workspaceId: string, fileId: string, body: Record<string, unknown>) => metadataRequest(`/v1/workspaces/${workspaceId}/files/${fileId}/preference`, { method: 'PUT', body: JSON.stringify(body) })
export const getFileActivities = (workspaceId: string, fileId: string, cursor?: string) => metadataRequest(`/v1/workspaces/${workspaceId}/files/${fileId}/activities${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
export const listTrashEntries = (workspaceId: string) => metadataRequest<TeamTrashEntry[]>(`/v1/workspaces/${workspaceId}/files/trash`)
export const restoreTrashEntry = (workspaceId: string, entryId: string) => metadataRequest<{ success: boolean; restoredPath: string }>(`/v1/workspaces/${workspaceId}/files/trash/${entryId}/restore`, { method: 'POST' })
export const purgeTrashEntry = (workspaceId: string, entryId: string) => metadataRequest<{ success: boolean; state: string }>(`/v1/workspaces/${workspaceId}/files/trash/${entryId}`, { method: 'DELETE' })

/** 检查文件是否在本地存在 */
export function isFileLocal(workspaceSlug: string, filePath: string): boolean {
  const localPath = getSafeWorkspaceFilePath(workspaceSlug, filePath)
  return !!localPath && existsSync(localPath)
}

/** 获取本地文件路径 */
export function getLocalFilePath(workspaceSlug: string, filePath: string): string {
  return getSafeWorkspaceFilePath(workspaceSlug, filePath) ?? join(getWorkspaceFilesDir(workspaceSlug), filePath)
}

// ===== 文件搜索 =====

export interface FileSearchOptions {
  q: string
  page?: number
  limit?: number
}

export interface FileSearchResult {
  files: TeamFileManifestEntry[]
  total: number
  page: number
  limit: number
  totalPages: number
}

/** 搜索团队工作区文件（按文件名/路径，支持 * 和 ? 通配符） */
export async function searchFiles(
  workspaceId: string,
  options: FileSearchOptions,
): Promise<FileSearchResult | null> {
  try {
    const params = new URLSearchParams()
    params.set('q', options.q)
    if (options.page) params.set('page', String(options.page))
    if (options.limit) params.set('limit', String(options.limit))

    const res = await teamFileFetch(
      `/v1/workspaces/${workspaceId}/files/search?${params.toString()}`
    )
    if (!res || !res.ok) return null
    return (await res.json()) as FileSearchResult
  } catch {
    return null
  }
}

/** 重命名远程文件或文件夹 */
export async function renameRemoteFile(
  workspaceId: string,
  workspaceSlug: string,
  path: string,
  newName: string,
): Promise<{ success: boolean; fromPath: string; toPath?: string; error?: string }> {
  try {
    const res = await teamFileFetch(
      `/v1/workspaces/${workspaceId}/files/rename`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, newName }),
      },
    )
    if (!res) return { success: false, fromPath: path, error: '未登录' }
    if (!res.ok) {
      const txt = await res.text()
      return { success: false, fromPath: path, error: txt.slice(0, 200) }
    }
    const result = (await res.json()) as { success: boolean; fromPath: string; toPath: string; newName: string }
    // 同步本地缓存 + 来源映射，避免文件从"已下载"变成"云端"
    if (result.success && result.toPath) {
      // 单个文件重命名：直接更新 key
      const store = readLocalSources()
      const oldKey = getLocalSourceKey(workspaceId, path)
      const newKey = getLocalSourceKey(workspaceId, result.toPath)
      if (store[oldKey]) {
        store[newKey] = { ...store[oldKey], remotePath: result.toPath }
        delete store[oldKey]
        writeLocalSources(store)
      }
      // 目录重命名：递归更新所有子路径
      const prefix = `${workspaceId}:${path}/`
      const newPrefix = `${workspaceId}:${result.toPath}/`
      const moved: Record<string, TeamFileLocalSourceEntry> = {}
      for (const [key, entry] of Object.entries(store)) {
        if (key.startsWith(prefix)) {
          const suffix = entry.remotePath.slice(path.length)
          moved[`${workspaceId}:${result.toPath}${suffix}`] = {
            ...entry,
            remotePath: `${result.toPath}${suffix}`,
          }
          delete store[key]
        }
      }
      if (Object.keys(moved).length > 0) writeLocalSources({ ...store, ...moved })
      moveLocalCache(workspaceSlug, path, result.toPath)
    }
    return result
  } catch (err) {
    return { success: false, fromPath: path, error: String(err) }
  }
}
