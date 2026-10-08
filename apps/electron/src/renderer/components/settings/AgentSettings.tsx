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

const EFFORT_OPTIONS: { value: AgentEffort; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最大' },
]

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
