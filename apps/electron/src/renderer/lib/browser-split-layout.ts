export interface BrowserSplitGeometry {
  browserWidth: number
  conversationWidth: number
  resizeGap: number
}

export function resolveBrowserSplitGeometry(
  containerWidth: number,
  ratio: number,
  visible: boolean,
  options: { resizeGap: number; minConversationWidth: number; minBrowserWidth: number },
): BrowserSplitGeometry {
  if (!visible) return { browserWidth: 0, conversationWidth: Math.max(0, containerWidth), resizeGap: 0 }
  const available = Math.max(0, containerWidth - options.resizeGap)
  const minConversation = Math.min(options.minConversationWidth, available)
  const minBrowser = Math.min(options.minBrowserWidth, Math.max(0, available - minConversation))
  const unclampedConversation = available * ratio
  const conversationWidth = Math.round(Math.max(minConversation, Math.min(available - minBrowser, unclampedConversation)))
  return {
    conversationWidth,
    browserWidth: Math.max(0, available - conversationWidth),
    resizeGap: options.resizeGap,
  }
}
