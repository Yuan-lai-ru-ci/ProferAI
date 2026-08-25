import { BrowserWindow, nativeTheme } from 'electron'
import type { ThemeMode, ThemeStyle } from '../../types'
import { getSettings } from './settings-service'
import { scanSkins } from './skin-service'

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
    // 皮肤包可声明自己的标题栏配色（manifest.titlebar）；优先消费，避免 Windows 视觉接缝。
    // 静态表只覆盖旧主题；girls-band 等新皮肤与用户导入皮肤必须走这里。
    try {
      const skin = scanSkins().find((s) => s.id === themeStyle)
      if (skin?.titlebar) {
        return { color: skin.titlebar.color, symbolColor: skin.titlebar.symbolColor, height: OVERLAY_HEIGHT }
      }
    } catch (error) {
      console.warn('[Titlebar] 读取皮肤 titlebar 失败，回退静态表:', error)
    }
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
 * 受管浏览器卡片宿主（data-browser-native-host）的 DOM 背景色，即 globals.css 的
 * `--browser-host-surface`：亮色 `0 0% 100%`（纯白）、暗色 `0 0% 7%`（#121212）。
 * 受管浏览器 WebContentsView / hostView 的背景必须与它一致，否则圆角边缘会出现色差分层。
 */
export function getBrowserHostSurfaceColor(): string {
  const settings = getSettings()
  const systemIsDark = nativeTheme.shouldUseDarkColors
  let isDark: boolean
  if (settings.themeMode === 'system') {
    isDark = systemIsDark
  } else if (settings.themeMode === 'dark') {
    isDark = true
  } else if (
    settings.themeMode === 'special'
    && settings.themeStyle
    && settings.themeStyle !== 'default'
  ) {
    // 特殊主题的亮暗按风格名判定（与 globals .dark 覆盖机制一致的主流皮肤命名）
    isDark = /dark|midnight|night|ink|black/i.test(settings.themeStyle)
  } else {
    isDark = false
  }
  return isDark ? '#121212' : '#ffffff'
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
