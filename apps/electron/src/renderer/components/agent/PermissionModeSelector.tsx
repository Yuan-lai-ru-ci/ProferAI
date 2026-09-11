/**
 * PermissionModeSelector — Agent 权限模式切换器
 *
 * 集成在 AgentView 输入工具栏中，紧凑的三模式切换按钮。
 * 每个会话独立维护自己的权限模式。
 *
 * 权限显示规则（与主进程 EffectiveAgentPresetPolicy 同语义）：
 * - 预设声明的 permissionMode 是本会话的权限上限；
 * - 用户通过本控件切换属于「显式 override」，只能把模式保持或收紧到预设上限内，
 *   不能从 auto/plan 放宽到 bypassPermissions；
 * - 未显式 override 时，工具栏直接显示预设上限（未设置预设则跟随默认完全自动），
 *   不再用全局默认值掩盖真实运行权限。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Zap, Compass, Map as MapIcon } from 'lucide-react'
import { AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'
import { agentPermissionModeMapAtom, agentDefaultPermissionModeAtom, sessionPersistedPermissionModeAtom, sessionExistsAtom, agentPlanModeSessionsAtom } from '@/atoms/agent-atoms'
import type { ProferPermissionMode } from '@profer/shared'
import { PROFER_PERMISSION_MODE_CONFIG, PROFER_PERMISSION_MODE_ORDER, resolveEffectivePermissionMode } from '@profer/shared'
import { updatePlanModeSessionSet } from '@/lib/agent-plan-mode'

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
}

export function PermissionModeSelector({
  sessionId,
  presetPermissionMode,
  composerTool = false,
}: PermissionModeSelectorProps): React.ReactElement | null {
  const [modeMap, setModeMap] = useAtom(agentPermissionModeMapAtom)
  const setPlanModeSessions = useSetAtom(agentPlanModeSessionsAtom)
  const defaultMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedSessionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const sessionExistsInList = useAtomValue(sessionExistsAtom(sessionId))

  // 预设上限：预设显式声明 > 全局默认（完全自动）。
  const presetCapMode = presetPermissionMode ?? defaultMode
  // 用户显式选择只存 modeMap（本会话瞬时）；重启后由 session meta.permissionMode 恢复。
  const modeMapValue = modeMap.get(sessionId)
  const hasRequestedOverride = modeMapValue !== undefined || persistedSessionMode !== undefined
  const requestedMode = modeMapValue ?? persistedSessionMode
  const mode = hasRequestedOverride
    ? resolveEffectivePermissionMode(presetCapMode, requestedMode!)
    : presetCapMode

  // 初始化：只有存在真实手动 override（已持久化到 session meta）时才回填 modeMap，
  // 避免把“默认完全自动”误当成用户选择，导致工具栏与运行时预设权限脱节。
  React.useEffect(() => {
    if (!sessionExistsInList || persistedSessionMode === undefined) return

    setModeMap((prev: Map<string, ProferPermissionMode>) => {
      if (prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.set(sessionId, persistedSessionMode)
      return next
    })
  }, [sessionId, persistedSessionMode, sessionExistsInList, setModeMap])

  /** 候选模式是否能在当前预设上限内生效（更宽松会被 resolve 收紧，视为不可选）。 */
  const canSelectMode = React.useCallback(
    (candidate: ProferPermissionMode): boolean =>
      resolveEffectivePermissionMode(presetCapMode, candidate) === candidate,
    [presetCapMode],
  )

  /** 从当前有效模式向后循环，返回第一个不受预设上限限制的目标。 */
  const findNextSelectableMode = React.useCallback(
    (currentMode: ProferPermissionMode): ProferPermissionMode | null => {
      const start = PROFER_PERMISSION_MODE_ORDER.indexOf(currentMode)
      for (let step = 1; step < PROFER_PERMISSION_MODE_ORDER.length; step++) {
        const candidate = PROFER_PERMISSION_MODE_ORDER[(start + step) % PROFER_PERMISSION_MODE_ORDER.length]!
        if (canSelectMode(candidate)) return candidate
      }
      return null
    },
    [canSelectMode],
  )

  /** 循环切换模式：目标模式必须落在预设权限上限内，否则提示并保持现状。 */
  const cycleMode = React.useCallback(async () => {
    const prevRequested = modeMap.get(sessionId) ?? persistedSessionMode
    const nextMode = findNextSelectableMode(mode)
    if (!nextMode) {
      toast.info(`当前预设将权限限制为「${PROFER_PERMISSION_MODE_CONFIG[presetCapMode].label}」，不能切换到更宽松的模式`)
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

    // 热切换运行中的当前 session；失败时回滚 modeMap 保持 UI/后端一致
    try {
      await window.electronAPI.updateSessionPermissionMode(sessionId, nextMode)
    } catch (error) {
      console.error('[PermissionModeSelector] 运行中切换权限模式失败，回滚 UI:', error)
      setModeMap((prev: Map<string, ProferPermissionMode>) => {
        const next = new Map(prev)
        if (prevRequested === undefined) next.delete(sessionId)
        else next.set(sessionId, prevRequested)
        return next
      })
      setPlanModeSessions((prev: Set<string>) =>
        updatePlanModeSessionSet(prev, sessionId, (prevRequested ?? presetCapMode) === 'plan')
      )
    }
  }, [mode, presetCapMode, sessionId, setModeMap, setPlanModeSessions, persistedSessionMode, modeMap, findNextSelectableMode])

  const config = PROFER_PERMISSION_MODE_CONFIG[mode]
  const capConfig = PROFER_PERMISSION_MODE_CONFIG[presetCapMode]
  const Icon = MODE_ICONS[mode]
  const triggerLabel = `${config.label}：${config.description}`

  if (composerTool) {
    return (
      <AgentComposerToolTrigger
        label={triggerLabel}
        tooltip={
          <div className="max-w-[220px]">
            <p className="font-medium">{config.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{config.description}</p>
            {presetPermissionMode !== undefined && (
              <p className="mt-1 text-xs text-foreground/60">预设上限 · {capConfig.label}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">点击切换模式</p>
          </div>
        }
        onClick={() => { cycleMode(); requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus()) }}
      >
        <Icon className="size-5" />
      </AgentComposerToolTrigger>
    )
  }

  return (
    <button
      type="button"
      aria-label={triggerLabel}
      title={triggerLabel}
      onClick={() => { cycleMode(); requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus()) }}
      className="size-[36px] rounded-full text-foreground/60 hover:text-foreground"
    >
      <Icon className="size-5" />
    </button>
  )
}
