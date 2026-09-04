/**
 * 版本更新日志（CHANGELOG）服务
 *
 * 读取应用内置的 CHANGELOG.json，返回每次版本发布的更新内容。
 * 数据由团队每次发版时维护本地文件，不依赖 GitHub 等外部服务。
 */

import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangelogEntry } from '@profer/shared'

/**
 * 内置资源目录
 * dev: __dirname/resources（build:resources 阶段拷贝）
 * prod: process.resourcesPath（electron-builder extraResources 产物）
 */
function getBundledResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
}

/**
 * 读取内置版本更新日志
 *
 * @returns 版本记录列表（新版本在前）；文件缺失或解析失败时返回空数组
 */
export function getChangelog(): ChangelogEntry[] {
  try {
    const filePath = join(getBundledResourcesDir(), 'CHANGELOG.json')
    if (!existsSync(filePath)) {
      console.warn('[CHANGELOG] 未找到内置 CHANGELOG.json:', filePath)
      return []
    }

    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as { releases?: ChangelogEntry[] }
    return Array.isArray(data.releases) ? data.releases : []
  } catch (error) {
    console.error('[CHANGELOG] 读取版本更新日志失败:', error)
    return []
  }
}
