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
import { app, net } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getConfigDir } from './config-paths'
import type { SkinInfo } from '../../types'

/** 皮肤 CSS 内容缓存（皮肤文件小，读一次即可）；LRU 上限防止无界增长 */
const SKIN_CSS_CACHE = new Map<string, string>()
const SKIN_CSS_CACHE_MAX = 64

/**
 * 皮肤注册表缓存：进程内扫描结果复用。
 * 皮肤安装/删除/手动刷新时由 invalidateSkinCache 清空，
 * 避免窗口创建、系统主题变化等高频路径重复全量扫盘（P0）。
 */
let skinsRegistryCache: SkinInfo[] | null = null

/** 皮肤处理后的 CSS 磁盘持久化缓存目录（按文件 mtime 签名失效，避免冷启动重复 base64 编码） */
const getSkinCssDiskCacheDir = (): string => join(getConfigDir(), 'skin-cache')

/** 皮肤预览图 data URL 缓存（每张最多 ~2MB，数量上限 32） */
const SKIN_PREVIEW_CACHE = new Map<string, string>()
const SKIN_PREVIEW_CACHE_MAX = 32

/** 简易 LRU：读命中后重新插入到末尾（Map 迭代序 = 插入序），超出上限淘汰最旧 */
function cacheGet(cache: Map<string, string>, key: string): string | undefined {
  const value = cache.get(key)
  if (value !== undefined) {
    cache.delete(key)
    cache.set(key, value)
  }
  return value
}

function cacheSet(cache: Map<string, string>, key: string, value: string, max: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

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
/** 皮肤 CSS 中 assets 引用匹配：`url(assets/xxx.webp)`（安装校验 ASSET_RE 同款白名单） */
const SKIN_ASSET_RE = /url\(\s*(['"]?)(assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:webp|png|svg|jpe?g))\1\s*\)/gi
/** profer-skin:// 协议路径白名单：仅允许皮肤目录内 assets/ 下的图片 */
const SKIN_ASSET_PATH_RE = /^assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:webp|png|svg|jpe?g)$/
/** 磁盘缓存格式版本：CSS 引用方式（base64 内联 → profer-skin:// 协议）变化时递增，旧缓存自动失效 */
const SKIN_CSS_CACHE_FORMAT_VERSION = 2

/** 皮肤 id 白名单（kebab-case，与 skin-manager-service 的 ID_RE 一致） */
const SKIN_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

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
  // 注册表缓存同步失效：安装/删除/刷新都会改变注册表内容
  skinsRegistryCache = null
  if (skinId) {
    SKIN_CSS_CACHE.delete(skinId)
    SKIN_PREVIEW_CACHE.delete(skinId)
    try {
      rmSync(join(getSkinCssDiskCacheDir(), `${skinId}.css`), { force: true })
      rmSync(join(getSkinCssDiskCacheDir(), `${skinId}.meta.json`), { force: true })
    } catch { /* 磁盘缓存清理失败可忽略 */ }
  } else {
    SKIN_CSS_CACHE.clear()
    SKIN_PREVIEW_CACHE.clear()
    try { rmSync(getSkinCssDiskCacheDir(), { recursive: true, force: true }) } catch { /* 磁盘缓存清理失败可忽略 */ }
  }
}

/** manifest.json 原始形状（宽松：字段可能缺失/类型错误，由解析函数归一） */
export interface SkinManifestRaw {
  id?: unknown
  name?: unknown
  tone?: unknown
  contractVersion?: unknown
  version?: unknown
  author?: unknown
  description?: unknown
  titlebar?: { color?: unknown; symbolColor?: unknown }
  previewScale?: unknown
  previewPosition?: unknown
  tooltip?: unknown
}

/**
 * 单一 manifest 文本解析入口（JSON + BOM + 基础字段校验）。
 * skin-service 的 readManifest（扫描注册表）与 skin-manager-service 的 validatePackage
 * （安装校验）共用，字段扩展只需改这一处，避免双写漂移（P2-L6）。
 * 失败返回具体 reason（安装场景直接透传给用户）。
 */
export function parseSkinManifestText(text: string): { ok: true; manifest: SkinManifestRaw } | { ok: false; reason: string } {
  let parsed: unknown
  try {
    // JSON.parse 不接受 UTF-8 BOM；Windows 编辑器及部分压缩工具常会写入 BOM。
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    return { ok: false, reason: `manifest.json 不是有效 JSON${err instanceof Error ? `：${err.message}` : ''}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'manifest.json 必须是 JSON 对象' }
  }
  const manifest = parsed as SkinManifestRaw
  if (typeof manifest.id !== 'string' || !manifest.id) {
    return { ok: false, reason: 'manifest.id 缺失或不是字符串' }
  }
  if (manifest.tone !== 'light' && manifest.tone !== 'dark') {
    return { ok: false, reason: 'manifest.tone 必须为 light 或 dark' }
  }
  return { ok: true, manifest }
}

/** 解析单个皮肤的 manifest.json，字段缺失/无效时返回 null */
export function readManifest(dir: string, builtin: boolean): SkinInfo | null {
  let text: string
  try {
    text = readFileSync(join(dir, 'manifest.json'), 'utf-8')
  } catch (err) {
    console.warn('[皮肤] 读取 manifest 失败:', dir, err)
    return null
  }
  const parsed = parseSkinManifestText(text)
  if (!parsed.ok) {
    console.warn('[皮肤] 跳过无效 manifest（' + parsed.reason + '）:', dir)
    return null
  }
  const manifest = parsed.manifest
  const titlebar =
    manifest.titlebar && typeof manifest.titlebar === 'object' && typeof manifest.titlebar.color === 'string'
      ? {
          color: manifest.titlebar.color,
          symbolColor:
            typeof manifest.titlebar.symbolColor === 'string' ? manifest.titlebar.symbolColor : '#ffffff',
        }
      : undefined
  return {
    id: manifest.id as string,
    name: typeof manifest.name === 'string' && manifest.name ? manifest.name : (manifest.id as string),
    tone: manifest.tone as 'light' | 'dark',
    // v1 皮肤没有 contractVersion；无效值同样按 v1 降级，保证用户旧皮肤可继续加载。
    contractVersion: typeof manifest.contractVersion === 'number' && Number.isInteger(manifest.contractVersion) && manifest.contractVersion >= 2
      ? manifest.contractVersion
      : 1,
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    author: typeof manifest.author === 'string' ? manifest.author : undefined,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    titlebar,
    builtin,
    previewScale: typeof manifest.previewScale === 'number' && manifest.previewScale > 0 ? manifest.previewScale : undefined,
    previewPosition: typeof manifest.previewPosition === 'string' ? manifest.previewPosition : undefined,
    tooltip: typeof manifest.tooltip === 'string' ? manifest.tooltip : undefined,
  }
}

/**
 * 扫描皮肤注册表：内置优先，用户皮肤不与内置重名。
 * 用户目录存在损坏条目/权限异常时降级跳过，不让整个注册表静默变空。
 * 结果进程级缓存，invalidateSkinCache 时失效。
 */
export function scanSkins(): SkinInfo[] {
  if (skinsRegistryCache) return skinsRegistryCache
  const skins: SkinInfo[] = []
  const seen = new Set<string>()
  const builtinDir = getBuiltinSkinDir()
  const userDir = getUserSkinDir()

  for (const [dir, builtin] of [
    [builtinDir, true],
    [userDir, false],
  ] as const) {
    if (!existsSync(dir)) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      console.warn('[皮肤] 扫描目录失败，跳过:', dir, err)
      continue
    }
    for (const entry of entries) {
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
  skinsRegistryCache = skins
  // 注册表信息量大且每次扫描都打印；降为 debug 级避免噪音（只在开发/排查时需要）
  console.debug('[皮肤] 注册表:', skins.map((s) => `${s.id}(${s.tone}${s.builtin ? ',内置' : ',用户'})`).join(', '))
  return skins
}

/** 按 id 定位皮肤目录（内置优先）；id 必须通过白名单校验，防路径穿越 */
function findSkinDir(skinId: string): string | null {
  if (!SKIN_ID_RE.test(skinId)) return null
  for (const base of [getBuiltinSkinDir(), getUserSkinDir()]) {
    const dir = join(base, skinId)
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  return null
}

/**
 * 计算皮肤文件签名：manifest/skin.css/assets 的 mtime 与文件名列表。
 * 任一文件变更签名即变化，用于磁盘缓存失效判断。
 * 目录异常时返回 null（此时不启用磁盘缓存，走正常读取）。
 */
function skinCssSignature(dir: string): string | null {
  try {
    const parts: string[] = []
    for (const name of ['manifest.json', 'skin.css']) {
      const file = join(dir, name)
      if (!existsSync(file)) return null
      parts.push(`${name}:${statSync(file).mtimeMs}`)
    }
    const assetsDir = join(dir, 'assets')
    if (existsSync(assetsDir)) {
      const entries = readdirSync(assetsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .sort((a, b) => a.name.localeCompare(b.name))
      parts.push(entries.map((entry) => `${entry.name}:${statSync(join(assetsDir, entry.name)).mtimeMs}`).join(','))
    }
    return parts.join('|')
  } catch {
    return null
  }
}

/** 读取皮肤 CSS 内容；无此皮肤或文件缺失返回 null */
export function getSkinCss(skinId: string): string | null {
  const cached = cacheGet(SKIN_CSS_CACHE, skinId)
  if (cached !== undefined) return cached
  const dir = findSkinDir(skinId)
  if (!dir) return null
  const cssPath = join(dir, 'skin.css')
  if (!existsSync(cssPath)) return null

  // 磁盘持久化缓存：签名一致时直接复用处理结果，冷启动避免重复 base64 编码（P1）
  const sig = skinCssSignature(dir)
  if (sig) {
    const diskCacheDir = getSkinCssDiskCacheDir()
    const cachePath = join(diskCacheDir, `${skinId}.css`)
    const metaPath = join(diskCacheDir, `${skinId}.meta.json`)
    try {
      if (existsSync(cachePath) && existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { sig?: string; v?: number }
        // 格式版本不一致（如 base64 内联 → profer-skin:// 协议）时旧缓存作废
        if (meta.v === SKIN_CSS_CACHE_FORMAT_VERSION && meta.sig === sig) {
          const css = readFileSync(cachePath, 'utf-8')
          cacheSet(SKIN_CSS_CACHE, skinId, css, SKIN_CSS_CACHE_MAX)
          return css
        }
      }
    } catch {
      // 磁盘缓存损坏/签名文件异常：忽略，走正常读取
    }
  }

  try {
    const rawCss = readFileSync(cssPath, 'utf-8')
    // assets 不再 base64 内联：改为稳定的 profer-skin://<skinId>/assets/... 协议引用，
    // 图片由主进程协议 handler 按需读取（P2：移除大图 IPC 传输与编码开销）
    const css = rawCss.replace(SKIN_ASSET_RE, (_match, quote: string, assetPath: string) => {
      return `url(${quote}profer-skin://${skinId}/${assetPath}${quote})`
    })
    cacheSet(SKIN_CSS_CACHE, skinId, css, SKIN_CSS_CACHE_MAX)
    // 写磁盘缓存（失败静默降级，不影响正常功能）
    if (sig) {
      try {
        const diskCacheDir = getSkinCssDiskCacheDir()
        mkdirSync(diskCacheDir, { recursive: true })
        writeFileSync(join(diskCacheDir, `${skinId}.css`), css)
        writeFileSync(join(diskCacheDir, `${skinId}.meta.json`), JSON.stringify({ sig, v: SKIN_CSS_CACHE_FORMAT_VERSION }))
      } catch {
        // 磁盘不可写（只读目录等）：静默降级
      }
    }
    return css
  } catch (err) {
    console.warn('[皮肤] 读取 skin.css 失败:', skinId, err)
    return null
  }
}

/**
 * 处理 profer-skin://<skinId>/assets/<file> 请求。
 * 皮肤 assets 通过稳定协议引用（替代 base64 内联），URL 由 getSkinCss 生成；
 * skinId 走 kebab-case 白名单，路径仅允许皮肤目录内 assets/ 图片，防目录穿越。
 */
export function handleProferSkinRequest(request: Request): Promise<Response> | Response {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }
  const skinId = url.hostname
  if (!SKIN_ID_RE.test(skinId)) return new Response('Forbidden', { status: 403 })
  const dir = findSkinDir(skinId)
  if (!dir) return new Response('Not Found', { status: 404 })

  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!SKIN_ASSET_PATH_RE.test(relativePath)) return new Response('Forbidden', { status: 403 })
  const target = resolve(dir, relativePath)
  if (!target.startsWith(`${resolve(dir)}${sep}`)) return new Response('Forbidden', { status: 403 })
  if (!existsSync(target) || !statSync(target).isFile()) return new Response('Not Found', { status: 404 })
  return net.fetch(pathToFileURL(target).toString())
}

/** 读取皮肤预览图为 data URL；无 preview 文件返回 null（内存缓存；不存在时统一返回 null） */
export function getSkinPreview(skinId: string): string | null {
  const cached = cacheGet(SKIN_PREVIEW_CACHE, skinId)
  if (cached !== undefined) {
    return cached === '' ? null : cached
  }
  const dir = findSkinDir(skinId)
  if (!dir) return null
  for (const ext of PREVIEW_PRIORITY) {
    const previewPath = join(dir, `preview${ext}`)
    if (!existsSync(previewPath)) continue
    try {
      const buf = readFileSync(previewPath)
      const mime = PREVIEW_MIME[ext] ?? 'application/octet-stream'
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      cacheSet(SKIN_PREVIEW_CACHE, skinId, dataUrl, SKIN_PREVIEW_CACHE_MAX)
      return dataUrl
    } catch (err) {
      console.warn('[皮肤] 读取 preview 失败:', skinId, err)
      return null
    }
  }
  // 无 preview 文件：用空串占位缓存（表示“已查过、无预览”），对外统一返回 null
  cacheSet(SKIN_PREVIEW_CACHE, skinId, '', SKIN_PREVIEW_CACHE_MAX)
  return null
}
