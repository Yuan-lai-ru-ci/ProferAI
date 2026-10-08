/**
 * TeamWorkspaceSettings — 团队工作区设置页
 *
 * 管理成员、邀请、角色、同步配置、ownership 转让。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { UserPlus, Shield, Trash2, Crown, Loader2, Plus, Key, Copy, Check, X, Mail, RefreshCw } from 'lucide-react'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from '@/components/settings/primitives'
import { Input } from '@profer/ui/primitives/input'
import { Button } from '@profer/ui/primitives/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import { Badge } from '@profer/ui/primitives/badge'
import { teamWorkspacesAtom } from '@/atoms/team-atoms'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import type { WorkspaceRole } from '@profer/shared'

/** 角色名中文映射 */
function roleLabel(role: string): string {
  switch (role) {
    case 'owner': return '拥有者'
    case 'admin': return '管理员'
    case 'member': return '成员'
    case 'viewer': return '观察者'
    default: return role
  }
}

/** 角色颜色 */
function roleColor(role: string): string {
  switch (role) {
    case 'owner': return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
    case 'admin': return 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
    case 'member': return 'bg-muted text-muted-foreground'
    case 'viewer': return 'bg-muted/50 text-muted-foreground/70'
    default: return ''
  }
}

/** 已连接服务器信息条 */
function ServerInfo(): React.ReactElement | null {
  const [servers, setServers] = React.useState<Array<{ baseUrl: string; email: string; isLoggedIn: boolean }>>([])
  const [error, setError] = React.useState(false)
  React.useEffect(() => {
    window.electronAPI.auth.getServerInfo().then(setServers).catch(() => setError(true))
  }, [])
  if (servers.length === 0) return error ? <p role="status" className="text-xs text-muted-foreground">服务器信息暂不可用</p> : null
  return (
    <SettingsRow label="已连接服务器" icon={<Shield size={14} />}>
      <div className="flex flex-col gap-0.5 text-xs">
        {servers.map((s) => (
          <div key={s.baseUrl} className="flex flex-wrap items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${s.isLoggedIn ? 'bg-green-500' : 'bg-gray-300'}`} />
            <span className="min-w-0 break-all text-muted-foreground">{s.baseUrl}</span>
            <span>{s.isLoggedIn ? '已登录' : '未登录'}</span>
            {s.email && <span className="text-foreground/70">{s.email}</span>}
          </div>
        ))}
      </div>
    </SettingsRow>
  )
}

export function TeamWorkspaceSettings(): React.ReactElement {
  const [teamWorkspaces, setTeamWorkspaces] = useAtom(teamWorkspacesAtom)
  const setAgentWorkspaces = useAtom(agentWorkspacesAtom)[1]
  const [selectedWsId, setSelectedWsId] = React.useState<string | null>(null)
  const [members, setMembers] = React.useState<Array<{ userId: string; displayName: string; avatar: string; role: WorkspaceRole; joinedAt: number; isOnline?: boolean; lastSeenAt?: number }>>([])
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState<string>('member')
  const [joinToken, setJoinToken] = React.useState('')
  const [joiningViaToken, setJoiningViaToken] = React.useState(false)
  const [generatedCode, setGeneratedCode] = React.useState('')
  const [generatingCode, setGeneratingCode] = React.useState(false)
  const [codeCopied, setCodeCopied] = React.useState(false)
  const [codeRole, setCodeRole] = React.useState<string>('member')
  const [loading, setLoading] = React.useState(false)
  const [creatingWs, setCreatingWs] = React.useState(false)
  const [newWsName, setNewWsName] = React.useState('')
  const [isComposing, setIsComposing] = React.useState(false)
  const createInputRef = React.useRef<HTMLInputElement>(null)
  const selectionRef = React.useRef(selectedWsId)
  selectionRef.current = selectedWsId
  const requestGeneration = React.useRef(0)
  const [reloadGeneration, setReloadGeneration] = React.useState(0)
  const [listLoading, setListLoading] = React.useState(true)
  const [listError, setListError] = React.useState(false)
  const [detailErrors, setDetailErrors] = React.useState<string[]>([])
  const [operation, setOperation] = React.useState<string | null>(null)
  const operationRef = React.useRef(false)
  const [confirmation, setConfirmation] = React.useState<{ label: string; description: string; run: () => Promise<void> } | null>(null)

  // 邀请列表
  const [invitations, setInvitations] = React.useState<Array<{
    id: string; workspaceId: string; inviterId: string; inviterName: string
    inviteeEmail: string; role: string; token: string; status: string
    createdAt: number; expiresAt: number
  }>>([])
  const [invLoading, setInvLoading] = React.useState(false)

  // 使用统计
  const [stats, setStats] = React.useState<{ totalSize: number; fileCount: number; dirCount: number; memberCount: number; onlineCount: number; pendingInvites: number } | null>(null)

  const selectedWs = teamWorkspaces.find((w) => w.id === selectedWsId)

  const listRequest = React.useRef(0)
  const loadWorkspaces = React.useCallback(async () => {
    const request = ++listRequest.current
    setListLoading(true)
    setListError(false)
    try {
      const list = await window.electronAPI.team.listWorkspaces()
      if (request !== listRequest.current) return
      setTeamWorkspaces(list)
    } catch {
      if (request !== listRequest.current) return
      setListError(true)
      try {
        const all = await window.electronAPI.listAgentWorkspaces()
        if (request === listRequest.current) setTeamWorkspaces(all.filter((w) => w.type === 'team'))
      } catch { /* 保留本地快照，但明确标识加载失败。 */ }
    } finally {
      if (request === listRequest.current) setListLoading(false)
    }
  }, [setTeamWorkspaces])

  React.useEffect(() => {
    void loadWorkspaces()
    return () => { listRequest.current += 1 }
  }, [loadWorkspaces])

  // 每个选择绑定独立代次；旧工作区响应不能覆盖新选择或卸载后的页面。
  React.useEffect(() => {
    const generation = ++requestGeneration.current
    const current = () => generation === requestGeneration.current && selectionRef.current === selectedWsId
    setMembers([])
    setInvitations([])
    setStats(null)
    setGeneratedCode('')
    setGeneratingCode(false)
    setCodeCopied(false)
    setDeleteConfirm('')
    setInviteEmail('')
    setConfirmation(null)
    setDetailErrors([])
    if (!selectedWsId) { setLoading(false); setInvLoading(false); return }
    setLoading(true)
    setInvLoading(true)
    const failed = (label: string) => { if (current()) setDetailErrors((prev) => [...prev, label]) }
    window.electronAPI.team.getMembers(selectedWsId)
      .then((data) => { if (current()) setMembers(data as typeof members) })
      .catch(() => failed('成员'))
      .finally(() => { if (current()) setLoading(false) })
    window.electronAPI.team.listInvitations(selectedWsId)
      .then((data) => { if (current()) setInvitations(data as typeof invitations) })
      .catch(() => failed('邀请'))
      .finally(() => { if (current()) setInvLoading(false) })
    window.electronAPI.team.getStats(selectedWsId)
      .then((data) => { if (current()) { setStats(data); if (!data) failed('统计') } })
      .catch(() => failed('统计'))
    return () => { requestGeneration.current += 1 }
  }, [selectedWsId, reloadGeneration])

  const runOperation = async (label: string, run: () => Promise<void>): Promise<void> => {
    if (operationRef.current) return
    operationRef.current = true
    setOperation(label)
    try { await run(); setConfirmation(null) }
    catch { /* 操作函数已经给出错误提示，确认框保留以便重试。 */ }
    finally { operationRef.current = false; setOperation(null) }
  }

  /** 撤销邀请 */
  const handleCancelInvitation = async (invitationId: string): Promise<void> => {
    if (!selectedWsId) return
    const workspaceId = selectedWsId
    try {
      await window.electronAPI.team.cancelInvitation({ workspaceId: selectedWsId, invitationId })
      if (selectionRef.current !== workspaceId) return
      setInvitations((prev) => prev.filter((i) => i.id !== invitationId))
      toast.success('已撤销邀请')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败')
      throw err
    }
  }

  const handleInvite = async (): Promise<void> => {
    if (!inviteEmail || !selectedWsId) return
    const workspaceId = selectedWsId
    const generation = requestGeneration.current
    try {
      await window.electronAPI.team.createInvitation({
        workspaceId: selectedWsId,
        email: inviteEmail,
        role: inviteRole,
      })
      toast.success(`已邀请 ${inviteEmail}`)
      if (selectionRef.current !== workspaceId || generation !== requestGeneration.current) return
      setInviteEmail('')
      window.electronAPI.team.listInvitations(workspaceId).then((data) => {
        if (selectionRef.current !== workspaceId || generation !== requestGeneration.current) return
        setInvitations(data as typeof invitations)
      }).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '邀请失败')
    }
  }

  const handleGenerateCode = async (): Promise<void> => {
    if (!selectedWsId) return
    const workspaceId = selectedWsId
    const generation = requestGeneration.current
    setGeneratingCode(true)
    try {
      const result = await window.electronAPI.team.createInvitation({
        workspaceId: selectedWsId,
        email: '',
        role: codeRole,
      })
      if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string') throw new Error('邀请码响应格式无效')
      if (selectionRef.current !== workspaceId || generation !== requestGeneration.current) return
      setGeneratedCode(result.token)
      toast.success('邀请码已生成')
      window.electronAPI.team.listInvitations(workspaceId).then((data) => {
        if (selectionRef.current !== workspaceId || generation !== requestGeneration.current) return
        setInvitations(data as typeof invitations)
      }).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败')
    } finally {
      if (selectionRef.current === workspaceId) setGeneratingCode(false)
    }
  }

  const handleCopyCode = async (): Promise<void> => {
    if (!generatedCode) return
    try {
      await navigator.clipboard.writeText(generatedCode)
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 2000)
    } catch {
      toast.error('复制失败')
    }
  }

  const handleJoinViaToken = async (): Promise<void> => {
    if (!joinToken.trim() || joiningViaToken || operationRef.current) return
    operationRef.current = true
    setJoiningViaToken(true)
    try {
      await window.electronAPI.team.acceptInvitation(joinToken.trim())
      toast.success('已加入工作区')
      setJoinToken('')
      window.electronAPI.team.listWorkspaces().then((list) => {
        if (Array.isArray(list)) setTeamWorkspaces(list)
      }).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加入失败')
    } finally {
      operationRef.current = false
      setJoiningViaToken(false)
    }
  }

  const handleRemoveMember = async (userId: string): Promise<void> => {
    if (!selectedWsId) return
    const workspaceId = selectedWsId
    try {
      await window.electronAPI.team.removeMember({ workspaceId: selectedWsId, userId })
      if (selectionRef.current !== workspaceId) return
      setMembers((prev) => prev.filter((m) => m.userId !== userId))
      toast.success('已移除成员')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '移除失败')
      throw err
    }
  }

  const handleTransferOwnership = async (targetUserId: string): Promise<void> => {
    if (!selectedWsId) return
    const workspaceId = selectedWsId
    try {
      await window.electronAPI.team.transferOwnership({ workspaceId: selectedWsId, targetUserId })
      if (selectionRef.current !== workspaceId) return
      setTeamWorkspaces((prev) => prev.map((ws) => ws.id === workspaceId ? { ...ws, role: 'admin' } : ws))
      setReloadGeneration((value) => value + 1)
      toast.success('ownership 已转让')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '转让失败')
      throw err
    }
  }

  const handleLeave = async (): Promise<void> => {
    if (!selectedWsId) return
    if (selectedWs?.role === 'owner') {
      toast.error('拥有者不能直接退出，请先转让 ownership')
      return
    }
    const workspaceId = selectedWsId
    try {
      await window.electronAPI.team.leaveWorkspace(selectedWsId)
      toast.success('已退出工作区')
      setTeamWorkspaces((prev) => prev.filter((ws) => ws.id !== workspaceId))
      if (selectionRef.current === workspaceId) setSelectedWsId(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '退出失败')
      throw err
    }
  }

  /** 删除工作区 */
  const [deleteConfirm, setDeleteConfirm] = React.useState('')
  const handleDeleteWorkspace = async (): Promise<void> => {
    if (!selectedWsId || !selectedWs) return
    if (deleteConfirm !== selectedWs.name) {
      toast.error('请输入工作区名称确认删除')
      return
    }
    const workspaceId = selectedWsId
    try {
      await window.electronAPI.team.deleteWorkspace(selectedWsId)
      toast.success(`已删除「${selectedWs.name}」`)
      setTeamWorkspaces((prev) => prev.filter((w) => w.id !== workspaceId))
      if (selectionRef.current === workspaceId) { setSelectedWsId(null); setDeleteConfirm('') }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
      throw err
    }
  }

  const handleCreateWs = (): void => {
    setCreatingWs(true)
    setNewWsName('')
    setTimeout(() => createInputRef.current?.focus(), 50)
  }

  const confirmCreateWs = async (): Promise<void> => {
    const name = newWsName.trim()
    if (!name) { setCreatingWs(false); return }
    if (operationRef.current) return
    operationRef.current = true
    setOperation('创建')
    try {
      const ws = await window.electronAPI.team.createWorkspace(name)
      setTeamWorkspaces((prev) => [ws, ...prev])
      setSelectedWsId(ws.id)
      setCreatingWs(false)
      setNewWsName('')
      toast.success(`已创建「${ws.name}」`)
      window.electronAPI.listAgentWorkspaces().then((list) => {
        if (Array.isArray(list)) setAgentWorkspaces(list)
      }).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    } finally {
      operationRef.current = false
      setOperation(null)
    }
  }


  return (
    <div className="min-w-0 space-y-8">
      <SettingsSection title="团队工作区" description="管理已加入工作区的成员、邀请和权限" action={
        <Button size="sm" variant="outline" onClick={() => void loadWorkspaces()} disabled={listLoading || !!operation}>
          <RefreshCw size={14} className={listLoading ? 'animate-spin' : ''} />刷新工作区
        </Button>
      }>
        {listLoading && <p role="status" className="text-sm text-muted-foreground">正在加载团队工作区…</p>}
        {listError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive">
          <span>远程工作区加载失败，当前显示本地快照。</span>
          <Button size="sm" variant="outline" onClick={() => void loadWorkspaces()} disabled={listLoading}>重试工作区</Button>
        </div>}
        {!listLoading && !listError && teamWorkspaces.length === 0 && <p className="text-sm text-muted-foreground">尚未加入团队工作区</p>}
        <SettingsCard>
          <ServerInfo />
          <SettingsRow label="选择工作区">
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="选择团队工作区"
                disabled={!!operation}
                value={selectedWsId ?? ''}
                onChange={(e) => setSelectedWsId(e.target.value || null)}
                className="w-full min-w-0 sm:w-48 rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">请选择</option>
                {teamWorkspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} ({ws.role ? roleLabel(ws.role) : '未知'})
                  </option>
                ))}
              </select>
              {creatingWs ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="新团队工作区名称"
                    ref={createInputRef}
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                    onCompositionStart={() => setIsComposing(true)}
                    onCompositionEnd={() => setIsComposing(false)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing) confirmCreateWs(); if (e.key === 'Escape') setCreatingWs(false) }}
                    placeholder="工作区名称"
                    className="w-32 h-7 text-xs"
                    disabled={!!operation}
                  />
                  <Button size="sm" onClick={confirmCreateWs} disabled={!!operation}>
                    {operation === '创建' ? '创建中…' : '创建'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!!operation} onClick={() => setCreatingWs(false)}>取消</Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={handleCreateWs} disabled={!!operation || listLoading || listError}>
                  <Plus size={14} className="mr-1" />
                  新建
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {selectedWs && (
        <>
          {detailErrors.length > 0 && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-destructive pl-3 text-sm">
            <span className="text-destructive">{detailErrors.join('、')}加载失败，未将失败当作空数据。</span>
            <Button size="sm" variant="outline" onClick={() => setReloadGeneration((value) => value + 1)} disabled={loading || invLoading || !!operation}>重试工作区数据</Button>
          </div>}
          {(selectedWs.role === 'owner' || selectedWs.role === 'admin') && (
            <>
              <SettingsSection title="生成邀请码" description="生成一个邀请码，任何人凭此码即可注册并加入工作区">
                <SettingsCard>
                  <SettingsRow label="权限" icon={<Key size={14} />}>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label="邀请码角色"
                        value={codeRole}
                        onChange={(e) => setCodeRole(e.target.value)}
                        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="admin">管理员</option>
                        <option value="member">成员</option>
                        <option value="viewer">观察者</option>
                      </select>
                      <Button size="sm" onClick={() => void runOperation('生成邀请码', handleGenerateCode)} disabled={generatingCode || !!operation || listError}>
                        {generatingCode ? '生成中...' : '生成邀请码'}
                      </Button>
                    </div>
                  </SettingsRow>
                  {generatedCode && (
                    <SettingsRow label="邀请码" description="7 天内有效。将此码发送给需要加入的人">
                      <div className="min-w-0 flex flex-wrap items-center gap-1.5">
                        <code className="min-w-0 break-all bg-muted px-3 py-1.5 rounded text-xs font-mono select-all">
                          {generatedCode}
                        </code>
                        <Button variant="ghost" size="sm" onClick={handleCopyCode} title="复制邀请码" aria-label="复制邀请码">
                          {codeCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                        </Button>
                      </div>
                    </SettingsRow>
                  )}
                </SettingsCard>
              </SettingsSection>

              <SettingsSection title="邮箱邀请" description="定向邀请指定邮箱的用户">
                <SettingsCard>
                  <SettingsRow label="邮箱" icon={<UserPlus size={14} />}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="email"
                        aria-label="受邀成员邮箱"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        onCompositionStart={() => setIsComposing(true)}
                        onCompositionEnd={() => setIsComposing(false)}
                        placeholder="member@team.com"
                        className="w-full min-w-0 sm:w-56"
                      />
                      <select
                        aria-label="邮箱邀请角色"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="admin">管理员</option>
                        <option value="member">成员</option>
                        <option value="viewer">观察者</option>
                      </select>
                      <Button size="sm" onClick={() => void runOperation('邮箱邀请', handleInvite)} disabled={!inviteEmail.trim() || !!operation || listError}>
                        邀请
                      </Button>
                    </div>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection title={`邀请记录 (${invitations.length})`} description="已发出的邀请及其状态">
                <SettingsCard>
                  {invLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 size={16} className="animate-spin" />
                    </div>
                  ) : invitations.length === 0 ? (
                    <p className="text-muted-foreground text-sm py-2">{detailErrors.includes('邀请') ? '邀请记录暂不可用' : '暂无邀请记录'}</p>
                  ) : (
                    <div className="divide-y divide-border/60">
                      {invitations.map((inv) => {
                        const statusConfig: Record<string, { label: string; className: string }> = {
                          pending:   { label: '待接受', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
                          accepted:  { label: '已接受', className: 'bg-green-500/10 text-green-600 dark:text-green-400' },
                          declined:  { label: '已拒绝', className: 'bg-muted text-muted-foreground' },
                          cancelled: { label: '已撤销', className: 'bg-muted text-muted-foreground' },
                          expired:   { label: '已过期', className: 'bg-red-500/10 text-red-600 dark:text-red-400' },
                        }
                        const sc = statusConfig[inv.status] ?? { label: inv.status, className: '' }
                        const isPublic = !inv.inviteeEmail
                        return (
                          <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 px-1">
                            <div className="flex items-center gap-3 min-w-0">
                              <Badge className={`text-[10px] ${sc.className}`}>{sc.label}</Badge>
                              <div className="flex flex-col min-w-0">
                                <div className="flex items-center gap-1.5">
                                  {isPublic ? (
                                    <Key size={12} className="text-muted-foreground flex-shrink-0" />
                                  ) : (
                                    <Mail size={12} className="text-muted-foreground flex-shrink-0" />
                                  )}
                                  <span className="text-sm truncate">
                                    {isPublic ? '公开邀请码' : inv.inviteeEmail}
                                  </span>
                                </div>
                                <span className="text-[11px] text-muted-foreground">
                                  {roleLabel(inv.role)} · 由 {inv.inviterName} 邀请
                                  {inv.status === 'pending' && inv.expiresAt > Date.now()
                                    ? ` · ${Math.ceil((inv.expiresAt - Date.now()) / 86400000)} 天后过期`
                                    : ''}
                                </span>
                              </div>
                            </div>
                            {inv.status === 'pending' && (
                              <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                                <Button
                                  variant="ghost" size="sm"
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(inv.token)
                                      toast.success('已复制邀请码')
                                    } catch { toast.error('复制失败') }
                                  }}
                                  title="复制邀请码"
                                  aria-label="复制邀请记录邀请码"
                                >
                                  <Copy size={13} />
                                </Button>
                                <Button
                                  variant="ghost" size="sm"
                                  disabled={!!operation || listError}
                                  onClick={() => setConfirmation({ label: '撤销邀请', description: '该邀请码或邮箱邀请将不再允许新成员加入。', run: () => handleCancelInvitation(inv.id) })}
                                  title="撤销邀请"
                                  aria-label="撤销邀请"
                                >
                                  <X size={13} className="text-destructive/70" />
                                </Button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>
            </>
          )}

          {(selectedWs.role === 'owner' || selectedWs.role === 'admin') && (
            <SettingsSection title="通知设置" description="配置团队工作区的桌面通知">
              <SettingsCard>
                <NotificationSettingsRow />
              </SettingsCard>
            </SettingsSection>
          )}

          {stats && (
            <SettingsSection title="使用统计">
              <SettingsCard>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">文件</span><span className="font-medium">{stats.fileCount}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">文件夹</span><span className="font-medium">{stats.dirCount}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">存储</span><span className="font-medium">{stats.totalSize < 1048576 ? `${(stats.totalSize/1024).toFixed(0)} KB` : `${(stats.totalSize/1048576).toFixed(1)} MB`}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">成员</span><span className="font-medium">{stats.memberCount}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">在线</span><span className="font-medium text-green-600">{stats.onlineCount}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">待处理邀请</span><span className="font-medium">{stats.pendingInvites}</span></div>
                </div>
              </SettingsCard>
            </SettingsSection>
          )}

          <SettingsSection title={`成员 (${members.length})`}>
            <SettingsCard>
              {loading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={16} className="animate-spin" />
                </div>
              ) : (
                members.length === 0 ? <p className="text-sm text-muted-foreground py-2">{detailErrors.includes('成员') ? '成员列表暂不可用' : '暂无成员'}</p> :
                <div className="divide-y divide-border/60">
                  {members.map((m) => (
                    <div key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2 px-1">
                      <div className="min-w-0 flex flex-wrap items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${m.isOnline ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} title={m.isOnline ? '在线' : '离线'} />
                        <span className="min-w-0 break-words text-sm">{m.displayName}</span>
                        <Badge className={`text-[10px] ${roleColor(m.role)}`}>
                          {roleLabel(m.role)}
                        </Badge>
                      </div>
                      {selectedWs.role === 'owner' && m.role !== 'owner' && (
                        <div className="flex items-center gap-1">
                          {m.role === 'admin' && (
                            <Button variant="ghost" size="sm" title="转让拥有者" aria-label={`转让拥有者给${m.displayName}`} disabled={!!operation || listError} onClick={() => setConfirmation({ label: '转让拥有者', description: `将「${selectedWs.name}」的拥有者权限转让给「${m.displayName}」，你将成为管理员。`, run: () => handleTransferOwnership(m.userId) })}>
                              <Crown size={14} className="text-amber-500" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" title="移除成员" aria-label={`移除成员${m.displayName}`} disabled={!!operation || listError} onClick={() => setConfirmation({ label: '移除成员', description: `「${m.displayName}」将失去「${selectedWs.name}」的访问权限。`, run: () => handleRemoveMember(m.userId) })}>
                            <Trash2 size={14} className="text-destructive/70" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </SettingsCard>
          </SettingsSection>

          {selectedWs.role === 'owner' ? (
            <SettingsSection title="危险操作">
              <SettingsCard>
                <SettingsRow label="删除工作区" description="永久删除该工作区及其所有内容。此操作不可撤销。">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label="删除工作区名称确认"
                      value={deleteConfirm}
                      onChange={(e) => setDeleteConfirm(e.target.value)}
                      placeholder={`输入「${selectedWs.name}」确认`}
                      className="w-40 h-7 text-xs"
                    />
                    <Button
                      variant="destructive" size="sm"
                      disabled={deleteConfirm !== selectedWs.name || !!operation || listError}
                      onClick={() => setConfirmation({ label: '删除工作区', description: `将删除「${selectedWs.name}」及其全部内容。请确认已备份所需数据。`, run: handleDeleteWorkspace })}
                    >
                      删除
                    </Button>
                  </div>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>
          ) : (
            <SettingsSection title="危险操作">
              <SettingsCard>
                <SettingsRow label="退出工作区" description="将失去对该工作区所有内容的访问权限">
                  <Button variant="destructive" size="sm" disabled={!!operation || listError} onClick={() => setConfirmation({ label: '退出工作区', description: `你将失去「${selectedWs.name}」及其文件的访问权限。`, run: handleLeave })}>
                    退出工作区
                  </Button>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>
          )}
        </>
      )}
      <SettingsSection title="通过邀请码加入">
        <SettingsCard>
          <SettingsRow label="邀请码" icon={<Key size={14} />}>
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="团队工作区邀请码" value={joinToken}
                onChange={(e) => setJoinToken(e.target.value)} placeholder="粘贴邀请 Token"
                className="w-full min-w-0 sm:w-56 font-mono text-xs" />
              <Button size="sm" onClick={handleJoinViaToken} disabled={!joinToken.trim() || joiningViaToken || !!operation}>
                {joiningViaToken ? '加入中…' : '加入'}
              </Button>
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !operationRef.current) setConfirmation(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.label}？</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!operation}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!!operation} onClick={(event) => { event.preventDefault(); if (confirmation) void runOperation(confirmation.label, confirmation.run) }}>
              {operation ? '处理中…' : '确认执行'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 通知设置行（内嵌组件） */
function NotificationSettingsRow(): React.ReactElement {
  const [settings, setSettings] = React.useState<{
    enabled: boolean; fileUpload: boolean; fileDelete: boolean; memberJoin: boolean; memberLeave: boolean; invitation: boolean; planningReminder?: boolean
  } | null>(null)
  const [error, setError] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)

  const load = React.useCallback(async () => {
    setError(false)
    try {
      const result = await window.electronAPI.team.getNotificationSettings()
      setSettings(result)
    } catch { setError(true) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  const toggle = async (key: keyof NonNullable<typeof settings>, value: boolean): Promise<void> => {
    if (!settings || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      await window.electronAPI.team.updateNotificationSettings({ [key]: value })
      setSettings({ ...settings, [key]: value })
    } catch { toast.error('通知设置保存失败，保留原设置') }
    finally { savingRef.current = false; setSaving(false) }
  }

  if (error) {
    return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive">
      <span>通知设置加载失败</span>
      <Button variant="outline" size="sm" onClick={() => void load()}>重试通知配置</Button>
    </div>
  }
  if (!settings) return <p role="status" className="text-sm text-muted-foreground">正在加载通知配置…</p>

  const items: Array<{ key: keyof NonNullable<typeof settings>; label: string }> = [
    { key: 'fileUpload', label: '新文件上传' },
    { key: 'fileDelete', label: '文件删除' },
    { key: 'planningReminder', label: '团队事项到期' },
    { key: 'memberJoin', label: '新成员加入' },
    { key: 'memberLeave', label: '成员离开' },
    { key: 'invitation', label: '邀请' },
  ]

  return (
    <div aria-busy={saving}>
      <SettingsToggle label="启用桌面通知" checked={settings.enabled} disabled={saving} onCheckedChange={(value) => void toggle('enabled', value)} />
      {items.map(({ key, label }) => (
        <SettingsToggle key={key} label={label} checked={settings[key] ?? true} disabled={saving || !settings.enabled} onCheckedChange={(value) => void toggle(key, value)} />
      ))}
    </div>
  )
}
