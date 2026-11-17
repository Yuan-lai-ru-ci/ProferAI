/**
 * WebUI 的配置读取层（只读设置，不启停任何东西）。
 *
 * 单独成文件是为了切断循环依赖：`webui-service` 需要配置，`remote-service` 也需要
 * 「网页能看哪些会话」来约束 WS 命令；若让其中任何一方提供配置，两者就会互相 import。
 * 本模块只依赖 settings-service 与纯函数层，谁都可以安全引用。
 */
import { app } from 'electron'
import { getSettings } from './settings-service'
import {
  normalizeBindHost,
  normalizePublishedIds,
  planWebuiPort,
  WEBUI_DEFAULT_PORT,
  WEBUI_DEV_DEFAULT_PORT,
} from './webui-routing'

/** WebUI 独立服务的默认端口（正式版 7800、开发版 7801），与 Pocket 的 7788/7789 错开。 */
export function getDefaultWebuiPort(): number {
  return app.isPackaged ? WEBUI_DEFAULT_PORT : WEBUI_DEV_DEFAULT_PORT
}

/** 实际要监听的端口：环境变量 > 设置 > 默认。 */
export function resolveWebuiPort(input?: unknown): number {
  return planWebuiPort({
    saved: input ?? getSettings().webuiPort,
    env: process.env.PROFER_WEBUI_PORT,
    fallback: getDefaultWebuiPort(),
  })
}

export interface WebuiConfig {
  enabled: boolean
  bindHost: string
  /** 期望监听端口（未被占用时的首选值） */
  port: number
  publishedSessionIds: string[]
}

export function getWebuiConfig(): WebuiConfig {
  const settings = getSettings()
  return {
    enabled: settings.webuiEnabled === true,
    bindHost: normalizeBindHost(settings.webuiBindHost),
    port: resolveWebuiPort(settings.webuiPort),
    publishedSessionIds: normalizePublishedIds(settings.webuiPublishedSessionIds),
  }
}

/**
 * 「网页能访问哪些会话」的唯一读口。
 *
 * 白名单本身是持久化配置，会落后于会话状态（归档、删除），所以这里只回配置；
 * 「这个会话当前是否还能对外服务」由 `webui-session-guard` 在读的时候复核。
 */
export function readWebuiPublishedIds(): string[] {
  return normalizePublishedIds(getSettings().webuiPublishedSessionIds)
}
