/**
 * DingTalkSettings - 钉钉集成设置页（多 Bot 版本）
 *
 * 支持多个钉钉 Bot 的配置管理、连接状态、创建引导。
 * 保存配置后自动启动 Stream 连接。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Loader2, ExternalLink, Power, PowerOff, Plus, Trash2, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsSecretInput } from './primitives/SettingsSecretInput'
import { dingtalkBotStatesAtom } from '@/atoms/dingtalk-atoms'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@profer/ui/primitives/alert-dialog'
import { cn } from '@/lib/utils'
import { IntegrationSettingsFeedback, useIntegrationAction } from './IntegrationSettingsFeedback'
import type { DingTalkBotConfig, DingTalkBotBridgeState, DingTalkBridgeStatus, DingTalkTestResult } from '@profer/shared'

/** 安全地用系统浏览器打开链接 */
function openLink(url: string): void {
  window.electronAPI.openExternal(url)
}

/** 可点击的外部链接组件 */
function Link({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-primary hover:underline cursor-pointer"
      onClick={() => openLink(href)}
    >
      {children}
      <ExternalLink className="size-3 flex-shrink-0" />
    </button>
  )
}

/** 状态指示器颜色映射 */
const STATUS_CONFIG: Record<DingTalkBridgeStatus, { color: string; label: string }> = {
  disconnected: { color: 'bg-gray-400', label: '未连接' },
  connecting: { color: 'bg-amber-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-500', label: '已连接' },
  error: { color: 'bg-red-500', label: '连接错误' },
}

// ===== 主组件 =====

export function DingTalkSettings(): React.ReactElement {
  const botStates = useAtomValue(dingtalkBotStatesAtom)
  const [bots, setBots] = React.useState<DingTalkBotConfig[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const { busy: adding, run: runAdd } = useIntegrationAction()

  const loadBots = React.useCallback(async () => {
    setLoadError('')
    try {
      const config = await window.electronAPI.getDingTalkMultiConfig()
      setBots(config.bots)
    } catch {
      try {
        const legacy = await window.electronAPI.getDingTalkConfig()
        if (legacy.clientId) {
          setBots([{ id: 'legacy', name: '钉钉助手', enabled: legacy.enabled, clientId: legacy.clientId, clientSecret: legacy.clientSecret }])
        } else {
          setBots([])
        }
      } catch {
        setLoadError('无法读取钉钉 Bot 配置，请重试。')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { loadBots() }, [loadBots])

  const handleAddBot = React.useCallback(() => runAdd(async () => {
    try {
      const saved = await window.electronAPI.saveDingTalkBotConfig({
        name: `钉钉助手 ${bots.length + 1}`,
        enabled: false,
        clientId: '',
        clientSecret: '',
      })
      setBots((prev) => [...prev, saved])
    } catch {
      toast.error('创建 Bot 失败')
    }
  }), [bots.length, runAdd])

  if (loading) {
    return <IntegrationSettingsFeedback loading message="正在加载钉钉 Bot 配置…" />
  }

  return (
    <div className="min-w-0 space-y-6">
      {loadError && <IntegrationSettingsFeedback message={loadError} onRetry={() => void loadBots()} />}
      {/* Bot 列表 */}
      <SettingsSection
        title="钉钉 Bot 列表"
        description="管理多个钉钉机器人，每个 Bot 可绑定不同的工作区和模型"
        action={
          <Button size="sm" variant="outline" onClick={handleAddBot} disabled={adding || Boolean(loadError)}>
            <Plus size={14} className="mr-1.5" />
            添加 Bot
          </Button>
        }
      >
        {loadError && bots.length === 0 ? null : bots.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有配置钉钉 Bot。点击「添加 Bot」开始。
            </div>
          </SettingsCard>
        ) : (
          <div className="space-y-3">
            {bots.map((bot) => (
              <BotConfigCard
                key={bot.id}
                bot={bot}
                state={botStates[bot.id]}
                onSaved={loadBots}
                onRemoved={loadBots}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 创建钉钉机器人引导 */}
      <SettingsSection
        title="创建钉钉机器人"
        description="按以下步骤在钉钉开放平台创建企业内部应用"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-5 text-sm">
            {/* 步骤 1 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                <span className="font-medium text-foreground">创建企业内部应用</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                前往{' '}
                <Link href="https://open-dev.dingtalk.com">钉钉开放平台</Link>
                ，点击「创建应用」，选择「企业内部开发」，填写应用信息。
              </p>
            </div>

            {/* 步骤 2 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                <span className="font-medium text-foreground">获取凭证</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入应用详情页，在「凭证与基础信息」中找到{' '}
                <span className="text-foreground font-medium">Client ID (AppKey)</span> 和{' '}
                <span className="text-foreground font-medium">Client Secret (AppSecret)</span>，
                复制到上方配置表单中。
              </p>
            </div>

            {/* 步骤 3 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                <span className="font-medium text-foreground">添加机器人能力并保存连接</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                在「应用能力」中启用机器人功能。
                然后回到 Profer，<span className="text-foreground font-medium">先点击「保存配置」</span>，
                确认状态变为「已连接」后，再去钉钉后台配置事件订阅（选择 Stream 模式）。
              </p>
            </div>

            {/* 步骤 4 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">4</span>
                <span className="font-medium text-foreground">配置权限并发布</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                在「权限管理」中申请所需权限（消息收发、群组管理等），
                然后发布应用版本，等待企业管理员审批通过。
              </p>
            </div>

            {/* 提示 */}
            <div className="pl-7 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              <span className="font-medium">重要：</span>配置事件订阅前，必须先在 Profer 中保存凭证并确认 Stream 连接成功，
              否则钉钉后台会提示「Stream 模式接入失败」。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

// ===== 单个 Bot 配置卡片 =====

interface BotConfigCardProps {
  bot: DingTalkBotConfig
  state: DingTalkBotBridgeState | undefined
  onSaved: () => void
  onRemoved: () => void
}

function BotConfigCard({ bot, state, onSaved, onRemoved }: BotConfigCardProps): React.ReactElement {
  const setBotStates = useSetAtom(dingtalkBotStatesAtom)
  const [name, setName] = React.useState(bot.name)
  const [clientId, setClientId] = React.useState(bot.clientId)
  const [clientSecret, setClientSecret] = React.useState('')
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<DingTalkTestResult | null>(null)
  const [expanded, setExpanded] = React.useState(!bot.clientId) // 新建的 Bot 默认展开
  const { busy, run } = useIntegrationAction()
  const [actionError, setActionError] = React.useState('')
  const [secretError, setSecretError] = React.useState('')
  const secretEdited = React.useRef(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const panelId = React.useId()
  const connectionGeneration = React.useRef(0)

  // 加载已有 secret（使用 bot-specific API）
  const loadSecret = React.useCallback(async () => {
    if (!bot.clientSecret) return
    setSecretError('')
    try {
      const secret = await window.electronAPI.getDecryptedDingTalkBotSecret(bot.id)
      if (!secretEdited.current) setClientSecret(secret)
    } catch {
      if (bot.id === 'legacy' && window.electronAPI.getDecryptedDingTalkSecret) {
        try {
          const legacySecret = await window.electronAPI.getDecryptedDingTalkSecret()
          if (!secretEdited.current) setClientSecret(legacySecret)
          return
        } catch { /* 继续显示具体错误 */ }
      }
      setSecretError('无法读取此 Bot 的 Secret。可重试或输入新的 Secret；留空将保留原凭据。')
    }
  }, [bot.id, bot.clientSecret])
  React.useEffect(() => { void loadSecret() }, [loadSecret])

  const statusConfig = state ? STATUS_CONFIG[state.status] : STATUS_CONFIG.disconnected
  const isConnected = state?.status === 'connected' || state?.status === 'connecting'
  React.useEffect(() => {
    if (state?.status !== 'connecting') return
    const timeout = window.setTimeout(() => setActionError('等待连接已超时，可停止后重试。当前配置已保留。'), 60_000)
    return () => window.clearTimeout(timeout)
  }, [state?.status])

  const handleSave = React.useCallback(() => run(async () => {
    if (!clientId.trim() || !name.trim()) return
    setActionError('')
    try {
      await window.electronAPI.saveDingTalkBotConfig({
        id: bot.id,
        name: name.trim(),
        enabled: true,
        clientId: clientId.trim(),
        clientSecret: clientSecret || '',
        defaultWorkspaceId: bot.defaultWorkspaceId,
        defaultChannelId: bot.defaultChannelId,
        defaultModelId: bot.defaultModelId,
      })
      toast.success(`Bot "${name}" 已保存`)
      onSaved()
    } catch {
      setActionError('保存配置失败，输入已保留。请重试保存。')
    }
  }), [bot, name, clientId, clientSecret, onSaved, run])

  const handleTest = React.useCallback(async () => {
    if (!clientId.trim() || !clientSecret.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testDingTalkConnection(clientId.trim(), clientSecret.trim())
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, message: `测试失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }, [clientId, clientSecret])

  const handleToggle = React.useCallback(() => run(async () => {
    setActionError('')
    const generation = ++connectionGeneration.current
    try {
      if (isConnected) {
        await window.electronAPI.stopDingTalkBot(bot.id)
        toast.success(`Bot "${bot.name}" 已停止`)
      } else {
        setBotStates((previous) => ({ ...previous, [bot.id]: { botId: bot.id, botName: bot.name, status: 'connecting' } }))
        void window.electronAPI.startDingTalkBot(bot.id).catch(() => {
          if (generation !== connectionGeneration.current) return
          setActionError('启动失败，当前配置已保留。请重试。')
          setBotStates((previous) => ({ ...previous, [bot.id]: { botId: bot.id, botName: bot.name, status: 'error', errorMessage: '启动失败' } }))
        })
        toast.success(`Bot "${bot.name}" 启动中...`)
      }
    } catch { setActionError('连接操作失败，当前配置已保留。可再次启动或停止。') }
  }), [bot.id, bot.name, isConnected, run, setBotStates])

  const handleRemove = React.useCallback(() => run(async () => {
    setActionError('')
    try {
      if (!await window.electronAPI.removeDingTalkBot(bot.id)) throw new Error('Bot 不存在或未删除')
      toast.success(`Bot "${bot.name}" 已删除`)
      setDeleteOpen(false)
      onRemoved()
    } catch {
      setActionError('删除失败，Bot 已保留。请重试。')
    }
  }), [bot.id, bot.name, onRemoved, run])

  return (
    <SettingsCard>
      {/* 头部：名称 + 状态 + 展开/折叠 */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={panelId}>
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.color}`} />
          <span className="min-w-0 truncate font-medium text-sm">{bot.name || '未命名 Bot'}</span>
          <span className="text-xs text-muted-foreground">{statusConfig.label}</span>
          <span className="text-xs text-muted-foreground">{expanded ? '▾' : '▸'}</span>
        </button>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Button size="sm" variant="outline" onClick={handleToggle} disabled={busy || testing}>
              <PowerOff size={14} className="mr-1" />
              停止
            </Button>
          ) : bot.clientId ? (
            <Button size="sm" variant="outline" onClick={handleToggle} disabled={busy || testing}>
              {state?.status === 'connecting' ? <Loader2 size={14} className="animate-spin mr-1" /> : <Power size={14} className="mr-1" />}
              启动
            </Button>
          ) : null}
        </div>
      </div>
      {actionError && <IntegrationSettingsFeedback message={actionError} />}

      {/* 展开的配置表单 */}
      {expanded && (
        <div id={panelId} className="pb-4 space-y-3" aria-busy={busy}>
          {secretError && <IntegrationSettingsFeedback message={secretError} onRetry={() => void loadSecret()} />}
          <SettingsInput
            label="Bot 名称"
            value={name}
            onChange={setName}
            placeholder="如：研发助手"
          />
          <SettingsInput
            label="Client ID (AppKey)"
            value={clientId}
            onChange={setClientId}
            placeholder="dingxxxxxxxx"
          />
          <SettingsSecretInput
            label="Client Secret (AppSecret)"
            value={clientSecret}
            onChange={(value) => { secretEdited.current = true; setClientSecret(value) }}
            placeholder="输入 Client Secret"
          />

          <div className="flex flex-wrap items-center gap-3 px-4">
            <Button size="sm" variant="outline" onClick={handleTest}
              disabled={busy || testing || !clientId.trim() || !clientSecret.trim()}>
              {testing && <Loader2 size={14} className="animate-spin" />}
              <span>{testing ? '测试中...' : '测试连接'}</span>
            </Button>
            <Button size="sm" onClick={handleSave} disabled={busy || testing || !clientId.trim() || !name.trim() || (!bot.clientSecret && !clientSecret.trim())}>
              {busy ? '处理中…' : '保存配置'}
            </Button>
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" disabled={busy || testing}>
                  <Trash2 size={14} className="mr-1" />
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除</AlertDialogTitle>
                  <AlertDialogDescription>
                    删除 Bot &quot;{bot.name}&quot; 将同时断开连接。此操作不可撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {actionError && <IntegrationSettingsFeedback message={actionError} />}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
                  <AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void handleRemove() }}>删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {testResult && (
            <div className={cn(
              'mx-4 p-3 rounded-lg flex items-start gap-2 text-sm',
              testResult.success ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'
            )}>
              {testResult.success
                ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                : <XCircle size={16} className="flex-shrink-0 mt-0.5" />
              }
              <span>{testResult.message}</span>
            </div>
          )}

          {state?.status === 'error' && state.errorMessage && (
            <div className="p-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm">
              {state.errorMessage}
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  )
}
