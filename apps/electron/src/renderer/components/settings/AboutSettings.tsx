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
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { updateStatusAtom, updaterAvailableAtom, checkForUpdates } from '@/atoms/updater'
import {
  environmentCheckResultAtom,
  hasEnvironmentIssuesAtom,
} from '@/atoms/environment'
import { EnvironmentCheckCard } from '@/components/environment/EnvironmentCheckCard'
import { Badge } from '@/components/ui/badge'
import { ReleaseNotesViewer } from './ReleaseNotesViewer'

/** 从 package.json 构建时由 Vite define 注入 */
declare const __APP_VERSION__: string
const APP_VERSION = __APP_VERSION__

const GITHUB_RELEASES_URL = 'https://github.com/Yuan-lai-ru-ci/Profer/releases'

/** 更新状态卡片 */
function UpdateCard(): React.ReactElement | null {
  const available = useAtomValue(updaterAvailableAtom)
  const status = useAtomValue(updateStatusAtom)
  const [checking, setChecking] = React.useState(false)
  const [showReleaseNotes, setShowReleaseNotes] = React.useState(false)
  const [release, setRelease] = React.useState<import('@profer/shared').GitHubRelease | null>(null)

  // updater 不可用时不渲染
  if (!available) return null

  const handleCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await checkForUpdates()
    } finally {
      // 状态由 atom 订阅自动更新，延迟重置 checking 避免按钮闪烁
      setTimeout(() => setChecking(false), 1000)
    }
  }

  const handleQuitAndInstall = (): void => {
    window.electronAPI.updater?.quitAndInstall()
  }

  // 当检测到新版本时，获取完整的 release 信息
  React.useEffect(() => {
    if (status.status === 'available' && status.version && !release) {
      window.electronAPI
        .getReleaseByTag(`v${status.version}`)
        .then((r) => {
          if (r) {
            setRelease(r)
            setShowReleaseNotes(true)
          }
        })
        .catch((err) => {
          console.error('[更新] 获取 Release 信息失败:', err)
        })
    }
  }, [status.status, status.version, release])

  const isChecking = checking || status.status === 'checking' || status.status === 'downloading'
  const hasReleaseNotes = status.releaseNotes || release?.body

  return (
    <SettingsCard>
      <SettingsRow label="软件更新">
        <div className="flex items-center gap-3">
          {/* 状态文字 */}
          <StatusText status={status.status} version={status.version} error={status.error} />

          {/* 操作按钮 */}
          {status.status === 'downloaded' ? (
            <button
              onClick={handleQuitAndInstall}
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

      {/* Release Notes（新版本可用时显示） */}
      {status.status === 'available' && hasReleaseNotes && (
        <div className="px-4 pb-4 border-t">
          <button
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

          {showReleaseNotes && release && (
            <div className="mt-2">
              <ReleaseNotesViewer
                release={release}
                showHeader={false}
                compact
              />
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  )
}

/** 状态文字组件 */
function StatusText({ status, version, error }: {
  status: string
  version?: string
  error?: string
}): React.ReactElement {
  switch (status) {
    case 'checking':
      return <span className="text-xs text-muted-foreground">正在检查...</span>
    case 'available':
      return (
        <span className="text-xs text-primary flex items-center gap-1">
          <ExternalLink className="h-3 w-3" />
          新版本 v{version} 可用
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
        <span className="text-xs text-destructive flex items-center gap-1" title={error}>
          <AlertCircle className="h-3 w-3" />
          检查失败
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

  // 初始化时加载缓存的检测结果
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (settings.lastEnvironmentCheck) {
        setResult(settings.lastEnvironmentCheck)
        setEnvironmentResult(settings.lastEnvironmentCheck)
      }
    })
  }, [])

  // 执行环境检测
  const handleCheck = async () => {
    setIsChecking(true)
    try {
      const checkResult = await window.electronAPI.checkEnvironment()
      setResult(checkResult)
      setEnvironmentResult(checkResult)
    } catch (error) {
      console.error('[环境检测] 检测失败:', error)
    } finally {
      setIsChecking(false)
    }
  }

  // Node.js 检测状态
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
        <div className="flex items-center justify-between">
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
          Agent 模式需要 Node.js 和 Git 支持
        </p>
      </div>

      <div className="p-4 space-y-3">
        {/* Node.js 检测卡片 */}
        <EnvironmentCheckCard
          name="Node.js"
          status={nodejsStatus}
          version={result?.nodejs.version}
          requirement="推荐 22 LTS，最低 18 LTS"
          action={{
            type: 'openExternal',
            url: result?.nodejs.downloadUrl || 'https://nodejs.org/',
          }}
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
      </div>
    </SettingsCard>
  )
}

/** Shell 环境卡片（Windows 平台）*/
function ShellEnvironmentCard(): React.ReactElement | null {
  const [runtimeStatus, setRuntimeStatus] = React.useState<RuntimeStatus | null>(null)
  const [isChecking, setIsChecking] = React.useState(false)

  // 初始化时加载运行时状态
  React.useEffect(() => {
    window.electronAPI.getRuntimeStatus().then((status) => {
      setRuntimeStatus(status)
    })
  }, [])

  // 重新检测
  const handleCheck = async () => {
    setIsChecking(true)
    try {
      // 触发重新初始化运行时（后续可以添加此 IPC 方法）
      const status = await window.electronAPI.getRuntimeStatus()
      setRuntimeStatus(status)
    } catch (error) {
      console.error('[Shell 环境检测] 检测失败:', error)
    } finally {
      setIsChecking(false)
    }
  }

  // 非 Windows 平台不显示
  if (!runtimeStatus || !runtimeStatus.shell) {
    return null
  }

  const { shell } = runtimeStatus
  const hasShell = shell.gitBash?.available || shell.wsl?.available

  return (
    <SettingsCard>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
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
  return (
    <div className="space-y-8">
      <SettingsSection
        title="关于 Profer"
        description="集成通用 AI Agent 的下一代人工智能软件 — Profer"
      >
        <SettingsCard>
          <SettingsRow label="版本">
            <span className="text-sm text-muted-foreground font-mono">{APP_VERSION}</span>
          </SettingsRow>
          <SettingsRow label="运行时">
            <span className="text-sm text-muted-foreground">Electron + React</span>
          </SettingsRow>
          <SettingsRow
            label="开源协议"
            description="社区版基于 AGPL-3.0 开源，商业授权请联系 erlichliu@gmail.com"
          >
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline"
            >
              AGPL-3.0
            </a>
          </SettingsRow>
          <SettingsRow label="项目地址">
            <a
              href="https://github.com/Yuan-lai-ru-ci/Profer.git"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline"
            >
              github.com/Yuan-lai-ru-ci/Profer
            </a>
          </SettingsRow>
        </SettingsCard>

        {/* 自动更新卡片（updater 不可用时不渲染） */}
        <UpdateCard />

        {/* 环境检测卡片 */}
        <EnvironmentCard />

        {/* Shell 环境卡片（仅 Windows） */}
        <ShellEnvironmentCard />
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

  const getAuth = React.useCallback(async () => {
    try {
      return await window.electronAPI.auth.getTeamAuth()
    } catch {
      return null
    }
  }, [])

  const handleSubmit = React.useCallback(async () => {
    if (!content.trim()) return
    setSubmitState('submitting')
    setErrorMsg('')
    try {
      const auth = await getAuth()
      if (!auth?.baseUrl) {
        setErrorMsg('未连接到 Profer 服务端，请先在通用设置中登录团队账号。')
        setSubmitState('error')
        return
      }
      const resp = await fetch(`${auth.baseUrl}/v1/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.trim(),
          contact: contact.trim() || undefined,
          category,
          pageUrl: 'proma://settings/about',
          teamEmail: auth.teamEmail || undefined,
          teamAccountId: auth.teamAccountId || undefined,
        }),
      })
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({ error: '请求失败' }))
        throw new Error(d.error || `请求失败 (${resp.status})`)
      }
      setSubmitState('success')
      setContent('')
      setContact('')
      setCategory('general')
    } catch (err: any) {
      setErrorMsg(err.message || '提交失败，请稍后重试')
      setSubmitState('error')
    }
  }, [content, contact, category, getAuth])

  const handleReset = React.useCallback(() => {
    setSubmitState('idle')
    setErrorMsg('')
  }, [])

  return (
    <SettingsSection title="意见反馈" description="告诉我们你的想法、建议或遇到的问题。每一条反馈我们都会认真阅读。">
      <SettingsCard>
        {submitState === 'success' ? (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <CheckCircle2 size={40} className="text-green-500" />
            <p className="text-base font-medium text-foreground">感谢你的反馈！</p>
            <p className="text-sm text-muted-foreground">我们已收到你的意见，会尽快处理。</p>
            <Button variant="outline" size="sm" onClick={handleReset} className="mt-2">
              继续提交
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-1">
            {submitState === 'error' && errorMsg && (
              <Alert variant="destructive">
                <AlertCircle size={16} />
                <AlertDescription>{errorMsg}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-content" className="text-sm font-medium">
                意见内容 <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="feedback-content"
                placeholder="请详细描述你的想法、建议或遇到的问题..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={5}
                maxLength={5000}
                disabled={submitState === 'submitting'}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground self-end">
                {content.length}/5000
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-category" className="text-sm font-medium">分类</Label>
              <Select value={category} onValueChange={setCategory} disabled={submitState === 'submitting'}>
                <SelectTrigger id="feedback-category" className="w-[200px]">
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
              className="self-start mt-2"
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
