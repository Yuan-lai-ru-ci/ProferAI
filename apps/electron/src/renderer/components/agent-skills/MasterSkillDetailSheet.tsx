/**
 * MasterSkillDetailSheet — 全局元 Skill 详情抽屉
 *
 * 承载元 Skill 的 SKILL.md 编辑（保存自动 bump 版本 + 生成快照）、
 * 版本历史浏览与回退，以及「同步到工作区」入口。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { Sparkles, Save, X, Pencil, ArrowLeft, RefreshCw, History, Download } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsCard } from '@/components/settings/primitives'
import type { MasterSkillMeta, MasterSkillVersion } from '@profer/shared'
import { extractSkillBody, rebuildSkillMd } from './skillMdUtils'

interface Props {
  skill: MasterSkillMeta | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
  /** 打开同步对话框 */
  onSync: (slug: string) => void
}

export function MasterSkillDetailSheet(props: Props): React.ReactElement {
  const { skill, onOpenChange } = props
  return (
    <Sheet open={!!skill} onOpenChange={onOpenChange}>
      <SheetContent hideClose side="right" className="w-[62vw] min-w-[680px] max-w-[1100px] sm:max-w-[1100px] p-0 flex flex-col gap-0" aria-describedby={undefined}>
        <SheetTitle className="sr-only">全局元 Skill 详情</SheetTitle>
        {skill && <MasterSkillBody key={skill.slug} {...props} skill={skill} />}
      </SheetContent>
    </Sheet>
  )
}

function MasterSkillBody({ skill, onOpenChange, onChanged, onSync }: Props & { skill: MasterSkillMeta }): React.ReactElement {
  const slug = skill.slug
  const [content, setContent] = React.useState<string | null>(null)
  const [history, setHistory] = React.useState<MasterSkillVersion[]>([])
  const [isEditing, setIsEditing] = React.useState(false)
  const [editBody, setEditBody] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [note, setNote] = React.useState('')
  const [tab, setTab] = React.useState<'edit' | 'history'>('edit')
  const [rollingBack, setRollingBack] = React.useState(false)
  const [displayName, setDisplayName] = React.useState(skill.name)
  const [displayDesc, setDisplayDesc] = React.useState(skill.description ?? '')
  const [isEditingMeta, setIsEditingMeta] = React.useState(false)
  const [editName, setEditName] = React.useState('')
  const [editDesc, setEditDesc] = React.useState('')
  const [savingMeta, setSavingMeta] = React.useState(false)

  React.useEffect(() => {
    setContent(null)
    setHistory([])
    setIsEditing(false)
    setTab('edit')
    window.electronAPI.skillMaster.read(slug)
      .then(setContent)
      .catch((e) => {
        console.error('[MasterSkill] 读取失败:', e)
        setContent(null)
      })
    window.electronAPI.skillMaster.listHistory(slug)
      .then(setHistory)
      .catch(() => setHistory([]))
  }, [slug])

  const body = React.useMemo(() => extractSkillBody(content ?? ''), [content])

  const saveMeta = async (): Promise<void> => {
    setSavingMeta(true)
    try {
      await window.electronAPI.skillMaster.renameMeta(slug, { name: editName, description: editDesc })
      setDisplayName(editName)
      setDisplayDesc(editDesc)
      setIsEditingMeta(false)
      onChanged()
      toast.success('元数据已更新')
    } catch (e) {
      console.error('[MasterSkill] 更新元数据失败:', e)
      toast.error('更新元数据失败')
    } finally {
      setSavingMeta(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!content) return
    setSaving(true)
    try {
      const newContent = rebuildSkillMd(content, { body: editBody })
      await window.electronAPI.skillMaster.save(slug, newContent, note.trim() || undefined)
      setContent(newContent)
      setIsEditing(false)
      setNote('')
      onChanged()
      // 刷新历史
      const h = await window.electronAPI.skillMaster.listHistory(slug)
      setHistory(h)
      toast.success('元 Skill 已保存（版本已 bump）')
    } catch (e) {
      console.error('[MasterSkill] 保存失败:', e)
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const rollback = async (snapshotId: string): Promise<void> => {
    setRollingBack(true)
    try {
      await window.electronAPI.skillMaster.rollback(slug, snapshotId)
      const c = await window.electronAPI.skillMaster.read(slug)
      const h = await window.electronAPI.skillMaster.listHistory(slug)
      setContent(c)
      setHistory(h)
      onChanged()
      toast.success(`已回退到 ${snapshotId}`)
    } catch (e) {
      console.error('[MasterSkill] 回退失败:', e)
      toast.error('回退失败')
    } finally {
      setRollingBack(false)
    }
  }

  return (
    <div className="flex h-full flex-col min-h-0">
      {/* 头部 */}
      <div className="shrink-0 border-b border-border/60 px-5 pb-4 pt-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" type="button" onClick={() => onOpenChange(false)}>
            <ArrowLeft size={18} />
          </Button>
          <h3 className="text-lg font-medium text-foreground">全局元 Skill 详情</h3>
        </div>

        <div className="mt-4 flex items-start gap-3">
          <div className="rounded-xl bg-amber-500/12 p-2 text-amber-500 shadow-sm shrink-0">
            <Sparkles size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold text-foreground">{displayName}</h3>
              {skill.version && (
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">v{skill.version}</span>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{slug}</div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 mr-auto flex-wrap">
            <span className="text-[11px] text-muted-foreground">已同步 {skill.syncedWorkspaceCount} 个工作区</span>
            {skill.userModified && (
              <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">已修改</span>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => onSync(slug)}>
            <Download size={14} className="mr-1" />
            同步到工作区
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* 编辑 / 历史 切换 */}
        <div className="flex items-center gap-1 px-5 pt-3">
          <TabButton active={tab === 'edit'} label="编辑" onClick={() => setTab('edit')} />
          <TabButton active={tab === 'history'} label={`历史 (${history.length})`} onClick={() => setTab('history')} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-5">
          {tab === 'edit' ? (
            <div className="flex flex-col gap-3">
              {/* 元数据（name / description）编辑 */}
              <div className="rounded-lg border border-border/60 bg-content-area px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">元数据</span>
                  {!isEditingMeta ? (
                    <Button size="sm" variant="ghost" onClick={() => { setEditName(displayName); setEditDesc(displayDesc); setIsEditingMeta(true) }}>
                      <Pencil size={13} className="mr-1" /> 编辑
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setIsEditingMeta(false)} disabled={savingMeta}>
                        <X size={13} className="mr-1" /> 取消
                      </Button>
                      <Button size="sm" onClick={() => void saveMeta()} disabled={savingMeta}>
                        <Save size={13} className="mr-1" /> {savingMeta ? '保存中...' : '保存'}
                      </Button>
                    </div>
                  )}
                </div>
                {isEditingMeta ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="名称"
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <textarea
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="描述"
                      rows={2}
                      className="w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                ) : (
                  <div className="mt-1.5 flex flex-col gap-1">
                    <div className="text-sm text-foreground">{displayName || '未设置名称'}</div>
                    <div className="text-xs text-muted-foreground">{displayDesc || '暂无描述'}</div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="font-mono text-xs text-muted-foreground">SKILL.md</div>
                {!isEditing ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setEditBody(body); setIsEditing(true) }}
                  >
                    <RefreshCw size={14} className="mr-1" />
                    编辑
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)} disabled={saving}>
                      <X size={14} className="mr-1" /> 取消
                    </Button>
                    <Button size="sm" onClick={() => void save()} disabled={saving}>
                      <Save size={14} className="mr-1" /> {saving ? '保存中...' : '保存并生成新版本'}
                    </Button>
                  </div>
                )}
              </div>

              {isEditing && (
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="本次改动说明（可选，会记录到版本历史）"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}

              <SettingsCard divided={false}>
                <div className="p-4">
                  {isEditing ? (
                    <textarea
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      className="min-h-[360px] w-full resize-y rounded-md border border-border bg-transparent p-3 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="输入 SKILL.md 正文（保存后 version 自动 +1）..."
                    />
                  ) : (
                    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-[13px] text-foreground">
                      {content ?? '加载中...'}
                    </pre>
                  )}
                </div>
              </SettingsCard>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                每次保存自动生成一条快照；点击「回退」可恢复到指定版本（会保留一条新的回退记录）。
              </p>
              {history.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">暂无版本历史</div>}
              {history.map((v) => (
                <div key={v.snapshotId} className="flex items-center gap-3 rounded-lg border border-border/60 bg-content-area px-3 py-2.5">
                  <History size={14} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{v.snapshotId}</span>
                      <span className="text-xs text-muted-foreground">v{v.version}</span>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                      {v.note ? ` · ${v.note}` : ''}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rollingBack || v.snapshotId === history[history.length - 1]?.snapshotId}
                    onClick={() => void rollback(v.snapshotId)}
                  >
                    回退
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'rounded-lg bg-muted px-3 py-1.5 text-[13px] font-medium text-foreground'
          : 'rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted/50'
      }
    >
      {label}
    </button>
  )
}
