/**
 * WelcomeView — 主区域空状态启动器
 *
 * 当没有打开任何标签页时，自动为当前模式创建一个新会话并打开标签页。
 * 这样用户直接看到完整的 ChatView/AgentView（含全功能输入框），
 * 问候语和 Tips 在对话空状态中展示。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Loader2 } from 'lucide-react'
import { appModeAtom } from '@/atoms/app-mode'
import { useCreateSession } from '@/hooks/useCreateSession'

export function WelcomeView(): React.ReactElement {
  const mode = useAtomValue(appModeAtom)
  const { createChat, createAgent } = useCreateSession()
  const createdRef = React.useRef(false)

  React.useEffect(() => {
    if (createdRef.current) return
    createdRef.current = true

    if (mode === 'agent') {
      createAgent()
    } else {
      createChat()
    }
  }, [mode, createChat, createAgent])

  // 短暂的过渡状态（通常几十毫秒内就会被 SplitContainer 替换）
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground/40" />
    </div>
  )
}
