/**
 * AI Elements - 语音输入按钮
 *
 * 通过主进程唤起系统级豆包流式语音输入浮窗。
 */

import { useCallback } from 'react'
import { MicIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'

interface SpeechButtonProps {
  /** @deprecated 语音结果统一由全局语音输入回填到当前输入框 */
  onTranscript?: (text: string) => void
  /** 是否禁用 */
  disabled?: boolean
  className?: string
  /** Agent 输入区使用统一 Composer 触发器；Chat 默认保持原样。 */
  composerTool?: boolean
  tabletMode?: boolean
}

export function SpeechButton({
  disabled = false,
  className,
  composerTool = false,
  tabletMode = false,
}: SpeechButtonProps): React.ReactElement {
  const handleClick = useCallback((): void => {
    void (async () => {
      try {
        const settings = await window.electronAPI.getVoiceDictationSettings()
        if (!settings.enabled) {
          toast.info('请先在设置中打开语音输入开关')
          return
        }

        await window.electronAPI.toggleVoiceDictation()
      } catch (error) {
        console.error('[语音输入] 唤起浮窗失败:', error)
        toast.error('唤起语音输入失败')
      }
    })()
  }, [])

  if (composerTool) {
    return (
      <AgentComposerToolTrigger
        label="语音输入"
        tooltip="语音输入"
        tabletMode={tabletMode}
        className={className}
        onClick={handleClick}
        disabled={disabled}
      >
        <MicIcon className="size-5" />
      </AgentComposerToolTrigger>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'relative size-8 transition-all duration-200 text-foreground/60 hover:text-foreground',
            className
          )}
          onClick={handleClick}
          disabled={disabled}
        >
          <MicIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>语音输入</p>
      </TooltipContent>
    </Tooltip>
  )
}
