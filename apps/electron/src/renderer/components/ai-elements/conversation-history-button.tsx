import type { ComponentProps } from 'react'
import { useConversationScroll } from './conversation-scroll'

/** 同步状态更新和异步 prepend 都由共享 content observer 完成锚点恢复。 */
export function ConversationHistoryButton({ onClick, ...props }: ComponentProps<'button'>): React.ReactElement {
  const { beginLayout } = useConversationScroll()
  return <button {...props} onClick={(event) => {
    beginLayout()
    onClick?.(event)
  }} />
}
