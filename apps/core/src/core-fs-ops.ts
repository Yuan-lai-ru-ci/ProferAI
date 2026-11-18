/**
 * Core 文件操作（跨平台）：重命名、移动、复制、删除到回收站、预览读取。
 *
 * 设计约束：
 * - 路径一律由 Core 解析，调用方只传绝对路径与“单段名称”；
 * - Windows / Linux / macOS 共用同一套实现：分隔符用 `path` 模块，跨卷移动回退为复制+删除，
 *   不依赖系统回收站（回收站放在 Core 自己的配置目录下，三平台一致）；
 * - 拒绝根目录、Core 配置目录及其祖先/子孙，避免一次误操作把 Core 自己删掉。
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const WIN_RESERVED = /[<>:"|?*]/

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 单段名称：拒绝分隔符、NUL、非法字符（按平台）与边界名称。 */
export function assertEntryName(input: string): string {
  const name = typeof input === 'string' ? input.trim() : ''
  if (!name || name === '.' || name === '..') throw new Error('名称无效')
  if (name.length > 255) throw new Error('名称过长')
  if (name.includes('/') || name.includes(String.fromCharCode(92)) || name.includes(String.fromCharCode(0))) throw new Error('名称不能包含路径分隔符')
  if (process.platform === 'win32' && (WIN_RESERVED.test(name) || /[. ]$/.test(name))) throw new Error('名称包含 Windows 不允许的字符')
  return name
}

/**
 * 路径安全校验：
 * - 源（要改/删的东西）不能是配置目录、配置目录内部，也不能是配置目录的祖先；
 * - 目标目录可以是配置目录的祖先（例如把文件放回上层临时目录），但不能是配置目录本身或它的子目录。
 */
export function assertOperablePath(input: string, configDir: string, mode: 'source' | 'destination' = 'source'): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw || raw.includes(String.fromCharCode(0)) || !isAbsolute(raw)) throw new Error('路径无效，必须是绝对路径')
  const target = resolve(raw)
  if (parse(target).root === target) throw new Error('不能对根目录执行此操作')
  const config = resolve(configDir)
  const insideConfig = isInside(config, target)
  if (target === config || insideConfig) throw new Error('不能操作 Core 配置目录及其内部路径')
  if (mode === 'source' && isInside(target, config)) throw new Error('不能操作 Core 配置目录的上级目录')
  return target
}

/** 目标最终路径也要挡在配置目录之外，避免覆盖配置本身。 */
function assertTargetOutsideConfig(target: string, configDir: string): string {
  const config = resolve(configDir)
  if (target === config || isInside(config, target)) throw new Error('不能覆盖 Core 配置目录')
  return target
}

function rmTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) { rmSync(path); return }
  if (stat.isDirectory()) { for (const name of readdirSync(path)) rmTree(join(path, name)) }
  rmSync(path, { recursive: true, force: true })
}

function copyTree(from: string, to: string): void {
  const stat = lstatSync(from)
  if (stat.isSymbolicLink()) { symlinkSync(readlinkSync(from), to); return }
  if (stat.isDirectory()) {
    mkdirSync(to)
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name))
    return
  }
  copyFileSync(from, to)
}

/** 目标已存在时默认拒绝；显式覆盖时先删除目标（不跟符号链接）。 */
function prepareDestination(target: string, overwrite: boolean): void {
  if (!existsSync(target)) return
  if (!overwrite) throw new Error('目标已存在')
  rmTree(target)
}

export function renameEntry(path: string, newName: string, configDir: string): { path: string } {
  const source = assertOperablePath(path, configDir)
  const name = assertEntryName(newName)
  const target = join(dirname(source), name)
  if (target === source) return { path: source }
  prepareDestination(target, false)
  try { renameSync(source, target) } catch { copyTree(source, target); rmTree(source) }
  return { path: target }
}

export function moveEntry(from: string, toDir: string, configDir: string, overwrite = false): { path: string } {
  const source = assertOperablePath(from, configDir)
  const dir = assertOperablePath(toDir, configDir, 'destination')
  if (!statSync(dir).isDirectory()) throw new Error('目标不是文件夹')
  if (lstatSync(source).isDirectory() && isInside(source, dir)) throw new Error('不能把文件夹移动到它自己里面')
  const target = assertTargetOutsideConfig(join(dir, basename(source)), configDir)
  if (target === source) return { path: source }
  prepareDestination(target, overwrite)
  try {
    renameSync(source, target)
  } catch (error) {
    // 跨盘/跨卷：rename 会抛 EXDEV，回退成复制后删除。
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyTree(source, target)
    rmTree(source)
  }
  return { path: target }
}

export function copyEntry(from: string, toDir: string, configDir: string, overwrite = false): { path: string } {
  const source = assertOperablePath(from, configDir)
  const dir = assertOperablePath(toDir, configDir, 'destination')
  if (!statSync(dir).isDirectory()) throw new Error('目标不是文件夹')
  if (lstatSync(source).isDirectory() && isInside(source, dir)) throw new Error('不能把文件夹复制到它自己里面')
  const target = assertTargetOutsideConfig(join(dir, basename(source)), configDir)
  if (target === source) throw new Error('源和目标是同一个位置')
  prepareDestination(target, overwrite)
  copyTree(source, target)
  return { path: target }
}

/** 删除到 Core 自带的回收站：三平台一致，附带恢复所需的原始路径。 */
export function trashEntry(path: string, configDir: string): { path: string } {
  const source = assertOperablePath(path, configDir)
  const bucket = join(resolve(configDir), 'trash', `${Date.now()}-${randomUUID().slice(0, 8)}`)
  mkdirSync(bucket, { recursive: true })
  const target = join(bucket, basename(source))
  try { renameSync(source, target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyTree(source, target)
    rmTree(source)
  }
  writeFileSync(join(bucket, 'meta.json'), JSON.stringify({ originalPath: source, trashedAt: Date.now(), name: basename(source) }), 'utf8')
  return { path: target }
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.jsonc', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.xml', '.yml', '.yaml', '.toml', '.ini', '.log', '.sh', '.ps1', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sql', '.csv'])
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' }

/** 预览读取：只给文本与图片，限制大小；二进制返回 null 由调用方提示。 */
export function readEntryPreview(path: string, configDir: string, maxBytes = 10 * 1024 * 1024): { path: string; base64: string; mime: string; size: number } | null {
  const target = assertOperablePath(path, configDir)
  if (!existsSync(target)) throw new Error('文件不存在')
  const stat = statSync(target)
  if (!stat.isFile()) throw new Error('只能预览文件')
  if (stat.size > maxBytes) throw new Error('文件过大，无法预览')
  const ext = target.slice(target.lastIndexOf('.')).toLowerCase()
  const mime = IMAGE_MIME[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
  if (mime === 'application/octet-stream') return null
  return { path: target, base64: readFileSync(target).toString('base64'), mime, size: stat.size }
}
