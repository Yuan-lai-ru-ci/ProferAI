import { session as electronSession, type Session } from 'electron'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { PROFER_PLUGIN_ID_PATTERN } from '@profer/plugin-api'
import { resolveInstalledPluginRoot } from './plugin-manager'

/**
 * 插件 session 共享注册：主窗口 View 与独立悬浮 BrowserWindow 复用同一 partition
 * （profer-plugin-{pluginId}），协议 handler 与会话守卫必须在任一侧首个页面创建前就绪。
 * 注册属于 Electron Session 生命周期，注册后与窗口解耦，不可重复 protocol.handle。
 */

const guardedPartitions = new Set<string>()
const protocolPartitions = new Set<string>()

const PLUGIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function pluginResourceResponse(request: Request, expectedPluginId: string, root: string): Response | Promise<Response> {
  let url: URL
  try { url = new URL(request.url) } catch { return new Response('Bad Request', { status: 400 }) }
  if (url.hostname !== expectedPluginId || !PROFER_PLUGIN_ID_PATTERN.test(url.hostname)) return new Response('Forbidden', { status: 403 })

  let relativePath: string
  try { relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, '')) } catch { return new Response('Bad Request', { status: 400 }) }
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\')) return new Response('Forbidden', { status: 403 })
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !target.startsWith(`${root}${sep}`)) return new Response('Forbidden', { status: 403 })
  try {
    if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !statSync(target).isFile()) return new Response('Not Found', { status: 404 })
    const realTarget = realpathSync(target)
    if (!realTarget.startsWith(`${root}${sep}`)) return new Response('Forbidden', { status: 403 })
  } catch {
    return new Response('Not Found', { status: 404 })
  }

  const mime = MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  try {
    // 直接读取已验证文件，避免在 session 的默认拒绝 webRequest 下再发起 file:// 子请求。
    const body = readFileSync(target)
    const headers = new Headers({
      'Content-Type': mime,
      'Content-Security-Policy': PLUGIN_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    })
    return new Response(body, { status: 200, headers })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

function installSessionGuards(pluginSession: Session): void {
  pluginSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  pluginSession.setPermissionCheckHandler(() => false)
  pluginSession.on('will-download', (event, item) => {
    event.preventDefault()
    item.cancel()
  })
  pluginSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('profer-plugin://') })
  })
}

/** 返回插件专用 session，并确保协议 handler 与守卫已注册（幂等）。 */
export function ensurePluginSession(pluginId: string): Session {
  const partition = `profer-plugin-${pluginId}`
  const pluginSession = electronSession.fromPartition(partition, { cache: false })
  if (!guardedPartitions.has(partition)) {
    installSessionGuards(pluginSession)
    guardedPartitions.add(partition)
  }
  if (!protocolPartitions.has(partition)) {
    pluginSession.protocol.handle('profer-plugin', (request) => {
      try {
        return pluginResourceResponse(request, pluginId, resolveInstalledPluginRoot(pluginId))
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    })
    protocolPartitions.add(partition)
  }
  return pluginSession
}
