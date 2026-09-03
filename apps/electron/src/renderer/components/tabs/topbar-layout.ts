export const TOPBAR_HEIGHT = 40
export const TOPBAR_CONTENT_HEIGHT = 37
export const MAC_TOPBAR_HEIGHT = 45
export const MAC_TOPBAR_CONTENT_HEIGHT = 37
export const MAC_TOPBAR_TOP_INSET = 5

export interface TopBarGeometryInput {
  frameHeight?: number
  contentHeight?: number
  brandWidth: number
  actionWidth: number
  availableWidth: number
}

export interface TopBarGeometry {
  frameHeight: number
  contentHeight: number
  verticalGutter: number
  tabsViewportWidth: number
}

/**
 * 默认顶栏保持 40px 外框、内容行 37px；Mac 全局顶栏保持 45px 外框，Tab 行顶部固定 5px、内容高 37px。
 * 横向列宽由真实 brand/action slot 决定，不能通过垂直偏移或负 margin 补偿。
 */
export function resolveTopBarGeometry({
  frameHeight = TOPBAR_HEIGHT,
  contentHeight = TOPBAR_CONTENT_HEIGHT,
  brandWidth,
  actionWidth,
  availableWidth,
}: TopBarGeometryInput): TopBarGeometry {
  const safeFrameHeight = Math.max(0, frameHeight)
  const safeContentHeight = Math.min(Math.max(0, contentHeight), safeFrameHeight)
  const verticalGutter = (safeFrameHeight - safeContentHeight) / 2
  const tabsViewportWidth = Math.max(0, availableWidth - Math.max(0, brandWidth) - Math.max(0, actionWidth))

  return {
    frameHeight: safeFrameHeight,
    contentHeight: safeContentHeight,
    verticalGutter,
    tabsViewportWidth,
  }
}
