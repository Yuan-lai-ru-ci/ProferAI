import { execFileSync } from 'node:child_process'
import { app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const DEV_APP_USER_MODEL_ID = 'com.profer.app.dev'
export const DEV_SHORTCUT_NAME = 'Profer Dev.lnk'

/** Windows 开发态的裸 electron.exe 需要独立 AUMID，绝不能复用生产 Profer 身份。 */
export function shouldMaintainDevShellShortcut(
  platform: NodeJS.Platform = process.platform,
  isPackaged = app.isPackaged,
): boolean {
  return platform === 'win32' && !isPackaged
}

function getProgramsPath(): string {
  return join(process.env.APPDATA ?? app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
}

function quoteWindowsArgument(value: string): string {
  if (!/[\s"]/u.test(value)) return value
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

/**
 * Electron 能写 AUMID，但它的 icon 字段只接受 EXE/DLL。写完 AUMID 后，
 * 通过 Windows 官方 WScript Shell COM 把 IconLocation 设为裸 ICO。
 */
function setShortcutIconLocation(shortcutPath: string, iconPath: string): void {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    '$link = $shell.CreateShortcut($env:PROFER_DEV_SHORTCUT_PATH)',
    '$link.IconLocation = "$env:PROFER_DEV_SHORTCUT_ICON,0"',
    '$link.Save()',
  ].join('; ')
  execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    windowsHide: true,
    env: { ...process.env, PROFER_DEV_SHORTCUT_PATH: shortcutPath, PROFER_DEV_SHORTCUT_ICON: iconPath },
  })
}

export function maintainDevShellShortcut(): void {
  if (!shouldMaintainDevShellShortcut()) return

  const iconPath = join(__dirname, 'resources', 'icon.ico')
  if (!existsSync(iconPath)) {
    console.warn(`[开发 Shell] 未找到 Profer 开发图标，跳过快捷方式维护: ${iconPath}`)
    return
  }

  const shortcutPath = join(getProgramsPath(), DEV_SHORTCUT_NAME)
  const exists = existsSync(shortcutPath)
  const args = process.argv.slice(1).map(quoteWindowsArgument).join(' ')
  // icon 暂时指向 electron.exe：满足 Electron 的 EXE/DLL 限制；随后 COM 覆盖为 Profer ICO。
  const ok = shell.writeShortcutLink(shortcutPath, exists ? 'update' : 'create', {
    target: process.execPath,
    cwd: app.getAppPath(),
    args,
    description: 'Profer 开发版（仅供本机开发）',
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: DEV_APP_USER_MODEL_ID,
  })
  if (!ok) throw new Error(`无法写入开发版 Shell 快捷方式: ${shortcutPath}`)

  setShortcutIconLocation(shortcutPath, iconPath)
  console.log(`[开发 Shell] 已维护 ${DEV_SHORTCUT_NAME}（AUMID=${DEV_APP_USER_MODEL_ID}）`)
}
