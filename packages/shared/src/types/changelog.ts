/**
 * 版本更新日志（CHANGELOG）相关类型
 *
 * 版本历史内容由每次发版时维护在应用内置的 CHANGELOG.json 中，
 * 前端直接读取本地文件展示，不依赖 GitHub 等外部服务。
 */

/** 单条版本更新记录 */
export interface ChangelogEntry {
  /** 版本号（如 0.15.42） */
  version: string
  /** 发布日期（YYYY-MM-DD） */
  date: string
  /** 标题（默认显示 v{version}；可选） */
  title?: string
  /** 本次更新内容（Markdown 格式） */
  notes: string
}

/** 内置 CHANGELOG 文件结构 */
export interface ChangelogFile {
  /** 版本更新记录列表（新版本在前） */
  releases: ChangelogEntry[]
}

/** 版本更新日志 IPC 通道常量 */
export const CHANGELOG_IPC_CHANNELS = {
  /** 获取版本更新日志 */
  GET: 'changelog:get',
} as const
