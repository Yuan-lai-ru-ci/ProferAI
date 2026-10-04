import * as React from 'react'
import * as automationApi from '@/domains/automation/automation-api'
import { BellRing, Check, Eye, X } from 'lucide-react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import type { Recommendation } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { automationFormAtom, automationToDraft } from '@/atoms/automation-atoms'

export function AutomationRecommendations({ recommendations, onRefresh }: { recommendations: Recommendation[]; onRefresh: () => Promise<void> }): React.ReactElement | null {
  const setForm = useSetAtom(automationFormAtom)
  if (recommendations.length === 0) return null
  const respond = async (recommendation: Recommendation, status: 'accepted' | 'dismissed'): Promise<void> => {
    try {
      await automationApi.respondToRecommendation({ id: recommendation.id, status })
      if (status === 'dismissed') toast.success('已忽略这条建议')
      await onRefresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : '处理建议失败') }
  }
  const open = async (recommendation: Recommendation): Promise<void> => {
    if (recommendation.action.type === 'edit_automation' && recommendation.action.automationId) {
      const item = (await automationApi.listAutomations()).find((a) => a.id === recommendation.action.automationId)
      if (item) setForm({ open: true, draft: automationToDraft(item) })
    }
    await respond(recommendation, 'accepted')
  }
  return <section aria-labelledby="automation-recommendations" className="mb-6 rounded-xl border border-primary/20 bg-primary/5 p-4">
    <div className="mb-3 flex items-center gap-2"><BellRing className="size-4 text-primary" /><h2 id="automation-recommendations" className="text-sm font-semibold">建议</h2><span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{recommendations.length}</span></div>
    <div className="space-y-3">
      {recommendations.map((recommendation) => <article key={recommendation.id} className="rounded-lg border border-border/60 bg-background/70 p-3">
        <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-medium">{recommendation.title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{recommendation.reason}</p></div><span className="shrink-0 text-xs text-muted-foreground">{Math.round(recommendation.confidence * 100)}%</span></div>
        {recommendation.evidence.map((evidence) => <p key={`${recommendation.id}-${evidence.label}`} className="mt-2 text-xs text-muted-foreground"><strong>{evidence.label}：</strong>{evidence.detail}</p>)}
        <div className="mt-3 flex flex-wrap justify-end gap-2"><Button size="sm" variant="default" onClick={() => void open(recommendation)}><Eye className="mr-1 size-3.5" />检查任务</Button><Button size="sm" variant="ghost" onClick={() => void respond(recommendation, 'dismissed')}><X className="mr-1 size-3.5" />不再建议</Button></div>
      </article>)}
    </div>
  </section>
}
