/**
 * LoginDialog — 团队登录/注册对话框
 */
import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { Globe, Mail, Lock, User, Ticket, LogIn, UserPlus, Server } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { authStatusAtom } from '@/atoms/identity-atoms'

interface LoginDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface LoginResult {
  success: boolean
  teamAccountId?: string
  teamEmail?: string
  joinedWorkspace?: string
  error?: string
}

export function LoginDialog({ open, onOpenChange }: LoginDialogProps): React.ReactElement {
  const [, setAuthStatus] = useAtom(authStatusAtom)
  const [mode, setMode] = React.useState<'login' | 'register'>('login')
  const [serverUrl, setServerUrl] = React.useState('http://47.109.108.57/proma')
  const [showServerUrl, setShowServerUrl] = React.useState(false)
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [invitationToken, setInvitationToken] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!email || !password) return
    if (mode === 'register' && !invitationToken.trim()) {
      toast.error('请输入邀请码')
      return
    }
    if (mode === 'register' && !displayName.trim()) return

    setLoading(true)
    try {
      const fn = mode === 'login' ? window.electronAPI.auth.login : window.electronAPI.auth.register
      const result = await fn({ serverUrl, email, password, displayName, invitationToken: invitationToken.trim() }) as unknown as LoginResult
      if (result.success) {
        setAuthStatus({
          isLoggedIn: true,
          teamAccountId: result.teamAccountId,
          teamEmail: result.teamEmail,
        })
        const msg = result.joinedWorkspace
          ? `注册成功，已加入「${result.joinedWorkspace}」`
          : mode === 'login' ? `已登录: ${result.teamEmail}` : `注册成功: ${result.teamEmail}`
        toast.success(msg)
        onOpenChange(false)
      } else {
        toast.error(result.error ?? (mode === 'login' ? '登录失败' : '注册失败'))
      }
    } catch (err) {
      toast.error(mode === 'login' ? '登录请求失败' : '注册请求失败')
    } finally {
      setLoading(false)
    }
  }

  const switchMode = (m: 'login' | 'register') => {
    setMode(m)
    setLoading(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] p-0 overflow-hidden">
        {/* 顶部装饰带 */}
        <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-background px-6 pt-6 pb-4">
          <DialogHeader className="text-left space-y-1">
            <DialogTitle className="text-xl">
              {mode === 'login' ? '登录' : '创建账户'}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              {mode === 'login'
                ? '登录团队服务器，访问协作工作区'
                : '使用邀请码注册，加入团队协作'}
            </DialogDescription>
          </DialogHeader>

          {/* 模式切换 */}
          <div className="flex gap-1 mt-3 p-0.5 bg-muted/60 rounded-lg">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm font-medium rounded-md transition-all ${
                mode === 'login' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <LogIn size={14} />登录
            </button>
            <button
              type="button"
              onClick={() => switchMode('register')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm font-medium rounded-md transition-all ${
                mode === 'register' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <UserPlus size={14} />注册
            </button>
          </div>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="px-6 pb-6 pt-3 space-y-3.5">
          {/* 邀请码（注册必填） */}
          {mode === 'register' && (
            <div className="space-y-1.5">
              <Label htmlFor="invite-token" className="text-xs font-medium flex items-center gap-1">
                <Ticket size={12} />邀请码 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="invite-token"
                value={invitationToken}
                onChange={(e) => setInvitationToken(e.target.value)}
                placeholder="粘贴管理员发送的邀请码"
                className="h-9 font-mono text-xs tracking-wide"
                required
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">需要有效的邀请码才能注册账户</p>
            </div>
          )}

          {/* 显示名称 */}
          {mode === 'register' && (
            <div className="space-y-1.5">
              <Label htmlFor="display-name" className="text-xs font-medium flex items-center gap-1">
                <User size={12} />显示名称
              </Label>
              <Input id="display-name" value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="你的名字" className="h-9" required />
            </div>
          )}

          {/* 邮箱 */}
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-xs font-medium flex items-center gap-1">
              <Mail size={12} />邮箱
            </Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@team.com" className="h-9" required />
          </div>

          {/* 密码 */}
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs font-medium flex items-center gap-1">
              <Lock size={12} />密码
            </Label>
            <Input id="password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••" className="h-9" required />
          </div>

          {/* 服务器地址（可折叠） */}
          <div>
            <button
              type="button"
              onClick={() => setShowServerUrl(!showServerUrl)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <Server size={11} />
              {showServerUrl ? '隐藏服务器设置' : '服务器设置'}
            </button>
            {showServerUrl && (
              <div className="mt-1.5">
                <Input id="server-url" value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://team.example.com" className="h-8 text-xs" />
              </div>
            )}
          </div>

          {/* 提交按钮 */}
          <Button type="submit" className="w-full h-10 mt-2" disabled={loading}>
            {loading
              ? (mode === 'login' ? '登录中...' : '注册中...')
              : mode === 'login' ? '登录' : '创建账户并加入'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
