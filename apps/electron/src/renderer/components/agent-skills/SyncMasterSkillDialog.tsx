/**
 * SyncMasterSkillDialog — 同步全局元 Skill 到选定工作区
 *
 * 列出目标工作区（个人工作区），对每个预检冲突；有冲突的工作区显示警告，
 * 用户可选择「覆盖（强制）」或默认跳过；确认后批量同步并反馈结果。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { Download, AlertTriangle, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MasterSkillMeta, SyncSkillResult } from '@profer/shared'

interface TargetGuard {
  id: string
  slug: string
  name: string
  enabled: boolean
  conflict: boolean
  changedFiles: string[]
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: MasterSkillMeta | null
  /** 目标工作区（个人工作区传入） */
  workspaces: Array<{ id: string; slug: string; name: string; type?: string }>
  onDone: () => void
}

export function SyncMasterSkillDialog({ open, onOpenChange, skill, workspaces, onDone }: Props): React.ReactElement | null {
  const [targets, setTargets] = React.useState<TargetGuard[]>([])
  const [checking, setChecking] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [results, setResults] = React.useState<SyncSkillResult[] | null>(null)

  // 打开时初始化目标列表并预检冲突
  React.useEffect(() => {
    if (!open || !skill) return
    setResults(null)
    setSyncing(false)

    const personal = workspaces.filter((w) => w.type !== 'team')
    const initial: TargetGuard[] = personal.map((w) => ({
      id: w.id,
      slug: w.slug,
      name: w.name,
      enabled: false,
      conflict: false,
      changedFiles: [],
    }))
    setTargets(initial)
    setChecking(true)
    Promise.all(
      initial.map(async (t) => {
        try {
          const c = await window.electronAPI.skillMaster.detectConflict(t.slug, skill.slug)
          return { ...t, conflict: c.hasConflict, changedFiles: c.changedFiles }
        } catch {
          return t
        }
      }),
    )
      .then(setTargets)
      .finally(() => setChecking(false))
  }, [open, skill, workspaces])

  if (!skill) return null

  const toggle = (slug: string): void => {
    setTargets((prev) => prev.map((t) => (t.slug === slug ? { ...t, enabled: !t.enabled } : t)))
  }

  const forceMark = (slug: string): void => {
    setTargets((prev) => prev.map((t) =>
      t.slug === slug ? { ...t, enabled: !t.enabled, conflict: false } : t,
    ))
  }

  const doSync = async (): Promise<void> => {
    if (!skill || syncing) return
    const selected = targets.filter((t) => t.enabled)
    if (selected.length === 0) {
      toast.info('请勾选至少一个目标工作区')
      return
    }
    const conflictSlugs = selected.filter((t) => t.conflict).map((t) => t.slug)
    setSyncing(true)
    try {
      const res = await window.electronAPI.skillMaster.syncToWorkspaces(
        skill.slug,
        selected.map((t) => t.slug),
        { forceSlugs: conflictSlugs },
      )
      setResults(res)
      const ok = res.filter((r) => r.success).length
      toast.success(`已同步到 ${ok} 个工作区`)
      onDone()
    } catch (e) {
      console.error('[SyncSkill] 同步失败:', e)
      toast.error('同步失败')
    } finally {
      setSyncing(false)
    }
  }

  const selectedCount = targets.filter((t) => t.enabled).length

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!syncing) onOpenChange(o) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download size={16} />
            同步「{skill.name}」到工作区
          </DialogTitle>
          <DialogDescription>
            元 Skill 当前版本 v{skill.version}。勾选目标工作区，有冲突的会提示。
          </DialogDescription>
        </DialogHeader>

        {checking ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            检测冲突中...
          </div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto scrollbar-thin rounded-lg border border-border/60">
            {targets.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">暂无个人工作区可同步</div>
            )}
            {targets.map((t) => (
              <button
                key={t.slug}
                type="button"
                onClick={() => toggle(t.slug)}
                className={cn(
                  'flex w-full items-center gap-3 border-b border-border/40 px-3 py-2.5 text-left transition-colors last:border-b-0',
                  t.enabled ? 'bg-accent/40' : 'hover:bg-muted/40',
                )}
              >
                <span className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded border text-[10px]',
                  t.enabled ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                )}>
                  {t.enabled ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{t.name}</span>
                  {t.conflict ? (
                    <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                      <AlertTriangle size={11} />
                      检测到本地修改（{t.changedFiles.length} 文件），同步会强制覆盖
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{t.slug}</span>
                  )}
                </span>
                {t.conflict && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); forceMark(t.slug) }}
                    className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-foreground/10"
                  >
                    覆盖
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {results && results.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs">
            {results.map((r) => (
              <div key={r.workspaceSlug} className="flex items-center gap-2 py-0.5">
                <span className={r.success ? 'text-green-600' : 'text-red-500'}>
                  {r.success ? '✓' : '✕'}
                </span>
                <span className="text-muted-foreground">{r.workspaceSlug}</span>
                {r.error && <span className="text-red-400">{r.error}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={syncing}>
            关闭
          </Button>
          <Button onClick={() => void doSync()} disabled={syncing || checking || selectedCount === 0}>
            {syncing ? (
              <>
                <Loader2 size={14} className="mr-1 animate-spin" /> 同步中...
              </>
            ) : (
              `同步到 ${selectedCount} 个工作区`
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
