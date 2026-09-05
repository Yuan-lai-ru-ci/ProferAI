/**
 * macOS 原生红绿灯位置同步。
 *
 * BrowserWindow 的 traffic lights 不属于 renderer，因此不会随 Chromium 页面缩放自动移动。
 * 位置坐标使用窗口 DIP；页面缩放后，renderer 中的左上安全区按同一倍率放大，原生按钮位置也
 * 必须按倍率换算，才能继续与侧栏布局保持一致。
 */

import type { BrowserWindow, Point } from 'electron'

export const DEFAULT_TRAFFIC_LIGHT_POSITION: Point = { x: 18, y: 18 }
/** 桌面主界面默认缩放；⌘0 也应回到此倍率，而非 Chromium 的 100%。 */
export const DEFAULT_MAIN_WINDOW_ZOOM_FACTOR = 1.1

export function resolveTrafficLightPosition(zoomFactor: number, base = DEFAULT_TRAFFIC_LIGHT_POSITION): Point {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return {
    x: Math.round(base.x * scale),
    y: Math.round(base.y * scale),
  }
}

/** 将原生红绿灯移动到与当前页面缩放倍率一致的位置。 */
export function syncMacTrafficLightPosition(win: BrowserWindow): void {
  if (process.platform !== 'darwin' || win.isDestroyed()) return
  win.setWindowButtonPosition(resolveTrafficLightPosition(win.webContents.getZoomFactor()))
}

/** 修改窗口页面缩放，并在 macOS 上同步原生红绿灯。 */
export function setWindowZoomLevel(win: BrowserWindow, level: number): void {
  if (win.isDestroyed()) return
  win.webContents.setZoomLevel(level)
  syncMacTrafficLightPosition(win)
}

export function adjustWindowZoom(win: BrowserWindow, delta: number): void {
  if (win.isDestroyed()) return
  setWindowZoomLevel(win, Math.max(-9, Math.min(9, win.webContents.getZoomLevel() + delta)))
}

/** 将主界面恢复到 Profer 设定的默认缩放，并同步 macOS 原生红绿灯。 */
export function resetWindowZoom(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.setZoomFactor(DEFAULT_MAIN_WINDOW_ZOOM_FACTOR)
  syncMacTrafficLightPosition(win)
}

/** 监听所有 Chromium 缩放入口，确保菜单、快捷键和滚轮缩放都能同步。 */
export function installMacTrafficLightZoomSync(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return

  syncMacTrafficLightPosition(win)
  win.webContents.on('zoom-changed', () => syncMacTrafficLightPosition(win))
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return

    const key = input.key.toLowerCase()
    if (key === '0') {
      event.preventDefault()
      resetWindowZoom(win)
    } else if (['=', '+', 'add', 'numadd'].includes(key)) {
      event.preventDefault()
      adjustWindowZoom(win, 0.5)
    } else if (['-', 'subtract', 'numsub'].includes(key)) {
      event.preventDefault()
      adjustWindowZoom(win, -0.5)
    }
  })
}
