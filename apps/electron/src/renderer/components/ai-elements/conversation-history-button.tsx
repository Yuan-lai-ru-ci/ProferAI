import type { ComponentProps } from 'react'
import { useConversationScroll } from './conversation-scroll'

/** prepend 期间按 scrollHeight 增量保持视口（块锚点会随过程组重建消失）。 */
export function ConversationHistoryButton({ onClick, ...props }: ComponentProps<'button'>): React.ReactElement {
  const { beginPrepend } = useConversationScroll()
  return <button {...props} onClick={(event) => {
    beginPrepend()
    onClick?.(event)
  }} />
}
