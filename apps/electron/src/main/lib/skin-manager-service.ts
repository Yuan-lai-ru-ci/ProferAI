import { app, dialog, shell, BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { SkinInfo, SkinManagerResult } from '../../types'
import { getBuiltinSkinIds, getUserSkinDir, invalidateSkinCache, parseSkinManifestText, scanSkins } from './skin-service'

const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
const MAX_CSS_BYTES = 512 * 1024
const MAX_ASSET_BYTES = 2 * 1024 * 1024
const ASSET_RE = /^assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(webp|png|svg|jpe?g)$/i
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PREVIEW_RE = /^preview\.(webp|png|svg|jpe?g)$/i

function fail(message: string): SkinManagerResult { return { ok: false, status: 'error', message } }
function skinInfo(id: string): SkinInfo | undefined { return scanSkins().find((skin) => skin.id === id) }
function dirSize(dir: string): number {
  // 递归深度/循环保护：symlink 目录不递归（junction 环会递归爆炸），
  // 目录层级超过 12 层视为异常（皮肤包正常远小于该深度）。
  return dirSizeInner(dir, 0)
}
function dirSizeInner(dir: string, depth: number): number {
  if (depth > 12) return 0
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    if (entry.isSymbolicLink()) return total
    if (entry.isDirectory()) return total + dirSizeInner(join(dir, entry.name), depth + 1)
    return total + statSync(join(dir, entry.name)).size
  }, 0)
}
function unsafeCss(css: string, packageRoot: string): boolean {
  // 注释中的示例代码不应参与校验，否则模板的注释示例会被误判为资源引用。
  const executableCss = css.replace(/\/\*[\s\S]*?\*\//g, '')
  if (/@import\b|@font-face\b|url\(\s*(['"]?)(?:https?:|file:|data:|\/\/)/i.test(executableCss)) return true
  const urls = [...executableCss.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((match) => (match[2] ?? '').trim())
  return urls.some((url) => !ASSET_RE.test(url) || !existsSync(join(packageRoot, ...url.split('/'))))
}
function validateAssets(packageRoot: string): SkinManagerResult | null {
  const assetsDir = join(packageRoot, 'assets')
  if (!existsSync(assetsDir)) return null
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !ASSET_RE.test(`assets/${entry.name}`)) return fail('assets 仅允许 png/webp/svg/jpg/jpeg 图片文件')
    if (statSync(join(assetsDir, entry.name)).size > MAX_ASSET_BYTES) return fail('单张皮肤图片不能超过 2 MB')
  }
  return null
}
function resolvePackageRoot(root: string): string | null {
  if (existsSync(join(root, 'manifest.json'))) return root
  const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  return entries.length === 1 && existsSync(join(root, entries[0]!.name, 'manifest.json')) ? join(root, entries[0]!.name) : null
}
function validatePackage(root: string): { id: string; info: SkinInfo } | SkinManagerResult {
  const packageRoot = resolvePackageRoot(root)
  if (!packageRoot) return fail('皮肤包根目录必须包含 manifest.json，或仅包含一层皮肤目录')
  if (!existsSync(join(packageRoot, 'skin.css'))) return fail('皮肤包缺少 skin.css')
  if (dirSize(packageRoot) > MAX_PACKAGE_BYTES) return fail('皮肤包超过 5 MB 限制')
  const css = readFileSync(join(packageRoot, 'skin.css'), 'utf8')
  if (Buffer.byteLength(css) > MAX_CSS_BYTES) return fail('skin.css 超过 512 KB 限制')
  if (unsafeCss(css, packageRoot)) return fail('skin.css 仅允许引用 assets/ 中的本地图片；不允许 @import、@font-face、data URL、外部或 file URL')
  const assetError = validateAssets(packageRoot)
  if (assetError) return assetError
  // 单一 manifest 解析入口（skin-service.parseSkinManifestText）：与扫描注册表共用，字段扩展不会双写漂移（P2-L6）
  let manifestText: string
  try {
    manifestText = readFileSync(join(packageRoot, 'manifest.json'), 'utf8')
  } catch {
    return fail('皮肤包根目录缺少 manifest.json')
  }
  const parsed = parseSkinManifestText(manifestText)
  if (!parsed.ok) return fail(parsed.reason)
  const manifest = parsed.manifest
  const id = manifest.id
  if (typeof id !== 'string' || !ID_RE.test(id)) return fail('皮肤 id 必须为 kebab-case')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return fail('manifest.name 不能为空')
  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('preview.') && !PREVIEW_RE.test(entry.name)) return fail('预览图仅允许 png/webp/svg/jpg/jpeg')
  }
  return {
    id,
    info: {
      id,
      name: manifest.name.trim(),
      tone: manifest.tone as 'light' | 'dark',
      builtin: false,
      // 用户皮肤的 contractVersion 只是能力声明，不作为安装门槛；v1 始终兼容。
      contractVersion: typeof manifest.contractVersion === 'number' && Number.isInteger(manifest.contractVersion) && manifest.contractVersion >= 2
        ? manifest.contractVersion
        : 1,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      author: typeof manifest.author === 'string' ? manifest.author : undefined,
      description: typeof manifest.description === 'string' ? manifest.description : undefined,
      titlebar:
        manifest.titlebar && typeof manifest.titlebar === 'object' && typeof manifest.titlebar.color === 'string'
          ? {
              color: manifest.titlebar.color,
              symbolColor: typeof manifest.titlebar.symbolColor === 'string' ? manifest.titlebar.symbolColor : '#ffffff',
            }
          : undefined,
      previewScale: typeof manifest.previewScale === 'number' && manifest.previewScale > 0 ? manifest.previewScale : undefined,
      previewPosition: typeof manifest.previewPosition === 'string' ? manifest.previewPosition : undefined,
      tooltip: typeof manifest.tooltip === 'string' ? manifest.tooltip : undefined,
    },
  }
}
function installDirectory(sourceRoot: string, replace = false): SkinManagerResult {
  const checked = validatePackage(sourceRoot)
  if ('ok' in checked) return checked
  const { id, info } = checked
  if (getBuiltinSkinIds().has(id)) return fail('不能覆盖内置皮肤')
  const targetBase = getUserSkinDir(); mkdirSync(targetBase, { recursive: true })
  const target = join(targetBase, id)
  if (existsSync(target) && !replace) return { ok: false, status: 'conflict', skin: skinInfo(id), message: `皮肤「${id}」已存在` }
  const temp = mkdtempSync(join(targetBase, '.install-'))
  try {
    const packageRoot = resolvePackageRoot(sourceRoot)!
    cpSync(packageRoot, temp, { recursive: true })
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(temp, target)
    invalidateSkinCache(id)
    return { ok: true, status: replace ? 'replaced' : 'installed', skin: { ...info, id }, message: `已安装皮肤「${info.name}」` }
  } catch (err) { rmSync(temp, { recursive: true, force: true }); return fail(`安装失败：${err instanceof Error ? err.message : String(err)}`) }
}
export function installSkinFromFolder(folder: string, replace = false): SkinManagerResult { return installDirectory(folder, replace) }
export function installSkinFromZip(zipPath: string, replace = false): SkinManagerResult {
  if (!zipPath.toLowerCase().endsWith('.zip')) return fail('仅支持 ZIP 文件')
  const temp = mkdtempSync(join(tmpdir(), 'profer-skin-'))
  try {
    const zip = new AdmZip(zipPath)
    for (const entry of zip.getEntries()) {
      const rawParts = entry.entryName.replace(/\\/g, '/').split('/')
      const name = normalize(entry.entryName)
      if (entry.entryName.startsWith('/') || rawParts.includes('..') || isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`)) return fail('ZIP 包含非法路径')
    }
    zip.extractAllTo(temp, true)
    return installDirectory(temp, replace)
  } catch (err) { return fail(`ZIP 导入失败：${err instanceof Error ? err.message : String(err)}`) } finally { rmSync(temp, { recursive: true, force: true }) }
}
export function deleteUserSkin(id: string): SkinManagerResult {
  if (!ID_RE.test(id)) return fail('无效皮肤 id')
  if (getBuiltinSkinIds().has(id)) return fail('内置皮肤不可删除')
  const target = join(getUserSkinDir(), id)
  if (!existsSync(target)) return fail('皮肤不存在')
  rmSync(target, { recursive: true, force: true }); invalidateSkinCache(id)
  return { ok: true, status: 'deleted', message: '皮肤已删除' }
}
export async function selectSkinZip(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow(); const result = win ? await dialog.showOpenDialog(win, { title: '导入皮肤 ZIP', properties: ['openFile'], filters: [{ name: '皮肤包', extensions: ['zip'] }] }) : await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '皮肤包', extensions: ['zip'] }] }); return result.canceled ? null : (result.filePaths[0] ?? null)
}
export async function selectSkinFolder(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const options = { title: '选择皮肤文件夹', properties: ['openDirectory'] as Electron.OpenDialogOptions['properties'] }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
function getSkinTemplateDir(): string { return app.isPackaged ? join(process.resourcesPath, 'skin-template') : join(__dirname, 'resources', 'skin-template') }
export async function openUserSkinsFolder(): Promise<void> { const dir = getUserSkinDir(); mkdirSync(dir, { recursive: true }); await shell.openPath(dir) }
export async function openSkinTemplateFolder(): Promise<void> { await shell.openPath(getSkinTemplateDir()) }
