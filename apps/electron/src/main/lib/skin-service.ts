/**
 * 皮肤服务
 *
 * 扫描内置皮肤（resources/skins/，随应用打包）与用户皮肤（~/.profer/skins/），
 * 合并为皮肤注册表；提供皮肤 CSS 内容读取（内存缓存，避免重复 IO）。
 *
 * 皮肤包 = 目录（id 即目录名）：
 *   manifest.json  — 元信息（name/tone/titlebar 等）
 *   skin.css       — :root token 表 + 特例规则（renderer 注入 <style>）
 *   preview.*      — 设置页预览图（可选）
 *
 * id 冲突策略：禁止同名，用户皮肤不覆盖内置皮肤（跳过并告警）。
 */
import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getConfigDir } from './config-paths'
import type { SkinInfo } from '../../types'

/** 皮肤 CSS 内容缓存（皮肤文件小，读一次即可） */
const SKIN_CSS_CACHE = new Map<string, string>()

/** 皮肤预览图 data URL 缓存 */
const SKIN_PREVIEW_CACHE = new Map<string, string>()

/** 预览图扩展名 → MIME（决定 data URL 前缀） */
const PREVIEW_MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** 皮肤目录下的预览图文件（preview.*，按扩展名优先 webp/png/svg） */
const PREVIEW_PRIORITY = ['.webp', '.png', '.svg', '.jpg', '.jpeg']
const SKIN_ASSET_RE = /url\(\s*(['"]?)(assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:webp|png|svg|jpe?g))\1\s*\)/gi
const ASSET_MIME: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

/** 内置皮肤目录：dev 为 dist/resources/skins（build:resources 拷贝），打包为 process.resourcesPath/skins */
function getBuiltinSkinDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skins')
    : join(__dirname, 'resources', 'skins')
}

/** 用户皮肤目录：~/.profer/skins/ */
export function getUserSkinDir(): string {
  return join(getConfigDir(), 'skins')
}

/** 内置皮肤 id 集合，供安装服务阻止覆盖。 */
export function getBuiltinSkinIds(): Set<string> {
  const dir = getBuiltinSkinDir()
  if (!existsSync(dir)) return new Set()
  return new Set(readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name))
}

/** 皮肤文件被安装/删除后清空读取缓存。 */
export function invalidateSkinCache(skinId?: string): void {
  if (skinId) {
    SKIN_CSS_CACHE.delete(skinId)
    SKIN_PREVIEW_CACHE.delete(skinId)
  } else {
    SKIN_CSS_CACHE.clear()
    SKIN_PREVIEW_CACHE.clear()
  }
}

/** 解析单个皮肤的 manifest.json，字段缺失/无效时返回 null */
function readManifest(dir: string, builtin: boolean): SkinInfo | null {
  try {
    // JSON.parse 不接受 UTF-8 BOM；Windows 编辑器及部分压缩工具常会写入 BOM。
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8').replace(/^\uFEFF/, '')) as {
      id?: unknown
      name?: unknown
      tone?: unknown
      version?: unknown
      author?: unknown
      description?: unknown
      titlebar?: { color?: unknown; symbolColor?: unknown }
      previewScale?: unknown
      previewPosition?: unknown
      tooltip?: unknown
    }
    if (typeof manifest.id !== 'string' || !manifest.id || (manifest.tone !== 'light' && manifest.tone !== 'dark')) {
      console.warn('[皮肤] 跳过无效 manifest（缺 id 或 tone 非法）:', dir)
      return null
    }
    const titlebar =
      manifest.titlebar && typeof manifest.titlebar === 'object' && typeof manifest.titlebar.color === 'string'
        ? {
            color: manifest.titlebar.color,
            symbolColor:
              typeof manifest.titlebar.symbolColor === 'string' ? manifest.titlebar.symbolColor : '#ffffff',
          }
        : undefined
    return {
      id: manifest.id,
      name: typeof manifest.name === 'string' && manifest.name ? manifest.name : manifest.id,
      tone: manifest.tone,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      author: typeof manifest.author === 'string' ? manifest.author : undefined,
      description: typeof manifest.description === 'string' ? manifest.description : undefined,
      titlebar,
      builtin,
      previewScale: typeof manifest.previewScale === 'number' && manifest.previewScale > 0 ? manifest.previewScale : undefined,
      previewPosition: typeof manifest.previewPosition === 'string' ? manifest.previewPosition : undefined,
      tooltip: typeof manifest.tooltip === 'string' ? manifest.tooltip : undefined,
    }
  } catch (err) {
    console.warn('[皮肤] 读取 manifest 失败:', dir, err)
    return null
  }
}

/** 扫描皮肤注册表：内置优先，用户皮肤不与内置重名 */
export function scanSkins(): SkinInfo[] {
  const skins: SkinInfo[] = []
  const seen = new Set<string>()
  const builtinDir = getBuiltinSkinDir()
  const userDir = getUserSkinDir()

  for (const [dir, builtin] of [
    [builtinDir, true],
    [userDir, false],
  ] as const) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const info = readManifest(join(dir, entry.name), builtin)
      if (!info) continue
      if (seen.has(info.id)) {
        if (!info.builtin) {
          console.warn('[皮肤] 跳过与内置同名的用户皮肤:', info.id)
        }
        continue
      }
      seen.add(info.id)
      skins.push(info)
    }
  }
  console.log('[皮肤] 注册表:', skins.map((s) => `${s.id}(${s.tone}${s.builtin ? ',内置' : ',用户'})`).join(', '))
  return skins
}

/** 按 id 定位皮肤目录（内置优先） */
function findSkinDir(skinId: string): string | null {
  for (const base of [getBuiltinSkinDir(), getUserSkinDir()]) {
    const dir = join(base, skinId)
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  return null
}

/** 读取皮肤 CSS 内容；无此皮肤或文件缺失返回 null */
export function getSkinCss(skinId: string): string | null {
  const cached = SKIN_CSS_CACHE.get(skinId)
  if (cached !== undefined) return cached
  const dir = findSkinDir(skinId)
  if (!dir) return null
  const cssPath = join(dir, 'skin.css')
  if (!existsSync(cssPath)) return null
  try {
    const rawCss = readFileSync(cssPath, 'utf-8')
    const css = rawCss.replace(SKIN_ASSET_RE, (_match, quote: string, assetPath: string) => {
      const assetFile = resolve(dir, assetPath)
      if (!assetFile.startsWith(`${resolve(dir)}\\`) || !existsSync(assetFile) || !statSync(assetFile).isFile()) return _match
      const ext = assetFile.slice(assetFile.lastIndexOf('.')).toLowerCase()
      const mime = ASSET_MIME[ext]
      if (!mime) return _match
      return `url(${quote}data:${mime};base64,${readFileSync(assetFile).toString('base64')}${quote})`
    })
    SKIN_CSS_CACHE.set(skinId, css)
    return css
  } catch (err) {
    console.warn('[皮肤] 读取 skin.css 失败:', skinId, err)
    return null
  }
}

/** 读取皮肤预览图为 data URL；无 preview 文件返回 null（内存缓存） */
export function getSkinPreview(skinId: string): string | null {
  const cached = SKIN_PREVIEW_CACHE.get(skinId)
  if (cached !== undefined) return cached
  const dir = findSkinDir(skinId)
  if (!dir) return null
  for (const ext of PREVIEW_PRIORITY) {
    const previewPath = join(dir, `preview${ext}`)
    if (!existsSync(previewPath)) continue
    try {
      const buf = readFileSync(previewPath)
      const mime = PREVIEW_MIME[ext] ?? 'application/octet-stream'
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      SKIN_PREVIEW_CACHE.set(skinId, dataUrl)
      return dataUrl
    } catch (err) {
      console.warn('[皮肤] 读取 preview 失败:', skinId, err)
      return null
    }
  }
  SKIN_PREVIEW_CACHE.set(skinId, '')
  return null
}
