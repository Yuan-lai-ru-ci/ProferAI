import { join, resolve } from 'node:path'

const DEFAULT_DEV_USER_DATA_DIR = '@profer/electron-dev'
const DEV_INSTANCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export interface DevInstanceEnvironment {
  [key: string]: string | undefined
  PROFER_DEV_INSTANCE?: string
  PROFER_USER_DATA_DIR?: string
  PROFER_VITE_PORT?: string
}

export interface DevPathOperations {
  join(...paths: string[]): string
  resolve(...paths: string[]): string
}

const hostPathOperations: DevPathOperations = { join, resolve }

/**
 * 读取受控开发实例标识。只允许安全文件名字符，避免环境变量变成路径穿越入口。
 */
export function getDevInstanceId(env: DevInstanceEnvironment = process.env): string | undefined {
  const value = env.PROFER_DEV_INSTANCE?.trim()
  if (!value) return undefined
  return DEV_INSTANCE_PATTERN.test(value) ? value : undefined
}

/**
 * 解析 Electron 开发实例的 userData。正式版永远不读取开发隔离参数。
 */
export function resolveDevUserDataPath(
  appDataPath: string,
  isPackaged: boolean,
  env: DevInstanceEnvironment = process.env,
  pathOperations: DevPathOperations = hostPathOperations,
): string {
  if (isPackaged) return pathOperations.join(appDataPath, '@profer', 'electron')

  const explicit = env.PROFER_USER_DATA_DIR?.trim()
  if (explicit) return pathOperations.resolve(explicit)

  const instanceId = getDevInstanceId(env)
  return instanceId
    ? pathOperations.join(appDataPath, '@profer', `electron-dev-${instanceId}`)
    : pathOperations.join(appDataPath, DEFAULT_DEV_USER_DATA_DIR)
}

/**
 * 解析开发 Vite 端口。只有显式提供合法 TCP 端口时才覆盖默认端口。
 */
export function resolveDevVitePort(env: DevInstanceEnvironment = process.env): number {
  const value = env.PROFER_VITE_PORT?.trim()
  if (!value || !/^\d+$/.test(value)) return 5174
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 5174
}

export function resolveDevAppName(env: DevInstanceEnvironment = process.env): string {
  const instanceId = getDevInstanceId(env)
  return instanceId ? `profer-dev-${instanceId}` : 'profer-dev'
}

/**
 * 读取显式的 `--user-data-dir` 开关。
 *
 * 为什么主进程要自己读：正式版原本把 userData 固定成 `appData/@profer/electron`，
 * 会把 Chromium 已按开关设置好的路径再覆盖回去，于是 `--user-data-dir` 形同虚设，
 * 单实例锁也因此仍落在真实用户数据目录里——发布前的启动冒烟与 QA 多开需要真正隔离。
 * 只接受命令行显式传入；不读任何环境变量，不影响双击启动。
 */
export function readUserDataDirSwitch(argv: readonly string[]): string | undefined {
  const prefix = '--user-data-dir='
  for (const arg of argv) {
    if (!arg.startsWith(prefix)) continue
    const value = arg.slice(prefix.length).trim()
    return value ? resolve(value) : undefined
  }
  return undefined
}
