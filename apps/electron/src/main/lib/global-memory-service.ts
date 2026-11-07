/**
 * 全局用户记忆 —— Electron 主进程适配层。
 *
 * 真正的实现已下沉到 `@profer/user-memory`，与 profer CLI 共用同一份代码。
 * 这里只做一件事：把「配置目录从哪来」接上主进程的 `getConfigDir()`
 * （它负责 `app.isPackaged` 探测、旧目录迁移和 0700 权限收紧）。
 *
 * 为什么保留这一层而不是让调用方直接用包：
 * - 主进程有 20+ 处调用点，保持原函数签名可以零改动迁移；
 * - 配置目录解析属于宿主职责，不应该让 headless 包去 require('electron')。
 */

import type { GlobalMemorySummary, SkillFileContent, SkillFileNode } from '@profer/shared'
import {
  deleteGlobalMemoryFile as deleteFile,
  ensureGlobalMemoryInitialized,
  getGlobalMemoryDir as getDir,
  getGlobalMemorySummary as getSummary,
  listGlobalMemoryFiles as listFiles,
  readGlobalMemoryFile as readFile,
  searchGlobalMemory as search,
  writeGlobalMemoryFile as writeFile,
} from '@profer/user-memory'
import { getConfigDir } from './config-root'

/** 全局记忆根目录（绝对路径）。 */
export function getGlobalMemoryDir(): string {
  return getDir(getConfigDir())
}

/** 确保记忆目录已初始化，返回根目录。 */
export function ensureGlobalMemory(): string {
  return ensureGlobalMemoryInitialized(getConfigDir())
}

export function getGlobalMemorySummary(): GlobalMemorySummary {
  return getSummary(getConfigDir())
}

export function listGlobalMemoryFiles(): SkillFileNode[] {
  return listFiles(getConfigDir())
}

export function readGlobalMemoryFile(relativePath: string): SkillFileContent {
  return readFile(getConfigDir(), relativePath)
}

export function writeGlobalMemoryFile(relativePath: string, content: string): void {
  writeFile(getConfigDir(), relativePath, content)
}

export function deleteGlobalMemoryFile(relativePath: string): void {
  deleteFile(getConfigDir(), relativePath)
}

export function searchGlobalMemory(query: string, topK = 10) {
  return search(getConfigDir(), query, topK)
}
