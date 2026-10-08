/**
 * WeChatSettings - 微信集成设置页
 *
 * 基于微信 iLink Bot API，扫码登录 + 长轮询消息。
 * 用户流程：点击登录 → 显示二维码 → 扫码 → 自动连接。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { Loader2, Power, PowerOff, LogOut, QrCode, ExternalLink } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsRow } from './primitives/SettingsRow'
import { wechatBridgeStateAtom } from '@/atoms/wechat-atoms'
import type { WeChatBridgeStatus } from '@profer/shared'
import { IntegrationSettingsFeedback, useIntegrationAction } from './IntegrationSettingsFeedback'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@profer/ui/primitives/alert-dialog'

/** 安全地用系统浏览器打开链接 */
function openLink(url: string): void {
  window.electronAPI.openExternal(url)
}

/** 状态指示器配置 */
const STATUS_CONFIG: Record<WeChatBridgeStatus, { color: string; label: string }> = {
  disconnected: { color: 'bg-gray-400', label: '未连接' },
  waiting_scan: { color: 'bg-amber-400 animate-pulse', label: '等待扫码...' },
  scanned: { color: 'bg-blue-400 animate-pulse', label: '已扫码，确认中...' },
  connecting: { color: 'bg-amber-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-500', label: '已连接' },
  error: { color: 'bg-red-500', label: '连接错误' },
}

export function WeChatSettings(): React.ReactElement {
  const [bridgeState, setBridgeState] = useAtom(wechatBridgeStateAtom)
  const [hasCredentials, setHasCredentials] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [loadError, setLoadError] = React.useState('')
  const [actionError, setActionError] = React.useState('')
  const [logoutOpen, setLogoutOpen] = React.useState(false)
  const { busy, run } = useIntegrationAction()
  const loginGeneration = React.useRef(0)

  // 加载配置和状态
  const load = React.useCallback(async () => {
    setLoadError('')
    try {
      const [config, status] = await Promise.all([window.electronAPI.getWeChatConfig(), window.electronAPI.getWeChatStatus()])
      setHasCredentials(!!config.credentials)
      setBridgeState(status)
      setLoaded(true)
    } catch { setLoadError('无法读取微信配置和连接状态，请重试。') }
  }, [setBridgeState])
  React.useEffect(() => { void load() }, [load])

  // 订阅状态变化
  React.useEffect(() => {
    const unsubscribe = window.electronAPI.onWeChatStatusChanged((state) => {
      setBridgeState(state)
      // 登录成功后更新凭证状态
      if (state.status === 'connected') {
        setHasCredentials(true)
      } else if (state.status === 'disconnected') {
        // 可能是登出
        window.electronAPI.getWeChatConfig().then((config) => {
          setHasCredentials(!!config.credentials)
        }).catch(() => setLoadError('无法刷新微信凭证状态，请重试。'))
      }
    })
    return unsubscribe
  }, [setBridgeState])

  // 开始扫码登录
  const handleLogin = React.useCallback(() => run(async () => {
    setActionError('')
    const generation = ++loginGeneration.current
    setBridgeState({ status: 'waiting_scan' })
    // IPC 等到扫码/授权结束才返回；保留取消和刷新入口，不锁住整个等待流程。
    void window.electronAPI.startWeChatLogin().catch((error: unknown) => {
      if (generation !== loginGeneration.current) return
      const message = error instanceof Error ? error.message : String(error)
      setActionError(`登录失败: ${message}。可重新扫码。`)
      setBridgeState({ status: 'error', errorMessage: message })
    })
  }), [run, setBridgeState])

  // 启动 Bridge
  const handleStart = React.useCallback(() => run(async () => {
    setActionError('')
    try {
      await window.electronAPI.startWeChatBridge()
      toast.success('微信 Bridge 已启动')
    } catch (error) {
      setActionError(`启动失败: ${error instanceof Error ? error.message : String(error)}。凭证已保留，可重试。`)
    }
  }), [run])

  // 停止 Bridge
  const handleStop = React.useCallback(() => run(async () => {
    setActionError('')
    loginGeneration.current += 1
    try {
      await window.electronAPI.stopWeChatBridge()
      setBridgeState({ status: 'disconnected' })
      toast.info('微信 Bridge 已停止')
    } catch (error) {
      setActionError(`停止失败: ${error instanceof Error ? error.message : String(error)}。请重试。`)
    }
  }), [run, setBridgeState])

  // 登出
  const handleLogout = React.useCallback(() => run(async () => {
    setActionError('')
    try {
      await window.electronAPI.logoutWeChat()
      setHasCredentials(false)
      setBridgeState({ status: 'disconnected' })
      setLogoutOpen(false)
      toast.info('已退出微信登录')
    } catch (error) {
      setActionError(`登出失败: ${error instanceof Error ? error.message : String(error)}。凭证未清除，可重试。`)
    }
  }), [run, setBridgeState])

  const statusConfig = STATUS_CONFIG[bridgeState.status]
  const isConnected = bridgeState.status === 'connected'
  const isLoggingIn = bridgeState.status === 'waiting_scan' || bridgeState.status === 'scanned'
  const isConnecting = bridgeState.status === 'connecting'
  const showQRCode = isLoggingIn && bridgeState.qrCodeData

  if (!loaded) return <IntegrationSettingsFeedback loading={!loadError} message={loadError || '正在加载微信配置…'} onRetry={loadError ? () => void load() : undefined} />

  return (
    <div className="min-w-0 space-y-6">
      {loadError && <IntegrationSettingsFeedback message={loadError} onRetry={() => void load()} />}
      {actionError && <IntegrationSettingsFeedback message={actionError} />}
      {/* 连接状态 */}
      <SettingsSection
        title="微信集成"
        description="扫码登录微信，在微信中控制 Profer Agent"
      >
        <SettingsCard>
          <SettingsRow label="Bridge 状态">
            <div className="flex flex-wrap items-center gap-3" aria-busy={busy}>
              <div className="flex items-center gap-2" role="status">
                <span className={`w-2 h-2 rounded-full ${statusConfig.color}`} />
                <span className="text-sm text-muted-foreground">{statusConfig.label}</span>
              </div>
              {isConnected ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleStop} disabled={busy}>
                    <PowerOff size={14} className="mr-1.5" />
                    停止
                  </Button>
                </div>
              ) : hasCredentials && !isLoggingIn ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleStart}
                    disabled={busy || isConnecting || Boolean(loadError)}
                  >
                    {isConnecting ? (
                      <Loader2 size={14} className="animate-spin mr-1.5" />
                    ) : (
                      <Power size={14} className="mr-1.5" />
                    )}
                    启动
                  </Button>
                </div>
              ) : !isLoggingIn ? (
                <Button size="sm" onClick={handleLogin} disabled={busy || Boolean(loadError)}>
                  <QrCode size={14} className="mr-1.5" />
                  扫码登录
                </Button>
              ) : <Button size="sm" variant="outline" onClick={handleStop} disabled={busy}>取消扫码</Button>}
              {hasCredentials && <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
                <AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={busy}><LogOut size={14} />登出</Button></AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader><AlertDialogTitle>退出微信登录？</AlertDialogTitle><AlertDialogDescription>将断开连接并清除本机登录凭证，再次使用需要重新扫码。</AlertDialogDescription></AlertDialogHeader>
                  {actionError && <IntegrationSettingsFeedback message={actionError} />}
                  <AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void handleLogout() }}>确认登出</AlertDialogAction></AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>}
            </div>
          </SettingsRow>
        </SettingsCard>

        {/* 错误信息 */}
        {bridgeState.status === 'error' && bridgeState.errorMessage && (
          <div role="alert" className="mt-2 px-3 py-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm">
            {bridgeState.errorMessage}
          </div>
        )}

        {/* 连接成功提示 */}
        {isConnected && (
          <div className="mt-2 px-3 py-2.5 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
            微信已连接，消息将自动接收。
          </div>
        )}
      </SettingsSection>

      {/* QR 码显示区域 */}
      {(showQRCode || isLoggingIn) && (
        <SettingsSection
          title="扫码登录"
          description="使用微信扫描下方二维码"
        >
          <SettingsCard divided={false}>
            <div className="flex flex-col items-center py-8 px-4">
              {showQRCode ? <div className="bg-white rounded-xl p-4 shadow-sm">
                <img
                  src={bridgeState.qrCodeData}
                  alt="微信登录二维码"
                  className="h-auto w-52 max-w-full"
                />
              </div> : <IntegrationSettingsFeedback loading message="正在获取微信登录二维码…" />}
              <p role="status" className="mt-4 text-sm text-muted-foreground">
                {bridgeState.status === 'scanned' ? (
                  <span className="text-blue-500 font-medium">已扫码，请在手机上确认登录</span>
                ) : (
                  '打开微信，扫描二维码登录'
                )}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={handleLogin}
                disabled={busy}
              >
                刷新二维码
              </Button>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}
      {bridgeState.status === 'error' && <Button size="sm" variant="outline" onClick={handleLogin} disabled={busy}>重新扫码登录</Button>}

      {/* 使用说明 */}
      <SettingsSection
        title="使用说明"
        description="微信机器人的工作方式"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-5 text-sm">
            {/* 步骤 1 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                <span className="font-medium text-foreground">扫码登录</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                点击上方「扫码登录」，用微信扫描二维码。
                这会将你的微信账号作为 Bot 接入 Profer。
              </p>
            </div>

            {/* 步骤 2 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                <span className="font-medium text-foreground">自动连接</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                扫码成功后，Profer 会自动建立长连接。
                凭证会加密保存，下次启动 Profer 时自动重连。
              </p>
            </div>

            {/* 步骤 3 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                <span className="font-medium text-foreground">收发消息</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                连接成功后，通过微信发送消息即可与 Profer Agent 交互。
                支持文本、图片、文件等消息类型。
              </p>
            </div>

            {/* 提示 */}
            <div className="pl-7 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              微信集成基于{' '}
              <button
                type="button"
                className="inline-flex items-center gap-0.5 underline hover:no-underline cursor-pointer"
                onClick={() => openLink('https://ilinkai.weixin.qq.com')}
              >
                iLink Bot API
                <ExternalLink className="size-2.5" />
              </button>
              ，这是微信官方提供的 Bot 接口。
              会话凭证使用系统级加密存储。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
