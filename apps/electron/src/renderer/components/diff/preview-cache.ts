/**
 * 文件预览的内容缓存与滚动位置缓存。
 *
 * 单独成模块的原因：左侧栏关闭 Tab 时要清这个缓存（`use-left-sidebar.ts`）。如果那里直接
 * import `DiffTabContent`，Rollup 为了不重复打包，会把整棵预览子树（DiffTabContent +
 * MarkdownRichEditor + PierreFile + OfficePreview…）留在入口 chunk 里，预览面的按需加载就失效了。
 * 缓存本身不依赖 React，抽出来之后两边都只依赖这一个小模块。
 */

export type PreviewCacheEntry = {
  oldContent: string
  newContent: string
  /** 非文本文件预览数据 */
  pdfSrc?: string
  imageDataUrl?: string
  imagePath?: string
  docxHtml?: string
  officeHtml?: string
  officeText?: string
  /** HTML 预览的目录级 token URL，允许加载同目录相对资源 */
  htmlPreviewUrl?: string
}

/** 内容缓存保留的最大条目数（LRU） */
export const PREVIEW_CACHE_MAX = 50

export const previewContentCache = new Map<string, PreviewCacheEntry>()

/** 滚动位置持久化：key = `${sessionId}:${filePath}` */
export const previewScrollPositions = new Map<string, { top: number; left: number }>()

export function previewScrollKey(sessionId: string, filePath: string): string {
  return `${sessionId}:${filePath}`
}

/** 获取缓存的滚动位置 */
export function getPreviewScrollPosition(
  sessionId: string,
  filePath: string,
): { top: number; left: number } | undefined {
  return previewScrollPositions.get(previewScrollKey(sessionId, filePath))
}

/**
 * 清除指定 session 的预览缓存，供 useCloseTab 调用。
 */
export function clearPreviewCacheForSession(sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const key of previewScrollPositions.keys()) {
    if (key.startsWith(prefix)) previewScrollPositions.delete(key)
  }
  for (const key of previewContentCache.keys()) {
    if (key.startsWith(prefix)) previewContentCache.delete(key)
  }
}
