/**
 * 定时任务表单视图（Codex 风格，覆盖在中间内容区，非弹窗）
 *
 * 两栏布局：
 * - 左：大的自然语言任务描述输入框（主角）
 * - 右：配置栏（启用 / 状态信息 / 调度模式 / 模型 / 工作区 / 运行历史）
 *
 * 表单打开时 AppShell 会隐藏右侧文件面板，中间区域扩展到全宽。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Clock, AlertTriangle, X, CheckCircle2, XCircle, MinusCircle, Pencil, Check } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { ModelSelector } from '@/components/chat/ModelSelector'
import {
  automationFormAtom,
  automationsAtom,
  AUTOMATION_INTERVAL_OPTIONS,
  AUTOMATION_WEEKDAY_OPTIONS,
  type AutomationDraft,
} from '@/atoms/automation-atoms'
import { agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { activeSessionIdAtom } from '@/atoms/tab-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import type { AutomationRun } from '@proma/shared'

const NO_WORKSPACE = '__none__'

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function RunStatusIcon({ status }: { status: AutomationRun['status'] }): React.ReactElement {
  if (status === 'success') return <CheckCircle2 className="size-3 text-emerald-500" />
  if (status === 'error') return <XCircle className="size-3 text-destructive" />
  return <MinusCircle className="size-3 text-muted-foreground/50" />
}

export function AutomationFormView(): React.ReactElement | null {
  const [formState, setFormState] = useAtom(automationFormAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const automations = useAtomValue(automationsAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const openSession = useOpenSession()

  const [form, setForm] = React.useState<AutomationDraft | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [editingName, setEditingName] = React.useState(false)
  const nameInputRef = React.useRef<HTMLInputElement>(null)

  // 卸载/关闭过程中不再 setState（保存 IPC 是异步的，结束时表单可能已经被关掉了）
  const isMountedRef = React.useRef(true)
  React.useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  React.useEffect(() => {
    if (formState.open && formState.draft) {
      setForm({ ...formState.draft })
    }
  }, [formState.open, formState.draft])

  // 切换会话/Tab 时自动关闭表单
  const initialSessionRef = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    if (!formState.open) {
      initialSessionRef.current = undefined
      return
    }
    if (initialSessionRef.current === undefined) {
      initialSessionRef.current = activeSessionId
      return
    }
    if (activeSessionId !== initialSessionRef.current) {
      setFormState({ open: false, draft: null })
    }
  }, [activeSessionId, formState.open, setFormState])

  if (!formState.open || !form) return null

  // 编辑模式下取实时的 automation（用于状态信息 + 运行历史，订阅 changed 后会刷新）
  const live = form.id ? automations.find((a) => a.id === form.id) : undefined

  const close = (): void => setFormState({ open: false, draft: null })
  const update = (patch: Partial<AutomationDraft>): void => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  /** 跳到运行历史中的某次子会话，先关掉表单 overlay 再 openSession */
  const handleOpenRunSession = (run: AutomationRun): void => {
    const session = agentSessions.find((s) => s.id === run.sessionId)
    if (!session) {
      toast.error('该会话已不存在')
      return
    }
    setFormState({ open: false, draft: null })
    openSession('agent', session.id, session.title)
  }

  const startEditName = (): void => {
    setEditingName(true)
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }
  const handleNameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      setEditingName(false)
    } else if (e.key === 'Escape') {
      setEditingName(false)
    }
  }

  const isEdit = !!form.id
  const canSave = !!(form.name.trim() && form.prompt.trim() && form.channelId)

  const handleSave = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      const common = {
        scheduleType: form.scheduleType,
        intervalMinutes: form.intervalMinutes,
        timeOfDay: form.timeOfDay,
        dayOfWeek: form.dayOfWeek,
        permissionMode: form.permissionMode,
      }
      if (isEdit && form.id) {
        await window.electronAPI.updateAutomation({
          id: form.id,
          name: form.name.trim(),
          prompt: form.prompt.trim(),
          ...common,
          channelId: form.channelId,
          modelId: form.modelId,
          workspaceId: form.workspaceId ?? '',
          active: form.active,
        })
        if (isMountedRef.current) toast.success('已保存')
      } else {
        const created = await window.electronAPI.createAutomation({
          name: form.name.trim(),
          prompt: form.prompt.trim(),
          ...common,
          channelId: form.channelId,
          modelId: form.modelId,
          workspaceId: form.workspaceId,
          sourceSessionId: form.sourceSessionId,
          active: form.active,
        })
        // 不关闭页面：转为编辑模式，便于继续调整
        if (isMountedRef.current && created?.id) {
          setForm((prev) => (prev ? { ...prev, id: created.id } : prev))
        }
        if (isMountedRef.current) toast.success('定时任务已创建')
      }
    } catch (err) {
      console.error('[定时任务] 保存失败:', err)
      if (isMountedRef.current) toast.error('保存失败')
    } finally {
      if (isMountedRef.current) setSaving(false)
    }
  }

  const selectedModel = form.channelId && form.modelId
    ? { channelId: form.channelId, modelId: form.modelId }
    : null

  return (
    <div className="titlebar-no-drag absolute inset-0 z-10 bg-content-area flex animate-in fade-in duration-200">
      {/* 左栏：自然语言任务描述（主角） */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-2 px-6 py-4 flex-shrink-0">
          <Clock className="size-4 text-primary flex-shrink-0" />
          {editingName ? (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <input
                ref={nameInputRef}
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                onKeyDown={handleNameKeyDown}
                onBlur={() => setEditingName(false)}
                placeholder="未命名任务"
                className="flex-1 bg-transparent text-sm font-semibold text-foreground border-b border-primary/50 outline-none px-0 py-0.5 min-w-0"
                maxLength={100}
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEditingName(false)}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              >
                <Check className="size-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <span className="truncate text-sm font-semibold text-foreground">
                {form.name.trim() || (isEdit ? '未命名任务' : '新建定时任务')}
              </span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={startEditName}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                aria-label="重命名任务"
              >
                <Pencil className="size-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 px-6 pb-6">
          <Textarea
            value={form.prompt}
            onChange={(e) => update({ prompt: e.target.value })}
            placeholder="用自然语言描述要重复执行的任务，例如：&#10;&#10;查看 Proma 仓库最近 10 分钟的新 issue，总结其中状态有变化的，输出一句话摘要。"
            className="w-full h-full resize-none text-[15px] leading-relaxed border-none shadow-none focus-visible:ring-0 bg-transparent px-0"
            autoFocus
          />
        </div>
      </div>

      {/* 右栏：配置 sidebar */}
      <div className="w-[340px] flex-shrink-0 border-l border-border/50 flex flex-col bg-content-area">
        <div className="flex items-center justify-between px-4 py-4 flex-shrink-0">
          <span className="text-sm font-semibold text-foreground">配置</span>
          <button
            onClick={close}
            className="titlebar-no-drag p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-5">
          {/* 启用开关（最上） */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="auto-active">启用</Label>
              <span className="text-xs text-muted-foreground">关闭后任务暂停调度</span>
            </div>
            <Switch
              id="auto-active"
              checked={form.active}
              onCheckedChange={(checked) => update({ active: checked })}
            />
          </div>

          {/* 状态信息（编辑模式显示） */}
          {isEdit && (
            <div className="rounded-lg bg-foreground/[0.03] p-3 flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">上次运行</span>
                <span className="text-foreground/80 tabular-nums">{formatTime(live?.lastRunAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">下次运行</span>
                <span className="text-foreground/80 tabular-nums">
                  {live?.active ? formatTime(live?.nextRunAt) : '已暂停'}
                </span>
              </div>
            </div>
          )}

          {/* 调度模式 */}
          <div className="flex flex-col gap-2">
            <Label>运行方式</Label>
            <Select
              value={form.scheduleType}
              onValueChange={(v) => update({ scheduleType: v as AutomationDraft['scheduleType'] })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="interval">每隔一段时间</SelectItem>
                <SelectItem value="daily">每天定点</SelectItem>
                <SelectItem value="weekly">每周定点</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* interval 模式：自定义分钟 */}
          {form.scheduleType === 'interval' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-interval">运行间隔（分钟）</Label>
              <div className="flex items-center gap-2">
                <input
                  id="auto-interval"
                  type="number"
                  min={1}
                  value={form.intervalMinutes}
                  onChange={(e) => update({ intervalMinutes: Math.max(1, Number(e.target.value) || 1) })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <span className="text-xs text-muted-foreground shrink-0">分钟一次</span>
              </div>
            </div>
          )}

          {/* daily 模式：时刻 */}
          {form.scheduleType === 'daily' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-time">时刻</Label>
              <input
                id="auto-time"
                type="time"
                value={form.timeOfDay ?? '09:00'}
                onChange={(e) => update({ timeOfDay: e.target.value })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}

          {/* weekly 模式：星期 + 时刻 同一行 */}
          {form.scheduleType === 'weekly' && (
            <div className="flex flex-col gap-2">
              <Label>每周</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={String(form.dayOfWeek ?? 1)}
                  onValueChange={(v) => update({ dayOfWeek: Number(v) })}
                >
                  <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_WEEKDAY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <input
                  type="time"
                  value={form.timeOfDay ?? '09:00'}
                  onChange={(e) => update({ timeOfDay: e.target.value })}
                  className="flex h-9 w-[120px] shrink-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </div>
          )}

          {/* 选择模型 */}
          <div className="flex flex-col gap-2">
            <Label>选择模型</Label>
            <ModelSelector
              externalSelectedModel={selectedModel}
              showChannelInTrigger
              onModelSelect={(opt) => update({ channelId: opt.channelId, modelId: opt.modelId })}
            />
          </div>

          {/* 工作区 */}
          <div className="flex flex-col gap-2">
            <Label>工作区</Label>
            <Select
              value={form.workspaceId ?? NO_WORKSPACE}
              onValueChange={(v) => update({ workspaceId: v === NO_WORKSPACE ? undefined : v })}
            >
              <SelectTrigger><SelectValue placeholder="选择工作区" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_WORKSPACE}>无工作区</SelectItem>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 权限模式 */}
          <div className="flex flex-col gap-2">
            <Label>运行权限</Label>
            <Select
              value={form.permissionMode}
              onValueChange={(v) => update({ permissionMode: v as AutomationDraft['permissionMode'] })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bypassPermissions">完全自动</SelectItem>
                <SelectItem value="auto">自动审批</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground leading-relaxed">
              {form.permissionMode === 'bypassPermissions'
                ? '所有工具调用自动允许（推荐用于无人值守）。'
                : '由 SDK 内置审批器判断，危险操作仍会请求确认；无人值守时这些请求会一直挂起，需手动到会话中处理。'}
            </span>
          </div>

          {form.permissionMode === 'bypassPermissions' && (
            <div className="flex gap-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <span>此任务将以「完全权限」无人值守运行，可自主读写文件、执行命令。请确认任务内容安全可信。</span>
            </div>
          )}

          {/* 运行历史（编辑模式） */}
          {isEdit && live && (
            <div className="flex flex-col gap-1.5">
              <Label>运行历史</Label>
              {live.runHistory.length === 0 ? (
                <div className="text-xs text-muted-foreground py-1">暂无运行记录</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {live.runHistory.slice(0, 10).map((run, i) => {
                    const sessionExists = agentSessions.some((s) => s.id === run.sessionId)
                    return (
                      <button
                        key={`${run.runAt}-${i}`}
                        type="button"
                        onClick={() => handleOpenRunSession(run)}
                        disabled={!sessionExists}
                        title={sessionExists ? '查看本次执行的会话' : '该会话已不存在'}
                        className="flex items-center gap-1.5 px-1.5 py-1 -mx-1.5 rounded-md text-[11px] text-foreground/60 text-left transition-colors enabled:hover:bg-foreground/[0.04] enabled:hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RunStatusIcon status={run.status} />
                        <span className="tabular-nums">{formatTime(run.runAt)}</span>
                        <span className="text-foreground/35 truncate">
                          {run.status === 'success' && run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : ''}
                          {run.status === 'error' ? (run.error ?? '失败') : ''}
                          {run.status === 'skipped' ? (run.skipReason ?? '跳过') : ''}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-4 border-t border-border/50 flex-shrink-0">
          <Button variant="ghost" onClick={close} disabled={saving}>取消</Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving ? '保存中…' : isEdit ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  )
}
