/**
 * MasterSkillsTab — Agent 技能视图里的「全局元 Skill」Tab
 *
 * 展示 default-skills/ 元 skill 库：用户可编辑、有版本历史、可同步到个人工作区。
 * 自包含：加载列表、打开详情、同步对话框。写操作后回调 onChanged 刷新外部计数。
 */

import * as React from 'react'
import { Blocks, Download, RefreshCw, Pencil, ArrowDownToLine } from 'lucide-react'
import type { MasterSkillMeta } from '@profer/shared'
import { MasterSkillDetailSheet } from './MasterSkillDetailSheet'
import { SyncMasterSkillDialog } from './SyncMasterSkillDialog'

interface Props {
  /** 目标工作区（用于同步对话框） */
  workspaces: Array<{ id: string; slug: string; name: string; type?: string }>
  onChanged: () => void
}

export function MasterSkillsTab({ workspaces, onChanged }: Props): React.ReactElement {
  const [skills, setSkills] = React.useState<MasterSkillMeta[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<MasterSkillMeta | null>(null)
  const [syncTarget, setSyncTarget] = React.useState<MasterSkillMeta | null>(null)

  const load = React.useCallback(() => {
    setLoading(true)
    window.electronAPI.skillMaster.list()
      .then(setSkills)
      .catch((e) => {
        console.error('[MasterSkills] 加载失败:', e)
        setSkills([])
      })
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return <div className="py-20 text-center text-sm text-muted-foreground">加载中...</div>
  }

  if (skills.length === 0) {
    return (
      <div className="flex h-full flex-col items-center gap-3 py-20 text-center">
        <Blocks size={32} className="text-foreground/30" />
        <div className="text-sm font-medium text-foreground/80">暂无全局元 Skill</div>
        <div className="max-w-sm text-[13px] text-foreground/50">
          元 Skill 是随应用内置到全局库的技能源，可在本页编辑并同步到个人工作区。
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground/55">全局元 Skill 库</span>
          <span className="text-[12px] tabular-nums text-foreground/35">{skills.length}</span>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/10"
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((skill) => (
          <button
            key={skill.slug}
            type="button"
            onClick={() => setSelected(skill)}
            className="group flex flex-col gap-2 rounded-xl border border-border/60 bg-content-area p-4 text-left transition-all hover:border-border hover:shadow-sm"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-amber-500/12 p-2 text-amber-500 shadow-sm shrink-0">
                <Blocks size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
                  {skill.version && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      v{skill.version}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{skill.slug}</div>
              </div>
            </div>

            <p className="line-clamp-2 min-h-[40px] text-[13px] leading-6 text-muted-foreground">
              {skill.description ?? '暂无描述'}
            </p>

            <div className="mt-auto flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                <ArrowDownToLine size={11} />
                {skill.syncedWorkspaceCount} 个工作区
              </span>
              {skill.versionCount > 0 && (
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {skill.versionCount} 个版本
                </span>
              )}
              {skill.userModified && (
                <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  已修改
                </span>
              )}
              <span className="ml-auto flex gap-1">
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground group-hover:text-foreground">
                  <Pencil size={11} className="inline" /> 编辑
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); setSyncTarget(skill) }}
                  className="flex items-center gap-1 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-500/20 dark:text-blue-400"
                >
                  <Download size={11} /> 同步
                </span>
              </span>
            </div>
          </button>
        ))}
      </div>

      <MasterSkillDetailSheet
        skill={selected}
        onOpenChange={(open) => { if (!open) setSelected(null) }}
        onChanged={() => { load(); onChanged() }}
        onSync={(slug) => {
          const s = skills.find((x) => x.slug === slug)
          setSelected(null)
          setSyncTarget(s ?? null)
        }}
      />

      <SyncMasterSkillDialog
        open={!!syncTarget}
        onOpenChange={(open) => { if (!open) setSyncTarget(null) }}
        skill={syncTarget}
        workspaces={workspaces}
        onDone={() => { load(); onChanged() }}
      />
    </div>
  )
}
