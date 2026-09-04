/**
 * JoinWorkspaceDialog — 接受邀请加入团队工作区
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import type { WorkspaceRole } from '@profer/shared'

interface JoinWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token?: string
}

export function JoinWorkspaceDialog({ open, onOpenChange, token }: JoinWorkspaceDialogProps): React.ReactElement {
  const setWorkspaces = useAtomValue(agentWorkspacesAtom) as unknown as never
  const [, setWs] = React.useState(setWorkspaces)
  const [verifying, setVerifying] = React.useState(false)
  const [inviteInfo, setInviteInfo] = React.useState<{
    workspaceName: string
    inviterName: string
    role: string
  } | null>(null)
  const [joining, setJoining] = React.useState(false)

  // 验证邀请 token
  React.useEffect(() => {
    if (!token || !open) return
    setVerifying(true)
    window.electronAPI.team.verifyInvitation(token)
      .then((info) => setInviteInfo(info as typeof inviteInfo))
      .catch(() => toast.error('邀请链接无效或已过期'))
      .finally(() => setVerifying(false))
  }, [token, open])

  const handleJoin = async (): Promise<void> => {
    if (!token) return
    setJoining(true)
    try {
      const ws = await window.electronAPI.team.acceptInvitation(token)
      toast.success(`已加入「${ws.name}」`)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加入失败')
    } finally {
      setJoining(false)
    }
  }

  const handleDecline = async (): Promise<void> => {
    if (!token) return
    try {
      await window.electronAPI.team.declineInvitation(token)
    } catch { /* ignore */ }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>加入团队工作区</DialogTitle>
          <DialogDescription>
            {verifying
              ? '正在验证邀请...'
              : inviteInfo
                ? `你被 ${inviteInfo.inviterName} 邀请加入`
                : '无法加载邀请信息'}
          </DialogDescription>
        </DialogHeader>

        {verifying && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        )}

        {inviteInfo && (
          <div className="space-y-4 pt-4">
            <div className="rounded-lg border p-4 space-y-2">
              <p className="font-medium text-lg">{inviteInfo.workspaceName}</p>
              <p className="text-sm text-muted-foreground">
                角色: {inviteInfo.role === 'admin' ? '管理员' : inviteInfo.role === 'member' ? '成员' : '观察者'}
              </p>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={handleDecline}>
                拒绝
              </Button>
              <Button className="flex-1" onClick={handleJoin} disabled={joining}>
                {joining ? '加入中...' : '加入工作区'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
