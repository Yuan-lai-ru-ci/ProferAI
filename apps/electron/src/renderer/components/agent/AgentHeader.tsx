/**
 * AgentHeader — 保留为兼容组件。
 *
 * 会话标题与重命名入口已完全收敛到顶部 TabBar，内容区不再保留重复标题占位。
 */

import * as React from 'react'

interface AgentHeaderProps {
  sessionId: string
}

export function AgentHeader({ sessionId: _sessionId }: AgentHeaderProps): React.ReactElement | null {
  return null
}
