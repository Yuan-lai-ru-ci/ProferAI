import { createHash } from 'node:crypto'

/**
 * 全局单一浏览器 profile：所有工作区、所有 Agent 会话、所有入口（Agent MCP / Pi 桥接 /
 * IPC 用户面板直开）共用同一个身份，登录状态自始至终只落一份，跨会话、跨重启稳定留存，
 * 接近普通浏览器体验。
 *
 * 历史设计曾按工作区 / 会话分层：workspaceId 存在时用 `workspace:<id>`，否则 `session:<sessionId>`。
 * 但不同入口在配置 profile 的时机与可用参数不一致，部分路径会落到 per-session profile，
 * 导致每次新会话都要重新登录（典型如 bilibili）。用户确认不再需要多身份隔离，故统一为单一 key。
 *
 * 持久化 partition 仅保存于本机 Electron userData 中，绝不外发。
 */
const GLOBAL_BROWSER_PROFILE_KEY = 'global-browser-profile'

/** 返回全局固定 profile key（忽略入参，保留签名以兼容既有调用方）。 */
export function resolveBrowserProfileKey(_workspaceId?: string, _sessionId?: string): string {
  return GLOBAL_BROWSER_PROFILE_KEY
}

/** 将 profile 标识转换为稳定、不可反推工作区 ID 的 Electron 持久 partition。 */
export function buildPersistentBrowserPartition(profileKey: string): string {
  const digest = createHash('sha256').update(profileKey).digest('hex').slice(0, 32)
  return `persist:proma-browser-${digest}`
}
