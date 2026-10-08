/**
 * ShortcutSettings — 快捷键设置面板
 *
 * 分组展示所有快捷键，支持：
 * - 查看当前快捷键绑定
 * - 点击录制自定义快捷键
 * - 冲突检测和提示
 * - 恢复默认值
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'
import { SettingsSection, SettingsCard } from './primitives'
import { Switch } from '@profer/ui/primitives/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@profer/ui/primitives/tooltip'
import { shortcutOverridesAtom, sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_CATEGORY_LABELS,
} from '@/lib/shortcut-defaults'
import type { ShortcutCategory, ShortcutOverrides } from '@/lib/shortcut-defaults'
import {
  getActiveAccelerator,
  getAcceleratorDisplay,
  checkConflict,
  registerShortcut,
  updateShortcutOverrides,
  isMac,
} from '@/lib/shortcut-registry'

// ===== 快捷键录制组件 =====

interface ShortcutRecorderProps {
  /** 快捷键 ID */
  shortcutId: string
  /** 当前显示的 accelerator（null 表示已被用户禁用） */
  currentAccelerator: string | null
  /** 保存录制结果 */
  onSave: (shortcutId: string, accelerator: string) => Promise<boolean>
  /** 录制/pending 状态变化时通知父组件，便于父组件隐藏并列操作按钮 */
  disabled?: boolean
  onActiveChange?: (active: boolean) => void
}

function ShortcutRecorder({
  shortcutId,
  currentAccelerator,
  onSave,
  onActiveChange,
  disabled,
}: ShortcutRecorderProps): React.ReactElement {
  const [recording, setRecording] = React.useState(false)
  const [pendingKeys, setPendingKeys] = React.useState('')
  const [conflict, setConflict] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const pendingKeysRef = React.useRef('')

  const setPendingAccelerator = React.useCallback((accelerator: string) => {
    pendingKeysRef.current = accelerator
    setPendingKeys(accelerator)
  }, [])

  const handleStartRecording = React.useCallback(() => {
    if (disabled || saving) return
    setRecording(true)
    setPendingAccelerator('')
    setConflict(null)
  }, [setPendingAccelerator, disabled, saving])

  const handleCancel = React.useCallback(() => {
    setRecording(false)
    setPendingAccelerator('')
    setConflict(null)
    setSaving(false)
  }, [setPendingAccelerator])

  const normalizeKey = React.useCallback((rawKey: string): string => {
    if (rawKey === ' ') return 'Space'
    if (rawKey === '+') return 'Plus'
    if (rawKey.length === 1) return rawKey.toUpperCase()

    const keyMap: Record<string, string> = {
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Escape: 'Esc',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Enter: 'Enter',
      Tab: 'Tab',
    }
    return keyMap[rawKey] ?? rawKey
  }, [])

  const isStandaloneKeyAllowed = React.useCallback((key: string): boolean => {
    return /^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)
  }, [])

  const finishCapture = React.useCallback((accelerator: string) => {
    if (!accelerator) return

    const conflictId = checkConflict(accelerator, shortcutId)
    if (conflictId) {
      const conflictDef = DEFAULT_SHORTCUTS.find((s) => s.id === conflictId)
      setConflict(conflictDef?.name ?? conflictId)
      setPendingAccelerator(accelerator)
      setRecording(false)
      return
    }

    setPendingAccelerator(accelerator)
    setConflict(null)
    setRecording(false)
  }, [shortcutId, setPendingAccelerator])

  // 录制模式下的按键捕获
  React.useEffect(() => {
    if (!recording) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') { handleCancel(); return }
      if (e.isComposing || e.repeat) return

      // 构建 accelerator 字符串
      const parts: string[] = []
      if (e.metaKey && isMac) parts.push('Cmd')
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.shiftKey) parts.push('Shift')
      if (e.altKey) parts.push('Alt')

      // 单独按修饰键时先显示已捕获的修饰键，等待用户继续按普通键。
      if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) {
        setPendingAccelerator(parts.join('+'))
        return
      }

      // 标准化按键名称
      const key = normalizeKey(e.key)

      // 普通字母/数字/符号需要修饰键；F1-F24 允许作为独立快捷键。
      if (parts.length === 0 && !isStandaloneKeyAllowed(key)) {
        setPendingAccelerator('')
        return
      }

      parts.push(key)
      const accelerator = parts.join('+')
      finishCapture(accelerator)
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (!pendingKeysRef.current) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

      e.preventDefault()
      e.stopPropagation()
      finishCapture(pendingKeysRef.current)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [
    recording,
    handleCancel,
    normalizeKey,
    isStandaloneKeyAllowed,
    setPendingAccelerator,
    finishCapture,
  ])

  const canSave = !!pendingKeys && !recording && !conflict && !saving

  // 同步录制/pending 状态给父组件，避免父组件在录制期间渲染会改写 override 的按钮
  React.useEffect(() => {
    onActiveChange?.(recording || !!pendingKeys || saving)
  }, [recording, pendingKeys, saving, onActiveChange])

  const handleSave = React.useCallback(async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const saved = await onSave(shortcutId, pendingKeys)
      if (saved) {
        handleCancel()
      }
    } finally {
      setSaving(false)
    }
  }, [canSave, handleCancel, onSave, pendingKeys, shortcutId])

  if (recording || pendingKeys) {
    return (
      <div className="flex flex-wrap items-center gap-2" aria-live="polite" aria-busy={saving}>
        {conflict ? (
          <span className="text-xs px-2 py-1 rounded bg-destructive/10 text-destructive border border-destructive/20">
            {getAcceleratorDisplay(pendingKeys)} 与「{conflict}」冲突
          </span>
        ) : (
          <span className={`text-xs px-2 py-1 rounded border ${
            recording
              ? 'bg-primary/10 text-primary border-primary/20 animate-pulse'
              : 'bg-muted text-foreground/80 border-border'
          }`}>
            {recording
              ? pendingKeys
                ? `${getAcceleratorDisplay(pendingKeys)} + ...`
                : '请按下快捷键...'
              : getAcceleratorDisplay(pendingKeys)}
          </span>
        )}
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleCancel} disabled={saving}>
          取消
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          disabled={!canSave}
          onClick={handleSave}
        >
          {saving ? '保存中' : '保存'}
        </Button>
      </div>
    )
  }

  if (currentAccelerator === null) {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={`录制 ${shortcutId} 的快捷键`}
        className="text-xs px-2.5 py-1 rounded-md bg-muted/40 text-muted-foreground/70 italic transition-colors hover:bg-muted hover:text-foreground/80"
        onClick={handleStartRecording}
        title="点击录制新快捷键"
      >
        已禁用
      </button>
    )
  }

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`录制 ${shortcutId} 的快捷键`}
      className="text-xs px-2.5 py-1 rounded-md bg-muted hover:bg-muted/80 text-foreground/80 font-mono transition-colors"
      onClick={handleStartRecording}
      title="点击自定义快捷键"
    >
      {getAcceleratorDisplay(currentAccelerator)}
    </button>
  )
}

// ===== 主组件 =====

export function ShortcutSettings(): React.ReactElement {
  const [overrides, setOverrides] = useAtom(shortcutOverridesAtom)
  const [sendWithCmdEnter, setSendWithCmdEnter] = useAtom(sendWithCmdEnterAtom)
  // 当前正在录制的快捷键 id，用于隐藏并列操作按钮，避免与录制中途的 state 冲突
  const [recordingId, setRecordingId] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const [resetOpen, setResetOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // 临时独占应用内 handler，阻止录制按键触发已有操作；缓存和绑定保持不变。
  React.useEffect(() => {
    if (!recordingId) return
    const releases = DEFAULT_SHORTCUTS.filter((item) => !item.global).map((item) => registerShortcut(item.id, () => {}, { exclusive: true }))
    return () => releases.forEach((release) => release())
  }, [recordingId])

  const handleRecordingChange = React.useCallback(
    (shortcutId: string, active: boolean) => {
      setRecordingId((prev) => {
        if (active) return shortcutId
        return prev === shortcutId ? null : prev
      })
    },
    [],
  )

  // 按分类分组
  const grouped = React.useMemo(() => {
    const groups = new Map<ShortcutCategory, typeof DEFAULT_SHORTCUTS>()
    for (const def of DEFAULT_SHORTCUTS) {
      const list = groups.get(def.category) ?? []
      list.push(def)
      groups.set(def.category, list)
    }
    return groups
  }, [])

  const commitOverrides = React.useCallback(async (next: ShortcutOverrides, message: string, shortcutId?: string, disabling = false): Promise<boolean> => {
    if (savingRef.current || recordingId && shortcutId !== recordingId) return false
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const settings = await window.electronAPI.updateSettings({ shortcutOverrides: next })
      const saved = settings.shortcutOverrides ?? next
      setOverrides(saved)
      updateShortcutOverrides(saved)
      const global = shortcutId ? DEFAULT_SHORTCUTS.find((item) => item.id === shortcutId)?.global : true
      if (global) {
        try {
          const results = await window.electronAPI.reregisterGlobalShortcuts()
          if (!disabling && (shortcutId ? results[shortcutId] === false : Object.values(results).some((value) => !value))) {
            toast.warning(`${message}；部分全局快捷键当前未注册`, { description: '对应功能可能未启用，或组合已被系统/其他应用占用。' })
            return true
          }
        } catch {
          toast.warning(`${message}；全局快捷键重新注册失败，请重试`)
          return true
        }
      }
      toast.success(message)
      return true
    } catch (cause) {
      setError(`快捷键保存失败，原绑定已保留：${cause instanceof Error ? cause.message : String(cause)}`)
      toast.error('快捷键保存失败，原绑定已保留')
      return false
    } finally { savingRef.current = false; setSaving(false) }
  }, [recordingId, setOverrides])
  const handleSaveShortcut = (id: string, accelerator: string) => commitOverrides({ ...overrides, [id]: { ...overrides[id], [isMac ? 'mac' : 'win']: accelerator } }, '快捷键已保存', id)
  const handleReset = (id: string) => {
    const next = { ...overrides }
    delete next[id]
    return commitOverrides(next, '已恢复默认快捷键', id)
  }
  const handleDisable = (id: string) => commitOverrides({ ...overrides, [id]: { ...overrides[id], [isMac ? 'mac' : 'win']: null } }, '快捷键已禁用', id, true)
  const handleResetAll = async () => { if (await commitOverrides({}, '已恢复全部默认快捷键')) setResetOpen(false) }
  const hasOverrides = Object.keys(overrides).length > 0
  const handleToggleSendKey = async () => {
    if (savingRef.current || recordingId) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const settings = await window.electronAPI.updateSettings({ sendWithCmdEnter: !sendWithCmdEnter })
      setSendWithCmdEnter(settings.sendWithCmdEnter ?? !sendWithCmdEnter)
      toast.success('发送快捷键已保存')
    } catch (cause) {
      setError(`发送快捷键保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
      toast.error('发送快捷键保存失败，原设置已保留')
    } finally { savingRef.current = false; setSaving(false) }
  }

  // 分类顺序
  const categoryOrder: ShortcutCategory[] = ['app', 'navigation', 'edit', 'global']

  return (
    <div className="space-y-6" aria-busy={saving}>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {/* 描述 + 恢复全部按钮 */}
      <SettingsSection title="快捷键" description="点击绑定开始录制；保存后生效，Esc 取消。录制草稿期间不会修改已有绑定。"><div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          点击快捷键可自定义，录制后点击保存生效，按 Esc 取消录制
        </p>
        {hasOverrides && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            disabled={saving || recordingId !== null}
            onClick={() => setResetOpen(true)}
          >
            <RotateCcw size={12} className="mr-1" />
            恢复全部默认
          </Button>
        )}
      </div></SettingsSection>

      {/* 发送消息快捷键切换 */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
          发送消息
        </h3>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-lg bg-surface-raised">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">发送 / 换行快捷键</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              切换 Enter 发送消息或换行的行为
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-0.5">
            <button
              type="button"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                !sendWithCmdEnter
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              disabled={saving || recordingId !== null}
              aria-pressed={!sendWithCmdEnter}
              onClick={() => sendWithCmdEnter && handleToggleSendKey()}
            >
              Enter 发送
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                sendWithCmdEnter
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              disabled={saving || recordingId !== null}
              aria-pressed={sendWithCmdEnter}
              onClick={() => !sendWithCmdEnter && handleToggleSendKey()}
            >
              {isMac ? '⌘' : 'Ctrl'}+Enter 发送
            </button>
          </div>
        </div>
      </div>

      {/* 按分类分组展示 */}
      {categoryOrder.map((category) => {
        const shortcuts = grouped.get(category)
        if (!shortcuts) return null

        return (
          <SettingsSection key={category} title={SHORTCUT_CATEGORY_LABELS[category]}>
            {category === 'global' && (
              <p className="text-xs text-muted-foreground/70 mb-2">
                全局快捷键在应用未聚焦时也能触发，可能与系统或其他应用冲突
              </p>
            )}
            <SettingsCard>
              {shortcuts.filter((def) => !def.readonly || (isMac ? def.defaultMac : def.defaultWin)).map((def) => {
                const currentAccel = getActiveAccelerator(def.id)
                const platformOverride = overrides[def.id]?.[isMac ? 'mac' : 'win']
                const isDisabled = platformOverride === null
                const isCustomized = !isDisabled && !!platformOverride

                return (
                  <div
                    key={def.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {def.name}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {def.description}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {def.readonly ? (
                        <span className="text-xs px-2.5 py-1 rounded-md bg-muted text-foreground/60 font-mono">
                          {getAcceleratorDisplay(isMac ? def.defaultMac : def.defaultWin)}
                        </span>
                      ) : (
                        <>
                          <ShortcutRecorder
                            shortcutId={def.id}
                            currentAccelerator={currentAccel}
                            disabled={saving || (recordingId !== null && recordingId !== def.id)}
                            onSave={handleSaveShortcut}
                            onActiveChange={(active) => handleRecordingChange(def.id, active)}
                          />
                          {recordingId !== def.id && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <Switch
                                    checked={!isDisabled}
                                    disabled={saving || recordingId !== null}
                                    onCheckedChange={(checked) => {
                                      if (checked) {
                                        handleReset(def.id)
                                      } else {
                                        handleDisable(def.id)
                                      }
                                    }}
                                    aria-label={`${isDisabled ? '启用' : '禁用'} ${def.name}`}
                                  />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                {isDisabled
                                  ? '已禁用 — 打开以恢复默认快捷键'
                                  : '关闭以禁用此快捷键，避免与其他应用冲突'}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {isCustomized && recordingId !== def.id && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-muted-foreground"
                                  disabled={saving || recordingId !== null}
                                  aria-label={`恢复 ${def.name} 默认快捷键`}
                                  onClick={() => handleReset(def.id)}
                                >
                                  <RotateCcw size={12} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">恢复默认快捷键</TooltipContent>
                            </Tooltip>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </SettingsCard>
          </SettingsSection>
        )
      })}
      <AlertDialog open={resetOpen} onOpenChange={(open) => { if (!saving) setResetOpen(open) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>恢复全部默认快捷键？</AlertDialogTitle><AlertDialogDescription>将清除所有平台的自定义绑定，并重新启用已禁用的快捷键。发送 / 换行偏好不受影响。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={saving}>取消</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void handleResetAll() }}>{saving ? '保存中…' : '恢复全部默认'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
