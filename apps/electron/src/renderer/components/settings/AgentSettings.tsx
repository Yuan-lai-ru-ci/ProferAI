/**
 * AgentSettings - Agent 配置页
 *
 * Skills 与 MCP 的管理已迁移到独立的「Agent 技能」全屏视图
 * （左侧栏入口，components/agent-skills/AgentSkillsView），
 * Agent 预设管理也已迁移到该视图的「预设」tab。
 * 此页仅保留推理档位与内置工具的只读概览。
 * 展示类偏好（自动预览修改中文件、输出完保持展开）已迁至「使用偏好」。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Pencil, ImagePlus, Search } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import { settingsTabAtom } from '@/atoms/settings-tab'
import { chatToolsAtom } from '@/atoms/chat-tool-atoms'
import { agentEffortAtom } from '@/atoms/agent-atoms'
import { SettingsSection, SettingsCard, SettingsSegmentedControl } from './primitives'
import type { AgentEffort } from '@profer/shared'
import { toast } from 'sonner'
import { useSessionSettingMutation } from '@/lib/use-session-setting-mutation'
import { Input } from '@profer/ui/primitives/input'
import { handoffSuggestTurnCountAtom, updateHandoffSuggestTurnCount } from '@/atoms/session-handoff'
import { MAX_HANDOFF_SUGGEST_TURN_COUNT } from '@/types/settings'

const EFFORT_OPTIONS: { value: AgentEffort; label: string }[] = [
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中度' },
  { value: 'high', label: '深度' },
  { value: 'max', label: '极限' },
]

/**
 * 「建议新开会话」轮数阈值。
 *
 * 与 `GoalIdleCheckinSetting` 同一套交互：输入期只保留数字草稿，
 * 失焦（或回车）才归一落盘，避免每敲一个字符就写一次 settings.json。
 * 0 = 关闭，这也是默认值。
 */
function HandoffSuggestTurnCountSetting(): React.ReactElement {
  const [count, setCount] = useAtom(handoffSuggestTurnCountAtom)
  const [draft, setDraft] = React.useState(String(count))

  React.useEffect(() => { setDraft(String(count)) }, [count])

  const commit = (raw: string): void => {
    const parsed = Number(raw)
    const next = Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.round(parsed), MAX_HANDOFF_SUGGEST_TURN_COUNT)
      : 0
    setDraft(String(next))
    if (next === count) return
    void updateHandoffSuggestTurnCount(next, setCount, count).catch(() => {
      toast.error('保存失败，请重试')
    })
  }

  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">建议新开会话</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          超过这个轮数后，在输入框上方提示把当前进展整理成交接文档，并带着它开一个新会话。
          0 = 关闭。
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id="handoff-suggest-turn-count"
          inputMode="numeric"
          className="h-8 w-16 text-center"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
        <span className="text-xs text-muted-foreground">轮</span>
      </div>
    </div>
  )
}

export function AgentSettings(): React.ReactElement {
  const tools = useAtomValue(chatToolsAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const [effort, setEffort] = useAtom(agentEffortAtom)
  const { pending, mutate } = useSessionSettingMutation()

  const handleEffortChange = React.useCallback((value: string) => {
    const next = EFFORT_OPTIONS.find((option) => option.value === value)?.value
    if (!next || pending) return
    const previous = effort
    void mutate({
      execute: () => window.electronAPI.updateSettings({ agentEffort: next }),
      applyOptimistic: () => setEffort(next),
      applyAuthoritative: () => setEffort(next),
      rollback: () => setEffort(previous),
      onError: () => toast.error('思考强度保存失败，请重试'),
    })
  }, [effort, pending, mutate, setEffort])

  const gptImageTool = tools.find((t) => t.meta.id === 'gpt-image')
  const webSearchTool = tools.find((t) => t.meta.id === 'web-search')

  interface BuiltinToolItem {
    id: string
    name: string
    description: string
    icon: React.ReactElement
    enabled: boolean
    available: boolean
  }

  const builtinTools: BuiltinToolItem[] = [
    {
      id: 'gpt-image',
      name: 'AI 图片生成',
      description: '启用并配置后，自动提供给 Chat 与 Agent 的图片生成和编辑能力',
      icon: <ImagePlus className="size-4" />,
      enabled: gptImageTool?.enabled ?? false,
      available: gptImageTool?.available ?? false,
    },
    {
      id: 'web-search',
      name: '联网搜索',
      description: '实时搜索互联网获取最新信息',
      icon: <Search className="size-4" />,
      enabled: webSearchTool?.enabled ?? false,
      available: webSearchTool?.available ?? false,
    },
  ]

  return (
    <div className="space-y-6">
      <SettingsSection title="默认推理行为" description="作为会话未单独指定时的默认值；会话和预设中的选择优先。">
        <SettingsCard>
          <SettingsSegmentedControl
            label="思考强度"
            description="低强度响应更快，高强度适合复杂任务。实际支持的档位由内核与模型决定。"
            value={effort ?? 'high'}
            onValueChange={handleEffortChange}
            disabled={pending}
            options={EFFORT_OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="长会话"
        description="会话越长，上下文越容易在压缩里丢失细节；交接让下一个会话从干净上下文接手。"
      >
        <SettingsCard>
          <HandoffSuggestTurnCountSetting />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="内置工具"
        description="在 Chat 工具中配置；Agent 是否可用还受当前预设能力范围限制。Skills、MCP 与预设在侧边栏的「Agent 技能」管理。"
        action={
          <Button size="sm" variant="outline" onClick={() => setSettingsTab('tools')}>
            <Pencil size={14} />
            <span>配置</span>
          </Button>
        }
      >
        <SettingsCard divided>
          {builtinTools.map((tool) => {
            const isActive = tool.enabled && tool.available
            return (
              <div key={tool.id} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={cn('shrink-0', !isActive && 'opacity-40')}>{tool.icon}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('text-sm font-medium', !isActive && 'text-muted-foreground')}>{tool.name}</span>
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full',
                        isActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                      )}>
                        {isActive ? '已启用' : !tool.available ? '需配置' : '未启用'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{tool.description}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
