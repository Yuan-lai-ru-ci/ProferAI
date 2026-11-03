/**
 * 工作区文件监听器（多根）
 *
 * 监听两类根，事件语义一致、来源不同：
 * 1. **managed**：`~/.profer/agent-workspaces/` 递归监听（存量行为，逐字保留）。
 * 2. **project**：每个项目工作区的 `<rootPath>/.profer` 单独一个 watcher。
 *    项目源码树（`.profer` 之外）**不监听**——源码变化交给 git diff / 预览链路。
 *
 * 根据变化的文件路径区分事件类型：
 * - mcp.json / mcp.local.json / skills/ / presets/ 变化 → 推送 CAPABILITIES_CHANGED（侧边栏刷新）
 * - 其他文件变化 → 推送 WORKSPACE_FILES_CHANGED（文件浏览器刷新）
 *
 * 同时支持监听附加目录（外部路径），变化时统一推送 WORKSPACE_FILES_CHANGED。
 *
 * project 的 `.profer` 会随工作区创建/移除增删：watcher 监听中央索引
 * （`<configRoot>/agent-workspaces.json`）的变化做增量同步，调用方也可直接调
 * `syncProjectWorkspaceWatchers()`。所有监听器按目录去重，不会重复监听。
 *
 * 所有事件均做 debounce 防抖，避免高频文件操作导致渲染进程风暴。
 *
 * 平台说明：不用 chokidar，沿用现有 `fs.watch`（本机 FSEvents 递归派发不完整时的既有方案）。
 */

import { watch, existsSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@profer/shared'
import type { AgentWorkspace, WorkspaceStorageMode } from '@profer/shared'
import { getAgentWorkspacesDir, getAgentWorkspacesIndexPath } from './config-paths'
import { resolveWorkspaceLocation } from './workspace-locator'
import { listAgentWorkspaces, getWorkspaceAttachedDirectories } from './agent-workspace-manager'

/** debounce 延迟（ms） */
const DEBOUNCE_MS = 300

/** watcher 'error' 事件后的自愈重启延迟（ms），避免对持续故障状态紧密重试 */
const WATCHER_RESTART_DELAY_MS = 5000

// 高频变动目录：跳过其中的变更事件，防止 node_modules / .next 等产生 IPC 事件风暴
const HIGH_NOISE_SEGMENTS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit',
])

function isHighNoisePath(normalizedPath: string): boolean {
  return normalizedPath.split('/').some((seg) => HIGH_NOISE_SEGMENTS.has(seg))
}

/**
 * project `.profer` 内不监听的顶层目录：
 * - `sessions/`：会话运行时数据（高频写，且不属于工作区资产）
 * - `cache/`：可再生的缓存
 */
const PROJECT_IGNORED_TOP_SEGMENTS = new Set(['sessions', 'cache', '.lock', 'tmp'])

/** `.profer` 顶层或直接文件名中，属于「能力」（侧边栏）而非「文件树」的部分。 */
const PROJECT_CAPABILITY_DIRS = new Set(['skills', 'skills-inactive', 'presets'])
const PROJECT_CAPABILITY_FILES = new Set(['mcp.json', 'mcp.local.json', 'agent-presets.json'])

let watcher: FSWatcher | null = null

/** 中央索引监听器：project 工作区增删后据此增删 `.profer` 根。 */
let indexWatcher: FSWatcher | null = null

interface ProjectWatcherEntry {
  watcher: FSWatcher
  slug: string
}

/** project `.profer` 监听器：key = configDir（`<rootPath>/.profer`） */
const projectWatchers = new Map<string, ProjectWatcherEntry>()

/** 索引变化后的重同步防抖定时器 */
let projectSyncTimer: ReturnType<typeof setTimeout> | null = null

/** 附加目录监听器：路径 → FSWatcher */
const attachedWatchers = new Map<string, FSWatcher>()
/** 附加目录防抖定时器 */
let attachedFilesTimer: ReturnType<typeof setTimeout> | null = null
/** 能力变化（MCP / Skills / 预设）防抖定时器，所有根共用 */
let capabilitiesTimer: ReturnType<typeof setTimeout> | null = null
/** 工作区文件变化防抖定时器，所有根共用 */
let filesTimer: ReturnType<typeof setTimeout> | null = null
/** 主窗口引用（供所有监听器使用） */
let mainWin: BrowserWindow | null = null

/** project 监听根（只读视图，供测试与诊断）。 */
export interface ProjectWatchRoot {
  slug: string
  /** 项目根（locator 归一化后） */
  rootPath: string
  /** 实际监听的目录：`<rootPath>/.profer` */
  configDir: string
}

/**
 * 纯函数：从工作区清单算出应当监听的项目 `.profer` 目录。
 *
 * 规则：
 * - 只取 `mode === 'project'`（locator 的结论是唯一真相源，异常条目按 managed）；
 * - 按 `configDir` 去重（同一项目不会被监听两次）；
 * - `.profer` 尚不存在时跳过（不监听、也不 mkdir，I4）。
 *
 * 传入 `locate` / `dirExists` 只为可测试性，生产调用一律用缺省实现。
 */
export function computeProjectWatchRoots(
  workspaces: ReadonlyArray<Pick<AgentWorkspace, 'slug' | 'storageMode'>>,
  locate: (slug: string) => { configDir: string; rootPath: string; mode: WorkspaceStorageMode } = resolveWorkspaceLocation,
  dirExists: (path: string) => boolean = existsSync,
): ProjectWatchRoot[] {
  const roots: ProjectWatchRoot[] = []
  const seen = new Set<string>()

  for (const workspace of workspaces) {
    if (typeof workspace?.slug !== 'string' || workspace.slug.length === 0) continue
    const location = locate(workspace.slug)
    if (location.mode !== 'project') continue
    if (seen.has(location.configDir)) continue
    if (!dirExists(location.configDir)) continue
    seen.add(location.configDir)
    roots.push({ slug: workspace.slug, rootPath: location.rootPath, configDir: location.configDir })
  }

  return roots
}

/** 当前实际被监听的 project `.profer` 目录（排序后，只读）。 */
export function getWatchedProjectConfigDirs(): string[] {
  return [...projectWatchers.keys()].sort()
}

/** 所有监听根的只读清单：managed 根 + 每个 project `.profer`。 */
export function getWatchedRoots(): { managedDir: string; projectConfigDirs: string[] } {
  return { managedDir: getAgentWorkspacesDir(), projectConfigDirs: getWatchedProjectConfigDirs() }
}

function scheduleCapabilitiesChanged(): void {
  if (capabilitiesTimer) clearTimeout(capabilitiesTimer)
  capabilitiesTimer = setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED)
    }
    capabilitiesTimer = null
  }, DEBOUNCE_MS)
}

function scheduleWorkspaceFilesChanged(): void {
  if (filesTimer) clearTimeout(filesTimer)
  filesTimer = setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED)
    }
    filesTimer = null
  }, DEBOUNCE_MS)
}

/**
 * 启动工作区文件监听
 *
 * @param win 主窗口引用，用于向渲染进程推送事件
 */
export function startWorkspaceWatcher(win: BrowserWindow): void {
  mainWin = win

  // 恢复工作区级附加目录监听（独立于根目录 watcher；即使根目录不存在也应恢复）
  restoreWorkspaceAttachedWatchers()

  startManagedWatcher(win)
  startIndexWatcher(win)
  syncProjectWorkspaceWatchers()
}

/** managed 根：`~/.profer/agent-workspaces/` 递归监听（存量行为）。 */
function startManagedWatcher(win: BrowserWindow): void {
  if (watcher) return

  const watchDir = getAgentWorkspacesDir()

  if (!existsSync(watchDir)) {
    console.warn('[工作区监听] 目录不存在，跳过:', watchDir)
    return
  }

  try {
    watcher = watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || win.isDestroyed()) return

      // filename 格式: {slug}/mcp.json 或 {slug}/skills/xxx/SKILL.md 或 {slug}/{sessionId}/file.txt
      const normalizedFilename = filename.toString().replace(/\\/g, '/')

      // 以 '.' 开头的相对路径：隐藏文件（.DS_Store 等）或 FSEvents 把父目录变更
      // 报成的残缺名（如 '.json'）。managed 根下只有工作区目录，一律忽略。
      if (normalizedFilename.startsWith('.')) return

      // 跳过 node_modules / .next 等高频变动目录，防止大规模工作区触发 IPC 事件风暴
      if (isHighNoisePath(normalizedFilename)) return

      const pathParts = normalizedFilename.split('/').filter(Boolean)

      // 仅忽略工作区顶层 config.json；会话目录内同名文件仍属于用户文件。
      if (pathParts.length === 2 && pathParts[1] === 'config.json') {
        return
      }

      const isCapabilitiesChange =
        normalizedFilename.endsWith('/mcp.json') ||
        normalizedFilename.includes('/skills/')

      if (isCapabilitiesChange) {
        // MCP/Skills 变化 → 通知侧边栏刷新
        scheduleCapabilitiesChanged()
      } else {
        // 其他文件变化 → 通知文件浏览器刷新
        scheduleWorkspaceFilesChanged()
      }
    })

    // EventEmitter 在 'error' 事件无监听器时会抛出未捕获异常并终止 Electron 主进程，
    // 当目录被删除/权限变更/iCloud 同步异常等运行时错误发生时即触发。必须显式监听并降级。
    watcher.on('error', (err) => {
      console.error('[工作区监听] 运行时错误，将尝试自愈重启:', err)
      try { watcher?.close() } catch { /* watcher 可能已自动关闭 */ }
      watcher = null
      setTimeout(() => {
        if (!win.isDestroyed() && !watcher) startManagedWatcher(win)
      }, WATCHER_RESTART_DELAY_MS)
    })

    console.log('[工作区监听] 已启动文件监听:', watchDir)
  } catch (error) {
    console.error('[工作区监听] 启动失败:', error)
  }
}

/**
 * 中央索引监听：`<configRoot>/agent-workspaces.json` 变化 → 重算 project 根集合。
 *
 * 这是「工作区增删后动态增删 watcher」的触发点。索引写入走原子替换
 * （tmp + rename），因此按 basename 过滤即可，无需比对内容。
 */
function startIndexWatcher(win: BrowserWindow): void {
  if (indexWatcher) return

  const indexPath = getAgentWorkspacesIndexPath()
  const configRoot = dirname(indexPath)
  const indexName = basename(indexPath)

  if (!existsSync(configRoot)) {
    console.warn('[项目监听] 配置根不存在，跳过索引监听:', configRoot)
    return
  }

  try {
    indexWatcher = watch(configRoot, { recursive: false }, (_eventType, filename) => {
      // filename 为 null 时无法判定，保守重同步（成本只是一次索引读取）
      if (filename && basename(filename.toString()) !== indexName) return
      if (projectSyncTimer) clearTimeout(projectSyncTimer)
      projectSyncTimer = setTimeout(() => {
        projectSyncTimer = null
        if (!win.isDestroyed()) syncProjectWorkspaceWatchers()
      }, DEBOUNCE_MS)
    })

    indexWatcher.on('error', (err) => {
      console.error('[项目监听] 索引监听运行时错误，移除监听器:', err)
      try { indexWatcher?.close() } catch { /* 已关闭 */ }
      indexWatcher = null
    })

    console.log('[项目监听] 已监听工作区索引:', indexPath)
  } catch (error) {
    console.error('[项目监听] 索引监听启动失败:', error)
  }
}

/**
 * 同步 project 监听根集合：新增缺的、关掉多余的。
 *
 * 索引写入后（以及启动时）调用；重复调用无副作用。
 */
export function syncProjectWorkspaceWatchers(): void {
  let desired: ProjectWatchRoot[]
  try {
    desired = computeProjectWatchRoots(listAgentWorkspaces())
  } catch (error) {
    console.error('[项目监听] 解析工作区清单失败，保留现有监听:', error)
    return
  }

  const desiredDirs = new Set(desired.map((root) => root.configDir))

  for (const [configDir, entry] of [...projectWatchers]) {
    if (desiredDirs.has(configDir)) continue
    try { entry.watcher.close() } catch { /* 已关闭 */ }
    projectWatchers.delete(configDir)
    console.log('[项目监听] 已停止:', configDir, `(${entry.slug})`)
  }

  for (const root of desired) {
    watchProjectConfigDir(root.slug, root.configDir)
  }
}

/** 过滤 project `.profer` 内不该产生任何事件的相对路径。 */
function shouldIgnoreProjectPath(relativePath: string): boolean {
  const parts = relativePath.split('/').filter(Boolean)
  const top = parts[0]
  if (top === undefined) return true
  // sessions/ 与 cache/ 只认顶层：`skills/sessions/x` 属于技能内容，仍应刷新
  if (PROJECT_IGNORED_TOP_SEGMENTS.has(top)) return true
  if (parts.some((seg) => HIGH_NOISE_SEGMENTS.has(seg))) return true
  // 顶层 config.json（附加目录等本机配置）：与 managed 一致，不触发文件树刷新
  if (parts.length === 1 && top === 'config.json') return true
  // 顶层隐藏条目（.gitignore / .DS_Store / FSEvents 残缺名）：不产生刷新
  if (parts.length === 1 && top.startsWith('.')) return true
  return false
}

/** project `.profer` 内的能力变更判定（MCP / Skills / 预设 → 侧边栏刷新）。 */
function isProjectCapabilitiesPath(relativePath: string): boolean {
  const parts = relativePath.split('/').filter(Boolean)
  const top = parts[0]
  if (top === undefined) return false
  // 能力目录（skills/、presets/…）内部的任何变动都算能力变更
  if (PROJECT_CAPABILITY_DIRS.has(top)) return true
  // 能力文件只认顶层：`workspace-files/mcp.json` 这类用户文件走文件树刷新
  return parts.length === 1 && PROJECT_CAPABILITY_FILES.has(top)
}

/** 单个 project `.profer` 监听（按 configDir 去重）。 */
function watchProjectConfigDir(slug: string, configDir: string): void {
  if (projectWatchers.has(configDir)) return
  if (!existsSync(configDir)) return

  try {
    const w = watch(configDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !mainWin || mainWin.isDestroyed()) return

      const relativePath = filename.toString().replace(/\\/g, '/')
      if (shouldIgnoreProjectPath(relativePath)) return

      if (isProjectCapabilitiesPath(relativePath)) {
        scheduleCapabilitiesChanged()
      } else {
        scheduleWorkspaceFilesChanged()
      }
    })

    // 同主 watcher：必须监听 'error'，否则运行时异常会终止主进程。
    w.on('error', (err) => {
      console.error('[项目监听] 运行时错误，移除监听器:', configDir, err)
      try { w.close() } catch { /* 已关闭 */ }
      projectWatchers.delete(configDir)
    })

    projectWatchers.set(configDir, { watcher: w, slug })
    console.log('[项目监听] 已启动:', configDir, `(${slug})`)
  } catch (error) {
    console.error('[项目监听] 启动失败:', configDir, error)
  }
}

/**
 * 停止工作区文件监听
 */
export function stopWorkspaceWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
    console.log('[工作区监听] 已停止')
  }

  if (indexWatcher) {
    indexWatcher.close()
    indexWatcher = null
  }
  if (projectSyncTimer) {
    clearTimeout(projectSyncTimer)
    projectSyncTimer = null
  }
  for (const [configDir, entry] of projectWatchers) {
    entry.watcher.close()
    console.log('[项目监听] 已停止:', configDir)
  }
  projectWatchers.clear()

  if (capabilitiesTimer) {
    clearTimeout(capabilitiesTimer)
    capabilitiesTimer = null
  }
  if (filesTimer) {
    clearTimeout(filesTimer)
    filesTimer = null
  }

  // 同时清理所有附加目录监听器
  for (const [dirPath, w] of attachedWatchers) {
    w.close()
    console.log('[附加目录监听] 已停止:', dirPath)
  }
  attachedWatchers.clear()
  mainWin = null
}

/**
 * 启动后恢复所有工作区级附加目录的文件监听。
 *
 * 会话级附加目录由 LIST_SESSIONS 恢复（见 ipc.ts），但工作区级附加目录持久化在各工作区
 * config.json 的 attachedDirectories 里，启动时若不主动恢复，重启后目录变更不会再触发
 * 文件树刷新（需手动重新附加才能恢复）。对应上游 Profer issue #1314。
 *
 * watchAttachedDirectory 内部按路径去重，工作区级与会话级附加同一目录不会重复监听。
 */
export function restoreWorkspaceAttachedWatchers(): void {
  let restored = 0
  try {
    const workspaces = listAgentWorkspaces()
    for (const ws of workspaces) {
      // 单个工作区失败（典型：project 的 rootPath 被移走 → WorkspaceRootMissingError）
      // 不得中断其余工作区的恢复，否则一个失效项目会让所有附加目录监听失效。
      try {
        const dirs = getWorkspaceAttachedDirectories(ws.slug)
        for (const dir of dirs) {
          watchAttachedDirectory(dir)
          restored++
        }
      } catch (error) {
        console.warn('[工作区监听] 跳过失效工作区的附加目录恢复:', ws.slug, error)
      }
    }
    if (restored > 0) {
      console.log(`[工作区监听] 已恢复 ${restored} 个工作区级附加目录监听`)
    }
  } catch (error) {
    console.error('[工作区监听] 恢复工作区级附加目录监听失败:', error)
  }
}

/**
 * 开始监听附加目录
 * 当目录内文件变化时，推送 WORKSPACE_FILES_CHANGED 事件
 */
export function watchAttachedDirectory(dirPath: string): void {
  if (attachedWatchers.has(dirPath)) return
  if (!existsSync(dirPath)) {
    console.warn('[附加目录监听] 目录不存在，跳过:', dirPath)
    return
  }

  try {
    const w = watch(dirPath, { recursive: true }, (_eventType, filename) => {
      if (!mainWin || mainWin.isDestroyed()) return

      // 过滤高频噪声目录（node_modules / .git 等），防止大规模附加目录产生 IPC 事件风暴
      if (filename) {
        const normalized = filename.toString().replace(/\\/g, '/')
        if (isHighNoisePath(normalized)) return
      }

      // 统一防抖：所有附加目录变化合并为一次刷新
      if (attachedFilesTimer) clearTimeout(attachedFilesTimer)
      attachedFilesTimer = setTimeout(() => {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED)
        }
        attachedFilesTimer = null
      }, DEBOUNCE_MS)
    })

    // 同主 watcher：监听 'error' 防止运行时异常拖死主进程。
    // 附加目录通常是用户外接的项目目录，断电/挂载/权限变化更易触发。
    w.on('error', (err) => {
      console.error('[附加目录监听] 运行时错误，移除监听器:', dirPath, err)
      try { w.close() } catch { /* 已关闭 */ }
      attachedWatchers.delete(dirPath)
    })

    attachedWatchers.set(dirPath, w)
    console.log('[附加目录监听] 已启动:', dirPath)
  } catch (error) {
    console.error('[附加目录监听] 启动失败:', dirPath, error)
  }
}

/**
 * 停止监听附加目录
 */
export function unwatchAttachedDirectory(dirPath: string): void {
  const w = attachedWatchers.get(dirPath)
  if (w) {
    w.close()
    attachedWatchers.delete(dirPath)
    console.log('[附加目录监听] 已停止:', dirPath)
  }
}
