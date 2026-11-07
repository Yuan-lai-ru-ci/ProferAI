/**
 * 配置目录与画像文件路径解析（electron-free）。
 *
 * 为什么独立成模块：CLI 没有 Electron 运行时，不能复用主进程的
 * `config-root.ts`（那里要靠 `app.isPackaged` 决定 `.profer` / `.profer-dev`，
 * 还要做旧目录迁移与权限收紧）。但两个宿主必须对「画像文件在哪」给出同一个答案，
 * 否则同一台机器上 GUI 和 CLI 会读写不同的目录。
 *
 * 因此这里只负责**布局**，不负责 Electron 特有的探测：
 *   - 显式传入的 configDir 优先级最高（CLI 的 --config-dir）
 *   - 其次 PROFER_CONFIG_DIR（与主进程一致的受控覆盖）
 *   - 再次 PROFER_DEV / PROMA_DEV → ~/.profer-dev
 *   - 兜底 ~/.profer
 *
 * 目录布局（与主进程 config-paths.ts 保持一致）：
 *   <configDir>/user-profile.json        用户名 / 头像
 *   <configDir>/global-memory/MEMORY.md  跨工作区用户记忆索引
 *   <configDir>/global-memory/*.md       画像与主题记忆正文
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ConfigDirOptions {
  /** 显式指定配置目录。优先级最高；原样返回，不做 resolve。 */
  configDir?: string
  /** 使用开发目录 .profer-dev（等价于 PROFER_DEV=1；兼容 PROMA_DEV=1）。 */
  dev?: boolean
}

/** 解析 Profer 配置根目录。 */
export function resolveConfigDir(opts: ConfigDirOptions = {}): string {
  if (opts.configDir) return opts.configDir

  const override = process.env.PROFER_CONFIG_DIR?.trim()
  if (override) return resolve(override)

  const useDev = opts.dev || process.env.PROFER_DEV === '1' || process.env.PROMA_DEV === '1'
  return join(homedir(), useDev ? '.profer-dev' : '.profer')
}

/** 全局用户记忆目录。 */
export function getGlobalMemoryDir(configDir: string): string {
  return join(configDir, 'global-memory')
}

/** 用户档案文件（用户名 / 头像）。 */
export function getUserProfilePath(configDir: string): string {
  return join(configDir, 'user-profile.json')
}
