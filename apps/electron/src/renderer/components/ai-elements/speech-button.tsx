/**
 * AI Elements - 语音输入按钮
 *
 * 通过主进程唤起系统级豆包流式语音输入浮窗。
 */

import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
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
import {
  voiceDictationEnabledAtom,
  voiceDictationSettingsAtom,
} from '@/atoms/voice-dictation-atoms'

interface SpeechButtonProps {
  /** @deprecated 语音结果统一由全局语音输入回填到当前输入框 */
  onTranscript?: (text: string) => void
  /** 是否禁用 */
  disabled?: boolean
  className?: string
  /** Agent 输入区使用统一 Composer 触发器；Chat 默认保持原样。 */
  composerTool?: boolean
}

export function useLoadVoiceDictationSettings(): void {
  const setSettings = useSetAtom(voiceDictationSettingsAtom)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getVoiceDictationSettings()
      .then((settings) => {
        if (!cancelled) setSettings(settings)
      })
      .catch((error) => console.error('[语音输入] 加载设置失败:', error))

    return () => {
      cancelled = true
    }
  }, [setSettings])
}

export function SpeechButton({
  disabled = false,
  className,
  composerTool = false,
}: SpeechButtonProps): React.ReactElement | null {
  const enabled = useAtomValue(voiceDictationEnabledAtom)

  useLoadVoiceDictationSettings()

  const handleClick = useCallback((): void => {
    void (async () => {
      try {
        await window.electronAPI.toggleVoiceDictation()
      } catch (error) {
        console.error('[语音输入] 唤起浮窗失败:', error)
        toast.error('唤起语音输入失败')
      }
    })()
  }, [])

  if (!enabled) return null

  if (composerTool) {
    return (
      <AgentComposerToolTrigger
        label="语音输入"
        tooltip="语音输入"
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
