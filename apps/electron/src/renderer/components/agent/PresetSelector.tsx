/**
 * PresetSelector — Agent 预设选择器
 *
 * 集成在 AgentView 输入工具栏中，展示当前会话绑定的预设（岗位），
 * 点击展开全部预设（内置 standard/code/minimal + 未来自定义），切换即持久化。
 *
 * 心智模型：模型=大脑、Skill=手册、预设=岗位（对齐 DeepSeek Harness）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { BriefcaseBusiness } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { agentSessionPresetMapAtom, workspacePresetsAtom, presetOf } from '@/atoms/agent-preset-atoms'
import { agentSessionsAtom, workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import { DEFAULT_PRESET_ID } from '@profer/shared'
import type { AgentEffort, ProferPermissionMode } from '@profer/shared'
import { cn } from '@/lib/utils'

/** 预设特性 badge 的中文短标签 */
const EFFORT_LABEL: Record<AgentEffort, string> = { low: '低', medium: '中', high: '高', max: '最大' }
const PERMISSION_LABEL: Record<ProferPermissionMode, string> = { auto: '自动审批', bypassPermissions: '完全自动', plan: '计划' }

/** 「极简」开关（紧凑模式）持久化 key：记住用户上次的显示偏好，跨会话/重启生效 */
const COMPACT_MODE_STORAGE_KEY = 'profer-preset-selector-compact'

function readStoredCompactMode(): boolean {
  try {
    return localStorage.getItem(COMPACT_MODE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistCompactMode(on: boolean): void {
  try {
    localStorage.setItem(COMPACT_MODE_STORAGE_KEY, on ? '1' : '0')
  } catch { /* localStorage 不可用时静默降级为不持久化 */ }
}

interface PresetSelectorProps {
  sessionId: string
  /** 会话 meta 上持久化的预设 ID（跨重启真源） */
  persistedPresetId?: string
  /** 会话所属工作区 slug（预设为工作区级配置） */
  workspaceSlug?: string
}

export function PresetSelector({ sessionId, persistedPresetId, workspaceSlug }: PresetSelectorProps): React.ReactElement | null {
  const [presets, setPresets] = useAtom(workspacePresetsAtom(workspaceSlug))
  const [presetMap, setPresetMap] = useAtom(agentSessionPresetMapAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  // 记住上次选择的「极简」紧凑显示偏好（localStorage 惰性初始化）
  const [compactMode, setCompactMode] = React.useState<boolean>(readStoredCompactMode)
  const toggleCompactMode = React.useCallback((on: boolean) => {
    setCompactMode(on)
    persistCompactMode(on)
  }, [])
  // 与 Skills 相同的刷新信号：技能页增删改/导入预设后，这里立即重拉最新列表
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)

  React.useEffect(() => {
    void window.electronAPI.listAgentPresets(workspaceSlug)
      .then(setPresets)
      .catch((error) => console.error('[PresetSelector] 加载工作区预设失败:', error))
  }, [workspaceSlug, capabilitiesVersion, setPresets])

  const effectiveId = presetMap.get(sessionId) ?? persistedPresetId ?? DEFAULT_PRESET_ID
  const current = presetOf(presets, effectiveId)

  const selectPreset = React.useCallback(async (presetId: string) => {
    const prevId = effectiveId
    // 乐观更新
    setPresetMap((prev: Map<string, string>) => {
      const next = new Map(prev)
      next.set(sessionId, presetId)
      return next
    })
    try {
      const updated = await window.electronAPI.updateAgentSessionPreset(sessionId, presetId)
      setAgentSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, presetId: updated.presetId } : s)))
    } catch (error) {
      console.error('[PresetSelector] 切换预设失败，回滚 UI:', error)
      setPresetMap((prev: Map<string, string>) => {
        const next = new Map(prev)
        next.set(sessionId, prevId)
        return next
      })
    }
  }, [effectiveId, sessionId, setPresetMap, setAgentSessions])

  if (presets.length === 0) return null

  return (
    <TooltipProvider delayDuration={300}>
      <Popover
        onOpenChange={(open) => {
          // 打开时刷新，保证技能页导入/编辑后的最新预设可见
          if (open) {
            void window.electronAPI.listAgentPresets(workspaceSlug)
              .then(setPresets)
              .catch((error) => console.error('[PresetSelector] 刷新工作区预设失败:', error))
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`预设：${current?.name ?? '标准'}`}
                className="size-[36px] rounded-full text-foreground/60 hover:text-foreground"
              >
                <BriefcaseBusiness className="size-5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            <p className="font-medium">预设 · {current?.name ?? '标准'}</p>
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" className="w-72 p-1.5">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-medium text-foreground/60">Agent 预设（岗位）</span>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-foreground/55 select-none">
                <span>极简</span>
                <Switch checked={compactMode} onCheckedChange={toggleCompactMode} className="scale-90" />
              </label>
            </div>
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => { selectPreset(preset.id); requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus()) }}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted',
                  preset.id === effectiveId && 'bg-muted',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className={cn('w-4 text-center', preset.id === effectiveId ? 'text-primary' : 'text-transparent')}>✓</span>
                  {preset.name}
                  {preset.isBuiltin && <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-foreground/50">内置</span>}
                  {preset.effort && <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-foreground/50">强度·{EFFORT_LABEL[preset.effort] ?? preset.effort}</span>}
                  {preset.permissionMode && <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-foreground/50">权限·{PERMISSION_LABEL[preset.permissionMode] ?? preset.permissionMode}</span>}
                </span>
                {!compactMode && (
                  <span className="pl-5.5 text-[11px] leading-4 text-foreground/55">{preset.description}</span>
                )}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}
