import type { BrowserViewBounds } from '@profer/shared'

/**
 * 将 renderer 的 CSS 像素转换为 contentView 坐标，并限制在主窗口范围内。
 * 这是受管浏览器唯一允许做缩放与裁切转换的位置。
 */
export function resolveBrowserViewportLayout(
  bounds: BrowserViewBounds,
  zoomFactor: number,
  contentBounds: Pick<BrowserViewBounds, 'width' | 'height'>,
): BrowserViewBounds {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const scaled = {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.max(0, Math.round(bounds.width * scale)),
    height: Math.max(0, Math.round(bounds.height * scale)),
  }
  const x = Math.min(Math.max(0, scaled.x), Math.max(0, contentBounds.width))
  const y = Math.min(Math.max(0, scaled.y), Math.max(0, contentBounds.height))
  return {
    x,
    y,
    width: Math.min(scaled.width, Math.max(0, contentBounds.width - x)),
    height: Math.min(scaled.height, Math.max(0, contentBounds.height - y)),
  }
}

/** React 清理与新视口挂载可交错；旧代际绝不能覆盖当前原生视图。 */
export function shouldApplyBrowserLayoutRevision(lastRevision: number, nextRevision: number): boolean {
  return Number.isSafeInteger(nextRevision) && nextRevision > lastRevision
}

export function hasUsableBrowserBounds(bounds: BrowserViewBounds): boolean {
  return bounds.width > 4 && bounds.height > 4
}

/** 将 frame 内的网页区域转换为 contentView 直接子 View 的绝对边界。 */
export function resolveBrowserPageHostBounds(
  viewportBounds: BrowserViewBounds,
  pageBounds: BrowserViewBounds,
): BrowserViewBounds {
  return {
    x: viewportBounds.x + pageBounds.x,
    y: viewportBounds.y + pageBounds.y,
    width: pageBounds.width,
    height: pageBounds.height,
  }
}

export function sameBrowserBounds(left: BrowserViewBounds | undefined, right: BrowserViewBounds): boolean {
  return !!left
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}
