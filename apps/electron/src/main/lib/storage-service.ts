/**
 * 存储管理服务
 *
 * 提供磁盘用量统计、孤儿数据检测和清理功能。
 * 由设置面板"磁盘管理"Tab 和启动时自动清理逻辑调用。
 */

import { existsSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import {
  getConfigDir,
  getAgentSessionsDir,
  getSdkConfigDir,
  getAgentWorkspacesDir,
  getAttachmentsDir,
  getConversationsDir,
  getPiCheckpointsDir,
} from './config-paths'
import { listAgentSessions } from './agent-session-manager'
import { removePiFileCheckpoints } from './pi-file-checkpoint'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { blobRootDir } from './blob-store'

// ─── 类型定义 ───

export type StorageCategoryKey =
  | 'agent-sessions'
  | 'sdk-config'
  | 'agent-checkpoints'
  | 'workspaces'
  | 'conversations'
  | 'attachments'
  | 'session-blobs'
  | 'temp-files'

export interface StorageCategory {
  label: string
  key: StorageCategoryKey
  bytes: number
  count: number
  hasOrphans: boolean
  orphanBytes: number
  orphanCount: number
  /** 其中属于「仍存在但已归档」会话的占用；这类数据没有孤儿可清，只能显式回收。 */
  archivedBytes?: number
  archivedCount?: number
  /** 上面那部分占用涉及的会话数（按会话目录计，不是文件数）。 */
  archivedSessions?: number
}

export interface StorageStats {
  categories: StorageCategory[]
  totalBytes: number
  calculatedAt: number
}

export interface CleanupOptions {
  categories: StorageCategoryKey[]
  orphansOnly: boolean
  archivedBeforeDays: number
  /**
   * 回收仍存在但已归档会话的「可重建」数据（当前只有文件检查点）。
   *
   * 与 `archivedBeforeDays` 分开是有意的：归档只做收纳，删数据必须是显式且可预期的动作，
   * 不能因为用户调了「自动归档天数」就悄悄失去文件回退能力。
   */
  includeArchivedSessions?: boolean
}

export interface CleanupResult {
  freedBytes: number
  deletedCount: number
  errors: string[]
}

// ─── 工具函数 ───

// 扫描时跳过的已知大型目录，防止超大工作区阻塞主进程事件循环
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle',
  '.turbo', '.parcel-cache', '.svelte-kit', '.output',
])

// 单次扫描最大文件数上限，防止超大工作区导致无限递归
const MAX_FILE_SCAN = 100_000

/** 检查点目录布局：复制引擎的清单在每份快照子目录内，git 引擎的共享仓库在会话目录下。 */
const CHECKPOINT_COPY_MANIFEST = '.manifest.json'
const CHECKPOINT_SHADOW_REPO = 'shadow.git'

async function getDirSize(dirPath: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  if (!existsSync(dirPath)) return { bytes, count }

  // limit 对象通过闭包在整个递归树内共享，作为全局文件计数上限
  const limit = { remaining: MAX_FILE_SCAN }

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (limit.remaining <= 0) return
        const fullPath = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            await walk(fullPath)
          } else if (entry.isFile()) {
            const stat = await fsPromises.stat(fullPath)
            bytes += stat.size
            count++
            limit.remaining--
          }
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip inaccessible dir */ }
  }

  await walk(dirPath)
  return { bytes, count }
}

function safeUnlink(filePath: string): number {
  try {
    const size = statSync(filePath).size
    unlinkSync(filePath)
    return size
  } catch {
    return 0
  }
}

async function safeRmDir(dirPath: string): Promise<number> {
  try {
    const { bytes } = await getDirSize(dirPath)
    rmSync(dirPath, { recursive: true, force: true })
    return bytes
  } catch {
    return 0
  }
}

// ─── 会话文件名解析 ───

export type AgentSessionFileKind = 'messages' | 'graph' | 'pi-harness'

export interface ParsedAgentSessionFileName {
  /** 会话 ID（不是文件名前缀片段）。UUID 自身含 `-`，只能按后缀剥离。 */
  baseSessionId: string
  kind: AgentSessionFileKind
}

const PI_HARNESS_SUFFIX = '-pi-harness.jsonl'
const GRAPH_SUFFIX = '-graph.jsonl'
const JSONL_SUFFIX = '.jsonl'

/**
 * 把 agent-sessions 目录里的文件名解析成「会话 ID + 文件种类」。
 *
 * 同一会话可能落盘三种文件：`{id}.jsonl`（消息）、`{id}-graph.jsonl`（Graph 事件）、
 * `{id}-pi-harness.jsonl`（Pi 事件账本）。判定孤儿必须回到 `baseSessionId`，
 * 否则侧车文件去掉 `.jsonl` 后得到 `X-graph`，永远不可能命中 UUID 索引而被整体误删。
 *
 * 顺序不能反：`-pi-harness` 必须先于 `-graph` 匹配；也绝不能 `split('-')[0]`，UUID 本身含 `-`。
 * 无法识别的文件名（非 .jsonl、后缀前没有会话 ID）返回 null，调用方一律按「不可判定」处理。
 */
export function parseAgentSessionFileName(fileName: string): ParsedAgentSessionFileName | null {
  if (!fileName.endsWith(JSONL_SUFFIX)) return null

  if (fileName.endsWith(PI_HARNESS_SUFFIX)) {
    const baseSessionId = fileName.slice(0, -PI_HARNESS_SUFFIX.length)
    return baseSessionId ? { baseSessionId, kind: 'pi-harness' } : null
  }

  if (fileName.endsWith(GRAPH_SUFFIX)) {
    const baseSessionId = fileName.slice(0, -GRAPH_SUFFIX.length)
    return baseSessionId ? { baseSessionId, kind: 'graph' } : null
  }

  const baseSessionId = fileName.slice(0, -JSONL_SUFFIX.length)
  return baseSessionId ? { baseSessionId, kind: 'messages' } : null
}

// ─── 统计 ───

function getActiveSessionIds(): Set<string> {
  // 孤儿检测需要全量（含归档），否则归档会话的文件会被误判为孤儿
  return new Set(listAgentSessions(true).map((s) => s.id))
}

function getActiveSdkSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const s of listAgentSessions(true)) {
    if (s.sdkSessionId) ids.add(s.sdkSessionId)
    if (s.forkSourceSdkSessionId) ids.add(s.forkSourceSdkSessionId)
  }
  return ids
}

function getActiveWorkspaceSlugs(): Set<string> {
  return new Set(listAgentWorkspaces().map((w) => w.slug))
}

/**
 * 收集全部会话文件引用到的 blob 哈希。
 *
 * 用正则而不是逐行 JSON.parse：会话文件可达几百 MB，解析全部行代价过高。
 * 误匹配的代价是**单向安全**的——只会把某个哈希误加入「被引用」集合，
 * 导致对应的孤儿 blob 这次不被删（下次再说），**绝不会反过来误删在用数据**。
 *
 * ⚠️ 不要给这个结果加缓存：会话文件是追加写的，目录 mtime 不会因追加而变，
 * 任何基于 mtime 的缓存都可能漏掉新写的引用，从而删掉活数据。
 */
async function collectReferencedBlobHashes(): Promise<Set<string>> {
  const hashes = new Set<string>()
  const dir = getAgentSessionsDir()
  if (!existsSync(dir)) return hashes

  const pattern = /"hash"\s*:\s*"sha256:([0-9a-f]{64})"/g
  try {
    const files = await fsPromises.readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      try {
        const content = await fsPromises.readFile(join(dir, file), 'utf-8')
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(content)) !== null) hashes.add(match[1]!)
      } catch { /* 单个文件读失败不影响其余 */ }
    }
  } catch { /* 目录不可读时返回已收集的部分 */ }

  return hashes
}

/** 遍历 blob 目录，逐文件回调（跳过临时文件） */
async function walkBlobFiles(
  onFile: (filePath: string, fileName: string, size: number) => void,
): Promise<void> {
  const root = blobRootDir()
  if (!existsSync(root)) return

  const walk = async (dir: string): Promise<void> => {
    let entries: string[]
    try {
      entries = await fsPromises.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      try {
        const stat = await fsPromises.stat(full)
        if (stat.isDirectory()) await walk(full)
        else if (!entry.includes('.tmp-')) onFile(full, entry, stat.size)
      } catch { /* skip */ }
    }
  }

  await walk(root)
}

async function calcSessionBlobsCategory(): Promise<StorageCategory> {
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0
  const orphans: { path: string; size: number }[] = []

  // 先收集引用集，再判定孤儿——顺序不能反
  const referenced = await collectReferencedBlobHashes()
  await walkBlobFiles((filePath, fileName, size) => {
    bytes += size
    count++
    if (!referenced.has(fileName)) {
      orphanBytes += size
      orphanCount++
      orphans.push({ path: filePath, size })
    }
  })

  return {
    label: '会话外置内容',
    key: 'session-blobs',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

async function calcAgentSessionsCategory(): Promise<StorageCategory> {
  const dir = getAgentSessionsDir()
  const activeIds = getActiveSessionIds()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0

  if (existsSync(dir)) {
    try {
      const files = await fsPromises.readdir(dir)
      for (const file of files) {
        const parsed = parseAgentSessionFileName(file)
        // 非 .jsonl 完全不计；.jsonl 但解析不出会话 ID 的只计入总量，不计孤儿
        if (!parsed && !file.endsWith('.jsonl')) continue
        const fullPath = join(dir, file)
        try {
          const stat = await fsPromises.stat(fullPath)
          bytes += stat.size
          count++
          // 侧车文件与消息文件共用同一个 baseSessionId 判定，口径必须与清理一致
          if (parsed && !activeIds.has(parsed.baseSessionId)) {
            orphanBytes += stat.size
            orphanCount++
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: 'Agent 会话记录',
    key: 'agent-sessions',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

async function calcSdkConfigCategory(): Promise<StorageCategory> {
  const sdkDir = getSdkConfigDir()
  const activeSdkIds = getActiveSdkSessionIds()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0

  const projectsDir = join(sdkDir, 'projects')
  if (existsSync(projectsDir)) {
    try {
      const hashDirs = await fsPromises.readdir(projectsDir)
      for (const hashDir of hashDirs) {
        const projPath = join(projectsDir, hashDir)
        try {
          if (!(await fsPromises.lstat(projPath)).isDirectory()) continue
          const files = await fsPromises.readdir(projPath)
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue
            const fullPath = join(projPath, file)
            try {
              const stat = await fsPromises.stat(fullPath)
              const sdkId = basename(file, '.jsonl')
              bytes += stat.size
              count++
              if (!activeSdkIds.has(sdkId)) {
                orphanBytes += stat.size
                orphanCount++
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const fileHistoryDir = join(sdkDir, 'file-history')
  if (existsSync(fileHistoryDir)) {
    try {
      const sdkIds = await fsPromises.readdir(fileHistoryDir)
      for (const sdkId of sdkIds) {
        const histPath = join(fileHistoryDir, sdkId)
        try {
          if (!(await fsPromises.lstat(histPath)).isDirectory()) continue
          const sub = await getDirSize(histPath)
          bytes += sub.bytes
          count += sub.count
          if (!activeSdkIds.has(sdkId)) {
            orphanBytes += sub.bytes
            orphanCount += sub.count
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // sdk-config 其他子目录（sessions, backups 等）
  if (existsSync(sdkDir)) {
    try {
      const entries = await fsPromises.readdir(sdkDir)
      for (const entry of entries) {
        if (entry === 'projects' || entry === 'file-history') continue
        const fullPath = join(sdkDir, entry)
        try {
          const stat = await fsPromises.lstat(fullPath)
          if (stat.isDirectory()) {
            const sub = await getDirSize(fullPath)
            bytes += sub.bytes
            count += sub.count
          } else {
            bytes += stat.size
            count++
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: 'SDK 会话数据',
    key: 'sdk-config',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

/** 检查点目录里存的是被快照文件的副本或 git 对象，任何「跳过目录」都会让统计偏小。 */
async function getCheckpointDirSize(
  dirPath: string,
  budget = { remaining: 400_000 },
): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  if (!existsSync(dirPath)) return { bytes, count }

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget.remaining <= 0) return
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          bytes += (await fsPromises.stat(full)).size
          count++
          budget.remaining--
        }
      } catch { /* skip */ }
    }
  }

  await walk(dirPath)
  return { bytes, count }
}

/** 复制引擎的清单里直接记了字节数，不必再扫一遍文件。 */
async function readCopyCheckpointManifest(
  manifestPath: string,
): Promise<{ bytes: number; count: number } | null> {
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown; bytes?: unknown; files?: unknown }
    if (parsed.version !== 2 || typeof parsed.bytes !== 'number') return null
    return { bytes: parsed.bytes, count: Array.isArray(parsed.files) ? parsed.files.length : 0 }
  } catch {
    return null
  }
}

/**
 * 单个会话的检查点占用。
 *
 * git 引擎的清单只记了「仓库当时的总量」，多个检查点共用一个影子仓库时相加会重复计算，
 * 因此仓库本身单独精确统计；复制引擎的清单则每条都是自己的体积，直接相加即可。
 */
async function checkpointSessionUsage(sessionDir: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  let entries
  try {
    entries = await fsPromises.readdir(sessionDir, { withFileTypes: true })
  } catch {
    return { bytes, count }
  }

  for (const entry of entries) {
    const full = join(sessionDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === CHECKPOINT_SHADOW_REPO) continue
      const manifest = await readCopyCheckpointManifest(join(full, CHECKPOINT_COPY_MANIFEST))
      if (manifest) {
        bytes += manifest.bytes
        count += manifest.count
        continue
      }
      // 没有清单的目录（中断残留）按实际占用算，否则会漏算
      const sub = await getCheckpointDirSize(full)
      bytes += sub.bytes
      count += sub.count
      continue
    }
    if (!entry.isFile()) continue
    try {
      bytes += (await fsPromises.stat(full)).size
      count++
    } catch { /* skip */ }
  }

  const repo = join(sessionDir, CHECKPOINT_SHADOW_REPO)
  if (existsSync(repo)) {
    const sub = await getCheckpointDirSize(repo)
    bytes += sub.bytes
    count += sub.count
  }

  return { bytes, count }
}

/**
 * 文件检查点（Pi 每轮编辑前的基线快照）。
 *
 * 这块以前完全不在统计范围内：`du ~/.profer` 与设置页「存储用量」相差的那几个 GB
 * 就是它。它也无法用「孤儿」概念处理——占用最大的往往是**已归档但还活着**的会话。
 */
async function calcCheckpointsCategory(): Promise<StorageCategory> {
  const dir = getPiCheckpointsDir()
  const sessions = listAgentSessions(true)
  const knownIds = new Set(sessions.map((s) => s.id))
  const archivedIds = new Set(sessions.filter((s) => s.archived).map((s) => s.id))
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0
  let archivedBytes = 0, archivedCount = 0, archivedSessions = 0

  if (existsSync(dir)) {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const usage = await checkpointSessionUsage(join(dir, entry.name))
        bytes += usage.bytes
        count += usage.count
        if (!knownIds.has(entry.name)) {
          orphanBytes += usage.bytes
          orphanCount += usage.count
        } else if (archivedIds.has(entry.name)) {
          archivedBytes += usage.bytes
          archivedCount += usage.count
          archivedSessions++
        }
      }
    } catch { /* 目录不可读时返回已统计的部分 */ }
  }

  return {
    label: '文件检查点',
    key: 'agent-checkpoints',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
    archivedBytes, archivedCount, archivedSessions,
  }
}

async function calcWorkspacesCategory(): Promise<StorageCategory> {
  const wsDir = getAgentWorkspacesDir()
  const activeIds = getActiveSessionIds()
  const activeSlugs = getActiveWorkspaceSlugs()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0

  if (existsSync(wsDir)) {
    try {
      const slugs = await fsPromises.readdir(wsDir)
      for (const slug of slugs) {
        const slugDir = join(wsDir, slug)
        try {
          if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
          const entries = await fsPromises.readdir(slugDir)
          for (const entry of entries) {
            const entryPath = join(slugDir, entry)
            try {
              if (!(await fsPromises.lstat(entryPath)).isDirectory()) continue
              // workspace-files, skills, skills-inactive 等元目录不算孤儿；
              // sessions 是 project 旧布局的会话容器（新布局已进项目内），
              // 整体计入占用、不按孤儿处理，避免把旧会话运行时数据当垃圾删掉。
              if (['workspace-files', 'skills', 'skills-inactive', '.claude-plugin', 'sessions'].includes(entry)) {
                const sub = await getDirSize(entryPath)
                bytes += sub.bytes
                count += sub.count
                continue
              }
              const sub = await getDirSize(entryPath)
              bytes += sub.bytes
              count += sub.count
              // session 目录的 ID 不在活跃列表中 → 孤儿
              if (!activeIds.has(entry) && !activeSlugs.has(entry)) {
                orphanBytes += sub.bytes
                orphanCount++
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: '工作区文件',
    key: 'workspaces',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

async function calcConversationsCategory(): Promise<StorageCategory> {
  const dir = getConversationsDir()
  const { bytes, count } = await getDirSize(dir)
  return {
    label: '对话记录',
    key: 'conversations',
    bytes, count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
  }
}

async function calcAttachmentsCategory(): Promise<StorageCategory> {
  const dir = getAttachmentsDir()
  const { bytes, count } = await getDirSize(dir)
  return {
    label: '附件文件',
    key: 'attachments',
    bytes, count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
  }
}

async function calcTempFilesCategory(): Promise<StorageCategory> {
  const previewDir = join(tmpdir(), 'profer-preview')
  const installerDir = join(app.getPath('temp'), 'profer-installers')
  const [preview, installer] = await Promise.all([
    getDirSize(previewDir),
    getDirSize(installerDir),
  ])
  return {
    label: '临时预览/安装文件',
    key: 'temp-files',
    bytes: preview.bytes + installer.bytes,
    count: preview.count + installer.count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
  }
}

export async function calculateStorageStats(): Promise<StorageStats> {
  const categories = await Promise.all([
    calcAgentSessionsCategory(),
    calcSdkConfigCategory(),
    calcCheckpointsCategory(),
    calcWorkspacesCategory(),
    calcConversationsCategory(),
    calcAttachmentsCategory(),
    calcSessionBlobsCategory(),
    calcTempFilesCategory(),
  ])
  return {
    categories,
    totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
    calculatedAt: Date.now(),
  }
}

// ─── 清理 ───

export async function cleanupTempFiles(): Promise<CleanupResult> {
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const previewDir = join(tmpdir(), 'profer-preview')
  if (existsSync(previewDir)) {
    try {
      const files = await fsPromises.readdir(previewDir)
      for (const file of files) {
        const freed = safeUnlink(join(previewDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理预览文件失败: ${e}`)
    }
  }

  const installerDir = join(app.getPath('temp'), 'profer-installers')
  if (existsSync(installerDir)) {
    try {
      const files = await fsPromises.readdir(installerDir)
      for (const file of files) {
        const freed = safeUnlink(join(installerDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理安装文件失败: ${e}`)
    }
  }

  if (freedBytes > 0) {
    console.log(`[存储清理] 临时文件: 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${deletedCount} 个文件`)
  }
  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanAgentSessions(): Promise<CleanupResult> {
  const dir = getAgentSessionsDir()
  const activeIds = getActiveSessionIds()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(dir)) return { freedBytes, deletedCount, errors }

  try {
    const files = await fsPromises.readdir(dir)
    for (const file of files) {
      const parsed = parseAgentSessionFileName(file)
      // 解析不出会话 ID 的文件不删：删除不可逆，宁可漏清也不能误删
      if (!parsed) continue
      if (activeIds.has(parsed.baseSessionId)) continue
      const freed = safeUnlink(join(dir, file))
      if (freed > 0) { freedBytes += freed; deletedCount++ }
    }
  } catch (e) {
    errors.push(`清理孤儿会话文件失败: ${e}`)
  }

  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanSdkConfig(): Promise<CleanupResult> {
  const sdkDir = getSdkConfigDir()
  const activeSdkIds = getActiveSdkSessionIds()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const projectsDir = join(sdkDir, 'projects')
  if (existsSync(projectsDir)) {
    try {
      const hashDirs = await fsPromises.readdir(projectsDir)
      for (const hashDir of hashDirs) {
        const projPath = join(projectsDir, hashDir)
        try {
          if (!(await fsPromises.lstat(projPath)).isDirectory()) continue
          const files = await fsPromises.readdir(projPath)
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue
            const sdkId = basename(file, '.jsonl')
            if (activeSdkIds.has(sdkId)) continue
            const freed = safeUnlink(join(projPath, file))
            if (freed > 0) { freedBytes += freed; deletedCount++ }
          }
          // 若目录为空则删除
          const remaining = await fsPromises.readdir(projPath)
          if (remaining.length === 0) {
            rmSync(projPath, { recursive: true, force: true })
          }
        } catch { /* skip */ }
      }
    } catch (e) {
      errors.push(`清理孤儿 SDK projects 失败: ${e}`)
    }
  }

  const fileHistoryDir = join(sdkDir, 'file-history')
  if (existsSync(fileHistoryDir)) {
    try {
      const sdkIds = await fsPromises.readdir(fileHistoryDir)
      for (const sdkId of sdkIds) {
        if (activeSdkIds.has(sdkId)) continue
        const histPath = join(fileHistoryDir, sdkId)
        try {
          if (!(await fsPromises.lstat(histPath)).isDirectory()) continue
          const freed = await safeRmDir(histPath)
          if (freed > 0) { freedBytes += freed; deletedCount++ }
        } catch { /* skip */ }
      }
    } catch (e) {
      errors.push(`清理孤儿 file-history 失败: ${e}`)
    }
  }

  return { freedBytes, deletedCount, errors }
}

/**
 * 清理没被任何会话引用的外置载荷（孤立 blob）。
 *
 * 会话被删除后，它的载荷不会自动消失——需要靠引用集反查出来。
 * **顺序必须是「先建引用集、再删」**，反过来会删掉在用数据。
 */
async function cleanupOrphanSessionBlobs(): Promise<CleanupResult> {
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const referenced = await collectReferencedBlobHashes()
  await walkBlobFiles((filePath, fileName) => {
    if (referenced.has(fileName)) return
    const freed = safeUnlink(filePath)
    if (freed > 0) { freedBytes += freed; deletedCount++ }
  })

  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanWorkspaces(): Promise<CleanupResult> {
  const wsDir = getAgentWorkspacesDir()
  const activeIds = getActiveSessionIds()
  const activeSlugs = getActiveWorkspaceSlugs()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(wsDir)) return { freedBytes, deletedCount, errors }

  try {
    const slugs = await fsPromises.readdir(wsDir)
    for (const slug of slugs) {
      const slugDir = join(wsDir, slug)
      try {
        if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
        const entries = await fsPromises.readdir(slugDir)
        for (const entry of entries) {
          if (['workspace-files', 'skills', 'skills-inactive', '.claude-plugin', '.claude', 'sessions'].includes(entry)) continue
          const entryPath = join(slugDir, entry)
          try {
            if (!(await fsPromises.lstat(entryPath)).isDirectory()) continue
            if (activeIds.has(entry) || activeSlugs.has(entry)) continue
            const freed = await safeRmDir(entryPath)
            if (freed > 0) { freedBytes += freed; deletedCount++ }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (e) {
    errors.push(`清理孤儿工作区目录失败: ${e}`)
  }

  return { freedBytes, deletedCount, errors }
}

/**
 * 建一份 Pi 原生会话文件索引（sessionId → 文件）。
 *
 * 不能用文件名片段匹配来定位：Pi 的文件名是 `{时间戳}_{sessionId}.jsonl`，而删除是不可逆的，
 * 只能认 header 里的 `type=session` + `id`。索引只扫一遍，避免每个已归档会话都全目录重扫。
 */
async function indexPiSessionFiles(): Promise<Map<string, { path: string; bytes: number }>> {
  const index = new Map<string, { path: string; bytes: number }>()
  const dir = join(getSdkConfigDir(), 'sessions', 'pi')
  if (!existsSync(dir)) return index

  let files: string[]
  try {
    files = await fsPromises.readdir(dir)
  } catch {
    return index
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const full = join(dir, file)
    try {
      const stat = await fsPromises.stat(full)
      const handle = await fsPromises.open(full, 'r')
      let headerLine = ''
      try {
        const buffer = Buffer.alloc(512)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        headerLine = buffer.subarray(0, bytesRead).toString('utf-8').split('\n', 1)[0] ?? ''
      } finally {
        await handle.close()
      }
      const header = headerLine ? JSON.parse(headerLine) as { type?: unknown; id?: unknown } : undefined
      if (header?.type === 'session' && typeof header.id === 'string') {
        index.set(header.id, { path: full, bytes: stat.size })
      }
    } catch { /* 损坏或非 Pi 的 JSONL 不参与匹配 */ }
  }

  return index
}

async function cleanupArchivedSessions(beforeDays: number): Promise<CleanupResult> {
  const cutoff = Date.now() - beforeDays * 24 * 60 * 60 * 1000
  const sessions = listAgentSessions(true)
  const sdkDir = getSdkConfigDir()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const victims = sessions.filter((session) => session.archived && session.updatedAt <= cutoff)
  if (victims.length === 0) return { freedBytes, deletedCount, errors }

  // Pi 原生会话文件与 agent-sessions 是两份不同的落盘：只删后者会留下整份 SDK 记录。
  // 先去重再建索引：没命中就不必扫全目录。
  const piSessionFiles = victims.some((session) => session.sdkSessionId)
    ? await indexPiSessionFiles()
    : new Map<string, { path: string; bytes: number }>()

  for (const session of victims) {
    // 删除 JSONL 消息文件
    const msgPath = join(getAgentSessionsDir(), `${session.id}.jsonl`)
    if (existsSync(msgPath)) {
      const freed = safeUnlink(msgPath)
      if (freed > 0) { freedBytes += freed; deletedCount++ }
    }

    // Pi 原生 session JSONL（resume 用的就是它）
    const sdkSessionId = session.sdkSessionId
    const piFile = sdkSessionId ? piSessionFiles.get(sdkSessionId) : undefined
    if (sdkSessionId && piFile) {
      const freed = safeUnlink(piFile.path)
      if (freed > 0) { freedBytes += freed; deletedCount++ }
      piSessionFiles.delete(sdkSessionId)
    }

    // 清理 SDK file-history（同步删除，safeRmDir 的同步路径）
    if (sdkSessionId) {
      const histDir = join(sdkDir, 'file-history', sdkSessionId)
      if (existsSync(histDir)) {
        try {
          rmSync(histDir, { recursive: true, force: true })
          deletedCount++
        } catch { /* skip */ }
      }
    }
  }

  if (freedBytes > 0) {
    console.log(`[存储清理] 归档数据: 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${deletedCount} 项`)
  }
  return { freedBytes, deletedCount, errors }
}

/**
 * 回收文件检查点。
 *
 * 两种范围互不重叠：
 * - `orphansOnly`：会话已经不存在的残留目录；
 * - `includeArchivedSessions`：仍存在但已归档会话的检查点。这是**显式**动作，
 *   删后这些会话失去文件回退能力（对话记录不受影响），因此不能跟归档本身绑在一起。
 */
async function cleanupCheckpoints(options: {
  orphansOnly: boolean
  includeArchivedSessions?: boolean
}): Promise<CleanupResult> {
  const dir = getPiCheckpointsDir()
  const sessions = listAgentSessions(true)
  const knownIds = new Set(sessions.map((s) => s.id))
  const archivedIds = new Set(sessions.filter((s) => s.archived).map((s) => s.id))
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(dir)) return { freedBytes, deletedCount, errors }

  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const exists = knownIds.has(entry.name)
      const target = options.orphansOnly
        ? !exists
        : Boolean(options.includeArchivedSessions) && exists && archivedIds.has(entry.name)
      if (!target) continue

      const sessionDir = join(dir, entry.name)
      // 先量后删：删完就不知道释放了多少
      const usage = await checkpointSessionUsage(sessionDir)
      removePiFileCheckpoints(dir, entry.name)
      if (existsSync(sessionDir)) {
        errors.push(`删除检查点失败: ${entry.name}`)
        continue
      }
      freedBytes += usage.bytes
      deletedCount += 1
    }
  } catch (e) {
    errors.push(`清理文件检查点失败: ${e}`)
  }

  if (freedBytes > 0) {
    console.log(`[存储清理] 文件检查点: 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${deletedCount} 个会话快照`)
  }
  return { freedBytes, deletedCount, errors }
}

export async function cleanupStorage(options: CleanupOptions): Promise<CleanupResult> {
  let totalFreed = 0, totalDeleted = 0
  const allErrors: string[] = []

  const merge = (r: CleanupResult) => {
    totalFreed += r.freedBytes
    totalDeleted += r.deletedCount
    allErrors.push(...r.errors)
  }

  for (const cat of options.categories) {
    if (cat === 'temp-files') {
      merge(await cleanupTempFiles())
      continue
    }

    if (options.orphansOnly) {
      switch (cat) {
        case 'agent-sessions': merge(await cleanupOrphanAgentSessions()); break
        case 'sdk-config': merge(await cleanupOrphanSdkConfig()); break
        case 'agent-checkpoints': merge(await cleanupCheckpoints({ orphansOnly: true })); break
        case 'workspaces': merge(await cleanupOrphanWorkspaces()); break
        case 'session-blobs': merge(await cleanupOrphanSessionBlobs()); break
      }
    } else if (cat === 'agent-checkpoints' && options.includeArchivedSessions) {
      merge(await cleanupCheckpoints({ orphansOnly: false, includeArchivedSessions: true }))
    } else if (options.archivedBeforeDays > 0) {
      if (cat === 'agent-sessions' || cat === 'sdk-config') {
        merge(await cleanupArchivedSessions(options.archivedBeforeDays))
      }
    }
  }

  if (totalFreed > 0) {
    console.log(`[存储清理] 总计释放 ${(totalFreed / 1024 / 1024).toFixed(1)} MB, 删除 ${totalDeleted} 项`)
  }
  return { freedBytes: totalFreed, deletedCount: totalDeleted, errors: allErrors }
}
