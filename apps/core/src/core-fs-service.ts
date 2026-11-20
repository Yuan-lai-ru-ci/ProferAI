/**
 * Core 侧任意路径浏览（仅目录）。
 *
 * 用途：桌面在“非本机内核”上新建/打开项目时，浏览的是**所属 Core** 的文件系统，
 * 而不是桌面这台机器。因此这里只做三件事：列目录、建目录、给起点。
 *
 * 安全边界：
 * - 只有已鉴权（Bearer Token）请求才会到达这里；
 * - 只返回目录项，不读文件内容，不写文件；
 * - 建目录只允许单段名称，拒绝分隔符、`..` 和空名。
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { CoreDirectoryListing, CoreDirectoryProbe, CoreFsEntry, CoreFsOverview, CoreFsRootOption, CoreProjectPlan } from '@profer/shared'

/** 单个目录最多返回的条目数，避免超大目录拖垮桌面渲染。 */
const MAX_DIRECTORY_ENTRIES = 2000

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function requireAbsolutePath(input: string): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw || raw.includes('\0')) throw new Error('路径无效')
  const expanded = expandHome(raw)
  if (!isAbsolute(expanded)) throw new Error('必须是绝对路径')
  return resolve(expanded)
}

/** Core 的浏览起点：平台、主目录与可跳转的根（Windows 为盘符，其余为 `/`）。 */
export function describeCoreFileSystem(): CoreFsOverview {
  const roots: CoreFsRootOption[] = []
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code)
      const path = `${letter}:\\`
      if (existsSync(path)) roots.push({ label: `${letter}:`, path })
    }
  } else {
    roots.push({ label: '/', path: '/' })
  }
  return { platform: process.platform, home: homedir(), roots }
}

/** 列目录。默认只列目录；`includeFiles` 时连同文件（含大小）一起返回，供系统文件管理使用。 */
export function listCoreDirectories(input: string, includeFiles = false): CoreDirectoryListing {
  const target = requireAbsolutePath(input)
  if (!statSync(target).isDirectory()) throw new Error('路径不是目录')
  const entries: CoreFsEntry[] = []
  for (const item of readdirSync(target, { withFileTypes: true })) {
    if (entries.length >= MAX_DIRECTORY_ENTRIES) break
    let isDirectory = item.isDirectory()
    if (!isDirectory && item.isSymbolicLink()) {
      try { isDirectory = statSync(join(target, item.name)).isDirectory() } catch { isDirectory = false }
    }
    if (!isDirectory && !includeFiles) continue
    let size: number | undefined
    if (!isDirectory) {
      try { size = statSync(join(target, item.name)).size } catch { size = undefined }
    }
    entries.push({ name: item.name, path: join(target, item.name), isDirectory, ...(size === undefined ? {} : { size }) })
  }
  entries.sort((left, right) => (left.isDirectory === right.isDirectory ? left.name.localeCompare(right.name, 'zh') : left.isDirectory ? -1 : 1))
  const parent = dirname(target)
  return { path: target, parent: parent === target ? null : parent, entries }
}

/** 按完整路径创建文件夹（中间层级一并创建）；已存在同路径的目录时视为成功。 */
export function createCoreDirectory(input: string): { path: string } {
  const target = requireAbsolutePath(input)
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new Error('该路径已存在且不是文件夹')
    return { path: target }
  }
  mkdirSync(target, { recursive: true })
  return { path: target }
}

/**
 * 探测目录状态（不读文件内容）：
 * - exists=false：路径不存在，前端会让用户确认后创建；
 * - isDirectory=false：路径被文件占用，不能作为项目根；
 * - empty=false：目录非空，前端会提示会生成 .profer 且不移动现有文件。
 */
export function probeCoreDirectory(input: string): CoreDirectoryProbe {
  const target = requireAbsolutePath(input)
  let stat
  try { stat = statSync(target) } catch { return { path: target, exists: false, isDirectory: false, empty: false, entryCount: 0, hasProfer: false } }
  if (!stat.isDirectory()) return { path: target, exists: true, isDirectory: false, empty: false, entryCount: 0, hasProfer: false }
  const entries = readdirSync(target)
  return { path: target, exists: true, isDirectory: true, empty: entries.length === 0, entryCount: entries.length, hasProfer: entries.includes('.profer') }
}

/** 从最近存在的上级往下，列出缺失的目录名（用于“要新建几个文件夹”的提示）。 */
function missingSegments(target: string): string[] {
  const missing: string[] = []
  let current = target
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    missing.unshift(basename(current))
    current = parent
  }
  return missing
}

function assertProjectName(name: string): string {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!value) throw new Error('项目名称不能为空')
  if (value === '.' || value === '..' || value.length > 120) throw new Error('项目名称无效')
  // 用字符码判断分隔符与 NUL，避免源码里出现转义字符。
  const forbidden = ['/', String.fromCharCode(92), String.fromCharCode(0)]
  if (forbidden.some(token => value.includes(token))) throw new Error('项目名称不能包含路径分隔符')
  return value
}

/**
 * 新建项目前的规划：把“父目录是否缺失 / 目标文件夹是否存在、是否为空”一次算清。
 * `projectName` 省略时目标就是 `basePath`（打开已有项目）。
 */
export function planCoreProject(input: { basePath: string; projectName?: string }): CoreProjectPlan {
  const basePath = requireAbsolutePath(input.basePath)
  const name = typeof input.projectName === 'string' && input.projectName.trim() ? assertProjectName(input.projectName) : undefined
  const targetPath = name ? join(basePath, name) : basePath
  const baseExists = existsSync(basePath)
  let baseIsDirectory = false
  if (baseExists) {
    try { baseIsDirectory = statSync(basePath).isDirectory() } catch { baseIsDirectory = false }
  }
  return {
    basePath,
    targetPath,
    baseExists,
    baseIsDirectory,
    baseMissingSegments: baseExists ? [] : missingSegments(basePath),
    target: probeCoreDirectory(targetPath),
  }
}
