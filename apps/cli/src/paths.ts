/**
 * 会话存储路径解析（electron-free）。
 *
 * Profer 主进程用 config-paths.ts 里的 getConfigDir()，其中通过 require('electron')
 * 判断 isPackaged 来在 .profer / .profer-dev 间切换——CLI 没有 electron 运行时，
 * 因此这里独立实现一份等价逻辑：
 *   - 默认 ~/.profer
 *   - 环境变量 PROFER_DEV=1 → ~/.profer-dev（兼容旧 PROMA_DEV=1）
 *   - 显式 configDir 覆盖（CLI 的 --config-dir）优先级最高
 *
 * 与 config-paths.ts 的目录布局保持一致：
 *   <configDir>/agent-sessions.json        会话索引
 *   <configDir>/agent-sessions/<id>.jsonl   单会话消息
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PathOptions {
  /** 显式指定配置目录（绝对路径）。优先级最高。 */
  configDir?: string
  /** 使用开发目录 .profer-dev（等价于 PROFER_DEV=1；兼容 PROMA_DEV=1）。 */
  dev?: boolean
}

export function resolveConfigDir(opts: PathOptions = {}): string {
  if (opts.configDir) return opts.configDir
  const useDev = opts.dev || process.env.PROFER_DEV === '1' || process.env.PROMA_DEV === '1'
  return join(homedir(), useDev ? '.profer-dev' : '.profer')
}

export function getSessionsIndexPath(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions.json')
}

export function getSessionsDir(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions')
}

export function getSessionMessagesPath(id: string, opts: PathOptions = {}): string {
  return join(getSessionsDir(opts), `${id}.jsonl`)
}
