/** 全局 Skill 列表：复用安装版“我的 Skills / Profer 内置”分组结构。 */
import * as React from 'react'
import { toast } from 'sonner'
import { Blocks, RefreshCw, Plus, ShieldCheck, Upload } from 'lucide-react'

type SkillSortMode = 'default' | 'alpha' | 'updated'
const SKILL_SORT_KEY = 'profer.agent-skills.sort.global'
function readSkillSortMode(): SkillSortMode { try { const value = window.localStorage.getItem(SKILL_SORT_KEY); return value === 'alpha' || value === 'updated' ? value : 'default' } catch { return 'default' } }
function sortListedSkills(skills: ListedSkill[], mode: SkillSortMode): ListedSkill[] { const indexed = skills.map((skill, index) => ({ skill, index })); return indexed.sort((a, b) => { if (mode === 'alpha') return a.skill.name.localeCompare(b.skill.name, undefined, { sensitivity: 'base' }) || a.skill.slug.localeCompare(b.skill.slug); if (mode === 'updated') return (Date.parse(('updatedAt' in a.skill ? a.skill.updatedAt : '') || '') < Date.parse(('updatedAt' in b.skill ? b.skill.updatedAt : '') || '') ? 1 : -1) || a.index - b.index; return a.index - b.index }).map(({ skill }) => skill) }
import type { GlobalSkillMeta, MasterSkillMeta } from '@profer/shared'
import { MasterSkillDetailSheet } from './MasterSkillDetailSheet'
import { CreateGlobalSkillDialog } from './CreateGlobalSkillDialog'

interface Props {
  globalMode?: boolean
  workspaceSlug?: string
  search?: string
  onChanged: () => void
}

type ListedSkill = MasterSkillMeta | GlobalSkillMeta

function isGlobalSkill(skill: ListedSkill): skill is GlobalSkillMeta {
  return 'skillId' in skill
}

function isBuiltinSkill(skill: ListedSkill): boolean {
  return isGlobalSkill(skill) && skill.type === 'builtin-meta'
}

export function MasterSkillsTab({ globalMode = false, workspaceSlug, search = '', onChanged }: Props): React.ReactElement {
  const [skills, setSkills] = React.useState<ListedSkill[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<ListedSkill | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [sortMode, setSortMode] = React.useState<SkillSortMode>(readSkillSortMode)

  const load = React.useCallback(() => {
    setLoading(true)
    void (globalMode ? window.electronAPI.globalSkill.list() : window.electronAPI.skillMaster.list())
      .then(setSkills)
      .catch((error) => { console.error('[Skills] 加载失败:', error); setSkills([]) })
      .finally(() => setLoading(false))
  }, [globalMode])

  React.useEffect(() => { load() }, [load])

  const importGlobalSkill = React.useCallback(async () => {
    setImporting(true)
    try {
      const result = await window.electronAPI.openFileDialog()
      const file = result.files.find((item) => item.filename.toLowerCase().endsWith('.md'))
      if (!file) return
      const content = new TextDecoder().decode(Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)))
      const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/m)?.[1] ?? ''
      const readField = (key: string): string => frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^['\"]|['\"]$/g, '') ?? ''
      const slug = file.filename.replace(/\.md$/i, '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-') || `imported-${Date.now()}`
      await window.electronAPI.globalSkill.createUser(slug, readField('name') || slug, readField('description'), content)
      toast.success(`已导入全局 Skill：${readField('name') || slug}`)
      load()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入全局 Skill 失败')
    } finally { setImporting(false) }
  }, [load, onChanged])

  if (loading) return <div className="py-20 text-center text-sm text-muted-foreground">加载中...</div>

  const query = search.trim().toLowerCase()
  const visibleSkills = query ? skills.filter((skill) => `${skill.name} ${skill.slug} ${skill.description ?? ''}`.toLowerCase().includes(query)) : skills
  const sortedSkills = sortListedSkills(visibleSkills, sortMode)
  const mySkills = sortedSkills.filter((skill) => !isBuiltinSkill(skill))
  const builtinSkills = sortedSkills.filter(isBuiltinSkill)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between px-1">
        <select value={sortMode} onChange={(event) => { const value = event.target.value as SkillSortMode; setSortMode(value); try { window.localStorage.setItem(SKILL_SORT_KEY, value) } catch {} }} className="h-8 rounded-lg border border-border/60 bg-content-area px-2 text-xs text-foreground/70 outline-none"><option value="default">默认排序</option><option value="alpha">按字母排序</option><option value="updated">按修改时间排序</option></select>
        <div className="flex items-center gap-2">
          {globalMode && <><button type="button" onClick={() => setCreateOpen(true)} className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"><Plus size={13} />新建全局 Skill</button><button type="button" onClick={() => void importGlobalSkill()} disabled={importing} className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 disabled:opacity-50"><Upload size={13} />{importing ? '导入中…' : '导入 Skill'}</button></>}
          <button type="button" onClick={load} className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/10"><RefreshCw size={12} />刷新</button>
        </div>
      </div>

      {mySkills.length > 0 && <SkillSection title={globalMode ? '全局 Skills' : '元 Skills'} skills={mySkills} onOpen={setSelected} />}
      {builtinSkills.length > 0 && <SkillSection title={globalMode ? '元 Skills' : 'Profer 内置'} skills={builtinSkills} onOpen={setSelected} />}
      {skills.length > 0 && visibleSkills.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">没有匹配的 Skill，试试更换搜索关键词。</div>}
      {skills.length === 0 && <div className="flex flex-col items-center gap-3 py-20 text-center"><Blocks size={32} className="text-foreground/30" /><div className="text-sm font-medium text-foreground/80">暂无{globalMode ? '全局 Skill' : 'Profer 内置'}</div><div className="max-w-sm text-[13px] text-foreground/50">{globalMode ? '全局 Skill 可跨工作区使用，创建后可在详情中管理生效范围。' : 'Profer 内置 Skill 会显示在这里。'}</div>{globalMode && <button type="button" onClick={() => setCreateOpen(true)} className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"><Plus size={13} />新建全局 Skill</button>}</div>}

      <MasterSkillDetailSheet skill={selected} workspaceSlug={workspaceSlug} globalMode={globalMode} onOpenChange={(open) => { if (!open) setSelected(null) }} onChanged={() => { load(); onChanged() }} />
      {globalMode && <CreateGlobalSkillDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => { load(); onChanged() }} />}
    </div>
  )
}

function SkillSection({ title, skills, onOpen }: { title: string; skills: ListedSkill[]; onOpen: (skill: ListedSkill) => void }): React.ReactElement {
  return <section className="flex flex-col gap-3"><div className="flex items-center gap-2 px-1"><span className="text-[13px] font-medium text-foreground/55">{title}</span><span className="text-[12px] tabular-nums text-foreground/35">{skills.length}</span></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{skills.map((skill) => <button key={isGlobalSkill(skill) ? skill.skillId : skill.slug} type="button" onClick={() => onOpen(skill)} className="group flex flex-col gap-3 rounded-xl border border-border/60 bg-content-area p-4 text-left transition-all hover:border-border hover:shadow-sm"><div className="flex items-start gap-3"><div className="rounded-xl bg-amber-500/12 p-2 text-amber-500 shadow-sm"><Blocks size={18} /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium text-foreground">{skill.name}</span>{skill.version && <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">v{skill.version}</span>}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{skill.slug}</div></div></div><p className="line-clamp-2 min-h-[40px] text-[13px] leading-6 text-muted-foreground">{skill.description ?? '暂无描述'}</p>{isBuiltinSkill(skill) && <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400"><ShieldCheck size={12} />Profer 内置</span></div>}</button>)}</div></section>
}
