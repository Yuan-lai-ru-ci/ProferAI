/**
 * 受管窗口（主窗口 / 会话窗口 / 规划中心 / 独立预览）使用的应用图标解析。
 *
 * 打包态 Windows 读取 `resources/app-icon.ico`，而不是源文件同名的
 * `resources/icon.ico`。原因：`resources/icon.ico` 历史上同时被 NSIS 文件关联的
 * DefaultIcon 引用，Shell（explorer）在升级安装时仍可能持有句柄，让安装器写不进
 * 这个文件，用户看到的就是「不能打开要写入的文件 D:\...\resources\icon.ico」。
 *
 * 现在文件关联与任务栏身份都指向 Profer.exe 内嵌图标（after-pack 会强制把品牌
 * 图标打进 exe，失败即中断打包），安装器不再改写任何被 Shell 引用的 .ico；
 * 窗口图标改用重命名后的副本，覆盖安装时不会和旧版本的注册表引用抢同一个文件。
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 打包产物中的图标文件名（纯函数，便于单测）。 */
export function resolveAppWindowIconFileName(
  platform: NodeJS.Platform,
  isPackaged: boolean,
): string {
  if (platform === 'darwin') return 'icon.icns'
  // 开发态 dist/resources 仍是 build:resources 直接拷贝的源目录结构，沿用 icon.ico。
  if (platform === 'win32') return isPackaged ? 'app-icon.ico' : 'icon.ico'
  return 'icon.png'
}

export interface AppWindowIconPathOptions {
  /** 覆盖资源目录（测试用）。 */
  resourcesDir?: string
  /** 覆盖平台判定（测试用）。 */
  platform?: NodeJS.Platform
  /** 覆盖打包态判定（测试用）。 */
  isPackaged?: boolean
}

/** 解析当前进程可用的窗口图标绝对路径；文件缺失时返回 undefined。 */
export function resolveAppWindowIconPath(options: AppWindowIconPathOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged ?? app.isPackaged
  const resourcesDir = options.resourcesDir
    ?? (isPackaged ? process.resourcesPath : join(__dirname, 'resources'))
  const iconPath = join(resourcesDir, resolveAppWindowIconFileName(platform, isPackaged))
  return existsSync(iconPath) ? iconPath : undefined
}
