import { BrowserWindow, nativeTheme } from 'electron'
import type { ThemeMode, ThemeStyle } from '../../types'
import { getSettings } from './settings-service'

interface OverlayColors {
  color: string
  symbolColor: string
  height: number
}

const OVERLAY_HEIGHT = 40

// Colors are computed as: alpha-composite of hsl(--muted / 0.5) over hsl(--content-area),
// matching the actual rendered TabBar background color to eliminate the visual seam on Windows.
const THEME_COLORS: Record<string, { color: string; symbolColor: string }> = {
  'default-light': { color: '#fafafa', symbolColor: '#0a0a0a' },
  'default-dark': { color: '#1c1c1c', symbolColor: '#fafafa' },
  'ocean-light': { color: '#e6eef5', symbolColor: '#1b2632' },
  'ocean-dark': { color: '#131c26', symbolColor: '#e7ebef' },
  'forest-light': { color: '#ecf1ee', symbolColor: '#1d3026' },
  'forest-dark': { color: '#16201b', symbolColor: '#e3e8e5' },
  'slate-light': { color: '#e6e4df', symbolColor: '#312f2a' },
  'slate-dark': { color: '#1f1c21', symbolColor: '#e9e6e3' },
  'mist-paper-dark': { color: '#2a2928', symbolColor: '#b8b6b3' },
}

export function resolveOverlayColors(
  themeMode: ThemeMode,
  themeStyle: ThemeStyle | undefined,
  systemIsDark: boolean
): OverlayColors {
  let key: string

  if (themeMode === 'special' && themeStyle && themeStyle !== 'default') {
    key = themeStyle
  } else if (themeMode === 'system') {
    key = systemIsDark ? 'default-dark' : 'default-light'
  } else if (themeMode === 'dark') {
    key = 'default-dark'
  } else {
    key = 'default-light'
  }

  const colors = THEME_COLORS[key] ?? THEME_COLORS['default-dark']!
  return { color: colors.color, symbolColor: colors.symbolColor, height: OVERLAY_HEIGHT }
}

export function getWindowFrameColor(): string {
  const settings = getSettings()
  return resolveOverlayColors(
    settings.themeMode,
    settings.themeStyle,
    nativeTheme.shouldUseDarkColors
  ).color
}

/**
 * 同步 Windows 原生窗口外壳颜色。
 *
 * `titleBarStyle: 'hidden'` 仍保留一圈由 Windows/DWM 合成的非客户区；若 BrowserWindow
 * 未显式设置 backgroundColor，Electron 会以默认白色填充该区域，在深色主题静止时也会
 * 显示为白边。用与标题栏一致的颜色同时更新窗口底色，避免窗口壳与 renderer 脱节。
 */
export function updateWindowFrameAppearance(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return

  const settings = getSettings()
  const { color, symbolColor, height } = resolveOverlayColors(
    settings.themeMode,
    settings.themeStyle,
    nativeTheme.shouldUseDarkColors
  )

  win.setBackgroundColor(color)
  try {
    win.setTitleBarOverlay({ color, symbolColor, height })
  } catch {
    // frameless 窗口（如 quick-task）不支持 setTitleBarOverlay，背景色仍需更新。
  }
}
