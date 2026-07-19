import * as React from 'react'
import { Bot, MessageSquare, Plus, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { AgentSessionMeta, ConversationMeta } from '@profer/shared'

export type KnowledgeTarget = { kind: 'chat' | 'agent'; sessionId?: string; title?: string }

interface Props {
  open: boolean
  itemCount: number
  onOpenChange: (open: boolean) => void
  onSelect: (target: KnowledgeTarget) => void | Promise<void>
}

export function KnowledgeSessionTargetPicker({ open, itemCount, onOpenChange, onSelect }: Props): React.ReactElement {
  const [chats, setChats] = React.useState<ConversationMeta[]>([])
  const [agents, setAgents] = React.useState<AgentSessionMeta[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [query, setQuery] = React.useState('')
  React.useEffect(() => {
    if (!open) return
    setLoading(true); setQuery('')
    Promise.all([window.electronAPI.listConversations(), window.electronAPI.listAgentSessions()])
      .then(([nextChats, nextAgents]) => { setChats(nextChats); setAgents(nextAgents) })
      .finally(() => setLoading(false))
  }, [open])
  const select = async (target: KnowledgeTarget) => { setSaving(true); try { await onSelect(target); onOpenChange(false) } finally { setSaving(false) } }
  const normalizedQuery = query.trim().toLowerCase()
  const visibleChats = chats.filter((chat) => !normalizedQuery || chat.title.toLowerCase().includes(normalizedQuery))
  const visibleAgents = agents.filter((agent) => !normalizedQuery || agent.title.toLowerCase().includes(normalizedQuery))
  const item = (key: string, icon: React.ReactNode, title: string, detail: string, target: KnowledgeTarget) => <button key={key} type="button" disabled={saving} onClick={() => void select(target)} className="flex w-full items-center gap-3 border-b px-3 py-3 text-left last:border-0 hover:bg-accent disabled:opacity-50"><span className="flex size-8 shrink-0 items-center justify-center rounded bg-accent">{icon}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{title}</span><span className="block truncate text-xs text-muted-foreground">{detail}</span></span></button>
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>导入到会话</DialogTitle><DialogDescription>将 {itemCount} 份资料导入目标会话。Chat 会在输入区等待随下一次问题发送；Agent 会获得当前会话的受控读取授权。</DialogDescription></DialogHeader><div className="flex h-8 items-center gap-2 rounded border px-2"><Search className="size-3.5 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选已有会话" className="min-w-0 flex-1 bg-transparent text-xs outline-none"/></div><div className="max-h-[55vh] overflow-y-auto rounded border">{loading ? <p className="p-8 text-center text-sm text-muted-foreground">正在加载会话…</p> : <><div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">新建会话</div>{item('new-chat', <Plus className="size-4"/>, '新建 Chat', '资料将留在输入区，等待你提问后发送', { kind: 'chat' })}{item('new-agent', <Plus className="size-4"/>, '新建 Agent', '资料将成为该 Agent 的受控读取范围', { kind: 'agent' })}{visibleChats.length ? <div className="border-y bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">已有 Chat</div> : null}{visibleChats.map((chat) => item(`chat-${chat.id}`, <MessageSquare className="size-4"/>, chat.title || '未命名对话', '输入区待发送资料', { kind: 'chat', sessionId: chat.id, title: chat.title || '未命名对话' }))}{visibleAgents.length ? <div className="border-y bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">已有 Agent</div> : null}{visibleAgents.map((agent) => item(`agent-${agent.id}`, <Bot className="size-4"/>, agent.title || '未命名 Agent', agent.knowledgeReferences?.length ? `已有 ${agent.knowledgeReferences.length} 份资料授权` : '添加受控资料读取授权', { kind: 'agent', sessionId: agent.id, title: agent.title || '未命名 Agent' }))}</>}</div></DialogContent></Dialog>
}
