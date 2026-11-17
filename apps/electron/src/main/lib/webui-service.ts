/**
 * Profer WebUI —— 「一个会话 = 一个网页」的静态托管层。
 *
 * 设计边界：
 *  - 只做 HTTP 响应：监听与连接接入在 `webui-server.ts`（它要复用 remote-service 的命令层），
 *    本文件不 import ws / remote-service，因此可以被 bun:test 直接驱动。
 *  - 不读写会话文件：会话内容、发消息、goal 全部走既有 WS 命令与主进程单写者。
 *  - 默认 0 个网页：开关默认关闭，且已发布会话注册表默认为空；
 *    /s/<id> 仅对白名单内的会话返回页面，其余一律 404。
 *  - 独立端口：WebUI 有自己的监听端口与凭据，与 Pocket 的移动模式互不影响。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { app } from 'electron'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getWebuiConfig } from './webui-config'
import {
  buildPublishedUrls,
  listWebuiInterfaces,
  pickAccessibleHost,
  resolveWebuiRoute,
  type WebuiNetworkInterface,
} from './webui-routing'

export interface WebuiLocalState {
  config: ReturnType<typeof getWebuiConfig>
  interfaces: WebuiNetworkInterface[]
  assetDir: string
  assetReady: boolean
}

export interface WebuiRequestContext {
  isAuthorized: (req: IncomingMessage) => boolean
  token: string | null
  /**
   * 会话标题（用于首屏 `<title>`）。
   *
   * 由调用方注入而不是这里去读会话索引：本层刻意不依赖 agent-session-manager，
   * 否则静态托管会连带把会话存储拉进来，测试也得多 mock 一层。
   */
  sessionTitle?: (sessionId: string) => string | undefined
  /**
   * 该会话当前是否还能对外服务（未归档、未删除）。
   *
   * 白名单是持久化的、会落后于会话状态（归档、删除），所以每次请求都要复核一遍：
   * 由调用方注入，静态托管层不依赖会话存储。
   */
  isSessionServable?: (sessionId: string) => boolean
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * 静态产物目录：开发时可用 PROFER_WEBUI_DIR 直接指向 profer-pocket/webui/dist，免去来回拷贝。
 *
 * 打包态读 `process.resourcesPath/webui`（由 electron-builder 的 extraResources 提供），
 * 这条链路必须与 `electron-builder.yml` 保持一致，否则安装包里会「页面 503」。
 */
export function getWebuiAssetDir(): string {
  const override = process.env.PROFER_WEBUI_DIR?.trim()
  if (override) return resolve(override)
  if (app.isPackaged) return join(process.resourcesPath, 'webui')
  // main 由 esbuild 打包到 apps/electron/dist/main.cjs；另兼容直接跑 TS 的目录结构
  const primary = resolve(__dirname, '..', 'resources', 'webui')
  const fallback = resolve(__dirname, '..', '..', 'resources', 'webui')
  return [primary, fallback].find((dir) => existsSync(join(dir, 'index.html'))) ?? primary
}

export function getWebuiLocalState(): WebuiLocalState {
  const assetDir = getWebuiAssetDir()
  return {
    config: getWebuiConfig(),
    interfaces: listWebuiInterfaces(),
    assetDir,
    assetReady: existsSync(join(assetDir, 'index.html')),
  }
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char)
}

function buildRootPage(publishedIds: readonly string[], token: string): string {
  const items = publishedIds.length === 0
    ? '<li>当前没有已发布会话。请在 Profer「设置 → 远程连接 → Web 会话」里添加。</li>'
    : publishedIds.map((id) => `<li><a href="/s/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}">${escapeHtml(id)}</a></li>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/webui/favicon.ico" sizes="any"><title>Profer Web 会话</title><style>:root{color-scheme:light dark;--bg:#101214;--ink:#e8eaed;--accent:#7cc4a0}@media (prefers-color-scheme: light){:root{--bg:#f7f5f2;--ink:#322f2a;--accent:#3a6f4e}}body{font:14px/1.7 system-ui,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:48px;max-width:720px}li{padding:6px 0}a{color:var(--accent)}</style></head><body><h1>Profer Web 会话</h1><p>一个会话对应一个网页。只有已发布的会话可以访问。</p><ul>${items}</ul></body></html>`
}

/** 首屏种下的 HttpOnly cookie：页面抹掉 URL 上的 ?token= 后，刷新仍能通过鉴权。 */
const TOKEN_COOKIE_NAME = 'profer_webui_token'
const TOKEN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/**
 * 凭据 cookie 的属性不是随便写的，两条都是被真机坑过的：
 *
 * - `Max-Age`：不写过期时间就是**会话 cookie**。iOS Safari 会随标签页被系统回收把它丢掉，
 *   而桌面 Chrome 不会 —— 所以这个坑只在手机上表现为「刷新一次就必须重新带 token」。
 * - `SameSite=Lax`：`Strict` 会让「从其它 App 点链接跳进来」的那一次请求不带 cookie。
 *   首屏有 URL token 兜着，但页面内再跳一次就会莫名其妙 401。
 */
function buildTokenCookie(token: string): string {
  return `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_COOKIE_MAX_AGE_SECONDS}`
}

/**
 * 未授权会话页的「自愈」页。
 *
 * 不含任何会话数据：只是把 localStorage 里存过的 token 拼回 `?token=` 再跳一次，
 * 让「cookie 被浏览器回收」不再等于「必须回电脑上重新复制链接」。
 * 已经带着 token 仍被拒时不跳转（否则死循环），直接显示更换链接的提示。
 *
 * 数据安全不受影响：这里只回一段静态脚本与说明，会话内容仍然只能从 /ws 拿，
 * 而 /ws 依旧要 token；发布白名单也没有放宽。
 */
function buildCredentialRecoveryPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/webui/favicon.ico" sizes="any"><title>需要访问凭据</title><style>:root{color-scheme:light dark;--bg:#191715;--ink:#ECEBE9;--muted:#AAA7A1;--primary:#B4998E}@media (prefers-color-scheme: light){:root{--bg:#F7F5F2;--ink:#322F2A;--muted:#66635C;--primary:#846558}}body{font:14px/1.7 system-ui,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:48px 24px;max-width:560px}h1{font-size:17px;margin:0 0 12px}p{margin:0 0 10px;color:var(--muted)}code{color:var(--primary)}</style></head><body><h1>这个页面需要访问凭据</h1><p>凭据已经失效，或者当前浏览器没有保存它。</p><p>请在电脑端 Profer 的「设置 → 远程连接 → Web 会话」里复制该会话的链接，重新打开一次。</p><p>iOS 上如果经常遇到，请确认没有开启无痕浏览。</p><script>(function(){try{var params=new URLSearchParams(location.search);if(params.has('token'))return;var saved=localStorage.getItem('profer-webui-token');if(!saved)return;params.set('token',saved);location.replace(location.pathname+'?'+params.toString())}catch(error){}})();</script></body></html>`
}

function readCookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== TOKEN_COOKIE_NAME) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/**
 * 首屏注入会话 id 与 token，页面随后用同源 defaultWsUrl() 连接 /ws。
 *
 * 顺便把 `<title>` 换成会话名：标签页在第一帧就是对的，不会先闪一下通用文案，
 * 也省得等 WS 连上再改 —— 慢网络下那个空窗期可能有好几秒。
 */
function injectBoot(html: string, sessionId: string, token: string, title?: string): string {
  const boot = JSON.stringify({ sessionId, token }).replace(/</g, '\\u003c')
  const script = `<script>window.__PROFER_WEBUI_BOOT__=${boot};</script>`
  const name = title?.trim()
  const withTitle = name
    ? html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(name)}</title>`)
    : html
  return withTitle.includes('<head>')
    ? withTitle.replace('<head>', `<head>${script}`)
    : `${script}${withTitle}`
}

/** 预压缩产物的后缀优先级：br 比 gz 小，浏览器同时支持时优先给 br。 */
const PRECOMPRESSED_SUFFIXES = ['.br', '.gz'] as const

function acceptsEncoding(header: string | undefined, encoding: string): boolean {
  if (!header) return false
  return header.toLowerCase().split(',').some((part) => part.trim().split(';')[0] === encoding)
}

/**
 * 取出可发送的静态资源内容。
 *
 * 打包进安装包的 JS 有 400KB 量级，手机在局域网刷新一次要全量重下；构建脚本会顺带产出
 * `.br` / `.gz`，这里按 `accept-encoding` 直接给压缩体（Node 没有内置压缩，实时压反而更慢）。
 * 找不到预压缩文件时退回原文件，行为与之前一致。
 */
function readAssetPayload(
  fullPath: string,
  acceptEncoding: string | undefined,
): { body: Buffer; encoding: string | null } {
  for (const suffix of PRECOMPRESSED_SUFFIXES) {
    const encoding = suffix.slice(1)
    if (!acceptsEncoding(acceptEncoding, encoding)) continue
    const candidate = `${fullPath}${suffix}`
    if (!existsSync(candidate)) continue
    return { body: readFileSync(candidate), encoding }
  }
  return { body: readFileSync(fullPath), encoding: null }
}

/**
 * 处理 WebUI 的 HTTP 请求。返回 false 表示该路径不属于 WebUI，
 * 由调用方继续走它自己的 404 逻辑。
 */
export function handleWebuiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebuiRequestContext,
): boolean {
  const pathname = (req.url || '').split('?')[0] ?? '/'
  const config = getWebuiConfig()
  const route = resolveWebuiRoute(pathname, config.publishedSessionIds)
  if (route.kind === 'foreign') return false

  const reply = (status: number, body: string, type = 'text/plain; charset=utf-8', extra?: Record<string, string>): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra })
    res.end(body)
  }

  if (!config.enabled) {
    reply(404, 'Not Found')
    return true
  }
  if (!ctx.token) {
    reply(503, '访问令牌尚未生成，请稍后重试')
    return true
  }
  // 静态资源是公开的前端产物（JS/CSS 不含会话数据），浏览器加载 <script>/<link>
  // 不会带 token query 或自定义 header，因此这里不鉴权。
  // 真正的访问控制由 /s/<id> 白名单与 /ws 的 token 保证。
  const publicAsset = route.kind === 'asset'
  const authorized = readCookieToken(req) === ctx.token || ctx.isAuthorized(req)
  if (!publicAsset && !authorized) {
    // 会话页回「自愈页」而不是裸 401：手机上 cookie 会被系统回收，
    // 让页面自己拿 localStorage 里的凭据重试一次，用户不用回电脑复制链接。
    if (route.kind === 'session') {
      reply(401, buildCredentialRecoveryPage(), 'text/html; charset=utf-8')
      return true
    }
    reply(401, 'Unauthorized')
    return true
  }
  if (route.kind === 'invalid') {
    reply(404, 'Not Found')
    return true
  }
  if (route.kind === 'root') {
    reply(200, buildRootPage(config.publishedSessionIds, ctx.token), 'text/html; charset=utf-8')
    return true
  }

  const assetDir = getWebuiAssetDir()
  if (route.kind === 'session') {
    // 白名单里有、但会话已归档/已删除：视为不再发布（老版本的设置里可能残留这种 id）
    if (ctx.isSessionServable && !ctx.isSessionServable(route.sessionId)) {
      reply(404, '该会话已归档或不存在，页面已停止发布')
      return true
    }
    const indexPath = join(assetDir, 'index.html')
    if (!existsSync(indexPath)) {
      reply(503, 'WebUI 静态产物缺失：请把 profer-pocket/webui/dist 拷到 resources/webui，或设置 PROFER_WEBUI_DIR')
      return true
    }
    reply(
      200,
      injectBoot(readFileSync(indexPath, 'utf-8'), route.sessionId, ctx.token, ctx.sessionTitle?.(route.sessionId)),
      'text/html; charset=utf-8',
      { 'set-cookie': buildTokenCookie(ctx.token) },
    )
    return true
  }

  const fullPath = resolve(assetDir, route.relativePath)
  if (fullPath !== assetDir && !fullPath.startsWith(assetDir + sep)) {
    reply(403, 'Forbidden')
    return true
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    reply(404, 'Not Found')
    return true
  }
  // 只有 assets/ 下带内容 hash 的产物才能长缓存。
  // favicon / apple-touch-icon 这类固定名没有 hash：若也长缓存，换了图标老访客一年都看不到，必须回来校验。
  const hashed = route.relativePath.startsWith('assets/')
    && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(route.relativePath)
  const payload = readAssetPayload(fullPath, req.headers['accept-encoding'])
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(fullPath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    vary: 'accept-encoding',
    ...(payload.encoding ? { 'content-encoding': payload.encoding } : {}),
  })
  res.end(payload.body)
  return true
}

/** 供设置面板组装展示地址：只做纯拼装，不触发服务启停。 */
export function buildWebuiPublishedUrls(port: number, host: string, token: string | null) {
  const interfaces = listWebuiInterfaces()
  // 监听 0.0.0.0 时用第一张局域网网卡的地址展示，否则复制出来的 127.0.0.1 在手机上必然打不开。
  return buildPublishedUrls(getWebuiConfig().publishedSessionIds, port, host, token, pickAccessibleHost(interfaces))
}
