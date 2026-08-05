import React, { useState } from 'react'
import { Shield, ShieldAlert, Check, X, Send, FileText, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type PendingInteractions = {
  permissions: Array<Record<string, any>>
  askUsers: Array<Record<string, any>>
  exitPlans: Array<Record<string, any>>
}

export function InteractionPanels({ pending, onPermission, onAskUser, onExitPlan }: {
  pending: PendingInteractions
  onPermission: (requestId: string, behavior: 'allow' | 'deny', alwaysAllow?: boolean) => Promise<void>
  onAskUser: (requestId: string, answers: Record<string, string>) => Promise<void>
  onExitPlan: (requestId: string, action: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback', feedback?: string) => Promise<void>
}): React.ReactElement | null {
  const permission = pending.permissions[0]
  if (permission) return <PermissionPanel request={permission} count={pending.permissions.length} onRespond={onPermission} />
  const ask = pending.askUsers[0]
  if (ask) return <AskUserPanel request={ask} count={pending.askUsers.length} onRespond={onAskUser} />
  const plan = pending.exitPlans[0]
  if (plan) return <ExitPlanPanel request={plan} count={pending.exitPlans.length} onRespond={onExitPlan} />
  return null
}

function Panel({ children }: { children: React.ReactNode }): React.ReactElement { return <div className="mx-3 mb-3 overflow-hidden rounded-xl border border-border bg-card shadow-lg">{children}</div> }
function PermissionPanel({ request, count, onRespond }: { request: Record<string, any>; count: number; onRespond: (id: string, behavior: 'allow' | 'deny', always?: boolean) => Promise<void> }): React.ReactElement {
  const [busy, setBusy] = useState(false); const dangerous = request.dangerLevel === 'dangerous'; const Icon = dangerous ? ShieldAlert : Shield
  const answer = async (behavior: 'allow' | 'deny', always = false) => { setBusy(true); try { await onRespond(request.requestId, behavior, always) } finally { setBusy(false) } }
  return <Panel><div className="flex items-center gap-2 px-3 pt-3"><Icon className={`size-4 ${dangerous ? 'text-amber-500' : 'text-primary'}`} /><span className="flex-1 text-sm font-medium">{dangerous ? '危险操作需要确认' : '需要确认'}</span>{count > 1 && <span className="text-xs text-muted-foreground">+{count - 1}</span>}</div><div className="px-3 py-2"><p className="text-xs text-foreground">{request.sdkTitle || request.description || request.toolName}</p>{(request.command || request.sdkDescription) && <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted/60 p-2 text-[11px] whitespace-pre-wrap">{request.command || request.sdkDescription}</pre>}</div><div className="flex flex-wrap justify-end gap-1.5 px-3 pb-3"><Button variant="ghost" size="sm" disabled={busy} onClick={() => answer('deny')} className="text-destructive"><X className="mr-1 size-3"/>拒绝</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => answer('allow', true)}>会话内总是允许</Button><Button size="sm" disabled={busy} onClick={() => answer('allow')}><Check className="mr-1 size-3"/>允许</Button></div></Panel>
}
function AskUserPanel({ request, count, onRespond }: { request: Record<string, any>; count: number; onRespond: (id: string, answers: Record<string, string>) => Promise<void> }): React.ReactElement {
  const questions = Array.isArray(request.questions) ? request.questions : []; const [answers, setAnswers] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false)
  const submit = async () => { setBusy(true); try { await onRespond(request.requestId, answers) } finally { setBusy(false) } }
  return <Panel><div className="flex items-center gap-2 px-3 pt-3"><MessageSquare className="size-4 text-primary"/><span className="flex-1 text-sm font-medium">Profer Agent 需要你的输入</span>{count > 1 && <span className="text-xs text-muted-foreground">+{count - 1}</span>}</div><div className="space-y-3 px-3 py-3">{questions.map((q: any, qi: number) => <div key={qi}><p className="mb-2 text-xs font-medium">{q.question}</p><div className="space-y-1">{(q.options || []).map((o: any) => <button key={o.label} type="button" onClick={() => setAnswers(p => ({ ...p, [q.question || String(qi)]: o.label }))} className={`w-full rounded-lg px-3 py-2 text-left text-xs ${answers[q.question || String(qi)] === o.label ? 'bg-primary/10 text-foreground ring-1 ring-primary/30' : 'bg-muted/60 text-foreground/75'}`}>{o.label}</button>)}</div><input value={answers[q.question || String(qi)] || ''} onChange={e => setAnswers(p => ({ ...p, [q.question || String(qi)]: e.target.value }))} placeholder="或输入你的回答" className="mt-2 h-9 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary/50" /></div>)}</div><div className="flex justify-end px-3 pb-3"><Button size="sm" disabled={busy} onClick={submit}><Send className="mr-1 size-3"/>提交回答</Button></div></Panel>
}
function ExitPlanPanel({ request, count, onRespond }: { request: Record<string, any>; count: number; onRespond: (id: string, action: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback', feedback?: string) => Promise<void> }): React.ReactElement {
  const [busy, setBusy] = useState(false); const [feedback, setFeedback] = useState(''); const answer = async (a: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback') => { setBusy(true); try { await onRespond(request.requestId, a, feedback) } finally { setBusy(false) } }
  return <Panel><div className="flex items-center gap-2 px-3 pt-3"><FileText className="size-4 text-primary"/><span className="flex-1 text-sm font-medium">Agent 计划待审批</span>{count > 1 && <span className="text-xs text-muted-foreground">+{count - 1}</span>}</div><p className="px-3 py-2 text-xs text-muted-foreground">Agent 已完成计划，请选择如何继续</p><div className="grid grid-cols-2 gap-1.5 px-3 pb-2"><Button size="sm" disabled={busy} onClick={() => answer('approve_auto')}>完全自动执行</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => answer('approve_edit')}>自动审批</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => answer('deny')} className="text-destructive">拒绝计划</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => answer('feedback')}>提交反馈</Button></div><input value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="可选：输入修改意见" className="mx-3 mb-3 h-9 w-[calc(100%-1.5rem)] rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary/50" /></Panel>
}
