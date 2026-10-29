/**
 * Agent 统一模型与思考强度控件 (AgentModelReasoningPicker)
 *
 * 遵循 Profer 设计系统标准：
 * 1. 结构扁平：直接使用 Popover + PopoverTrigger，避免被嵌套抽象层吞噬点击事件；
 * 2. 按钮样式与工具栏完全对齐：高度 h-9，边距 px-2，rounded-md，标准 hover/active 态；
 * 3. 悬浮面板：纯正 Profer 设计规范，轻量优雅，无廉价闪烁，同心圆角；
 * 4. 点击面板第一行直接拉起原生的完整 ModelSelector Dialog。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Cpu } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@profer/ui/primitives/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@profer/ui/primitives/tooltip'
import { getModelLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import { AgentReasoningSlider, THINKING_LEVEL_TITLES, EFFORT_TITLES } from './AgentReasoningSlider'
import { updateComposerEffort, updateComposerOpenAIThinkingLevel } from '@/domains/composer/composer-api'
import { ModelSelector } from '@/components/chat/ModelSelector'
import type {
  AgentEffort,
  AgentSessionMeta,
  AgentThinkingLevel,
  ReasoningCapability,
  ThinkingConfig,
  ModelOption,
} from '@profer/shared'
import { normalizeReasoningCapabilityLevel } from '@profer/shared'
import { channelsAtom } from '@/atoms/chat-atoms'
import type { ChannelProtocol } from '@/lib/channel-model-groups'

export interface AgentModelReasoningPickerProps {
  sessionId: string
  sessionMeta?: AgentSessionMeta
  capability?: ReasoningCapability
  capabilityLoading?: boolean
  presetEffort?: AgentEffort
  globalEffort?: AgentEffort
  agentThinking?: ThinkingConfig
  onToggleThinking?: () => void
  running: boolean
  onSessionUpdated: (session: AgentSessionMeta) => void
  thinkingExpanded: boolean
  onThinkingExpandedChange: (expanded: boolean) => void

  // 模型选择
  externalSelectedModel?: { channelId: string; modelId: string } | null
  onModelSelect?: (option: ModelOption) => void
  filterChannelIds?: string[]
  preferredProtocol?: ChannelProtocol
  strictProtocolFilter?: boolean
}

/** 规范化模型人类可读名称，剥离底层 ID 前缀 */
function formatHumanModelName(rawId: string): string {
  if (!rawId) return '选择模型'
  const colonIdx = rawId.lastIndexOf(':')
  const clean = colonIdx >= 0 ? rawId.slice(colonIdx + 1) : rawId
  if (clean.includes('deepseek-v4.1-flash')) return 'DeepSeek 4.1 Flash'
  if (clean.includes('deepseek-v4.1')) return 'DeepSeek 4.1'
  if (clean.includes('deepseek-chat')) return 'DeepSeek V3'
  if (clean.includes('deepseek-reasoner')) return 'DeepSeek R1'
  if (clean.includes('claude-3-7-sonnet')) return 'Claude 3.7 Sonnet'
  if (clean.includes('claude-3-5-sonnet')) return 'Claude 3.5 Sonnet'
  if (clean.includes('gpt-4o')) return 'GPT-4o'
  return clean
}

export function AgentModelReasoningPicker({
  sessionId,
  sessionMeta,
  capability,
  capabilityLoading = false,
  presetEffort,
  globalEffort,
  agentThinking,
  onToggleThinking,
  running,
  onSessionUpdated,
  thinkingExpanded,
  onThinkingExpandedChange,
  externalSelectedModel,
  onModelSelect,
  filterChannelIds,
  preferredProtocol = 'openai',
  strictProtocolFilter = true,
}: AgentModelReasoningPickerProps): React.ReactElement {
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false)
  const [savingReasoning, setSavingReasoning] = React.useState(false)

  const channels = useAtomValue(channelsAtom)

  // 思考档位计算
  const hasCapability = Boolean(capability && capability.levels.length > 0)
  const fallbackEffort = presetEffort ?? globalEffort ?? 'high'
  const sessionLevel = sessionMeta?.openAIThinkingLevel ?? null
  const sessionEffort = sessionMeta?.agentEffort ?? null

  const resolvedLevelLabel = React.useMemo(() => {
    if (hasCapability && capability) {
      const activeLvl = sessionLevel ?? normalizeReasoningCapabilityLevel(capability, fallbackEffort) ?? capability.defaultLevel
      return THINKING_LEVEL_TITLES[activeLvl] || activeLvl
    }
    const eff = sessionEffort ?? fallbackEffort
    return EFFORT_TITLES[eff] || eff
  }, [hasCapability, capability, sessionLevel, sessionEffort, fallbackEffort])

  const [hoverLevel, setHoverLevel] = React.useState<AgentThinkingLevel | AgentEffort | null>(null)
  const displayLevelLabel = React.useMemo(() => {
    if (hoverLevel) {
      return (hasCapability
        ? THINKING_LEVEL_TITLES[hoverLevel as AgentThinkingLevel]
        : EFFORT_TITLES[hoverLevel as AgentEffort]) || hoverLevel
    }
    return resolvedLevelLabel
  }, [hoverLevel, hasCapability, resolvedLevelLabel])

  const isOverridden = hasCapability ? sessionLevel != null : sessionEffort != null

  // 模型展示名称与 Provider
  const currentChannel = React.useMemo(() => {
    if (!externalSelectedModel?.channelId) return null
    return channels.find((c) => c.id === externalSelectedModel.channelId) ?? null
  }, [channels, externalSelectedModel])

  const modelDisplayName = React.useMemo(() => {
    if (!externalSelectedModel) return '选择模型'
    if (currentChannel) {
      const found = currentChannel.models?.find((m) => m.id === externalSelectedModel.modelId)
      if (found?.name) return found.name
    }
    return formatHumanModelName(externalSelectedModel.modelId)
  }, [externalSelectedModel, currentChannel])

  // 切换思考档位
  const handleReasoningChange = React.useCallback(
    async (value: AgentThinkingLevel | AgentEffort | null) => {
      if (savingReasoning) return
      setSavingReasoning(true)
      // 乐观回写：松手后圆钮/标签必须立刻落在新档位，否则会先跳回旧值、
      // 等 IPC 回来再跳到新值，看起来就是一次闪动。
      const previous = sessionMeta
      if (sessionMeta) {
        onSessionUpdated({
          ...sessionMeta,
          ...(hasCapability
            ? { openAIThinkingLevel: value as AgentThinkingLevel | null }
            : { agentEffort: value as AgentEffort | null }),
        })
      }
      const nextLabel = value
        ? (hasCapability
            ? THINKING_LEVEL_TITLES[value as AgentThinkingLevel]
            : EFFORT_TITLES[value as AgentEffort])
        : null
      try {
        if (hasCapability) {
          const updated = await updateComposerOpenAIThinkingLevel(sessionId, value as AgentThinkingLevel | null)
          onSessionUpdated(updated)
          toast.success(nextLabel ? `思考强度已切换为「${nextLabel}」` : '已恢复默认思考强度')
        } else {
          const updated = await updateComposerEffort(sessionId, value as AgentEffort | null)
          onSessionUpdated(updated)
          toast.success(nextLabel ? `思考强度已设为「${nextLabel}」` : '已恢复默认思考强度')
        }
      } catch (err) {
        // 写入失败时回滚乐观值，避免控件停在一个并未生效的档位。
        if (previous) onSessionUpdated(previous)
        toast.error(err instanceof Error ? err.message : '切换思考强度失败')
      } finally {
        setSavingReasoning(false)
      }
    },
    [savingReasoning, hasCapability, sessionId, onSessionUpdated, sessionMeta]
  )

  const handleOpenModelDialog = () => {
    // 直接拉起完整模型选择 Dialog：不先卸载 Popover，避免 Radix 关闭动画的
    // focus 回退与 Dialog 的 outside-dismiss 监听互相触发，导致刚打开就被关掉。
    setModelSelectorOpen(true)
  }

  const tooltipText = `模型与思考 · ${modelDisplayName} (${resolvedLevelLabel})`

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'h-9 px-2 rounded-md flex items-center gap-1.5 text-xs select-none transition-colors duration-150',
                  'text-foreground/75 hover:text-foreground hover:bg-accent',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30',
                  popoverOpen && 'bg-accent text-foreground'
                )}
                aria-label={tooltipText}
              >
                {/* 模型 Logo */}
                {externalSelectedModel ? (
                  <img
                    src={getModelLogo(externalSelectedModel.modelId, currentChannel?.provider)}
                    alt={modelDisplayName}
                    className="size-4 rounded object-cover shrink-0"
                  />
                ) : (
                  <Cpu className="size-3.5 shrink-0" />
                )}

                {/* 模型名称 */}
                <span className="max-w-[180px] truncate text-foreground/90 whitespace-nowrap font-medium">
                  {modelDisplayName}
                </span>

                {/* 思考档位简标 */}
                <span
                  className={cn(
                    'text-[10.5px] whitespace-nowrap shrink-0 transition-colors',
                    isOverridden ? 'text-primary font-medium' : 'text-muted-foreground/70'
                  )}
                >
                  · {resolvedLevelLabel}
                </span>

                <ChevronDown className="size-3 text-muted-foreground/70 transition-transform duration-200" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>
            <p>{tooltipText}</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[230px] p-2 rounded-xl border border-border bg-popover text-popover-foreground shadow-xl z-[100] animate-in fade-in zoom-in-95 duration-100"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col gap-1">
            {/* 上部：模型名称 + 思考档位 + 点击切换箭头 */}
            <button
              type="button"
              onClick={handleOpenModelDialog}
              className="flex items-center justify-between w-full px-2 py-1.5 rounded-lg hover:bg-accent transition-colors text-left group cursor-pointer"
            >
              <div className="flex items-center gap-1.5 min-w-0 pr-1">
                <span className="text-xs font-medium text-foreground truncate whitespace-nowrap">
                  {modelDisplayName}
                </span>
                <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                  {displayLevelLabel}
                </span>
              </div>
              <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
            </button>

            {/* 中部：标准轨道与同心纯白圆纽滑块 */}
            <AgentReasoningSlider
              capability={capability}
              sessionLevel={sessionLevel}
              sessionEffort={sessionEffort}
              presetEffort={presetEffort}
              globalEffort={globalEffort}
              disabled={savingReasoning}
              onChange={handleReasoningChange}
              onHoverLevelChange={setHoverLevel}
            />
          </div>
        </PopoverContent>
      </Popover>

      {/* 隐藏的完整模型选择 Dialog，点击卡片第一行触发 */}
      <ModelSelector
        filterChannelIds={filterChannelIds}
        preferredProtocol={preferredProtocol}
        strictProtocolFilter={strictProtocolFilter}
        externalSelectedModel={externalSelectedModel}
        hideTrigger
        onModelSelect={(option) => {
          onModelSelect?.(option)
          setModelSelectorOpen(false)
        }}
        open={modelSelectorOpen}
        onOpenChange={(next) => {
          setModelSelectorOpen(next)
          // Dialog 关闭后不再残留档位面板，避免选完模型又弹回 Popover。
          if (!next) setPopoverOpen(false)
        }}
      />
    </>
  )
}
