import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BrowserWindow, nativeImage } from 'electron'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { filterDisabledTools } from '@profer/shared'
import { SETTINGS_IPC_CHANNELS, SKIN_IPC_CHANNELS } from '../../types'
import { getUserSkinDir } from './skin-service'
import { installSkinFromFolder } from './skin-manager-service'
import { isWindowsReservedName } from './skin-name-guards'
import { updateSettings } from './settings-service'
import { updateWindowFrameAppearance } from './titlebar-overlay'
import { readAuthorizedAgentImage } from './agent-image-output-service'

type SkinTone = 'light' | 'dark'

type CreateSkinInput = {
  id: string
  name: string
  tone: SkinTone
  skinCss: string
  wallpaperPath?: string
  wallpaperFilename?: string
  /** 可选缩略图（皮肤库卡片预览图）。走与壁纸相同的授权读取边界；省略时从壁纸派生。 */
  previewPath?: string
  /** 可选：缩略图缩放倍数，写入 manifest.previewScale（必须 > 0）。 */
  previewScale?: number
  /** 可选：缩略图 CSS object-position，写入 manifest.previewPosition。 */
  previewPosition?: string
  version?: string
  author?: string
  description?: string
  titlebarColor?: string
  titlebarSymbolColor?: string
  replace?: boolean
  /** 创建成功后默认应用；仅用户明确要求不应用时传 false。 */
  apply?: boolean
}

type SkinToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details?: unknown
  isError?: boolean
}

const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_SKIN_CSS_BYTES = 512 * 1024
const MAX_ASSET_BYTES = 4 * 1024 * 1024
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
/** 缩略图独立上限：预览会转成 base64 data URL 常驻内存（×≈1.33），不宜照搬 assets 的 4 MB。 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
/** 派生缩略图的宽度上限：皮肤库卡片只有 80px 高，1200px 宽足够清晰又能控制体积。 */
const PREVIEW_MAX_WIDTH = 1200

function jsonResult(payload: unknown): SkinToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload }
}

function jsonError(error: unknown): SkinToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true }
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

/**
 * 把绝对路径缩写为 `~/...` 形式返回给 Agent。
 *
 * 皮肤安装目录在工作区之外，模型只有拿到确定性位置才不需要用 find 递归搜索；
 * 直接用 `~` 缩写既给出可定位路径，又不把完整本机 HOME 前缀写进工具文本。
 */
function tildePath(absolute: string): string {
  const home = homedir()
  if (absolute === home) return '~'
  return absolute.startsWith(`${home}${sep}`) ? `~${absolute.slice(home.length)}` : absolute
}

function extensionForMediaType(mediaType: string, label = '皮肤壁纸'): '.png' | '.jpg' | '.webp' {
  if (mediaType === 'image/png') return '.png'
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  throw new Error(`${label}仅支持 PNG、JPEG 和 WebP；GIF 不能作为皮肤资源`)
}

/**
 * 缩略图派生所需的图片源最小接口。
 *
 * 刻意不直接用 electron 的 NativeImage 类型：请求方与单测都不依赖 Electron 运行时，
 * 只需满足这几个方法即可注入替身。
 */
export type PreviewImageSource = {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; quality: 'good' }): PreviewImageSource
  toJPEG(quality: number): Buffer
}

/**
 * 从图片源派生缩略图：等比缩放到宽度上限后输出 JPEG。
 *
 * 缩略图仅用于皮肤库卡片预览（卡片只有 80px 高，且前端还会按 object-cover 再裁一次），
 * 所以这里不做裁切；JPEG 而非 PNG 是为了把体积降一个量级 —— 预览会转成 base64 data URL 常驻内存。
 */
export function derivePreviewImage(image: PreviewImageSource | null | undefined): { data: Buffer; filename: string } | undefined {
  try {
    if (!image || image.isEmpty()) return undefined
    const { width } = image.getSize()
    const resized = width > PREVIEW_MAX_WIDTH ? image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'good' }) : image
    const data = resized.toJPEG(82)
    if (!data || data.length === 0 || data.length > MAX_PREVIEW_BYTES) return undefined
    return { data, filename: 'preview.jpg' }
  } catch {
    return undefined
  }
}

/**
 * 从壁纸派生兜底缩略图。
 *
 * 皮肤库卡片只读皮肤根目录下的 `preview.<ext>`，Agent 不提供缩略图时卡片会渲染成空白灰条，
 * 因此默认用壁纸派生一张。用主进程自带的 `nativeImage`，不引入原生依赖。
 * 派生结果不含 skin.css 的遮罩层，所以会比实际界面观感更亮。
 */
function derivePreviewFromWallpaper(wallpaper: Buffer): { data: Buffer; filename: string } | undefined {
  try {
    return derivePreviewImage(nativeImage.createFromBuffer(wallpaper) as unknown as PreviewImageSource)
  } catch {
    // 派生失败不得阻断安装：缩略图缺失只是观感问题，皮肤本身仍可用。
    return undefined
  }
}

/** 将模型给出的文件名收敛为协议允许的小写 assets 文件名，并以真实媒体类型为准。 */
function safeAssetFilename(input: string | undefined, sourcePath: string, mediaType: string): string {
  const sourceExtension = extensionForMediaType(mediaType)
  const requested = (input?.trim() || basename(sourcePath)).toLowerCase()
  const requestedExtension = extname(requested)
  if (requestedExtension && requestedExtension !== sourceExtension && !(sourceExtension === '.jpg' && requestedExtension === '.jpeg')) {
    throw new Error(`壁纸文件名扩展名必须与真实图片格式一致（应为 ${sourceExtension}）`)
  }
  const extension = sourceExtension === '.jpg' && requestedExtension === '.jpeg' ? '.jpeg' : sourceExtension
  const stem = basename(requested, requestedExtension)
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (!stem) throw new Error('壁纸文件名无有效字符')
  // Windows 保留设备名带扩展名同样非法（con.png 在 Windows 也建不出来）；
  // 这里提前拦截，避免走到安装校验才报出难以理解的错误。
  if (isWindowsReservedName(stem)) {
    throw new Error(`壁纸文件名不能使用 Windows 保留设备名（con/prn/aux/nul/com1-9/lpt1-9）：${stem}`)
  }
  return `${stem}${extension}`
}

function validateCssInput(skinCss: string, wallpaperFilename?: string): void {
  if (!skinCss.trim()) throw new Error('skinCss 不能为空；请提供完整的 :root token 和皮肤规则')
  if (!skinCss.includes(':root')) throw new Error('skinCss 必须包含 :root token 表')
  if (Buffer.byteLength(skinCss, 'utf8') > MAX_SKIN_CSS_BYTES) throw new Error('skin.css 超过 512 KB 限制')
  if (wallpaperFilename && !skinCss.includes(`assets/${wallpaperFilename}`)) {
    throw new Error(`skinCss 未引用壁纸：assets/${wallpaperFilename}`)
  }
  if (/url\(\s*["']?(?:https?:|file:|data:|\.\.)/i.test(skinCss)) {
    throw new Error('skinCss 不得引用外链、file:、data: 或 ../ 路径')
  }
}

function broadcastSkinChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(SKIN_IPC_CHANNELS.ON_SKINS_CHANGED, { deletedId: null })
  }
}

function applySkinToAllWindows(id: string): void {
  updateSettings({ themeMode: 'special', themeStyle: id })
  const payload = { themeMode: 'special', themeStyle: id }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    updateWindowFrameAppearance(window)
    window.webContents.send(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, payload)
  }
}

async function createSkin(
  input: CreateSkinInput,
  context: { agentCwd: string; allowedRoots: string[] },
): Promise<SkinToolResult> {
  const id = input.id.trim().toLowerCase()
  if (!ID_RE.test(id)) throw new Error('皮肤 id 必须为 kebab-case，例如 midnight-blue')
  if (isWindowsReservedName(id)) {
    throw new Error('皮肤 id 不能使用 Windows 保留设备名（con/prn/aux/nul/com1-9/lpt1-9），否则在 Windows 上无法创建皮肤目录')
  }
  if (!input.name.trim()) throw new Error('皮肤名称不能为空')

  const userSkinDir = resolve(getUserSkinDir())
  const target = resolve(userSkinDir, id)
  if (!isInside(userSkinDir, target)) throw new Error('皮肤目标目录不合法')

  let wallpaperFilename: string | undefined
  let wallpaperBytes = 0
  let wallpaperData: Buffer | undefined
  if (input.wallpaperPath?.trim()) {
    const wallpaper = await readAuthorizedAgentImage(input.wallpaperPath, {
      agentCwd: context.agentCwd,
      allowedRoots: context.allowedRoots,
    })
    wallpaperFilename = safeAssetFilename(input.wallpaperFilename, wallpaper.absolutePath, wallpaper.mediaType)
    wallpaperData = wallpaper.data
    wallpaperBytes = wallpaper.data.length
    if (wallpaperBytes > MAX_ASSET_BYTES) throw new Error('单张皮肤壁纸不能超过 4 MB，请先压缩或转换')
  }

  // 缩略图：皮肤库卡片只认皮肤根目录下的 preview.<ext>。
  // 显式传入时扩展名取自真实媒体类型（不接受模型自定义命名，否则 PREVIEW_RE / PREVIEW_MIME 会错配）；
  // 省略时从壁纸派生兜底，避免 Agent 创建的皮肤在皮肤库里渲染成空白灰条。
  let previewFilename: string | undefined
  let previewData: Buffer | undefined
  if (input.previewPath?.trim()) {
    const preview = await readAuthorizedAgentImage(input.previewPath, {
      agentCwd: context.agentCwd,
      allowedRoots: context.allowedRoots,
    })
    previewFilename = `preview${extensionForMediaType(preview.mediaType, '皮肤缩略图')}`
    previewData = preview.data
    if (previewData.length > MAX_PREVIEW_BYTES) throw new Error('皮肤缩略图不能超过 2 MB，请先压缩或转换')
  } else if (wallpaperData) {
    const derived = derivePreviewFromWallpaper(wallpaperData)
    if (derived) {
      previewFilename = derived.filename
      previewData = derived.data
    }
  }
  const previewBytes = previewData?.length ?? 0

  validateCssInput(input.skinCss, wallpaperFilename)
  const manifest = {
    id,
    name: input.name.trim(),
    tone: input.tone,
    contractVersion: 2,
    ...(input.version?.trim() ? { version: input.version.trim() } : {}),
    ...(input.author?.trim() ? { author: input.author.trim() } : {}),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.titlebarColor?.trim() ? {
      titlebar: {
        color: input.titlebarColor.trim(),
        symbolColor: input.titlebarSymbolColor?.trim() || '#ffffff',
      },
    } : {}),
    // 取景参数口径与 skin-manager-service 的解析层保持一致（previewScale 要求 > 0，previewPosition 要求字符串），
    // 否则会被解析层静默丢弃。
    ...(typeof input.previewScale === 'number' && input.previewScale > 0 ? { previewScale: input.previewScale } : {}),
    ...(input.previewPosition?.trim() ? { previewPosition: input.previewPosition.trim() } : {}),
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const packageBytes = Buffer.byteLength(manifestText, 'utf8') + Buffer.byteLength(input.skinCss, 'utf8') + wallpaperBytes + previewBytes
  if (packageBytes > MAX_PACKAGE_BYTES) throw new Error('皮肤包超过 5 MB 限制')

  // 先写入隔离临时目录，再交给 installSkinFromFolder 做唯一的安全校验和原子安装。
  // 这样 replace=true 时校验失败也不会破坏原有皮肤。
  const stagingRoot = await mkdtemp(join(tmpdir(), 'profer-agent-skin-'))
  try {
    await writeFile(join(stagingRoot, 'manifest.json'), manifestText, 'utf8')
    await writeFile(join(stagingRoot, 'skin.css'), input.skinCss, 'utf8')
    if (wallpaperData && wallpaperFilename) {
      const assetsDir = join(stagingRoot, 'assets')
      await mkdir(assetsDir, { recursive: true })
      await writeFile(join(assetsDir, wallpaperFilename), wallpaperData)
    }
    // 预览图落在包根目录（不是 assets/）：getSkinPreview 按固定名 preview.<ext> 查找。
    if (previewData && previewFilename) {
      await writeFile(join(stagingRoot, previewFilename), previewData)
    }

    const result = installSkinFromFolder(stagingRoot, input.replace === true)
    if (!result.ok) throw new Error(result.message || '皮肤导入失败')
    broadcastSkinChanged()
    const applied = input.apply !== false
    if (applied) applySkinToAllWindows(id)
    // installedPath 必须是确定性路径：模型此前拿不到安装位置，会在 create_skin 之后
    // 用 find 从工作区一路搜到家目录（maxdepth 覆盖 ~/Music 等受保护目录，触发 macOS TCC 弹窗）。
    const installedPath = tildePath(target)
    const previewLabel = previewFilename ? `，缩略图 ${previewFilename}` : ''
    return jsonResult({
      ok: true,
      skin: result.skin,
      installedPath,
      skinDir: installedPath,
      wallpaper: wallpaperFilename ? `assets/${wallpaperFilename}` : undefined,
      preview: previewFilename,
      applied,
      validated: true,
      message: applied
        ? `已创建、安装并应用皮肤「${input.name.trim()}」，安装位置 ${installedPath}${previewLabel}，皮肤库和所有窗口已刷新。manifest、skin.css、壁纸与缩略图已由本工具校验通过，无需再搜索文件系统做二次确认。`
        : `已创建并安装皮肤「${input.name.trim()}」，安装位置 ${installedPath}${previewLabel}，皮肤库已刷新。manifest、skin.css、壁纸与缩略图已由本工具校验通过，无需再搜索文件系统做二次确认。`,
    })
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export const AGENT_SKIN_TOOL_NAME = 'create_skin'
export const AGENT_SKIN_TOOL_DESCRIPTION = 'Create/install a Profer skin only on explicit user request. Read profer-theme-authoring Skill first. Complete skinCss needs :root tokens and local assets/ only; authorized wallpaper is copied there, CSS url("assets/<filename>"). previewPath supplies a thumbnail, otherwise wallpaper derives preview.<ext>; neither means blank thumbnail. This tool validates, installs and refreshes the library; use returned installedPath, never find/ls/recursive scan afterwards. replace only with explicit overwrite authorization.'

type AgentSkinToolContext = { agentCwd?: string; allowedRoots?: string[]; workspaceSlug?: string }

export function buildPiAgentSkinTools(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  context: AgentSkinToolContext,
): ToolDefinition[] {
  if (!context.agentCwd || !context.workspaceSlug) return []
  return [sdk.defineTool({
    name: AGENT_SKIN_TOOL_NAME,
    label: '创建 Profer 皮肤',
    description: AGENT_SKIN_TOOL_DESCRIPTION,
    promptSnippet: 'CreateSkin: create and install a user skin; copies the authorized wallpaper into assets/, writes a preview thumbnail (previewPath or derived from the wallpaper), validates the CSS reference, and returns the definitive installedPath — do not search the filesystem afterwards.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 80 }),
      name: Type.String({ minLength: 1, maxLength: 120 }),
      tone: Type.Union([Type.Literal('light'), Type.Literal('dark')]),
      skinCss: Type.String({ minLength: 1, maxLength: MAX_SKIN_CSS_BYTES }),
      wallpaperPath: Type.Optional(Type.String({ maxLength: 4096 })),
      wallpaperFilename: Type.Optional(Type.String({ maxLength: 120 })),
      previewPath: Type.Optional(Type.String({ maxLength: 4096 })),
      previewScale: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      previewPosition: Type.Optional(Type.String({ maxLength: 64 })),
      version: Type.Optional(Type.String({ maxLength: 40 })),
      author: Type.Optional(Type.String({ maxLength: 120 })),
      description: Type.Optional(Type.String({ maxLength: 500 })),
      titlebarColor: Type.Optional(Type.String({ maxLength: 32 })),
      titlebarSymbolColor: Type.Optional(Type.String({ maxLength: 32 })),
      replace: Type.Optional(Type.Boolean()),
      apply: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      try {
        return await createSkin(params as CreateSkinInput, {
          agentCwd: context.agentCwd!,
          allowedRoots: context.allowedRoots ?? [],
        }) as AgentToolResult<unknown>
      } catch (error) {
        return jsonError(error) as AgentToolResult<unknown>
      }
    },
  })] as unknown as ToolDefinition[]
}

export async function injectAgentSkinMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  context: AgentSkinToolContext,
  disabledTools?: string[],
): Promise<void> {
  if (!context.agentCwd || !context.workspaceSlug) return
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }
  const server = sdk.createSdkMcpServer({
    name: 'agent-skin',
    version: '1.0.0',
    tools: filterDisabledTools([
      sdk.tool(
        AGENT_SKIN_TOOL_NAME,
        AGENT_SKIN_TOOL_DESCRIPTION,
        {
          id: z.string().trim().min(1).max(80),
          name: z.string().trim().min(1).max(120),
          tone: z.enum(['light', 'dark']),
          skinCss: z.string().min(1).max(MAX_SKIN_CSS_BYTES),
          wallpaperPath: z.string().max(4096).optional(),
          wallpaperFilename: z.string().max(120).optional(),
          previewPath: z.string().max(4096).optional(),
          previewScale: z.number().positive().optional(),
          previewPosition: z.string().max(64).optional(),
          version: z.string().max(40).optional(),
          author: z.string().max(120).optional(),
          description: z.string().max(500).optional(),
          titlebarColor: z.string().max(32).optional(),
          titlebarSymbolColor: z.string().max(32).optional(),
          replace: z.boolean().optional(),
          apply: z.boolean().optional(),
        },
        // Claude 路径要与 Pi 路径行为一致：校验失败必须返回结构化错误结果（isError + message），
        // 让模型能根据错误自愈重试，而不是把异常抛进 SDK。
        async (args) => {
          try {
            return await createSkin(args as CreateSkinInput, {
              agentCwd: context.agentCwd!,
              allowedRoots: context.allowedRoots ?? [],
            })
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
    ], disabledTools),
  })
  mcpServers['agent-skin'] = server as unknown as Record<string, unknown>
}
