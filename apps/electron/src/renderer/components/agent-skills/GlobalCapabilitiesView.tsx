import * as React from 'react'
import { Blocks, BriefcaseBusiness, Globe2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MasterSkillsTab } from './MasterSkillsTab'
import { AgentPresetSettings } from './AgentPresetSettings'

type GlobalCapabilityTab = 'skills' | 'presets'

/** 全局容器只负责领域切换；Skill/预设各自保留既有页面和详情交互。 */
export function GlobalCapabilitiesView({ initialTab = 'skills', workspaceSlug }: { initialTab?: GlobalCapabilityTab; workspaceSlug?: string }): React.ReactElement {
  const [tab, setTab] = React.useState<GlobalCapabilityTab>(initialTab)
  React.useEffect(() => { setTab(initialTab) }, [initialTab])
  const [search, setSearch] = React.useState('')
  return <section aria-label="全局配置" className="flex flex-col gap-5">
    <header className="rounded-2xl bg-gradient-to-br from-primary/12 via-primary/[0.05] to-transparent p-5 shadow-sm ring-1 ring-primary/10">
      <div className="flex items-start gap-3"><div className="rounded-xl bg-primary/15 p-2.5 text-primary"><Globe2 size={22} /></div><div><h2 className="text-base font-semibold">全局能力</h2><p className="mt-1 text-[13px] leading-6 text-muted-foreground">复用现有 Skill 与预设管理界面；工作区生效范围仅在详情页管理。</p></div></div>
    </header>
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-3 focus-within:border-primary/40"><Search size={14} className="text-foreground/40" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'skills' ? '搜索全局 Skills…' : '搜索全局预设…'} className="w-full bg-transparent text-[13px] outline-none" /></div>
      <div className="flex rounded-xl bg-muted p-0.5 self-start" role="tablist" aria-label="全局能力领域">
      <DomainTab active={tab === 'skills'} icon={<Blocks size={14} />} label="全局 Skill" onClick={() => setTab('skills')} />
      <DomainTab active={tab === 'presets'} icon={<BriefcaseBusiness size={14} />} label="全局预设" onClick={() => setTab('presets')} />
      </div>
    </div>
    {tab === 'skills' ? <MasterSkillsTab globalMode workspaceSlug={workspaceSlug} search={search} onChanged={() => undefined} /> : <AgentPresetSettings globalMode workspaceSlug={workspaceSlug} search={search} />}
  </section>
}

function DomainTab({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }): React.ReactElement {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cn('flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium', active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{icon}{label}</button>
}
