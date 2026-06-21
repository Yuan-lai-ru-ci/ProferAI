/**
 * TeamWorkspaceSettings — 团队工作区设置页
 *
 * 管理成员、邀请、角色、同步配置、ownership 转让。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { UserPlus, Shield, Trash2, Crown, Loader2, Plus, FolderOpen, Key, Copy, Check, X, Mail } from 'lucide-react'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from '@/components/settings/primitives'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { teamWorkspacesAtom } from '@/atoms/team-atoms'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import type { WorkspaceRole } from '@proma/shared'

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
  React.useEffect(() => {
    window.electronAPI.auth.getServerInfo().then(setServers).catch(() => {})
  }, [])
  if (servers.length === 0) return null
  return (
    <SettingsRow label="已连接服务器" icon={<Shield size={14} />}>
      <div className="flex flex-col gap-0.5 text-xs">
        {servers.map((s) => (
          <div key={s.baseUrl} className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${s.isLoggedIn ? 'bg-green-500' : 'bg-gray-300'}`} />
            <span className="text-muted-foreground">{s.baseUrl}</span>
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

  // 邀请列表
  const [invitations, setInvitations] = React.useState<Array<{
    id: string; workspaceId: string; inviterId: string; inviterName: string
    inviteeEmail: string; role: string; token: string; status: string
    createdAt: number; expiresAt: number
  }>>([])
  const [invLoading, setInvLoading] = React.useState(false)

  // 使用统计
  const [stats, setStats] = React.useState<{ totalSize: number; fileCount: number; dirCount: number; memberCount: number; onlineCount: number; pendingInvites: number } | null>(null)
  React.useEffect(() => {
    if (!selectedWsId) { setStats(null); return }
    window.electronAPI.team.getStats(selectedWsId).then(setStats).catch(() => {})
  }, [selectedWsId])

  const selectedWs = teamWorkspaces.find((w) => w.id === selectedWsId)

  // 加载团队工作区列表（优先远程 API，失败时回退到本地索引）
  React.useEffect(() => {
    window.electronAPI.team.listWorkspaces().then((list) => {
      if (Array.isArray(list) && list.length > 0) {
        setTeamWorkspaces(list)
      } else {
        // 远程 API 返回空或失败 → 回退到本地 agent workspace 索引
        window.electronAPI.listAgentWorkspaces().then((all) => {
          const team = all.filter((w) => w.type === 'team')
          if (team.length > 0) setTeamWorkspaces(team)
        }).catch(() => {})
      }
    }).catch(() => {
      // HTTP 请求失败 → 回退本地索引
      window.electronAPI.listAgentWorkspaces().then((all) => {
        const team = all.filter((w) => w.type === 'team')
        if (team.length > 0) setTeamWorkspaces(team)
      }).catch(() => {})
    })
  }, [setTeamWorkspaces])

  // 加载成员列表
  React.useEffect(() => {
    if (!selectedWsId) return
    setLoading(true)
    window.electronAPI.team.getMembers(selectedWsId)
      .then((data) => setMembers(data as typeof members))
      .catch(() => toast.error('加载成员列表失败'))
      .finally(() => setLoading(false))
  }, [selectedWsId])

  // 加载邀请列表
  React.useEffect(() => {
    if (!selectedWsId) return
    setInvLoading(true)
    window.electronAPI.team.listInvitations(selectedWsId)
      .then((data) => setInvitations(data as typeof invitations))
      .catch(() => { /* 忽略 */ })
      .finally(() => setInvLoading(false))
  }, [selectedWsId])

  /** 撤销邀请 */
  const handleCancelInvitation = async (invitationId: string): Promise<void> => {
    if (!selectedWsId) return
    try {
      await window.electronAPI.team.cancelInvitation({ workspaceId: selectedWsId, invitationId })
      setInvitations((prev) => prev.filter((i) => i.id !== invitationId))
      toast.success('已撤销邀请')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败')
    }
  }

  const handleInvite = async (): Promise<void> => {
    if (!inviteEmail || !selectedWsId) return
    try {
      await window.electronAPI.team.createInvitation({
        workspaceId: selectedWsId,
        email: inviteEmail,
        role: inviteRole,
      })
      toast.success(`已邀请 ${inviteEmail}`)
      setInviteEmail('')
      window.electronAPI.team.listInvitations(selectedWsId).then((data) => {
        setInvitations(data as typeof invitations)
      }).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '邀请失败')
    }
  }

  const handleGenerateCode = async (): Promise<void> => {
    if (!selectedWsId) return
    setGeneratingCode(true)
    try {
      const result = await window.electronAPI.team.createInvitation({
        workspaceId: selectedWsId,
        email: '',
        role: codeRole,
      }) as any
      setGeneratedCode(result.token)
      toast.success('邀请码已生成')
      window.electronAPI.team.listInvitations(selectedWsId).then((data) => {
        setInvitations(data as typeof invitations)
      }).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败')
    } finally {
      setGeneratingCode(false)
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
    if (!joinToken.trim()) return
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
      setJoiningViaToken(false)
    }
  }

  const handleRemoveMember = async (userId: string): Promise<void> => {
    if (!selectedWsId) return
    try {
      await window.electronAPI.team.removeMember({ workspaceId: selectedWsId, userId })
      setMembers((prev) => prev.filter((m) => m.userId !== userId))
      toast.success('已移除成员')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '移除失败')
    }
  }

  const handleTransferOwnership = async (targetUserId: string): Promise<void> => {
    if (!selectedWsId) return
    try {
      await window.electronAPI.team.transferOwnership({ workspaceId: selectedWsId, targetUserId })
      toast.success('ownership 已转让')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '转让失败')
    }
  }

  const handleLeave = async (): Promise<void> => {
    if (!selectedWsId) return
    if (selectedWs?.role === 'owner') {
      toast.error('拥有者不能直接退出，请先转让 ownership')
      return
    }
    try {
      await window.electronAPI.team.leaveWorkspace(selectedWsId)
      toast.success('已退出工作区')
      setSelectedWsId(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '退出失败')
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
    try {
      await window.electronAPI.team.deleteWorkspace(selectedWsId)
      toast.success(`已删除「${selectedWs.name}」`)
      setTeamWorkspaces((prev) => prev.filter((w) => w.id !== selectedWsId))
      setSelectedWsId(null)
      setDeleteConfirm('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
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
    setLoading(true)
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
      setLoading(false)
    }
  }

  if (teamWorkspaces.length === 0) {
    return (
      <SettingsSection title="团队工作区" description="暂无团队工作区。登录团队服务器后可在此管理。">
        <div className="text-center py-12 space-y-4">
          <p className="text-muted-foreground">尚未加入任何团队工作区</p>
          {creatingWs ? (
            <div className="flex items-center justify-center gap-2">
              <Input
                ref={createInputRef}
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing) confirmCreateWs(); if (e.key === 'Escape') setCreatingWs(false) }}
                placeholder="工作区名称"
                className="w-48"
                disabled={loading}
              />
              <Button size="sm" onClick={confirmCreateWs} disabled={loading}>
                {loading ? '创建中...' : '创建'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreatingWs(false)}>
                取消
              </Button>
            </div>
          ) : (
            <Button onClick={handleCreateWs}>
              <Plus size={14} className="mr-1" />
              创建团队工作区
            </Button>
          )}
        </div>
      </SettingsSection>
    )
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="团队工作区" description="管理团队成员、邀请和权限">
        <SettingsCard>
          <ServerInfo />
          <SettingsRow label="选择工作区">
            <div className="flex items-center gap-2">
              <select
                value={selectedWsId ?? ''}
                onChange={(e) => setSelectedWsId(e.target.value || null)}
                className="w-48 rounded-md border bg-background px-3 py-1.5 text-sm"
              >
                <option value="">请选择</option>
                {teamWorkspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} ({ws.role ? roleLabel(ws.role) : '未知'})
                  </option>
                ))}
              </select>
              {creatingWs ? (
                <div className="flex items-center gap-1">
                  <Input
                    ref={createInputRef}
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                    onCompositionStart={() => setIsComposing(true)}
                    onCompositionEnd={() => setIsComposing(false)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing) confirmCreateWs(); if (e.key === 'Escape') setCreatingWs(false) }}
                    placeholder="工作区名称"
                    className="w-32 h-7 text-xs"
                    disabled={loading}
                  />
                  <Button size="sm" onClick={confirmCreateWs} disabled={loading} className="h-7 text-xs">
                    {loading ? '...' : '确定'}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={handleCreateWs}>
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
          {(selectedWs.role === 'owner' || selectedWs.role === 'admin') && (
            <>
              <SettingsSection title="生成邀请码" description="生成一个邀请码，任何人凭此码即可注册并加入工作区">
                <SettingsCard>
                  <SettingsRow label="权限" icon={<Key size={14} />}>
                    <div className="flex items-center gap-2">
                      <select
                        value={codeRole}
                        onChange={(e) => setCodeRole(e.target.value)}
                        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="admin">管理员</option>
                        <option value="member">成员</option>
                        <option value="viewer">观察者</option>
                      </select>
                      <Button size="sm" onClick={handleGenerateCode} disabled={generatingCode}>
                        {generatingCode ? '生成中...' : '生成邀请码'}
                      </Button>
                    </div>
                  </SettingsRow>
                  {generatedCode && (
                    <SettingsRow label="邀请码" description="7 天内有效。将此码发送给需要加入的人">
                      <div className="flex items-center gap-1.5">
                        <code className="bg-muted px-3 py-1.5 rounded text-xs font-mono tracking-wider select-all">
                          {generatedCode}
                        </code>
                        <Button variant="ghost" size="sm" onClick={handleCopyCode} title="复制邀请码">
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
                    <div className="flex items-center gap-2">
                      <Input
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        onCompositionStart={() => setIsComposing(true)}
                        onCompositionEnd={() => setIsComposing(false)}
                        placeholder="member@team.com"
                        className="w-56"
                      />
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="admin">管理员</option>
                        <option value="member">成员</option>
                        <option value="viewer">观察者</option>
                      </select>
                      <Button size="sm" onClick={handleInvite} disabled={!inviteEmail}>
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
                    <p className="text-muted-foreground text-sm py-2">暂无邀请记录</p>
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
                          <div key={inv.id} className="flex items-center justify-between py-2.5 px-1">
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
                                >
                                  <Copy size={13} />
                                </Button>
                                <Button
                                  variant="ghost" size="sm"
                                  onClick={() => handleCancelInvitation(inv.id)}
                                  title="撤销邀请"
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

          {stats && (
            <SettingsSection title="使用统计">
              <SettingsCard>
                <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-sm">
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

          <SettingsSection title="通过邀请码加入">
            <SettingsCard>
              <SettingsRow label="邀请码" icon={<Key size={14} />}>
                <div className="flex items-center gap-2">
                  <Input
                    value={joinToken}
                    onChange={(e) => setJoinToken(e.target.value)}
                    placeholder="粘贴邀请 Token"
                    className="w-56 font-mono text-xs"
                  />
                  <Button size="sm" onClick={handleJoinViaToken} disabled={!joinToken.trim() || joiningViaToken}>
                    {joiningViaToken ? '加入中...' : '加入'}
                  </Button>
                </div>
              </SettingsRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title={`成员 (${members.length})`}>
            <SettingsCard>
              {loading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={16} className="animate-spin" />
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {members.map((m) => (
                    <div key={m.userId} className="flex items-center justify-between py-2 px-1">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${m.isOnline ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} title={m.isOnline ? '在线' : '离线'} />
                        <span className="text-sm">{m.displayName}</span>
                        <Badge className={`text-[10px] ${roleColor(m.role)}`}>
                          {roleLabel(m.role)}
                        </Badge>
                      </div>
                      {selectedWs.role === 'owner' && m.role !== 'owner' && (
                        <div className="flex items-center gap-1">
                          {m.role === 'admin' && (
                            <Button variant="ghost" size="sm" onClick={() => handleTransferOwnership(m.userId)}>
                              <Crown size={14} className="text-amber-500" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => handleRemoveMember(m.userId)}>
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
                  <div className="flex items-center gap-2">
                    <Input
                      value={deleteConfirm}
                      onChange={(e) => setDeleteConfirm(e.target.value)}
                      placeholder={`输入「${selectedWs.name}」确认`}
                      className="w-40 h-7 text-xs"
                    />
                    <Button
                      variant="destructive" size="sm"
                      disabled={deleteConfirm !== selectedWs.name}
                      onClick={handleDeleteWorkspace}
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
                  <Button variant="destructive" size="sm" onClick={handleLeave}>
                    退出工作区
                  </Button>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>
          )}
        </>
      )}
    </div>
  )
}
