/**
 * 次级主窗口的几何计算（纯函数）。
 *
 * 从标签拖出时窗口应该出现在鼠标附近，并且完整落在鼠标所在显示器的工作区内；
 * 这里不依赖 Electron，便于直接单测边界情况。
 */

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowSize {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * 计算拖出标签后新窗口的边界。
 *
 * - 尺寸沿用源窗口，但不超过鼠标所在显示器的工作区；
 * - 鼠标落在新窗口标签栏附近（水平 1/4 处、垂直顶部 24px），保留「标签跟着鼠标走」的直觉；
 * - 贴边时向工作区内收，避免窗口标题栏跑到屏幕外。
 */
export function resolveSecondaryWindowBounds(params: {
  cursor: Point
  workArea: WindowRect
  sourceSize?: WindowSize
}): WindowRect {
  const { cursor, workArea, sourceSize } = params
  const width = Math.round(clamp(sourceSize?.width ?? 1280, 480, workArea.width))
  const height = Math.round(clamp(sourceSize?.height ?? 860, 360, workArea.height))
  const x = Math.round(clamp(cursor.x - width * 0.25, workArea.x, workArea.x + workArea.width - width))
  const y = Math.round(clamp(cursor.y - 24, workArea.y, workArea.y + workArea.height - height))
  return { x, y, width, height }
}
