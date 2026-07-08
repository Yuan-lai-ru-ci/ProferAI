/**
 * LoginDialog — 登录/注册对话框
 * 支持个人注册（激活码）和团队注册（邀请码）
 */
import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { Globe, Mail, Lock, User, Ticket, LogIn, UserPlus, Server, Monitor } from 'lucide-react'
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
  accountType?: string
  error?: string
  deviceLimit?: {
    maxDevices: number
    devices: Array<{ id: string; deviceName: string; platform?: string | null; lastUsedAt: number }>
  }
}


export function LoginDialog({ open, onOpenChange }: LoginDialogProps): React.ReactElement {
  const [, setAuthStatus] = useAtom(authStatusAtom)
  const [mode, setMode] = React.useState<'login' | 'register'>('login')
  const [serverUrl, setServerUrl] = React.useState('')
  const [showServerUrl, setShowServerUrl] = React.useState(false)
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [invitationToken, setInvitationToken] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [deviceLimit, setDeviceLimit] = React.useState<NonNullable<LoginResult['deviceLimit']> | null>(null)
  const [revoking, setRevoking] = React.useState<string | null>(null)

  // 商业版预填服务器地址
  React.useEffect(() => {
    window.electronAPI.getBuildTarget().then((target) => {
      if (target === 'commercial') {
        setServerUrl('http://47.109.108.57/proma')
      }
    }).catch(() => {})
  }, [])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!email || !password) return
    if (mode === 'register' && !displayName.trim()) return
    if (mode === 'register' && !invitationToken.trim()) {
      toast.error('请输入邀请码或激活码')
      return
    }

    setLoading(true)
    try {
      const params: Record<string, string> = { serverUrl, email, password, displayName }
      // 同时发两种码，服务端根据实际类型走对应分支
      if (mode === 'register') {
        params.invitationToken = invitationToken.trim()
        params.activationCode = invitationToken.trim()
      }

      const fn = mode === 'login' ? window.electronAPI.auth.login : window.electronAPI.auth.register
      const result = await fn(params) as unknown as LoginResult
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
      } else if (result.deviceLimit) {
        setDeviceLimit(result.deviceLimit)
      } else {
        toast.error(result.error ?? (mode === 'login' ? '登录失败' : '注册失败'))
      }
    } catch (err) {
      toast.error(mode === 'login' ? '登录请求失败' : '注册请求失败')
    } finally {
      setLoading(false)
    }
  }

  const handleRevokeAndLogin = async (slotId: string): Promise<void> => {
    setRevoking(slotId)
    try {
      const result = await window.electronAPI.auth.login({ serverUrl, email, password, revokeSlotId: slotId }) as unknown as LoginResult
      if (result.success) {
        setAuthStatus({ isLoggedIn: true, teamAccountId: result.teamAccountId, teamEmail: result.teamEmail })
        toast.success(`已登录: ${result.teamEmail}`)
        setDeviceLimit(null)
        onOpenChange(false)
      } else if (result.deviceLimit) {
        setDeviceLimit(result.deviceLimit)
        toast.error(result.error ?? '仍超出设备上限')
      } else {
        toast.error(result.error ?? '登录失败')
      }
    } catch {
      toast.error('登录请求失败')
    } finally {
      setRevoking(null)
    }
  }

  const switchMode = (m: 'login' | 'register') => {
    setMode(m)
    setLoading(false)
    setDeviceLimit(null)
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
                ? '登录账户，使用服务端渠道和协作功能'
                : '创建账户，开始使用 Profer AI 助手'}
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
        {/* 设备上限：列出已登录设备，撤销一台后即可在本机登录 */}
        {deviceLimit ? (
          <div className="px-6 pb-6 pt-3 space-y-3">
            <div className="text-sm text-muted-foreground leading-relaxed">
              该账号已达设备上限（最多 {deviceLimit.maxDevices} 台）。登出其中一台后即可在本机登录：
            </div>
            <div className="space-y-2 max-h-[260px] overflow-y-auto">
              {deviceLimit.devices.map((d) => (
                <div key={d.id} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border">
                  <Monitor size={16} className="text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{d.deviceName}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {(d.platform || '未知平台')} · 最近活跃 {new Date(d.lastUsedAt).toLocaleString()}
                    </div>
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={revoking !== null}
                    onClick={() => handleRevokeAndLogin(d.id)}>
                    {revoking === d.id ? '登出中...' : '登出并登录'}
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" variant="ghost" className="w-full h-9" onClick={() => setDeviceLimit(null)}>
              返回
            </Button>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="px-6 pb-6 pt-3 space-y-3.5">
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

          {mode === 'register' && (
            <div className="space-y-1.5">
              <Label htmlFor="invite-token" className="text-xs font-medium flex items-center gap-1">
                <Ticket size={12} />邀请码 / 激活码 <span className="text-destructive">*</span>
              </Label>
              <Input id="invite-token" value={invitationToken}
                onChange={(e) => setInvitationToken(e.target.value)}
                placeholder="管理员发送的邀请码或激活码"
                className="h-9 font-mono text-xs" required />
            </div>
          )}

          {/* 邮箱 */}
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-xs font-medium flex items-center gap-1">
              <Mail size={12} />邮箱
            </Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" className="h-9" required />
          </div>

          {/* 密码 */}
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs font-medium flex items-center gap-1">
              <Lock size={12} />密码
            </Label>
            <Input id="password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少8位，含大小写字母和数字" className="h-9" required />
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
              : mode === 'login' ? '登录' : '创建账户'}
          </Button>
        </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
