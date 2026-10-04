/**
 * SkillCardSection — 技能详情里的「路由卡片（SKILL.json）」区块。
 *
 * 只编辑程序能判定的声明：需要哪些能力组/工具、是否只接受显式引用。
 * 「什么时候用」属于描述（SKILL.md frontmatter），这里不提供第二个写词的地方；
 * 卡片里的旧词表（triggers）只读展示、保存时不碰。保存后直接回显医生诊断。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Pencil, Save, X } from 'lucide-react'
import { AGENT_PRESET_CAPABILITY_GROUPS, type SkillDoctorIssue, type WorkspaceSkillCardState } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { Switch } from '@profer/ui/primitives/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { SettingsCard } from '@/components/settings/primitives'
import { cn } from '@/lib/utils'
import { cardFormFromManifest, cardPatchFromForm, EMPTY_SKILL_CARD_FORM, type SkillCardForm } from './skillCardForm'

interface SkillCardSectionProps {
  workspaceSlug: string
  skillSlug: string
  /** 内置源只读；只有工作区里的技能才允许改卡片。 */
  canEdit: boolean
  onChanged?: () => void
}

const SEVERITY_CLASS: Record<SkillDoctorIssue['severity'], string> = {
  error: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-500',
  info: 'text-muted-foreground',
}

export function SkillCardSection({ workspaceSlug, skillSlug, canEdit, onChanged }: SkillCardSectionProps): React.ReactElement {
  const [card, setCard] = React.useState<WorkspaceSkillCardState | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<SkillCardForm>({ ...EMPTY_SKILL_CARD_FORM })

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setEditing(false)
    window.electronAPI
      .readSkillCard(workspaceSlug, skillSlug)
      .then((state) => {
        if (!active) return
        setCard(state)
        setError(null)
        setForm(cardFormFromManifest(state.manifest))
      })
      .catch((cause) => {
        console.error('[SkillDetail] 读取路由卡片失败:', cause)
        if (!active) return
        setCard(null)
        // 内置源不在当前工作区，读不到是正常情况；把原因说清楚，不要显示成“暂无卡片”。
        setError(cause instanceof Error ? cause.message : '读取失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [workspaceSlug, skillSlug])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.electronAPI.writeSkillCard(workspaceSlug, skillSlug, cardPatchFromForm(form))
      setCard(next)
      setForm(cardFormFromManifest(next.manifest))
      setEditing(false)
      onChanged?.()
      const problems = next.doctor.filter((issue) => issue.severity !== 'info')
      if (next.present) toast.success('路由卡片已保存')
      else toast.success('路由卡片已清空（回到只读正文元数据）')
      for (const issue of problems.slice(0, 2)) toast.warning(issue.message)
    } catch (error) {
      console.error('[SkillDetail] 保存路由卡片失败:', error)
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const manifest = card?.manifest
  const keywords = manifest?.triggers?.keywords ?? []
  const excludeKeywords = manifest?.triggers?.excludeKeywords ?? []
  const toolGroups = manifest?.dependencies?.toolGroups ?? []
  const tools = manifest?.dependencies?.tools ?? []
  const explicitOnly = manifest?.policy?.implicit === false
  const doctor = (card?.doctor ?? []).filter((issue) => issue.severity !== 'info')

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          路由卡片
        </h4>
        {canEdit &&
          (!editing ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    setForm(cardFormFromManifest(card?.manifest))
                    setEditing(true)
                  }}
                  className="flex items-center rounded p-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Pencil size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">编辑依赖与触发方式</TooltipContent>
            </Tooltip>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                <X size={14} /> 取消
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                <Save size={14} /> {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          ))}
      </div>

      {loading ? (
        <div className="px-1 text-xs text-muted-foreground">加载中...</div>
      ) : error ? (
        <div className="px-1 text-xs text-muted-foreground">
          {canEdit ? `读取失败：${error}` : '内置源随技能本体发布；复制到当前工作区后才能编辑依赖与触发方式。'}
        </div>
      ) : (
        <SettingsCard divided={false}>
          <div className="flex flex-col">
            {editing ? (
              <div className="flex flex-col gap-3 p-4">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  「什么时候用」写在上面元数据的描述里（例如 “Use when: 画图表、流程图、可调参的讲解”）——
                  模型读到的就是描述，写在那里就够了；这里只填程序要判定的依赖与触发方式。
                </p>
                <Field label="需要的能力组" hint="缺任意一项时该技能不会自动触发">
                  <div className="flex flex-wrap gap-1.5">
                    {AGENT_PRESET_CAPABILITY_GROUPS.map((group) => {
                      const selected = form.toolGroups.includes(group.id)
                      return (
                        <button
                          key={group.id}
                          type="button"
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              toolGroups: selected ? current.toolGroups.filter((id) => id !== group.id) : [...current.toolGroups, group.id],
                            }))
                          }
                          className={cn(
                            'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                            selected ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {group.label}
                        </button>
                      )
                    })}
                  </div>
                </Field>
                <Field label="额外工具" hint="不在能力组里的工具名，如 mcp__server__tool">
                  <Input
                    value={form.tools}
                    onChange={(e) => setForm((current) => ({ ...current, tools: e.target.value }))}
                    placeholder="present_visualization"
                  />
                </Field>
                <label className="flex cursor-pointer items-center justify-between gap-2 select-none">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs">只接受显式引用</span>
                    <span className="text-[10px] text-muted-foreground">开启后只在 /skill:{skillSlug} 时加载，不参与自动触发</span>
                  </span>
                  <Switch className="scale-90 shrink-0" checked={form.explicitOnly} onCheckedChange={(on) => setForm((current) => ({ ...current, explicitOnly: on }))} />
                </label>
              </div>
            ) : (
              <>
                <CardRow label="依赖" value={toolGroups.length || tools.length ? [...toolGroups, ...tools].join('、') : '未声明'} />
                <CardRow label="触发依据" value={keywords.length ? `描述里的「什么时候用」 + 旧词表（${keywords.length} 个）` : '描述里的「什么时候用」'} />
                {excludeKeywords.length > 0 && <CardRow label="排除词" value={excludeKeywords.join('、')} />}
                {explicitOnly && <CardRow label="触发方式" value="只接受显式引用" />}
                <CardRow
                  label="状态"
                  value={card?.present ? '已写入 SKILL.json' : '暂无卡片（回退读正文 frontmatter / 侧车）'}
                />
                {doctor.map((issue) => (
                  <div key={`${issue.code}-${issue.message}`} className="flex items-start gap-4 px-4 py-2.5">
                    <span className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground">体检</span>
                    <span className={cn('min-w-0 flex-1 break-words text-xs', SEVERITY_CLASS[issue.severity])}>{issue.message}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </SettingsCard>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex flex-col">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </div>
  )
}

function CardRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-start gap-4 px-4 py-2.5">
      <span className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-sm text-foreground">{value}</span>
    </div>
  )
}
