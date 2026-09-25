/**
 * PermissionModeSelector — Agent 权限模式切换器
 *
 * 集成在 AgentView 输入工具栏中。点击按钮展开弹层，明确选择目标模式后才切换
 * （自动审批 / 完全自动 / 计划模式），不再单击循环——循环切换在「完全自动」与
 * 「计划模式」相邻时容易误触放宽权限。每个会话独立维护自己的权限模式。
 *
 * 权限显示规则（与主进程 EffectiveAgentPresetPolicy 同语义）：
 * - 预设声明的 permissionMode 是本会话的权限上限；
 * - 用户通过本控件切换属于「显式 override」，只能把模式保持或收紧到预设上限内，
 *   不能从 auto/plan 放宽到 bypassPermissions；
 * - 未显式 override 时，工具栏直接显示预设上限（未设置预设则跟随默认完全自动），
 *   不再用全局默认值掩盖真实运行权限；
 * - 超出预设上限的模式在菜单里保持可见但禁用，并说明受限原因：主进程
 *   `UPDATE_SESSION_PERMISSION_MODE` 只校验模式合法性、不按预设上限收敛，
 *   渲染层的这道门禁是唯一阻止用户持久化「比预设上限更宽松」的误导性模式值的地方。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Zap, Compass, Map as MapIcon } from 'lucide-react'
import {
  AgentComposerToolMenuItem,
  AgentComposerToolPopover,
  AgentComposerToolTrigger,
} from '@/components/ai-elements/composer/ComposerTool'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { agentPermissionModeMapAtom, agentDefaultPermissionModeAtom, sessionPersistedPermissionModeAtom, sessionExistsAtom, agentPlanModeSessionsAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import type { ProferPermissionMode } from '@profer/shared'
import { PROFER_PERMISSION_MODE_CONFIG } from '@profer/shared'
import { updatePlanModeSessionSet } from '@/lib/agent-plan-mode'
import { useSessionSettingMutation } from '@/lib/use-session-setting-mutation'
import {
  buildPermissionModeMenu,
  canSelectPermissionMode,
  describePermissionModeRestriction,
  resolveSelectorMode,
} from './permission-mode-selector-utils'

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
  const [modeMap, setModeMap] = useAtom(agentPermissionModeMapAtom)
  const setPlanModeSessions = useSetAtom(agentPlanModeSessionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const { pending, mutate } = useSessionSettingMutation()
  const defaultMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedSessionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const sessionExistsInList = useAtomValue(sessionExistsAtom(sessionId))
  const [open, setOpen] = React.useState(false)
  const latestLocalRequestRef = React.useRef(0)

  // 预设上限：预设显式声明 > 全局默认（完全自动）。
  const presetCapMode = presetPermissionMode ?? defaultMode
  // 用户显式选择只存 modeMap（本会话瞬时）；重启后由 session meta.permissionMode 恢复。
  const modeMapValue = modeMap.get(sessionId)
  const hasRequestedOverride = modeMapValue !== undefined || persistedSessionMode !== undefined
  const requestedMode = modeMapValue ?? persistedSessionMode
  const mode = hasRequestedOverride
    ? resolveSelectorMode(presetCapMode, requestedMode)
    : presetCapMode

  // 远端 projection 是唯一权威来源。请求在途时保留本地最新选择，避免旧 projection 回填造成闪回。
  React.useEffect(() => {
    if (!sessionExistsInList || persistedSessionMode === undefined) return
    if (latestLocalRequestRef.current > 0 && pending) return

    setModeMap((prev: Map<string, ProferPermissionMode>) => {
      const current = prev.get(sessionId)
      if (current === persistedSessionMode) return prev
      const next = new Map(prev)
      next.set(sessionId, persistedSessionMode)
      return next
    })
  }, [sessionId, persistedSessionMode, sessionExistsInList, pending, setModeMap])

  // 桌面权限菜单遵循显式用户选择：三种模式都允许切换。
  // 预设权限只作为运行策略元数据保留，不在这里阻断用户的 runtime/权限切换。
  const canSelectMode = React.useCallback(
    (_candidate: ProferPermissionMode): boolean => true,
    [],
  )

  /**
   * 切换到指定模式（弹层选择后触发）。
   *
   * 门禁有两层：菜单项 disabled（正常路径），以及这里的防御性检查 + toast 兜底
   * （菜单被程序化触发或上限变化时仍不能把更宽松的模式写回会话 meta）。
   */
  const selectMode = React.useCallback(async (nextMode: ProferPermissionMode) => {
    const prevRequested = modeMap.get(sessionId) ?? persistedSessionMode
    setOpen(false)

    const requestSequence = latestLocalRequestRef.current + 1
    latestLocalRequestRef.current = requestSequence
    if (nextMode === mode) {
      focusComposerInput()
      return
    }
    if (!canSelectMode(nextMode)) {
      toast.info(describePermissionModeRestriction(presetCapMode))
      focusComposerInput()
      return
    }

    // 乐观更新当前 session 的模式
    setModeMap((prev: Map<string, ProferPermissionMode>) => {
      const next = new Map(prev)
      next.set(sessionId, nextMode)
      return next
    })
    setPlanModeSessions((prev: Set<string>) =>
      updatePlanModeSessionSet(prev, sessionId, nextMode === 'plan')
    )

    void mutate({
      execute: (expectedRevision) => window.electronAPI.updateSessionPermissionMode(sessionId, nextMode, expectedRevision),
      applyAuthoritative: (updated) => {
        if (requestSequence !== latestLocalRequestRef.current) return
        setModeMap((prev: Map<string, ProferPermissionMode>) => {
          const next = new Map(prev)
          next.set(sessionId, updated.permissionMode ?? nextMode)
          return next
        })
        setPlanModeSessions((prev: Set<string>) => updatePlanModeSessionSet(prev, sessionId, (updated.permissionMode ?? nextMode) === 'plan'))
        setAgentSessions((previous) => previous.map((session) => session.id === updated.id ? updated : session))
      },
      rollback: () => {
        if (requestSequence !== latestLocalRequestRef.current) return
        setModeMap((prev: Map<string, ProferPermissionMode>) => {
          const next = new Map(prev)
          if (prevRequested === undefined) next.delete(sessionId)
          else next.set(sessionId, prevRequested)
          return next
        })
        setPlanModeSessions((prev: Set<string>) => updatePlanModeSessionSet(prev, sessionId, (prevRequested ?? presetCapMode) === 'plan'))
      },
      onError: (error) => console.error('[PermissionModeSelector] 运行中切换权限模式失败，回滚 UI:', error),
    }, persistedRevision)
    focusComposerInput()
  }, [mode, mutate, pending, persistedRevision, presetCapMode, sessionId, setAgentSessions, setModeMap, setPlanModeSessions, persistedSessionMode, modeMap, canSelectMode])

  const config = PROFER_PERMISSION_MODE_CONFIG[mode]
  const capConfig = PROFER_PERMISSION_MODE_CONFIG[presetCapMode]
  const Icon = MODE_ICONS[mode]
  const triggerLabel = `${config.label}：${config.description}`

  const menu = (
    <div className="flex flex-col py-0.5">
      {buildPermissionModeMenu(presetCapMode).map(({ mode: candidate }) => {
        const itemConfig = PROFER_PERMISSION_MODE_CONFIG[candidate]
        const ItemIcon = MODE_ICONS[candidate]
        const selected = candidate === mode
        const restriction = ''
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
        <p className="mt-1 text-xs text-foreground/60">预设上限 · {capConfig.label}</p>
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
