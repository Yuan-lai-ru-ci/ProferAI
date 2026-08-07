/**
 * TabletModeContext — 平板远程模式标记（Context 形式）
 *
 * 平板端复用桌面消息组件（AgentMessages → SDKMessageRenderer → ContentBlock →
 * MarkdownInlineCode / MarkdownLink → FilePathChip），prop 链路过深，逐层透传改动面大。
 * 用 Context 在 AgentMessages（已有 tabletMode prop）顶层注入，消息内部的
 * 预览/文件操作入口据此判断是否隐藏（平板无 MainArea/TabBar 渲染预览面板，
 * 且 WS 协议无 read_file，预览功能不可用，入口应诚实隐藏）。
 */

import * as React from 'react'

export const TabletModeContext = React.createContext(false)

export function useTabletMode(): boolean {
  return React.useContext(TabletModeContext)
}
