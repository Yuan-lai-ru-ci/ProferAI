/**
 * AboutSettings - 关于页面
 *
 * 显示应用版本号等基本信息，以及版本检测状态。
 * 检测到新版本后引导用户去 GitHub Releases 手动下载。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, Info, Terminal, ChevronDown, ChevronUp, ExternalLink, RotateCw, Send, MessageSquareText } from 'lucide-react'
import { toast } from 'sonner'
import type { EnvironmentCheckResult, RuntimeStatus } from '@profer/shared'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './primitives'
import { Button } from '@profer/ui/primitives/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'
import { Textarea } from '@profer/ui/primitives/textarea'
import { Input } from '@profer/ui/primitives/input'
import { Label } from '@profer/ui/primitives/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@profer/ui/primitives/select'
import { Alert, AlertDescription } from '@profer/ui/primitives/alert'
import { updateStatusAtom, updaterAvailableAtom, checkForUpdates } from '@/atoms/updater'
import {
  environmentCheckResultAtom,
  hasEnvironmentIssuesAtom,
} from '@/atoms/environment'
import { EnvironmentCheckCard } from '@/components/environment/EnvironmentCheckCard'
import { Badge } from '@profer/ui/primitives/badge'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VersionHistory } from './VersionHistory'
import { developerModeEnabledAtom, openEpistemicModeEnabledAtom } from '@/atoms/developer-mode'
import {
  INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE,
  advanceDeveloperModeUnlockClick,
} from '@/lib/plugin-unlock'

/** 从 package.json 构建时由 Vite define 注入 */
declare const __APP_VERSION__: string
const APP_VERSION = __APP_VERSION__

const GITHUB_RELEASES_URL = 'https://github.com/Yuan-lai-ru-ci/ProferAI/releases'

/** 更新状态卡片 */
function UpdateCard(): React.ReactElement | null {
  const available = useAtomValue(updaterAvailableAtom)
  const status = useAtomValue(updateStatusAtom)
  const [checking, setChecking] = React.useState(false)
  const [showReleaseNotes, setShowReleaseNotes] = React.useState(false)
  const [latestNotes, setLatestNotes] = React.useState<string | null>(null)
  const [checkError, setCheckError] = React.useState<string | null>(null)
  const checkingRef = React.useRef(false)
  const [restartOpen, setRestartOpen] = React.useState(false)
  const [restarting, setRestarting] = React.useState(false)
  const restartRef = React.useRef(false)

  const handleCheck = async (): Promise<void> => {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    setCheckError(null)
    try {
      await checkForUpdates()
    } catch (cause) {
      setCheckError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }

  const handleQuitAndInstall = async (): Promise<void> => {
    if (restartRef.current) return
    restartRef.current = true
    setRestarting(true)
    setCheckError(null)
    try {
      if (!window.electronAPI.updater) throw new Error('当前构建不支持应用内安装')
      await window.electronAPI.updater.quitAndInstall()
      setRestartOpen(false)
    } catch (cause) { setCheckError(cause instanceof Error ? cause.message : String(cause)) }
    finally { restartRef.current = false; setRestarting(false) }
  }

  const handleOpenManualUpdate = (): void => {
    const url = status.manualUrl
    if (!url) return
    void window.electronAPI.openExternal(url).catch((error: unknown) => {
      toast.error('无法打开下载页', { description: error instanceof Error ? error.message : String(error) })
    })
  }

  // 本地日志只匹配当前目标版本；旧请求不能覆盖新版本的说明。
  React.useEffect(() => {
    setLatestNotes(null)
    let cancelled = false
    if (status.status === 'available' && status.version && !status.releaseNotes) {
      window.electronAPI.updater?.getChangelog().then((entries) => {
        if (cancelled) return
        const match = entries.find((entry) => entry.version === status.version)
        if (match?.notes) { setLatestNotes(match.notes); setShowReleaseNotes(true) }
      }).catch(() => { /* 缺少本地日志时保留版本和下载入口 */ })
    }
    return () => { cancelled = true }
  }, [status.status, status.version, status.releaseNotes])

  if (!available) return <SettingsCard><SettingsRow label="软件更新" description="当前构建未提供应用内更新，可打开官方发布页查看安装包。"><Button size="sm" variant="outline" onClick={() => void window.electronAPI.openExternal(GITHUB_RELEASES_URL).catch(() => toast.error('无法打开发布页'))}><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />官方发布页</Button></SettingsRow></SettingsCard>

  const isChecking = checking || status.status === 'checking' || status.status === 'downloading'
  const hasReleaseNotes = status.releaseNotes || latestNotes

  return (
    <SettingsCard divided={false}>
      <SettingsRow label="软件更新">
        <div className="flex flex-wrap items-center gap-3">
          {/* 状态文字 */}
          <StatusText status={status.status} version={status.version} error={status.error} manual={!!status.manualUrl} />

          {/* 操作按钮 */}
          {status.manualUrl && status.status === 'available' ? (
            <button
              onClick={handleOpenManualUpdate}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              打开下载页
            </button>
          ) : status.status === 'downloaded' ? (
            <button
              onClick={() => setRestartOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <RotateCw className="h-3.5 w-3.5" />
              立即重启
            </button>
          ) : (
            <button
              onClick={handleCheck}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              {isChecking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              检查更新
            </button>
          )}
        </div>
      </SettingsRow>
      {checkError && <div role="alert" className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />检查更新失败：{checkError}<Button size="sm" variant="outline" onClick={() => void handleCheck()}>重试</Button></div>}

      {/* Release Notes（新版本可用时显示） */}
      {status.status === 'available' && hasReleaseNotes && (
        <div className="px-4 pb-4 border-t">
          <button
            aria-expanded={showReleaseNotes}
            onClick={() => setShowReleaseNotes(!showReleaseNotes)}
            className="w-full flex items-center justify-between py-3 text-left hover:opacity-80 transition-opacity"
          >
            <span className="text-sm font-medium">更新日志</span>
            {showReleaseNotes ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {showReleaseNotes && (
            <div className="mt-2">
              <div className="prose dark:prose-invert max-w-none text-xs prose-sm prose-p:my-1.5 prose-p:leading-[1.6] prose-li:leading-[1.6] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {latestNotes ? (
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {latestNotes}
                  </Markdown>
                ) : status.releaseNotes ? (
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {status.releaseNotes}
                  </Markdown>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}
      <AlertDialog open={restartOpen} onOpenChange={(open) => { if (!restartRef.current) setRestartOpen(open) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>重启并安装更新？</AlertDialogTitle><AlertDialogDescription>应用将关闭并安装已下载的版本。请先完成或保存正在进行的工作。</AlertDialogDescription></AlertDialogHeader>
          {checkError && <p role="alert" className="text-sm text-destructive">{checkError}</p>}
          <AlertDialogFooter><AlertDialogCancel disabled={restarting}>取消</AlertDialogCancel><AlertDialogAction disabled={restarting} onClick={(event) => { event.preventDefault(); void handleQuitAndInstall() }}>{restarting ? '正在重启…' : '重启并安装'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

/** 状态文字组件 */
function StatusText({ status, version, error, manual }: {
  status: string
  version?: string
  error?: string
  manual?: boolean
}): React.ReactElement {
  switch (status) {
    case 'disabled':
      return <span className="text-xs text-muted-foreground">当前版本暂不支持应用内更新</span>
    case 'checking':
      return <span className="text-xs text-muted-foreground">正在检查...</span>
    case 'available':
      return (
        <span className="text-xs text-primary flex items-center gap-1">
          <ExternalLink className="h-3 w-3" />
          {manual ? `新版本 v${version} 可用，请手动下载` : `新版本 v${version} 可用`}
        </span>
      )
    case 'downloading':
      return (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在下载 v{version}
        </span>
      )
    case 'downloaded':
      return (
        <span className="text-xs text-primary flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          更新 v{version} 已就绪
        </span>
      )
    case 'not-available':
      return (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          已是最新版本
        </span>
      )
    case 'error':
      return (
        <span role="alert" className="text-xs text-destructive flex items-center gap-1" title={error}>
          <AlertCircle className="h-3 w-3" />
          {error ? `检查失败：${error}` : '检查失败，可重试'}
        </span>
      )
    default:
      return <span className="text-xs text-muted-foreground">未检查</span>
  }
}

/** 环境检测卡片 */
function EnvironmentCard(): React.ReactElement {
  const hasIssues = useAtomValue(hasEnvironmentIssuesAtom)
  const setEnvironmentResult = useSetAtom(environmentCheckResultAtom)
  const [result, setResult] = React.useState<EnvironmentCheckResult | null>(null)
  const [isChecking, setIsChecking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // 初始化时加载缓存的检测结果
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (settings.lastEnvironmentCheck) {
        setResult(settings.lastEnvironmentCheck)
        setEnvironmentResult(settings.lastEnvironmentCheck)
      }
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  // 执行环境检测
  const handleCheck = async () => {
    setIsChecking(true)
    setError(null)
    try {
      const checkResult = await window.electronAPI.checkEnvironment()
      setResult(checkResult)
      setEnvironmentResult(checkResult)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      console.error('[环境检测] 检测失败:', cause)
    } finally {
      setIsChecking(false)
    }
  }

  // Node.js 检测状态
  const isMac = window.electronAPI.getPlatformInfo().platform === 'darwin'

  const nodejsStatus = !result
    ? 'checking'
    : result.nodejs.installed && result.nodejs.meetsMinimum
      ? result.nodejs.meetsRecommended
        ? 'success'
        : 'warning'
      : 'error'

  // Git 检测状态
  const gitStatus = !result
    ? 'checking'
    : result.git.installed && result.git.meetsRequirement
      ? 'success'
      : 'error'

  return (
    <SettingsCard>
      <div className="p-4 border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">环境检测</h3>
            {hasIssues && <Badge variant="destructive">!</Badge>}
          </div>
          <button
            onClick={handleCheck}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {isChecking ? '检测中...' : '重新检查'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Node.js 与 Git 的安装检查；实际使用的 Bun、Shell 与运行时可用性见上方摘要。
        </p>
      </div>

      <div className="p-4 space-y-3" aria-busy={isChecking}>
        {error && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">环境检测失败：{error}。请点击“重新检查”。</div>}
        {!result && <p role="status" className="text-sm text-muted-foreground">{isChecking ? '正在检测本地运行环境…' : '尚无检测结果，请点击“重新检查”。'}</p>}
        {result && <>
        {/* Node.js 检测卡片 */}
        <EnvironmentCheckCard
          name="Node.js"
          status={nodejsStatus}
          version={result?.nodejs.version}
          requirement="推荐 22 LTS，最低 18 LTS"
          action={
            isMac
              ? { type: 'download', installerId: 'nodejs', labelPrefix: '一键下载' }
              : {
                  type: 'openExternal',
                  url: result?.nodejs.downloadUrl || 'https://nodejs.org/',
                }
          }
          statusText={
            result && nodejsStatus === 'warning'
              ? `v${result.nodejs.version} (建议升级到 22 LTS 以获得最佳体验)`
              : undefined
          }
        />

        {/* Git 检测卡片 */}
        <EnvironmentCheckCard
          name="Git"
          status={gitStatus}
          version={result?.git.version}
          requirement="版本 >= 2.0"
          action={{
            type: 'openExternal',
            url: result?.git.downloadUrl || 'https://git-scm.com/',
          }}
        />

        {/* Windows 提示 */}
        {result?.platform === 'win32' && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Windows 用户建议：</strong>
              安装时请选择默认路径（C:\Program Files\...），并确保勾选"添加到 PATH"选项
            </AlertDescription>
          </Alert>
        )}
        </>}
      </div>
    </SettingsCard>
  )
}

/** 只读主进程已检测的运行时快照，不初始化、安装或修改运行时。 */
function RuntimeSummaryCard(): React.ReactElement {
  const [status, setStatus] = React.useState<RuntimeStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const requestRef = React.useRef(0)
  const read = React.useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.electronAPI.getRuntimeStatus()
      if (request === requestRef.current) setStatus(next)
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (request === requestRef.current) setLoading(false) }
  }, [])
  React.useEffect(() => { void read(); return () => { requestRef.current += 1 } }, [read])
  return <SettingsCard divided={false}>
    <SettingsRow label="运行时摘要" description="主进程已检测的本地快照；可用不代表模型渠道已配置。">
      <Button size="sm" variant="outline" disabled={loading} onClick={() => void read()}><RefreshCw size={14} aria-hidden="true" />{loading ? '读取中…' : '重新读取'}</Button>
    </SettingsRow>
    <div className="space-y-3 px-4 pb-4" aria-busy={loading}>
      {error && <p role="alert" className="text-sm text-destructive">读取运行时失败：{error}。请重新读取。</p>}
      {!loading && !error && !status && <p role="status" className="text-sm text-muted-foreground">主进程尚未提供运行时状态。</p>}
      {status && <dl className="space-y-3">{(['node', 'bun', 'git'] as const).map((key) => {
        const runtime = status[key]
        return <div key={key} className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          <dt className="w-16 shrink-0 text-sm font-medium">{key === 'node' ? 'Node.js' : key === 'bun' ? 'Bun' : 'Git'}</dt>
          <dd className="min-w-0 text-sm"><span className={runtime.available ? 'text-foreground' : 'text-destructive'}>{runtime.available ? `可用${runtime.version ? ` · ${runtime.version}` : ''}` : `不可用${runtime.error ? ` · ${runtime.error}` : ''}`}</span>{runtime.path && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{runtime.path}</p>}</dd>
        </div>
      })}</dl>}
    </div>
  </SettingsCard>
}

/** Shell 环境卡片（Windows 平台）*/
function ShellEnvironmentCard(): React.ReactElement | null {
  const [runtimeStatus, setRuntimeStatus] = React.useState<RuntimeStatus | null>(null)
  const [isChecking, setIsChecking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // 初始化时加载运行时状态
  React.useEffect(() => {
    window.electronAPI.getRuntimeStatus().then((status) => {
      setRuntimeStatus(status)
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  // 重新检测
  const handleCheck = async () => {
    setIsChecking(true)
    setError(null)
    try {
      const status = await window.electronAPI.reinitRuntime()
      setRuntimeStatus(status)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      console.error('[Shell 环境检测] 检测失败:', cause)
    } finally {
      setIsChecking(false)
    }
  }

  // 非 Windows 平台不显示
  if (!runtimeStatus || !runtimeStatus.shell) {
    if (error && window.electronAPI.getPlatformInfo().platform === 'win32') return <SettingsCard divided={false} className="p-4"><p role="alert" className="text-sm text-destructive">Shell 状态读取失败：{error}</p><Button className="mt-3" size="sm" variant="outline" disabled={isChecking} onClick={() => void handleCheck()}>重新检查 Shell</Button></SettingsCard>
    return null
  }

  const { shell } = runtimeStatus
  const hasShell = shell.gitBash?.available || shell.wsl?.available

  return (
    <SettingsCard>
      <div className="p-4 border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Shell 环境（Windows）</h3>
            {!hasShell && <Badge variant="destructive">!</Badge>}
          </div>
          <button
            onClick={handleCheck}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {isChecking ? '检测中...' : '重新检查'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Agent 模式需要 Git Bash 或 WSL 支持
        </p>
      </div>

      <div className="p-4 space-y-3">
        {error && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">Shell 环境检测失败：{error}。请点击“重新检查”。</div>}
        {/* Git Bash 检测卡片 */}
        <EnvironmentCheckCard
          name="Git Bash"
          status={shell.gitBash?.available ? 'success' : 'error'}
          version={shell.gitBash?.version ?? undefined}
          requirement="Git for Windows 自带"
          action={{ type: 'download', installerId: 'git-for-windows' }}
          statusText={
            shell.gitBash?.available
              ? `${shell.gitBash.path}`
              : shell.gitBash?.error || '未安装'
          }
        />

        {/* WSL 检测卡片 */}
        <EnvironmentCheckCard
          name="WSL"
          status={shell.wsl?.available ? 'success' : 'error'}
          version={shell.wsl?.version ? `WSL ${shell.wsl.version}` : undefined}
          requirement="WSL 1 或 WSL 2"
          action={{
            type: 'openExternal',
            url: 'https://learn.microsoft.com/zh-cn/windows/wsl/install',
          }}
          statusText={
            shell.wsl?.available
              ? `默认发行版: ${shell.wsl.defaultDistro || '未设置'} (${shell.wsl.distros.join(', ')})`
              : shell.wsl?.error || '未安装'
          }
        />

        {/* 推荐环境提示 */}
        {shell.recommended && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>当前使用：</strong>
              {shell.recommended === 'git-bash' ? 'Git Bash（推荐）' : 'WSL'}
            </AlertDescription>
          </Alert>
        )}

        {/* 无可用环境警告 */}
        {!hasShell && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>未检测到可用的 Shell 环境！</strong>
              <br />
              Agent 模式需要 Git Bash 或 WSL 才能运行。请安装其中之一后重启应用。
            </AlertDescription>
          </Alert>
        )}
      </div>
    </SettingsCard>
  )
}

export function AboutSettings(): React.ReactElement {
  const developerModeEnabled = useAtomValue(developerModeEnabledAtom)
  const setDeveloperModeEnabled = useSetAtom(developerModeEnabledAtom)
  const setOpenEpistemicModeEnabled = useSetAtom(openEpistemicModeEnabledAtom)
  const unlockClickStateRef = React.useRef(INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE)
  const unlockPendingRef = React.useRef(false)

  const handleVersionClick = React.useCallback((): void => {
    if (developerModeEnabled || unlockPendingRef.current) return

    const result = advanceDeveloperModeUnlockClick(unlockClickStateRef.current, Date.now())
    unlockClickStateRef.current = result.state
    if (!result.unlocked) return

    unlockPendingRef.current = true
    window.electronAPI.updateSettings({ developerModeEnabled: true })
      .then((settings) => {
        if (settings.developerModeEnabled !== true) throw new Error('应用未确认启用开发者模式')
        setDeveloperModeEnabled(settings.developerModeEnabled === true)
        setOpenEpistemicModeEnabled(settings.openEpistemicModeEnabled === true)
        toast.success('开发者模式已启用')
      })
      .catch((error: unknown) => {
        console.error('[开发者模式] 启用入口失败:', error)
        toast.error('开发者模式启用失败，请重试')
      })
      .finally(() => {
        unlockPendingRef.current = false
      })
  }, [developerModeEnabled, setDeveloperModeEnabled, setOpenEpistemicModeEnabled])

  return (
    <div className="space-y-8">
      <SettingsSection
        title="关于 Profer"
        description="集成通用 AI Agent 的下一代人工智能软件 — Profer"
      >
        <SettingsCard>
          <SettingsRow label="版本">
            {developerModeEnabled ? (
              <span className="font-mono text-sm text-muted-foreground">{APP_VERSION}</span>
            ) : (
              <button
                type="button"
                onClick={handleVersionClick}
                aria-label={`Profer 版本 ${APP_VERSION}`}
                className="select-none rounded-sm font-mono text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {APP_VERSION}
              </button>
            )}
          </SettingsRow>
        </SettingsCard>

      </SettingsSection>
      <SettingsSection title="软件更新" description="根据当前构建显示应用内更新或官方发布页；检查不会修改安装版本。">
        <UpdateCard />
      </SettingsSection>
      <SettingsSection title="运行环境" description="查看本地 Agent 所需的运行时状态；检测失败可重试。">
        <RuntimeSummaryCard />
        <EnvironmentCard />
        <ShellEnvironmentCard />
      </SettingsSection>
      <SettingsSection title="版本记录" description="查看当前应用随包提供的更新历史。">
        <VersionHistory />
      </SettingsSection>

      <FeedbackSection />
    </div>
  )
}

// ==================== 意见反馈 Section ====================

const FEEDBACK_CATEGORIES = [
  { value: 'general', label: '💬 通用反馈' },
  { value: 'feature', label: '💡 功能建议' },
  { value: 'bug', label: '🐛 BUG 报告' },
  { value: 'other', label: '📝 其他' },
]

type SubmitState = 'idle' | 'submitting' | 'success' | 'error'

function FeedbackSection(): React.ReactElement {
  const [content, setContent] = React.useState('')
  const [contact, setContact] = React.useState('')
  const [category, setCategory] = React.useState('general')
  const [submitState, setSubmitState] = React.useState<SubmitState>('idle')
  const [errorMsg, setErrorMsg] = React.useState('')
  const submittingRef = React.useRef(false)

  const getAuth = React.useCallback(async () => {
    try {
      return await window.electronAPI.auth.getTeamAuth()
    } catch {
      return null
    }
  }, [])

  const handleSubmit = React.useCallback(async () => {
    if (!content.trim() || submittingRef.current) return
    submittingRef.current = true
    setSubmitState('submitting')
    setErrorMsg('')
    try {
      const auth = await getAuth()
      if (!auth?.baseUrl) {
        setErrorMsg('未连接到 Profer 服务端，请先在账户设置中登录团队账号。')
        setSubmitState('error')
        return
      }
      const resp = await fetch(`${auth.baseUrl}/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        },
        body: JSON.stringify({
          content: content.trim(),
          contact: contact.trim() || undefined,
          category,
          pageUrl: 'profer://settings/about',
        }),
      })
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({ error: '请求失败' }))
        throw new Error(typeof d?.error === 'string' ? d.error : `请求失败 (${resp.status})`)
      }
      setSubmitState('success')
      setContent('')
      setContact('')
      setCategory('general')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : '提交失败，请稍后重试')
      setSubmitState('error')
    } finally { submittingRef.current = false }
  }, [content, contact, category, getAuth])

  const handleReset = React.useCallback(() => {
    setSubmitState('idle')
    setErrorMsg('')
  }, [])

  return (
    <SettingsSection title="意见反馈" description="告诉我们你的想法、建议或遇到的问题。每一条反馈我们都会认真阅读。">
      <SettingsCard>
        {submitState === 'success' ? (
          <div role="status" className="flex flex-col items-center justify-center py-10 gap-3">
            <CheckCircle2 size={40} className="text-primary" />
            <p className="text-base font-medium text-foreground">感谢你的反馈！</p>
            <p className="text-sm text-muted-foreground">我们已收到你的意见，会尽快处理。</p>
            <Button variant="outline" size="sm" onClick={handleReset} className="mt-2">
              继续提交
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4" aria-busy={submitState === 'submitting'}>
            {submitState === 'error' && errorMsg && (
              <Alert variant="destructive">
                <AlertCircle size={16} />
                <AlertDescription id="feedback-error" role="alert">{errorMsg} 输入内容已保留，可重试提交。</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-content" className="text-sm font-medium">
                意见内容 <span className="text-destructive">*</span>
              </Label>
              <Textarea
                aria-describedby={submitState === 'error' ? 'feedback-content-hint feedback-error' : 'feedback-content-hint'}
                required
                aria-invalid={submitState === 'error' && !content.trim()}
                id="feedback-content"
                placeholder="请详细描述你的想法、建议或遇到的问题..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={5}
                maxLength={5000}
                disabled={submitState === 'submitting'}
                className="resize-none"
              />
              <p id="feedback-content-hint" className="text-xs text-muted-foreground self-end" aria-live="polite">
                {content.length}/5000
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-category" className="text-sm font-medium">分类</Label>
              <Select value={category} onValueChange={setCategory} disabled={submitState === 'submitting'}>
                <SelectTrigger id="feedback-category" className="w-full sm:w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-contact" className="text-sm font-medium">
                联系方式 <span className="text-muted-foreground font-normal">（选填）</span>
              </Label>
              <Input
                id="feedback-contact"
                placeholder="邮箱或微信号，方便我们联系你"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={200}
                disabled={submitState === 'submitting'}
              />
            </div>
            <Button
              onClick={handleSubmit}
              disabled={!content.trim() || submitState === 'submitting'}
              className="w-full sm:w-auto sm:self-start mt-2"
            >
              {submitState === 'submitting' ? (
                <>
                  <Loader2 size={16} className="animate-spin mr-1.5" />
                  提交中...
                </>
              ) : (
                <>
                  <Send size={16} className="mr-1.5" />
                  提交反馈
                </>
              )}
            </Button>
          </div>
        )}
      </SettingsCard>
      <div className="flex items-start gap-2.5 text-xs text-muted-foreground bg-muted/30 rounded-lg p-3 mt-3">
        <MessageSquareText size={14} className="flex-shrink-0 mt-0.5" />
        <span>
          你的意见将发送到 Profer 服务端。提交内容请勿包含敏感信息（如密码、密钥等）。
        </span>
      </div>
    </SettingsSection>
  )
}
