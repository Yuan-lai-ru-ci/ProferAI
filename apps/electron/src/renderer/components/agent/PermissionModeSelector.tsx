/**
 * PermissionModeSelector — Agent 权限模式切换器
 *
 * 集成在 AgentView 输入工具栏中。点击按钮展开弹层，明确选择目标模式后才切换
 * （自动审批 / 完全自动 / 计划模式），不再单击循环——循环切换在「完全自动」与
 * 「计划模式」相邻时容易误触放宽权限。每个会话独立维护自己的权限模式。
 *
 * Core/主进程返回的会话权限是唯一权威值；预设只提供初始默认。
 * 明确的用户选择可以切换全部模式，运行时硬边界仍由后端执行。
 */

import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { toast } from 'sonner'
import { Zap, Compass, Map as MapIcon } from 'lucide-react'
import {
  AgentComposerToolMenuItem,
  AgentComposerToolPopover,
  AgentComposerToolTrigger,
} from '@/components/ai-elements/composer/ComposerTool'
import { Popover, PopoverAnchor, PopoverContent } from '@profer/ui/primitives/popover'
import { agentPermissionModeMapAtom, agentDefaultPermissionModeAtom, sessionPersistedPermissionModeAtom } from '@/atoms/agent-atoms'
import type { ProferPermissionMode } from '@profer/shared'
import { PROFER_PERMISSION_MODE_CONFIG } from '@profer/shared'
import { applyAuthoritativeSessionPermission, resolveSessionPermissionMode } from '@/lib/agent-session-permission'
import { useSessionSettingMutation } from '@/lib/use-session-setting-mutation'
import { updateComposerPermissionMode } from '@/domains/composer/composer-api'
import { buildPermissionModeMenu } from './permission-mode-selector-utils'

const MODE_ICONS: Record<ProferPermissionMode, React.ComponentType<{ className?: string }>> = {
  auto: Compass,
  bypassPermissions: Zap,
  plan: MapIcon,
}

interface PermissionModeSelectorProps {
  sessionId: string
  /** 当前会话绑定预设声明的权限模式；undefined 表示预设未显式设置（跟随默认完全自动）。 */
  presetPermissionMode?: ProferPermissionMode
  /** 输入区调用时通过统一 Composer 触发器保证 hover/focus/tooltip 一致。 */
  composerTool?: boolean
  /** 当前会话 projection revision，用于并发修改保护。 */
  persistedRevision?: number
}

/** 关闭菜单后把焦点交回输入框：弹层 onCloseAutoFocus 已 preventDefault，需显式归还。 */
function focusComposerInput(): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus())
}

export function PermissionModeSelector({
  sessionId,
  presetPermissionMode,
  composerTool = false,
  persistedRevision,
}: PermissionModeSelectorProps): React.ReactElement | null {
  const store = useStore()
  const modeMap = useAtomValue(agentPermissionModeMapAtom)
  const { pending, mutate } = useSessionSettingMutation()
  const defaultMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedSessionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const [open, setOpen] = React.useState(false)

  const presetDefaultMode = presetPermissionMode ?? defaultMode
  const mode = resolveSessionPermissionMode(presetDefaultMode, persistedSessionMode, modeMap.get(sessionId))

  // 等待权威回执后再更新显示，避免失败回滚、旧 projection 与跨会话请求相互覆盖。
  const selectMode = React.useCallback(async (nextMode: ProferPermissionMode) => {
    setOpen(false)
    if (pending || nextMode === mode) {
      focusComposerInput()
      return
    }
    void mutate({
      execute: (expectedRevision) => updateComposerPermissionMode(sessionId, nextMode, expectedRevision),
      applyAuthoritative: (updated) => {
        applyAuthoritativeSessionPermission(store, updated)
      },
      rollback: () => {},
      onError: (error) => {
        console.error('[PermissionModeSelector] 切换权限模式失败:', error)
        toast.error('切换权限模式失败', { description: error instanceof Error ? error.message : '请重试' })
      },
    }, persistedRevision)
    focusComposerInput()
  }, [mode, mutate, pending, persistedRevision, sessionId, store])

  const config = PROFER_PERMISSION_MODE_CONFIG[mode]
  const defaultConfig = PROFER_PERMISSION_MODE_CONFIG[presetDefaultMode]
  const Icon = MODE_ICONS[mode]
  const triggerLabel = `${config.label}：${config.description}`

  const menu = (
    <div className="flex flex-col py-0.5">
      {buildPermissionModeMenu(presetDefaultMode).map(({ mode: candidate }) => {
        const itemConfig = PROFER_PERMISSION_MODE_CONFIG[candidate]
        const ItemIcon = MODE_ICONS[candidate]
        const selected = candidate === mode
        const item = (
          <AgentComposerToolMenuItem
            key={candidate}
            onClick={() => { void selectMode(candidate) }}
            aria-label={itemConfig.label}
            aria-current={selected}
            disabled={pending}
            title={`${itemConfig.label}：${itemConfig.description}`}
            selected={selected}
          >
            <ItemIcon className="size-4 shrink-0 text-foreground/70" />
            <span className="flex-1 text-left">{itemConfig.label}</span>
            {selected && <span className="text-primary">✓</span>}
          </AgentComposerToolMenuItem>
        )
        return item
      })}
    </div>
  )

  const tooltip = (
    <div className="max-w-[220px]">
      <p className="font-medium">{config.label}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{config.description}</p>
      {presetPermissionMode !== undefined && (
        <p className="mt-1 text-xs text-foreground/60">预设默认 · {defaultConfig.label}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">点击选择模式</p>
    </div>
  )

  if (composerTool) {
    return (
      <AgentComposerToolPopover
        open={open}
        onOpenChange={setOpen}
        tooltip={tooltip}
        className="w-40"
        trigger={
          <AgentComposerToolTrigger label={triggerLabel}>
            <Icon className="size-5" />
          </AgentComposerToolTrigger>
        }
      >
        {menu}
      </AgentComposerToolPopover>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
          onClick={() => setOpen((value) => !value)}
          className="size-[36px] rounded-full text-foreground/60 hover:text-foreground"
        >
          <Icon className="size-5" />
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-40 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {menu}
      </PopoverContent>
    </Popover>
  )
}
