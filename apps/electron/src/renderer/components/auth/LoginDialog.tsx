/**
 * LoginDialog — 登录/注册对话框
 * 支持个人注册（激活码）和团队注册（邀请码）
 */
import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { Mail, Lock, User, Ticket, LogIn, UserPlus, Monitor, Send, CheckCircle2 } from 'lucide-react'
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
  membershipTier?: string
  error?: string
  channelRestore?: { restored: number; warning?: string }
  deviceLimit?: {
    maxDevices: number
    devices: Array<{ id: string; deviceName: string; platform?: string | null; lastUsedAt: number }>
  }
}


export function LoginDialog({ open, onOpenChange }: LoginDialogProps): React.ReactElement {
  const [, setAuthStatus] = useAtom(authStatusAtom)
  const [mode, setMode] = React.useState<'login' | 'register'>('login')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [inviteCode, setInviteCode] = React.useState('')
  const [openRegistration, setOpenRegistration] = React.useState(false)
  const [otpToken, setOtpToken] = React.useState('')
  const [otpCode, setOtpCode] = React.useState('')
  const [otpVerified, setOtpVerified] = React.useState(false)
  const [otpBusy, setOtpBusy] = React.useState(false)
  const [resendRemaining, setResendRemaining] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [deviceLimit, setDeviceLimit] = React.useState<NonNullable<LoginResult['deviceLimit']> | null>(null)
  const [revoking, setRevoking] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (mode !== 'register') return
    void window.electronAPI.auth.getRegistrationOptions().then((options) => setOpenRegistration(options.openRegistration)).catch(() => setOpenRegistration(false))
  }, [mode])

  React.useEffect(() => {
    if (resendRemaining <= 0) return
    const timer = window.setInterval(() => setResendRemaining((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [resendRemaining])

  const resetOtp = (): void => {
    setOtpToken('')
    setOtpCode('')
    setOtpVerified(false)
    setResendRemaining(0)
  }

  const handleSendOtp = async (): Promise<void> => {
    if (!email.trim()) { toast.error('请先输入邮箱'); return }
    setOtpBusy(true)
    try {
      const result = await window.electronAPI.auth.sendRegistrationOtp(email.trim())
      if (!result.success || !result.otpToken) { toast.error(result.error ?? '验证码发送失败'); return }
      setOtpToken(result.otpToken)
      setOtpCode('')
      setOtpVerified(false)
      setResendRemaining(result.resendAfterSec ?? 60)
      toast.success('验证码已发送，请检查邮箱')
    } finally { setOtpBusy(false) }
  }

  const handleVerifyOtp = async (code: string): Promise<void> => {
    if (!otpToken || code.length !== 6) return
    setOtpBusy(true)
    try {
      const result = await window.electronAPI.auth.verifyRegistrationOtp(email.trim(), otpToken, code)
      if (result.success) { setOtpVerified(true); toast.success('邮箱验证成功') }
      else { setOtpVerified(false); toast.error(result.error ?? '验证码错误') }
    } finally { setOtpBusy(false) }
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!email || !password) return
    if (mode === 'register' && !displayName.trim()) return
    if (mode === 'register' && !inviteCode.trim() && (!openRegistration || !otpVerified)) {
      toast.error(openRegistration ? '请填写邀请码或完成邮箱验证' : '请输入邀请码')
      return
    }

    setLoading(true)
    try {
      const params = { email, password, displayName, inviteCode: inviteCode.trim() || undefined, otpToken: otpToken || undefined, emailOtp: otpCode || undefined }

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
        const restoreWarn = result.channelRestore?.warning
        if (mode === 'login' && restoreWarn) {
          toast.warning(`渠道恢复提示: ${restoreWarn}`)
        }
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
      const result = await window.electronAPI.auth.login({ email, password, revokeSlotId: slotId }) as unknown as LoginResult
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
    resetOtp()
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

          {/* 邮箱 */}
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-xs font-medium flex items-center gap-1">
              <Mail size={12} />邮箱
            </Label>
            <div className="flex gap-2">
              <Input id="email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); if (otpToken) resetOtp() }}
                placeholder="you@example.com" className="h-9" required disabled={mode === 'register' && !!otpToken} />
              {mode === 'register' && openRegistration && (
                otpToken ? <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={resetOtp}>修改邮箱</Button>
                  : <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={handleSendOtp} disabled={otpBusy}><Send size={14} className="mr-1" />发送验证码</Button>
              )}
            </div>
          </div>

          {mode === 'register' && openRegistration && otpToken && (
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="email-otp" className="text-xs font-medium">邮箱验证码</Label>
                {otpVerified && <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={13} />已验证</span>}
              </div>
              <Input id="email-otp" value={otpCode} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                onChange={(e) => { const code = e.target.value.replace(/\D/g, '').slice(0, 6); setOtpCode(code); setOtpVerified(false); if (code.length === 6) void handleVerifyOtp(code) }}
                placeholder="输入或粘贴 6 位验证码" className="h-9 font-mono tracking-[0.35em] text-center" disabled={otpBusy || otpVerified} />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>已发送至 {email.replace(/^(.{2}).*(@.*)$/, '$1***$2')}</span>
                {resendRemaining > 0 ? <span>{resendRemaining}s 后可重发</span> : <button type="button" className="text-primary hover:underline" onClick={() => void handleSendOtp()} disabled={otpBusy}>重新发送</button>}
              </div>
              <p className="text-[11px] text-muted-foreground">没收到邮件？请检查垃圾箱，或确认邮箱地址后重新发送。</p>
            </div>
          )}

          {mode === 'register' && (
            <div className="space-y-1.5">
              <Label htmlFor="invite-code" className="text-xs font-medium flex items-center gap-1">
                <Ticket size={12} />邀请码 {!openRegistration && <span className="text-destructive">*</span>} {openRegistration && <span className="text-muted-foreground">（可选）</span>}
              </Label>
              <Input id="invite-code" value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder={openRegistration ? '有邀请码可填写，或完成邮箱验证' : '输入邀请码（如 UA1B2C3）'}
                className="h-9 font-mono text-xs" required={!openRegistration} />
            </div>
          )}

          {/* 密码 */}
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs font-medium flex items-center gap-1">
              <Lock size={12} />密码
            </Label>
            <Input id="password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少8位，含大小写字母和数字" className="h-9" required />
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
