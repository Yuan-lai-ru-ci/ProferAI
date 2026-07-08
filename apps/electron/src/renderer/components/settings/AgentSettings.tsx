/**
 * AgentSettings - Agent 配置页
 *
 * Skills 与 MCP 的管理已迁移到独立的「Agent 技能」全屏视图
 * （左侧栏入口，components/agent-skills/AgentSkillsView）。
 * 此页仅保留内置工具的只读概览。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Pencil, Brain, ImagePlus, Search, Cpu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { settingsTabAtom } from '@/atoms/settings-tab'
import { chatToolsAtom } from '@/atoms/chat-tool-atoms'
import { agentEffortAtom } from '@/atoms/agent-atoms'
import { SettingsSection, SettingsCard, SettingsSegmentedControl } from './primitives'
import type { AgentEffort } from '@proma/shared'

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

  const handleEffortChange = React.useCallback((value: string) => {
    const v = value as AgentEffort
    setEffort(v)
    window.electronAPI.updateSettings({ agentEffort: v }).catch(console.error)
  }, [setEffort])

  const memoryTool = tools.find((t) => t.meta.id === 'memory')
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
      id: 'memory',
      name: '记忆',
      description: '长期记忆存储与检索',
      icon: <Brain className="size-4" />,
      enabled: memoryTool?.enabled ?? false,
      available: memoryTool?.available ?? false,
    },
    {
      id: 'gpt-image',
      name: 'GPT Image',
      description: 'AI 图片生成与编辑',
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
      <SettingsSection title="Agent 配置" description="调整 Agent 的推理行为和资源限制">
        <SettingsCard>
          <SettingsSegmentedControl
            label="思考强度"
            description="控制 Agent 推理深度。低强度响应更快，高强度更适合复杂任务（仅 Claude Opus 4.6+ 支持 max）"
            value={effort ?? 'high'}
            onValueChange={handleEffortChange}
            options={EFFORT_OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
      title="内置工具"
      description="启用后自动注入到 Agent 会话，在工具设置中配置。Skills 与 MCP 已移至侧边栏的「Agent 技能」。"
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
                  <div className="flex items-center gap-2">
                    <span className={cn('text-sm font-medium', !isActive && 'text-muted-foreground')}>{tool.name}</span>
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded-full',
                      isActive ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
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
