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
import { toast } from 'sonner'
import { BriefcaseBusiness, AlertTriangle, Loader2, Settings2 } from 'lucide-react'
import { AgentComposerToolMenuItem, AgentComposerToolPopover, AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'
import { Switch } from '@/components/ui/switch'
import { agentPresetCacheKey, agentPresetsLoadedAtom, workspacePresetsAtom } from '@/atoms/agent-preset-atoms'
import { agentSessionsAtom, workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import type { AgentEffort, AgentPreset, PresetReference, ProferPermissionMode } from '@profer/shared'
import { cn } from '@/lib/utils'
import { referenceForSelectablePreset, selectablePresetMatchesReference } from './preset-selector-utils'

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
  /** 会话 meta 上持久化的预设 ID（旧数据兼容）。 */
  persistedPresetId?: string
  /** 会话 meta 上带作用域的预设引用（当前唯一真源）。 */
  persistedPresetReference?: PresetReference
  /** 会话所属工作区 slug（预设为工作区级配置） */
  workspaceSlug?: string
  /** 可选受控打开状态，供发送前提示复用同一个预设菜单。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 跳转到 Agent 技能页的工作区预设配置。 */
  onManagePresets?: () => void
}

export function PresetSelector({ sessionId, persistedPresetId, persistedPresetReference, workspaceSlug, open, onOpenChange, onManagePresets }: PresetSelectorProps): React.ReactElement {
  const [presets, setPresets] = useAtom(workspacePresetsAtom(workspaceSlug))
  const loadedPresetCaches = useAtomValue(agentPresetsLoadedAtom)
  const setLoadedPresetCaches = useSetAtom(agentPresetsLoadedAtom)
  const [internalOpen, setInternalOpen] = React.useState(false)
  const [switchingReference, setSwitchingReference] = React.useState<PresetReference | null>(null)
  const isOpen = open ?? internalOpen
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
      .then((list) => {
        setPresets(list)
        setLoadedPresetCaches((prev) => new Set(prev).add(agentPresetCacheKey(workspaceSlug)))
      })
      .catch((error) => console.error('[PresetSelector] 加载工作区预设失败:', error))
  }, [workspaceSlug, capabilitiesVersion, setPresets, setLoadedPresetCaches])

  // Manager 返回当前工作区可见预设；明确停用项不能出现在菜单中（含元预设）。
  const availablePresets = React.useMemo(
    () => presets.filter((preset) => preset.enabledInWorkspace !== false),
    [presets],
  )
  const current = persistedPresetReference
    ? availablePresets.find((preset) => selectablePresetMatchesReference(preset, persistedPresetReference))
    : availablePresets.find((preset) => preset.id === persistedPresetId)
  const presetsLoaded = loadedPresetCaches.has(agentPresetCacheKey(workspaceSlug))
  const presetRequired = presetsLoaded && availablePresets.length > 0 && !current
  const [showPresetRequired, setShowPresetRequired] = React.useState(false)
  React.useEffect(() => {
    if (!presetRequired) {
      setShowPresetRequired(false)
      return
    }
    const timer = window.setTimeout(() => setShowPresetRequired(true), 500)
    return () => window.clearTimeout(timer)
  }, [presetRequired])

  const closeMenu = React.useCallback(() => {
    setInternalOpen(false)
    onOpenChange?.(false)
  }, [onOpenChange])

  const selectPreset = React.useCallback(async (preset: AgentPreset) => {
    if (switchingReference) return
    const reference = referenceForSelectablePreset(preset, workspaceSlug)
    if (selectablePresetMatchesReference(preset, persistedPresetReference) || (!persistedPresetReference && preset.id === persistedPresetId)) {
      closeMenu()
      return
    }
    setSwitchingReference(reference)
    try {
      const updated = await window.electronAPI.rebindAgentSessionPresetReference(sessionId, reference)
      // 用主进程返回的完整 meta 替换，保证 presetId 与 presetReference 永远同步。
      setAgentSessions((prev) => prev.map((session) => (session.id === sessionId ? updated : session)))
      closeMenu()
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus())
      toast.success(`已切换到「${preset.name}」`, { description: '将在下一轮消息中生效' })
    } catch (error) {
      console.error('[PresetSelector] 切换预设失败:', error)
      toast.error('切换预设失败', {
        description: error instanceof Error ? error.message : '请刷新预设列表后重试',
      })
    } finally {
      setSwitchingReference(null)
    }
  }, [closeMenu, persistedPresetId, persistedPresetReference, sessionId, setAgentSessions, switchingReference, workspaceSlug])

  return (
    <AgentComposerToolPopover
      open={isOpen}
      onOpenChange={(nextOpen: boolean) => {
          setInternalOpen(nextOpen)
          onOpenChange?.(nextOpen)
          // 打开时刷新，保证技能页导入/编辑后的最新预设可见
          if (nextOpen) {
            void window.electronAPI.listAgentPresets(workspaceSlug)
              .then(setPresets)
              .catch((error) => console.error('[PresetSelector] 刷新工作区预设失败:', error))
          }
      }}
      tooltip={showPresetRequired ? '请先选择 Agent 预设' : `预设 · ${current?.name ?? '未知'}`}
      align="start"
      className="w-72"
      trigger={
          <AgentComposerToolTrigger
            label={showPresetRequired ? '请先选择 Agent 预设' : `预设：${current?.name ?? '标准'}`}
            state={showPresetRequired ? 'warning' : 'default'}
          >
            {showPresetRequired ? <AlertTriangle className="size-5" /> : <BriefcaseBusiness className="size-5" />}
          </AgentComposerToolTrigger>
        }
      >
        <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-medium text-foreground/60">Agent 预设（岗位）</span>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-foreground/55 select-none">
                <span>极简</span>
                <Switch checked={compactMode} onCheckedChange={toggleCompactMode} className="scale-90" />
              </label>
            </div>
            {availablePresets.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-foreground/55">当前工作区暂无可用预设</div>
            )}
            {availablePresets.map((preset) => (
              <AgentComposerToolMenuItem
                key={preset.id}
                onClick={() => void selectPreset(preset)}
                disabled={switchingReference !== null}
                selected={preset === current}
                className="flex-col items-start gap-0.5 px-2 py-1.5"
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className={cn('flex w-4 justify-center text-center', preset === current ? 'text-primary' : 'text-transparent')}>
                    {switchingReference && selectablePresetMatchesReference(preset, switchingReference)
                      ? <Loader2 className="size-3 animate-spin text-primary" aria-hidden="true" />
                      : '✓'}
                  </span>
                  {preset.name}
                  {preset.isBuiltin && <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-foreground/50">内置</span>}
                  {preset.effort && <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-foreground/50">强度·{EFFORT_LABEL[preset.effort] ?? preset.effort}</span>}
                  {preset.permissionMode && <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-foreground/50">权限·{PERMISSION_LABEL[preset.permissionMode] ?? preset.permissionMode}</span>}
                </span>
                {!compactMode && (
                  <span className="pl-5.5 text-[11px] leading-4 text-foreground/55">{preset.description}</span>
                )}
              </AgentComposerToolMenuItem>
            ))}
            <div className="my-1 border-t border-border/60" />
            <AgentComposerToolMenuItem
              onClick={() => { onManagePresets?.(); setInternalOpen(false); onOpenChange?.(false) }}
              className="text-foreground/70"
            >
              <Settings2 className="size-3.5" />
              管理工作区预设
            </AgentComposerToolMenuItem>
        </div>
    </AgentComposerToolPopover>
  )
}
