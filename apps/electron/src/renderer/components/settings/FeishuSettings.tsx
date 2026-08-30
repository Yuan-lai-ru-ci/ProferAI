/**
 * FeishuSettings - 飞书集成设置页
 *
 * 双 Tab 布局：
 * - Bot 配置：飞书应用凭证、连接状态、默认配置、创建引导、命令说明
 * - 绑定管理：查看/管理所有活跃的飞书聊天绑定（群聊/单聊的工作区/会话分配）
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Loader2, CheckCircle2, XCircle, ExternalLink, Users, User, Trash2, RefreshCw, Copy, Check, Power, PowerOff, Plus, ChevronRight, PlayCircle, QrCode, MessageSquare, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsSecretInput } from './primitives/SettingsSecretInput'
import { SettingsRow } from './primitives/SettingsRow'
import { feishuBotStatesAtom, feishuBindingsAtom } from '@/atoms/feishu-atoms'
import { agentPendingPromptAtom, agentWorkspacesAtom, agentSessionsAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { useCreateSession } from '@/hooks/useCreateSession'
import { cn } from '@/lib/utils'
import { isVisibleAgentSession, type FeishuTestResult, type FeishuChatBinding, type FeishuBotConfig, type FeishuBotBridgeState, type FeishuRegisterAppQRCode, type FeishuRegisterAppStatus, type FeishuSessionMirrorSettings, type FeishuSessionSyncMode, type LarkCliStatus, type LarkLoginEvent, type LarkMcpStatus } from '@profer/shared'

// ===== 常量 =====

/** 连接状态颜色映射 */
const STATUS_CONFIG = {
  disconnected: { color: 'bg-gray-400', label: '未连接' },
  connecting: { color: 'bg-amber-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-500', label: '已连接' },
  error: { color: 'bg-red-500', label: '连接错误' },
} as const


/** 飞书批量权限配置 JSON（用于一键复制粘贴到飞书开放平台） */
const FEISHU_SCOPES_JSON = JSON.stringify({
  scopes: {
    tenant: [
      'contact:contact.base:readonly',
      'drive:drive',
      'im:chat',
      'im:chat.announcement:write_only',
      'im:chat.managers:write_only',
      'im:chat.members:read',
      'im:chat.members:write_only',
      'im:chat.tabs:write_only',
      'im:chat.top_notice:write_only',
      'im:message',
      'im:message.group_at_msg:readonly',
      'im:message.group_msg',
      'im:message.p2p_msg:readonly',
      'im:message.reactions:write_only',
      'im:message:send_as_bot',
      'im:resource',
      'wiki:wiki',
    ],
    user: [],
  },
}, null, 2)

/**
 * 视频教程入口配置。
 * 后续把 url 填上即可在飞书配置页顶部显示视频教程卡片，留空则不渲染。
 * 支持 B 站 / YouTube 等任意 iframe 嵌入地址，例如：
 *   B 站：//player.bilibili.com/player.html?bvid=BVxxxxxx&autoplay=0
 *   YouTube：https://www.youtube.com/embed/VIDEO_ID
 *
 * TODO: 教程视频录制完成后，把 url 填回（之前测试用过 'https://www.bilibili.com/video/BV1z8G867Epv'）。
 */
const FEISHU_TUTORIAL_VIDEO = {
  url: '',
  title: '飞书 Bot 配置视频教程',
  description: '跟着视频一步步配，3 分钟内完成飞书 Bot 接入',
} as const

// ===== 视频教程组件 =====

/** 把任意视频链接归一化为可 iframe 嵌入的 URL（B 站 / YouTube / 直链皆支持） */
function normalizeVideoEmbedUrl(raw: string): { embedUrl: string; isIframe: boolean } | null {
  const url = raw.trim()
  if (!url) return null

  // B 站普通页：https://www.bilibili.com/video/BVxxxxxx[?p=N] → player.bilibili.com
  const bvMatch = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/)
  if (bvMatch) {
    const pMatch = url.match(/[?&]p=(\d+)/)
    const pageParam = pMatch ? `&page=${pMatch[1]}` : ''
    return { embedUrl: `https://player.bilibili.com/player.html?bvid=${bvMatch[1]}&autoplay=0&high_quality=1&danmaku=0${pageParam}`, isIframe: true }
  }
  // B 站短链（b23.tv/xxx）：无法在前端跟随重定向，让 iframe 自己处理
  if (/^https?:\/\/b23\.tv\//.test(url)) {
    return { embedUrl: url, isIframe: true }
  }
  // B 站 player 直链
  if (/^https?:\/\/player\.bilibili\.com\//.test(url)) {
    return { embedUrl: url, isIframe: true }
  }
  // YouTube watch / shorts / youtu.be → embed
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/)
  if (ytMatch) {
    return { embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}`, isIframe: true }
  }
  // YouTube embed 直链
  if (/^https?:\/\/(www\.)?youtube\.com\/embed\//.test(url)) {
    return { embedUrl: url, isIframe: true }
  }
  // mp4 / webm / m3u8 直链：用 video 标签
  if (/\.(mp4|webm|m3u8)(\?.*)?$/i.test(url)) {
    return { embedUrl: url, isIframe: false }
  }
  // 默认尝试当作 iframe 渲染
  return { embedUrl: url, isIframe: true }
}

/** 飞书配置页顶部的视频教程卡片，URL 留空时不渲染。
 *  默认展开方便新用户上手；检测到任一 Bot 已 connected（视为配置完成）会自动收起一次，
 *  之后用户随时可以手动展开/收起。 */
function FeishuTutorialVideo(): React.ReactElement | null {
  const video = React.useMemo(() => normalizeVideoEmbedUrl(FEISHU_TUTORIAL_VIDEO.url), [])
  const botStates = useAtomValue(feishuBotStatesAtom)
  const hasConnectedBot = React.useMemo(
    () => Object.values(botStates).some((b) => b.status === 'connected'),
    [botStates],
  )
  const [expanded, setExpanded] = React.useState(true)
  const autoCollapsedRef = React.useRef(false)

  React.useEffect(() => {
    if (hasConnectedBot && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true
      setExpanded(false)
    }
  }, [hasConnectedBot])

  if (!video) return null

  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-2">
          <PlayCircle size={16} className="text-primary" />
          {FEISHU_TUTORIAL_VIDEO.title}
        </span>
      }
      description={FEISHU_TUTORIAL_VIDEO.description}
    >
      <SettingsCard divided={false}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer text-left"
        >
          <span className="text-sm text-muted-foreground">
            {expanded ? '点击收起视频' : '点击展开视频教程（约 3 分钟）'}
          </span>
          <ChevronRight size={16} className={cn('text-muted-foreground transition-transform duration-200', expanded && 'rotate-90')} />
        </button>
        {expanded && (
          <div className="px-4 pb-4 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <div className="relative w-full overflow-hidden rounded-md bg-black" style={{ aspectRatio: '16 / 9' }}>
              {video.isIframe ? (
                <iframe
                  src={video.embedUrl}
                  title={FEISHU_TUTORIAL_VIDEO.title}
                  className="absolute inset-0 w-full h-full border-0"
                  allowFullScreen
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture"
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
                />
              ) : (
                <video
                  src={video.embedUrl}
                  controls
                  preload="metadata"
                  className="absolute inset-0 w-full h-full"
                />
              )}
            </div>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 工具组件 =====

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

// ===== 权限配置步骤组件 =====

/** 权限列表展示 + 一键复制批量权限 JSON */
function PermissionsStep(): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(FEISHU_SCOPES_JSON).then(() => {
      setCopied(true)
      toast.success('权限配置已复制到剪贴板')
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      toast.error('复制失败')
    })
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">4</span>
        <span className="font-medium text-foreground">配置权限</span>
      </div>
      <div className="pl-7 space-y-3 text-muted-foreground">
        <p>
          进入「权限管理」页面，点击下方按钮复制权限配置 JSON，
          在飞书开放平台点击右上角「<span className="text-foreground font-medium">批量开通权限</span>」按钮，把 JSON 粘贴进去即可一次性添加所有权限。
        </p>

        {/* 主操作：一键复制按钮（更显眼） */}
        <Button
          size="default"
          onClick={handleCopy}
          className={cn(
            'gap-2 transition-all',
            copied && 'bg-green-600 hover:bg-green-600 text-white'
          )}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          <span className="font-medium">{copied ? '已复制到剪贴板' : '一键复制权限配置 JSON'}</span>
        </Button>

        {/* 次要：展开查看每个权限对应的能力 */}
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight size={14} className={cn('transition-transform duration-200', expanded && 'rotate-90')} />
          <span>{expanded ? '收起权限明细' : '查看每个权限的作用'}</span>
        </button>
        {expanded && (
          <div className="bg-muted/50 rounded-md p-3 font-mono text-xs space-y-0.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <div><span className="text-foreground/70">im:message</span> — 获取与发送单聊、群组消息</div>
            <div><span className="text-foreground/70">im:message:send_as_bot</span> — 以机器人身份发送消息</div>
            <div><span className="text-foreground/70">im:message.p2p_msg:readonly</span> — 接收用户发给机器人的单聊消息</div>
            <div><span className="text-foreground/70">im:message.group_at_msg:readonly</span> — 接收群聊中 @机器人 的消息</div>
            <div><span className="text-foreground/70">im:message.group_msg</span> — 接收群聊所有用户消息（配合 im:chat 实现仅你和 Bot 的群免 @ 续聊、群聊上下文）</div>
            <div><span className="text-foreground/70">im:message.reactions:write_only</span> — 为消息添加状态表情（如⌨️/✅），让用户感知 Bot 正在处理 / 已完成</div>
            <div><span className="text-foreground/70">im:chat</span> — 创建群 + 读取/更新群基础信息（群名、简介、真人数量等；免 @ 续聊靠它判断群里只有你和 Bot）</div>
            <div><span className="text-foreground/70">im:chat.members:read</span> — 获取群成员列表（支持 @某人）</div>
            <div><span className="text-foreground/70">im:chat.members:write_only</span> — 添加 / 移除群成员（Bot 主动拉人入群）</div>
            <div><span className="text-foreground/70">im:chat.managers:write_only</span> — 指定 / 移除群管理员</div>
            <div><span className="text-foreground/70">im:chat.announcement:write_only</span> — 更新群公告（把任务进度挂到公告里）</div>
            <div><span className="text-foreground/70">im:chat.tabs:write_only</span> — 操作群会话标签页</div>
            <div><span className="text-foreground/70">im:chat.top_notice:write_only</span> — 设置群置顶消息</div>
            <div><span className="text-foreground/70">im:resource</span> — 获取消息中的资源文件（图片、文档等）</div>
            <div><span className="text-foreground/70">contact:contact.base:readonly</span> — 获取用户基本信息（群聊发送者名称）</div>
            <div><span className="text-foreground/70">drive:drive</span> — 云文档评论 @Bot 时读取与回复（支持文档协作场景）</div>
            <div><span className="text-foreground/70">wiki:wiki</span> — 解析知识库链接的真实文档（@Bot 在 wiki 文档评论时使用）</div>
          </div>
        )}
      </div>
    </div>
  )
}

// ===== 飞书 CLI 预置 Prompt =====

const FEISHU_CLI_WORKSPACE_PROMPT = `请在当前 Profer 工作区完成飞书 CLI 配置，并在完成后验证结果。

要求：
1. 先用官方 CLI 的 --help 确认当前版本支持的命令，不要猜参数。
2. 只把 @larksuite/cli 可执行工具安装到全局：npm install -g @larksuite/cli。
3. 把官方 Lark Agent Skills 安装到当前 Profer 工作区实际加载的 skills/ 目录；不要使用 -g，也不要只安装到 .agents/skills/，因为 Profer 不会从那里加载。
4. 初始化独立的 Lark CLI 应用：lark-cli config init --new。不要复用 Profer 飞书 Bot 应用。
5. 完成用户授权：lark-cli auth login --domain all。需要浏览器授权时提示我操作。
6. 最后运行 lark-cli auth status，报告 CLI、授权和工作区 Skill 是否就绪；不要在聊天、文件或日志中输出 token、App Secret 或 Cookie。

如果当前 CLI 版本的 Skill 安装命令无法直接写入 Profer skills/，请先查看帮助，再采用安全的复制方式完成，不要留下只存在于 .agents/skills/ 的无效安装。`

/** 可选的工作区级 Lark CLI 配置入口 */
function FeishuCliSection(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId)
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const { createAgent } = useCreateSession()
  const [working, setWorking] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(FEISHU_CLI_WORKSPACE_PROMPT).then(() => {
      setCopied(true)
      toast.success('配置提示词已复制')
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => toast.error('复制失败'))
  }, [])

  const handleStartInWorkspace = React.useCallback(async () => {
    if (!currentWorkspace) {
      toast.error('请先选择一个工作区')
      return
    }
    setWorking(true)
    try {
      const sessionId = await createAgent()
      if (!sessionId) {
        toast.error('创建配置会话失败')
        return
      }
      setPendingPrompt({ sessionId, message: FEISHU_CLI_WORKSPACE_PROMPT })
      setSettingsOpen(false)
      toast.success(`已在「${currentWorkspace.name}」开始配置`)
    } finally {
      setWorking(false)
    }
  }, [createAgent, currentWorkspace, setPendingPrompt, setSettingsOpen])

  return (
    <SettingsSection
      title="给当前工作区增加飞书能力"
      description="可选。Profer 会在当前工作区创建配置会话，自动安装 CLI、放置官方 Skills 并引导授权。普通 Bot 收发消息不需要这一步。"
    >
      <SettingsCard divided={false}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-4">
          <Button size="sm" onClick={() => void handleStartInWorkspace()} disabled={working || !currentWorkspace} className="gap-1.5">
            {working ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
            {working ? '正在打开配置会话…' : '在当前工作区配置'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopy} className="gap-1.5">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制提示词'}
          </Button>
          <span className="text-xs text-muted-foreground">
            {currentWorkspace ? `目标工作区：${currentWorkspace.name}` : '请先选择工作区'}
          </span>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== Lark 用户云端能力 =====

function LarkCloudCapabilitiesSection(): React.ReactElement {
  const [status, setStatus] = React.useState<LarkCliStatus | null>(null)
  const [loginEvent, setLoginEvent] = React.useState<LarkLoginEvent | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [working, setWorking] = React.useState(false)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await window.electronAPI.refreshLarkCliStatus())
    } catch {
      toast.error('无法检测 Lark CLI')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    return window.electronAPI.onLarkLoginEvent((event) => {
      setLoginEvent(event)
      if (event.type === 'completed') {
        void refresh()
        toast.success('Lark 用户授权已完成')
      } else if (event.type === 'failed') {
        toast.error(event.message)
      }
    })
  }, [refresh])

  const install = React.useCallback(async () => {
    setWorking(true)
    try {
      const result = await window.electronAPI.installLarkCli()
      result.success ? toast.success('Lark CLI 安装完成') : toast.error(result.message)
      if (result.success) await refresh()
    } finally {
      setWorking(false)
    }
  }, [refresh])

  const login = React.useCallback(async () => {
    setWorking(true)
    setLoginEvent(null)
    try {
      const result = await window.electronAPI.startLarkLogin()
      if (!result.started) toast.error(result.message)
      else if (result.authorizationUrl) {
        setLoginEvent({ type: 'url', authorizationUrl: result.authorizationUrl, message: '请在浏览器中完成授权' })
        openLink(result.authorizationUrl)
      } else toast.info('登录流程已启动，请按 CLI 提示完成授权')
    } catch {
      toast.error('无法启动 Lark 登录流程')
    } finally {
      setWorking(false)
    }
  }, [])

  const copyUrl = React.useCallback(() => {
    const url = loginEvent?.authorizationUrl
    if (!url) return
    navigator.clipboard.writeText(url).then(() => toast.success('授权链接已复制')).catch(() => toast.error('复制失败'))
  }, [loginEvent])

  const authLabel = status?.auth.state === 'logged_in' ? '已登录' : status?.auth.state === 'reauthorization_required' ? '需要重新授权' : status?.auth.state === 'logged_out' ? '未登录' : '未知'
  const ready = status?.cli.available && status.cli.version

  return (
    <SettingsSection title="飞书云端能力（Lark 用户授权）" description="通过官方 Lark CLI 使用你的用户身份访问云文档、表格和其他云端资源。凭据只保留在 CLI 的安全存储中，Profer 不读取或展示 token。">
      <SettingsCard divided={false}>
        <div className="px-4 py-4 space-y-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {loading ? <Loader2 size={16} className="animate-spin text-muted-foreground" /> : status?.error ? <XCircle size={16} className="text-red-500" /> : <CheckCircle2 size={16} className="text-green-500" />}
              <span className="font-medium">Lark CLI：{ready ? `已安装（${status.cli.version}）` : '未检测到'}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading} className="gap-1.5"><RefreshCw size={14} />检测</Button>
          </div>

          <div className="rounded-md bg-muted/50 p-3 space-y-1.5 text-xs text-muted-foreground">
            <div>用户授权：<span className="text-foreground font-medium">{authLabel}</span>{status?.auth.userLabel ? ` · ${status.auth.userLabel}` : ''}</div>
            <div>Node.js：{status?.node.version ?? '未检测到'} · npm：{status?.npm.version ?? '未检测到'} · npx：{status?.npx.version ?? '未检测到'}</div>
            {status?.auth.scopeCount != null && <div>已授权范围：{status.auth.scopeCount} 项（具体 token/权限内容不会展示）</div>}
            {status?.error && <div className="text-red-600 dark:text-red-400">诊断：{status.error}</div>}
          </div>

          <div className="flex flex-wrap gap-2">
            {!ready && <Button size="sm" onClick={() => void install()} disabled={working} className="gap-1.5">{working && <Loader2 size={14} className="animate-spin" />}安装官方 CLI</Button>}
            <Button size="sm" onClick={() => void login()} disabled={!ready || working} className="gap-1.5">{working && <Loader2 size={14} className="animate-spin" />}重新登录 / 授权</Button>
            {status?.cli.path && <span className="self-center text-xs text-muted-foreground">路径：{status.cli.path}</span>}
          </div>

          {loginEvent?.authorizationUrl && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="text-xs text-foreground">{loginEvent.message}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => openLink(loginEvent.authorizationUrl!)} className="gap-1.5"><ExternalLink size={14} />打开授权页</Button>
                <Button size="sm" variant="outline" onClick={copyUrl} className="gap-1.5"><Copy size={14} />复制链接</Button>
                <Button size="sm" variant="ghost" onClick={() => void window.electronAPI.cancelLarkLogin()}>取消</Button>
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

function LarkMcpSection(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [status, setStatus] = React.useState<LarkMcpStatus | null>(null)
  const [appId, setAppId] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [workspaceSlug, setWorkspaceSlug] = React.useState('')
  const [loginEvent, setLoginEvent] = React.useState<LarkLoginEvent | null>(null)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const next = await window.electronAPI.getLarkMcpStatus()
      setStatus(next)
      if (!workspaceSlug && workspaces[0]) setWorkspaceSlug(workspaces[0].slug)
    } catch {
      toast.error('无法读取 Lark MCP 配置')
    }
  }, [workspaceSlug, workspaces])

  React.useEffect(() => { void refresh() }, [refresh])

  React.useEffect(() => window.electronAPI.onLarkMcpLoginEvent((event) => {
    setLoginEvent(event)
    if (event.type === 'completed') toast.success('Lark MCP 用户授权已完成')
    if (event.type === 'failed') toast.error(event.message)
  }), [])

  const saveCredentials = React.useCallback(async () => {
    setSaving(true)
    try {
      const result = await window.electronAPI.saveLarkMcpCredentials({ appId, appSecret })
      if (!result.success) { toast.error(result.message); return }
      setAppSecret('')
      toast.success('MCP 应用凭据已安全保存')
      await refresh()
    } finally { setSaving(false) }
  }, [appId, appSecret, refresh])

  const testConnection = React.useCallback(async () => {
    setSaving(true)
    try {
      const result = await window.electronAPI.testLarkMcpConnection()
      result.success ? toast.success('官方 Lark MCP 协议握手成功') : toast.error(result.message)
    } finally { setSaving(false) }
  }, [])

  const login = React.useCallback(async () => {
    setSaving(true)
    setLoginEvent(null)
    try {
      const result = await window.electronAPI.startLarkMcpLogin()
      if (!result.started) toast.error(result.message)
      else toast.info('MCP 授权流程已启动，请在浏览器中完成确认')
    } finally { setSaving(false) }
  }, [])

  const copyLoginUrl = React.useCallback(() => {
    const url = loginEvent?.authorizationUrl
    if (!url) return
    navigator.clipboard.writeText(url).then(() => toast.success('授权链接已复制')).catch(() => toast.error('复制失败'))
  }, [loginEvent])

  const enable = React.useCallback(async () => {
    if (!workspaceSlug) { toast.error('请选择工作区'); return }
    setSaving(true)
    try {
      const result = await window.electronAPI.enableLarkMcpForWorkspace(workspaceSlug)
      result.success ? toast.success('已为工作区启用官方 Lark MCP') : toast.error(result.message)
      if (result.success) await refresh()
    } finally { setSaving(false) }
  }, [refresh, workspaceSlug])

  const disable = React.useCallback(async () => {
    if (!workspaceSlug) return
    setSaving(true)
    try {
      const result = await window.electronAPI.disableLarkMcpForWorkspace(workspaceSlug)
      result.success ? toast.success('已从工作区停用 Lark MCP') : toast.error(result.message)
    } finally { setSaving(false) }
  }, [workspaceSlug])

  return (
    <SettingsSection title="官方 Lark MCP（实验性）" description="为选定工作区接入官方 OpenAPI MCP。App Secret 使用系统加密存储，运行时注入，不会写入工作区 mcp.json、Skill 或聊天消息。">
      <SettingsCard divided={false}>
        <div className="px-4 py-4 space-y-4 text-sm">
          <div className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
            官方 MCP 仍处于 Beta。请创建或选择一个专用于 MCP 的飞书应用，配置 OAuth 回调地址 <code>http://localhost:3000/callback</code>，并为该应用开通文档、Base/多维表格和日历所需权限。日历通常需要用户权限 <code>calendar:calendar</code>、<code>calendar:calendar:read</code>；不要复用或粘贴 CLI token。
          </div>
          {status?.configured ? (
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
              <div>MCP 应用已配置：<span className="font-medium text-foreground">{status.appId}</span>（Secret 已加密保存，不可查看）</div>
              <div>已启用工作区：{status.enabledWorkspaces.length ? status.enabledWorkspaces.join('、') : '无'}</div>
            </div>
          ) : (
            <div className="space-y-2">
              <SettingsInput label="MCP App ID" value={appId} onChange={setAppId} placeholder="cli_xxxxx" />
              <SettingsSecretInput label="MCP App Secret" value={appSecret} onChange={setAppSecret} placeholder="仅保存到本机加密存储" />
              <Button size="sm" onClick={() => void saveCredentials()} disabled={saving || !appId.trim() || !appSecret.trim()} className="gap-1.5">{saving && <Loader2 size={14} className="animate-spin" />}安全保存 MCP 凭据</Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={workspaceSlug} onValueChange={setWorkspaceSlug}>
              <SelectTrigger className="h-8 w-[190px]"><SelectValue placeholder="选择工作区" /></SelectTrigger>
              <SelectContent>{workspaces.map((workspace) => <SelectItem key={workspace.slug} value={workspace.slug}>{workspace.name}</SelectItem>)}</SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={() => void testConnection()} disabled={saving || !status?.configured} className="gap-1.5">{saving && <Loader2 size={14} className="animate-spin" />}测试连接</Button>
            <Button size="sm" onClick={() => void login()} disabled={saving || !status?.configured} className="gap-1.5">{saving && <Loader2 size={14} className="animate-spin" />}进行用户授权</Button>
            <Button size="sm" onClick={() => void enable()} disabled={saving || !status?.configured || !workspaceSlug}>启用到工作区</Button>
            <Button size="sm" variant="outline" onClick={() => void disable()} disabled={saving || !workspaceSlug}>停用</Button>
          </div>
          {loginEvent?.authorizationUrl && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="text-xs text-foreground">{loginEvent.message}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => openLink(loginEvent.authorizationUrl!)} className="gap-1.5"><ExternalLink size={14} />打开授权页</Button>
                <Button size="sm" variant="outline" onClick={copyLoginUrl} className="gap-1.5"><Copy size={14} />复制链接</Button>
                <Button size="sm" variant="ghost" onClick={() => void window.electronAPI.cancelLarkMcpLogin()}>取消</Button>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">当前已启用云文档、Base/多维表格和日历工具集（查询/创建/更新日历事件、查询忙闲与主日历）。请先完成 MCP 用户授权，再启用工作区；启用后，从该工作区新建的 Claude 与 Pi Agent 会话会发现相同的 Lark MCP 工具。</p>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 绑定卡片组件 =====

interface FeishuBindingCardProps {
  binding: FeishuChatBinding
  onUpdate: (chatId: string, updates: { workspaceId?: string; sessionId?: string }) => void
  onRemove: (chatId: string) => void
}

function FeishuBindingCard({ binding, onUpdate, onRemove }: FeishuBindingCardProps): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessions = useAtomValue(agentSessionsAtom)

  const isGroup = binding.chatType === 'group'
  const displayName = isGroup ? (binding.groupName ?? '未知群组') : '单聊'

  // 当前绑定工作区下的会话列表
  const workspaceSessions = React.useMemo(
    () => sessions.filter(isVisibleAgentSession).filter((s) => s.workspaceId === binding.workspaceId),
    [sessions, binding.workspaceId]
  )

  const currentWorkspace = workspaces.find((w) => w.id === binding.workspaceId)
  const currentSession = sessions.find((s) => s.id === binding.sessionId && isVisibleAgentSession(s))

  return (
    <div className="px-4 py-3 space-y-3">
      {/* 头部：类型图标 + 名称 + 删除 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={cn(
            'flex items-center justify-center w-8 h-8 rounded-lg',
            isGroup ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-green-500/10 text-green-600 dark:text-green-400'
          )}>
            {isGroup ? <Users size={16} /> : <User size={16} />}
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">{displayName}</div>
            <div className="text-xs text-muted-foreground">
              {isGroup ? '群聊' : '私聊'} · {new Date(binding.createdAt).toLocaleDateString('zh-CN')}
            </div>
          </div>
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive">
              <Trash2 size={14} />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>解除绑定</AlertDialogTitle>
              <AlertDialogDescription>
                确定要解除「{displayName}」的飞书聊天绑定吗？解除后下次在飞书发消息会自动创建新绑定。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => onRemove(binding.chatId)}>
                确认解除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* 工作区选择 */}
      <div className="grid grid-cols-[80px_1fr] gap-2 items-center text-sm">
        <span className="text-muted-foreground">工作区</span>
        <Select
          value={binding.workspaceId}
          onValueChange={(value) => onUpdate(binding.chatId, { workspaceId: value })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="选择工作区">
              {currentWorkspace?.name ?? '未知工作区'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 会话显示 */}
        <span className="text-muted-foreground">会话</span>
        <Select
          value={binding.sessionId}
          onValueChange={(value) => onUpdate(binding.chatId, { sessionId: value })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="选择会话">
              {currentSession?.title ?? binding.sessionId.slice(0, 8)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaceSessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

// ===== 绑定管理 Tab =====

function FeishuBindingsTab(): React.ReactElement {
  const bindings = useAtomValue(feishuBindingsAtom)
  const setBindings = useSetAtom(feishuBindingsAtom)
  const botStates = useAtomValue(feishuBotStatesAtom)
  const [refreshing, setRefreshing] = React.useState(false)

  const anyConnected = Object.values(botStates).some((b) => b.status === 'connected')

  // 刷新绑定列表
  const refreshBindings = React.useCallback(async () => {
    setRefreshing(true)
    try {
      const list = await window.electronAPI.listFeishuBindings()
      setBindings(list)
    } catch {
      toast.error('获取绑定列表失败')
    } finally {
      setRefreshing(false)
    }
  }, [setBindings])

  // 进入 Tab 时自动刷新
  React.useEffect(() => {
    refreshBindings()
  }, [refreshBindings])

  // 有 Bot 连接时刷新
  React.useEffect(() => {
    if (anyConnected) {
      refreshBindings()
    }
  }, [anyConnected, refreshBindings])

  // 更新绑定
  const handleUpdate = React.useCallback(async (chatId: string, updates: { workspaceId?: string; sessionId?: string }) => {
    try {
      const result = await window.electronAPI.updateFeishuBinding({ chatId, ...updates })
      if (result) {
        setBindings((prev) => prev.map((b) => b.chatId === chatId ? result : b))
        toast.success('绑定已更新')
      }
    } catch {
      toast.error('更新绑定失败')
    }
  }, [setBindings])

  // 移除绑定
  const handleRemove = React.useCallback(async (chatId: string) => {
    try {
      const ok = await window.electronAPI.removeFeishuBinding(chatId)
      if (ok) {
        setBindings((prev) => prev.filter((b) => b.chatId !== chatId))
        toast.success('绑定已解除')
      }
    } catch {
      toast.error('解除绑定失败')
    }
  }, [setBindings])

  // 按类型分组：群聊 + 单聊
  const groupBindings = bindings.filter((b) => b.chatType === 'group')
  const p2pBindings = bindings.filter((b) => b.chatType !== 'group')

  return (
    <div className="space-y-8">
      <SettingsSection
        title="绑定管理"
        description="查看和管理飞书聊天与 Profer 工作区/会话的绑定关系"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={refreshBindings}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
            <span className="ml-1.5">刷新</span>
          </Button>
        }
      >
        {bindings.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              暂无活跃绑定。启动 Bridge 后在飞书中发消息即可自动创建绑定。
            </div>
          </SettingsCard>
        ) : (
          <div className="space-y-4">
            {/* 群聊绑定 */}
            {groupBindings.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  群聊 ({groupBindings.length})
                </div>
                <SettingsCard>
                  {groupBindings.map((binding) => (
                    <FeishuBindingCard
                      key={binding.chatId}
                      binding={binding}
                      onUpdate={handleUpdate}
                      onRemove={handleRemove}
                    />
                  ))}
                </SettingsCard>
              </div>
            )}

            {/* 单聊绑定 */}
            {p2pBindings.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  单聊 ({p2pBindings.length})
                </div>
                <SettingsCard>
                  {p2pBindings.map((binding) => (
                    <FeishuBindingCard
                      key={binding.chatId}
                      binding={binding}
                      onUpdate={handleUpdate}
                      onRemove={handleRemove}
                    />
                  ))}
                </SettingsCard>
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

// ===== 扫码注册 Dialog =====

interface RegisterFeishuDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 注册成功后回调，返回主进程拿到的 App ID/Secret；上层应在此处保存配置并启动 Bot */
  onSuccess: (result: { appId: string; appSecret: string }) => void
}

/** 扫码注册飞书 Bot：弹窗内全程引导，扫码成功后自动保存配置并启动 Bot */
function RegisterFeishuDialog({ open, onOpenChange, onSuccess }: RegisterFeishuDialogProps): React.ReactElement {
  const [qrcode, setQrcode] = React.useState<FeishuRegisterAppQRCode | null>(null)
  const [status, setStatus] = React.useState<FeishuRegisterAppStatus | null>(null)
  const [phase, setPhase] = React.useState<'idle' | 'qrcode' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = React.useState<string>('')

  // 用 ref 持有最新的 onSuccess，避免依赖 onSuccess 后回调引用变化触发整个 effect 重启
  // 重启会调 cancelFeishuRegistration 中断当前正在等待扫码的流程
  const onSuccessRef = React.useRef(onSuccess)
  React.useLayoutEffect(() => {
    onSuccessRef.current = onSuccess
  })

  // 弹窗打开 → 监听推送 + 启动注册；关闭 → 解监听 + 取消
  React.useEffect(() => {
    if (!open) return

    let cancelled = false
    setPhase('idle')
    setErrorMsg('')
    setQrcode(null)
    setStatus(null)

    const offQr = window.electronAPI.onFeishuRegisterQrcode((payload) => {
      setQrcode(payload)
      setPhase('qrcode')
    })
    const offStatus = window.electronAPI.onFeishuRegisterStatus((payload) => {
      setStatus(payload)
    })

    window.electronAPI.registerFeishuApp()
      .then((result) => {
        if (cancelled) return
        setPhase('success')
        onSuccessRef.current({ appId: result.appId, appSecret: result.appSecret })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        // SDK 在 abort 时抛出的错误，关闭弹窗时不显示
        if (msg.includes('aborted') || msg.includes('Abort')) return
        setPhase('error')
        setErrorMsg(msg)
      })

    return () => {
      cancelled = true
      offQr()
      offStatus()
      window.electronAPI.cancelFeishuRegistration().catch(() => {})
    }
  }, [open])

  const handleOpenInBrowser = React.useCallback(() => {
    if (qrcode?.url) {
      window.electronAPI.openExternal(qrcode.url)
    }
  }, [qrcode])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode size={18} className="text-primary" />
            扫码创建飞书 Bot
          </DialogTitle>
          <DialogDescription>
            飞书后端将自动创建一个 PersonalAgent 应用，扫码完成后 Profer 会自动保存凭证并启动 Bot，整个过程无需手动复制 App ID / Secret。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          {phase === 'idle' && (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 size={24} className="animate-spin" />
              <span>正在向飞书申请二维码…</span>
            </div>
          )}

          {phase === 'qrcode' && qrcode && (
            <>
              <div className="bg-white rounded-lg p-3 shadow-sm">
                {qrcode.dataUrl ? (
                  <img
                    src={qrcode.dataUrl}
                    alt="飞书扫码注册二维码"
                    className="w-[240px] h-[240px] block"
                  />
                ) : (
                  <div className="w-[240px] h-[240px] flex items-center justify-center text-xs text-muted-foreground">
                    二维码生成失败，请用浏览器打开
                  </div>
                )}
              </div>
              <div className="text-sm text-foreground text-center">
                用飞书 App 「扫一扫」，按提示完成应用创建
              </div>
              <div className="text-xs text-muted-foreground text-center">
                {status?.status === 'polling' && '等待扫码确认中…'}
                {status?.status === 'slow_down' && '轮询节奏已自动放慢'}
                {status?.status === 'domain_switched' && '已切换到国际版域名'}
                {!status && '二维码已就绪'}
              </div>
              <Button
                variant="link"
                size="sm"
                onClick={handleOpenInBrowser}
                className="h-auto p-0 text-xs"
              >
                或在浏览器中打开链接
              </Button>
            </>
          )}

          {phase === 'success' && (
            <div className="w-full flex flex-col items-center gap-4 py-2">
              <div className="flex flex-col items-center gap-2 text-sm">
                <CheckCircle2 size={32} className="text-green-600" />
                <span className="text-foreground font-medium">应用创建成功</span>
                <span className="text-xs text-muted-foreground">已自动保存配置，正在启动 Bot…</span>
              </div>

              <p className="max-w-[300px] text-center text-xs leading-5 text-muted-foreground">
                现在就可以在飞书里搜索这个 Bot 并发送第一条消息。云文档和日历能力可稍后在高级设置中按工作区启用。
              </p>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center gap-2 py-8 text-sm">
              <XCircle size={32} className="text-red-600" />
              <span className="text-foreground font-medium">创建失败</span>
              <span className="text-xs text-muted-foreground text-center max-w-[300px]">{errorMsg || '未知错误，请稍后重试'}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {phase === 'success' ? '关闭' : '取消'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 用于将新名称生成的占位符（参考 handleAddBot 的命名规则保持一致）
function defaultBotName(index: number): string {
  return `飞书助手 ${index + 1}`
}

// ===== Session 镜像设置 =====

const SESSION_SYNC_LABELS: Record<FeishuSessionSyncMode, string> = {
  off: '关闭',
  stream: '实时同步到飞书群',
}

function normalizeSessionMirrorSettings(settings: FeishuSessionMirrorSettings | undefined): FeishuSessionMirrorSettings {
  return settings?.mode === 'stream'
    ? { mode: 'stream', botId: settings.botId }
    : { mode: 'off' }
}

function SessionMirrorSection({ bots }: { bots: FeishuBotConfig[] }): React.ReactElement {
  const [settings, setSettings] = React.useState<FeishuSessionMirrorSettings>({ mode: 'off' })
  const [bindings, setBindings] = React.useState<FeishuChatBinding[]>([])
  const enabledBots = React.useMemo(
    () => bots.filter((bot) => bot.enabled && bot.appId),
    [bots],
  )
  const selectedBot = React.useMemo(
    () => enabledBots.find((bot) => bot.id === settings.botId),
    [enabledBots, settings.botId],
  )
  const selectedBotHasBinding = React.useMemo(
    () => Boolean(settings.botId && bindings.some((binding) =>
      binding.botId === settings.botId && binding.userId && binding.userId !== 'unknown'
    )),
    [bindings, settings.botId],
  )
  const showBotBindingWarning = settings.mode === 'stream' && Boolean(settings.botId) && !selectedBotHasBinding

  React.useEffect(() => {
    window.electronAPI.getSettings()
      .then((appSettings) => {
        setSettings(normalizeSessionMirrorSettings(appSettings.feishuSessionMirror))
      })
      .catch(() => {})

    window.electronAPI.listFeishuBindings()
      .then(setBindings)
      .catch(() => {})
  }, [])

  const saveSettings = React.useCallback(async (next: FeishuSessionMirrorSettings) => {
    setSettings(next)
    try {
      await window.electronAPI.updateSettings({ feishuSessionMirror: next })
      toast.success('飞书 Session 镜像设置已更新')
    } catch {
      toast.error('保存飞书 Session 镜像设置失败')
    }
  }, [])

  const handleModeChange = React.useCallback((value: string) => {
    const mode = value as FeishuSessionSyncMode
    const fallbackBotId = settings.botId ?? enabledBots[0]?.id
    const next: FeishuSessionMirrorSettings = mode === 'stream'
      ? { mode, botId: fallbackBotId }
      : { mode, botId: settings.botId }
    saveSettings(next).catch(() => {})
  }, [enabledBots, saveSettings, settings.botId])

  const handleBotChange = React.useCallback((botId: string) => {
    saveSettings({ ...settings, botId }).catch(() => {})
  }, [saveSettings, settings])

  return (
    <SettingsSection
      title="同步到飞书"
      description="开启后，每个新的 Profer Agent Session 会创建一个仅包含你和指定 Bot 的飞书群，并把输出同步到群内卡片，同时默认阻止电脑自动休眠，方便你脱离电脑在飞书上继续完成工作。"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-[180px_1fr] md:items-center">
            <div className="text-sm font-medium text-foreground">同步方式</div>
            <Select value={settings.mode} onValueChange={handleModeChange}>
              <SelectTrigger className="h-9">
                <SelectValue>{SESSION_SYNC_LABELS[settings.mode]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">关闭</SelectItem>
                <SelectItem value="stream">实时同步到飞书群</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 md:grid-cols-[180px_1fr] md:items-center">
            <div className="text-sm font-medium text-foreground">同步 Bot</div>
            <Select
              value={settings.botId ?? ''}
              onValueChange={handleBotChange}
              disabled={enabledBots.length === 0}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={enabledBots.length === 0 ? '先启用一个 Bot' : '选择同步 Bot'} />
              </SelectTrigger>
              <SelectContent>
                {enabledBots.map((bot) => (
                  <SelectItem key={bot.id} value={bot.id}>{bot.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-blue-500/10 px-3 py-3 text-xs text-blue-700 dark:text-blue-300">
            <MessageSquare size={15} className="mt-0.5 flex-shrink-0" />
            <div className="leading-relaxed">
              实时同步模式下，一个 Profer Session 对应一个飞书群。即使配置了多个 Bot，也只会使用这里选中的 Bot，避免同一 Session 被多个 Bot 重复建群或拆散上下文。
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-3 text-xs text-amber-800 dark:text-amber-300">
            <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
            <div className="space-y-1 leading-relaxed">
              <div className="font-medium text-amber-900 dark:text-amber-200">想在仅你和 Bot 的群里不 @Bot 也能继续发送消息，需要额外申请两个权限。</div>
              <div>
                请在飞书开放平台为同步 Bot 申请并发布以下权限：
              </div>
              <div className="flex flex-col gap-1 pl-1">
                <div>
                  <code className="rounded bg-amber-500/15 px-1 py-0.5 text-[11px] text-amber-900 dark:text-amber-100">im:message.group_msg</code>
                  {' '}— 接收群聊中所有用户消息（否则飞书不会把非 @ 的群消息推送给 Profer）
                </div>
                <div>
                  <code className="rounded bg-amber-500/15 px-1 py-0.5 text-[11px] text-amber-900 dark:text-amber-100">im:chat</code>
                  {' '}— 读取群基础信息以判断群里只有你和 Bot（缺少时无法识别 2 人群，仍需 @Bot）
                </div>
              </div>
              <div>
                两者都审核通过并发布后才会生效；任一缺失或审核未过时，仍需要在群里 @Bot 才能触发 Agent。一键复制的权限配置里已包含这两项，单独手动添加时请勿遗漏。
              </div>
            </div>
          </div>

          {showBotBindingWarning && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-3 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
              <div className="leading-relaxed">
                当前同步 Bot 还没有绑定记录。请先在飞书里向「{selectedBot?.name ?? '该 Bot'}」发送一条消息，Profer 记录你的 open_id 后才能自动为新 Session 建群。
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 单个 Bot 配置卡片 =====

interface BotConfigCardProps {
  bot: FeishuBotConfig
  state: FeishuBotBridgeState | undefined
  onSaved: () => void
  onRemoved: () => void
}

function BotConfigCard({ bot, state, onSaved, onRemoved }: BotConfigCardProps): React.ReactElement {
  const setBotStates = useSetAtom(feishuBotStatesAtom)
  const [name, setName] = React.useState(bot.name)
  const [appId, setAppId] = React.useState(bot.appId)
  const [appSecret, setAppSecret] = React.useState('')
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<FeishuTestResult | null>(null)
  const [expanded, setExpanded] = React.useState(!bot.appId) // 新建的 Bot 默认展开

  // 加载已有 secret（使用 bot-specific API）
  React.useEffect(() => {
    if (bot.appSecret && bot.id) {
      window.electronAPI.getDecryptedFeishuBotSecret?.(bot.id)
        .then((s: string) => { if (s) setAppSecret(s) })
        .catch(() => {
          // 回退到旧 API（兼容迁移前的首个 Bot）
          window.electronAPI.getDecryptedFeishuSecret?.()
            .then((s: string) => { if (s) setAppSecret(s) })
            .catch(() => {})
        })
    }
  }, [bot.id, bot.appSecret])

  const statusConfig = state ? STATUS_CONFIG[state.status] : STATUS_CONFIG.disconnected
  const isConnected = state?.status === 'connected' || state?.status === 'connecting'

  const handleSave = React.useCallback(async () => {
    if (!appId.trim() || !name.trim()) return
    try {
      await window.electronAPI.saveFeishuBotConfig({
        id: bot.id,
        name: name.trim(),
        enabled: true,
        appId: appId.trim(),
        appSecret: appSecret || '',
        defaultWorkspaceId: bot.defaultWorkspaceId,
        defaultChannelId: bot.defaultChannelId,
        defaultModelId: bot.defaultModelId,
      })
      toast.success(`Bot "${name}" 已保存`)
      onSaved()
    } catch {
      toast.error('保存配置失败')
    }
  }, [bot.id, name, appId, appSecret, onSaved])

  const handleTest = React.useCallback(async () => {
    if (!appId.trim() || !appSecret.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testFeishuConnection(appId.trim(), appSecret.trim())
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, message: `测试失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }, [appId, appSecret])

  /** 操作完成后主动拉取最新状态，确保 UI 同步 */
  const refreshBotStates = React.useCallback(async () => {
    try {
      const multiState = await window.electronAPI.getFeishuMultiStatus?.()
      if (multiState?.bots) {
        setBotStates(multiState.bots)
      }
    } catch { /* 忽略 */ }
  }, [setBotStates])

  const handleToggle = React.useCallback(async () => {
    if (isConnected) {
      await window.electronAPI.stopFeishuBot(bot.id)
      toast.success(`Bot "${bot.name}" 已停止`)
      await refreshBotStates()
    } else {
      // 启动是异步的（10-15秒），不阻塞等待完成
      // 先发起启动请求，然后轮询状态直到连接成功或失败
      window.electronAPI.startFeishuBot(bot.id).catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '启动失败')
        refreshBotStates()
      })
      // 短暂等待让主进程设置 connecting 状态
      await new Promise((r) => setTimeout(r, 300))
      await refreshBotStates()
      // 轮询直到状态不再是 connecting
      const poll = setInterval(async () => {
        try {
          const multiState = await window.electronAPI.getFeishuMultiStatus?.()
          if (multiState?.bots) {
            setBotStates(multiState.bots)
            const botState = multiState.bots[bot.id]
            if (!botState || botState.status !== 'connecting') {
              clearInterval(poll)
              if (botState?.status === 'connected') {
                toast.success(`Bot "${bot.name}" 已连接`)
              }
            }
          }
        } catch {
          clearInterval(poll)
        }
      }, 1000)
      // 安全超时：60秒后停止轮询
      setTimeout(() => clearInterval(poll), 60_000)
    }
  }, [bot.id, bot.name, isConnected, refreshBotStates, setBotStates])

  const handleRemove = React.useCallback(async () => {
    try {
      await window.electronAPI.removeFeishuBot(bot.id)
      toast.success(`Bot "${bot.name}" 已删除`)
      onRemoved()
    } catch {
      toast.error('删除失败')
    }
  }, [bot.id, bot.name, onRemoved])

  return (
    <SettingsCard>
      {/* 头部：名称 + 状态 + 展开/折叠 */}
      <div className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors">
        <button
          type="button"
          className="min-w-0 flex flex-1 items-center gap-3 text-left"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={`${bot.name || '未命名 Bot'}配置详情`}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.color}`} />
          <span className="font-medium text-sm truncate">{bot.name || '未命名 Bot'}</span>
          <span className="text-xs text-muted-foreground truncate">{bot.appId ? bot.appId.slice(0, 12) + '...' : '未配置'}</span>
          <span className="text-xs text-muted-foreground">{expanded ? '▾' : '▸'}</span>
        </button>
        <div className="ml-3 flex items-center gap-2">
          {isConnected ? (
            <Button size="sm" variant="outline" onClick={() => void handleToggle()}>
              <PowerOff size={14} className="mr-1" />
              停止
            </Button>
          ) : bot.appId ? (
            <Button size="sm" variant="outline" onClick={() => void handleToggle()}
              disabled={state?.status === 'connecting'}>
              {state?.status === 'connecting' ? <Loader2 size={14} className="animate-spin mr-1" /> : <Power size={14} className="mr-1" />}
              启动
            </Button>
          ) : null}
        </div>
      </div>

      {/* 展开的配置表单 */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          <SettingsInput
            label="Bot 名称"
            value={name}
            onChange={setName}
            placeholder="如：研发助手"
          />
          <SettingsInput
            label="App ID"
            value={appId}
            onChange={setAppId}
            placeholder="cli_xxxxxxxxxx"
          />
          <SettingsSecretInput
            label="App Secret"
            value={appSecret}
            onChange={setAppSecret}
            placeholder="输入 App Secret"
          />

          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={handleTest}
              disabled={testing || !appId.trim() || !appSecret.trim()}>
              {testing && <Loader2 size={14} className="animate-spin" />}
              <span>{testing ? '测试中...' : '测试连接'}</span>
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!appId.trim() || !name.trim()}>
              保存配置
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive">
                  <Trash2 size={14} className="mr-1" />
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除</AlertDialogTitle>
                  <AlertDialogDescription>
                    删除 Bot "{bot.name}" 将同时断开连接并清除所有绑定。此操作不可撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRemove}>删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {testResult && (
            <div className={cn(
              'p-3 rounded-lg flex items-start gap-2 text-sm',
              testResult.success ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'
            )}>
              {testResult.success
                ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                : <XCircle size={16} className="flex-shrink-0 mt-0.5" />
              }
              <span>{testResult.message}{testResult.botName && ` — ${testResult.botName}`}</span>
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

// ===== 一站式接入入口 =====

interface FeishuQuickStartProps {
  bots: FeishuBotConfig[]
  botStates: Record<string, FeishuBotBridgeState>
  onRegister: () => void
  onManualAdd: () => void
  onRefresh: () => void
  onTest: () => void
  testing: boolean
}

function FeishuQuickStart({ bots, botStates, onRegister, onManualAdd, onRefresh, onTest, testing }: FeishuQuickStartProps): React.ReactElement {
  const connectedBot = bots.find((bot) => botStates[bot.id]?.status === 'connected')
  const configuredBot = bots.find((bot) => bot.appId)
  const activeBot = connectedBot ?? configuredBot
  const status = connectedBot
    ? '已连接，可以开始使用'
    : configuredBot
      ? 'Bot 已保存，正在等待连接'
      : '还没有连接飞书 Bot'
  const statusTone = connectedBot
    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
    : configuredBot
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'bg-muted text-muted-foreground'

  return (
    <SettingsSection
      title="连接飞书"
      description="扫码创建一个 Bot，Profer 会自动保存并启动。完成后直接在飞书里发消息即可。"
    >
      <SettingsCard divided={false} className="overflow-hidden">
        <div className="px-4 py-4 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <MessageSquare size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">飞书 Bot</span>
                <span className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
                  statusTone,
                )}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', connectedBot ? 'bg-green-500' : configuredBot ? 'bg-amber-500' : 'bg-muted-foreground/50')} />
                  {status}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {activeBot ? `当前 Bot：${activeBot.name}` : '无需填写 App ID 或 App Secret'}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={onRefresh} className="shrink-0 gap-1.5" aria-label="刷新飞书连接状态">
              <RefreshCw size={14} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-3" aria-label="飞书接入步骤">
            {[
              ['1', '扫码创建', '用飞书扫一扫完成授权'],
              ['2', '自动启动', 'Profer 自动保存并连接'],
              ['3', '开始使用', '在飞书搜索 Bot 并发消息'],
            ].map(([number, title, description]) => (
              <div key={number} className="rounded-lg bg-muted/45 px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">{number}</span>
                  {title}
                </div>
                <p className="mt-1 pl-7 text-xs leading-5 text-muted-foreground">{description}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onRegister} className="gap-1.5">
              <QrCode size={14} />
              {bots.length ? '再创建一个 Bot' : '扫码创建飞书 Bot'}
            </Button>
            <Button size="sm" variant="outline" onClick={onTest} disabled={!activeBot || testing} className="gap-1.5">
              {testing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {testing ? '测试中…' : '测试连接'}
            </Button>
            <Button size="sm" variant="outline" onClick={onManualAdd} className="gap-1.5">
              <Plus size={14} />
              使用已有 Bot
            </Button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== Bot 配置 Tab（多 Bot 版本）=====

function FeishuConfigTab(): React.ReactElement {
  const botStates = useAtomValue(feishuBotStatesAtom)
  const setBotStates = useSetAtom(feishuBotStatesAtom)
  const [bots, setBots] = React.useState<FeishuBotConfig[]>([])
  const [loading, setLoading] = React.useState(true)
  const [testing, setTesting] = React.useState(false)
  const [advancedOpen, setAdvancedOpen] = React.useState(false)

  const loadBots = React.useCallback(async () => {
    try {
      const config = await window.electronAPI.getFeishuMultiConfig()
      setBots(config.bots)
    } catch {
      // fallback: 旧 API
      try {
        const oldConfig = await window.electronAPI.getFeishuConfig()
        if (oldConfig.appId) {
          setBots([{
            id: 'legacy',
            name: '飞书助手',
            enabled: oldConfig.enabled,
            appId: oldConfig.appId,
            appSecret: oldConfig.appSecret,
          }])
        }
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  // 进入 Tab 时同步最新状态，避免因启动时序问题导致颜色显示错误
  const refreshStates = React.useCallback(async () => {
    try {
      const multiState = await window.electronAPI.getFeishuMultiStatus?.()
      if (multiState?.bots) {
        setBotStates(multiState.bots)
      }
    } catch { /* 忽略 */ }
  }, [setBotStates])

  React.useEffect(() => {
    loadBots()
    refreshStates()
  }, [loadBots, refreshStates])

  const handleAddBot = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveFeishuBotConfig({
        name: defaultBotName(bots.length),
        enabled: false,
        appId: '',
        appSecret: '',
        defaultWorkspaceId: undefined,
        defaultChannelId: undefined,
        defaultModelId: undefined,
      })
      setBots((prev) => [...prev, saved])
    } catch {
      toast.error('创建 Bot 失败')
    }
  }, [bots.length])

  const [registerOpen, setRegisterOpen] = React.useState(false)

  const handleQuickTest = React.useCallback(async () => {
    const bot = bots.find((item) => botStates[item.id]?.status === 'connected') ?? bots.find((item) => item.appId)
    if (!bot?.appId) return
    setTesting(true)
    try {
      const secret = await window.electronAPI.getDecryptedFeishuBotSecret(bot.id)
      const result = await window.electronAPI.testFeishuConnection(bot.appId, secret)
      result.success ? toast.success(`连接测试通过${result.botName ? `：${result.botName}` : ''}`) : toast.error(result.message)
    } catch {
      toast.error('连接测试失败，请展开 Bot 管理查看详细信息')
    } finally {
      setTesting(false)
    }
  }, [botStates, bots])

  /** 扫码成功后：保存配置 + 自动启动 Bot */
  const handleRegisterSuccess = React.useCallback(async (result: { appId: string; appSecret: string }) => {
    try {
      const saved = await window.electronAPI.saveFeishuBotConfig({
        name: defaultBotName(bots.length),
        enabled: true,
        appId: result.appId,
        appSecret: result.appSecret,
        defaultWorkspaceId: undefined,
        defaultChannelId: undefined,
        defaultModelId: undefined,
      })
      setBots((prev) => [...prev, saved])
      toast.success(`Bot "${saved.name}" 已创建`)
      // 自动启动 Bot（不阻塞 UI）
      window.electronAPI.startFeishuBot(saved.id).catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '自动启动失败，请手动启动')
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存配置失败')
    }
  }, [bots.length])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* 视频教程（顶部最显眼处，未配置 URL 时自动隐藏） */}
      <FeishuTutorialVideo />

      <RegisterFeishuDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onSuccess={handleRegisterSuccess}
      />

      <FeishuQuickStart
        bots={bots}
        botStates={botStates}
        onRegister={() => setRegisterOpen(true)}
        onManualAdd={() => { setAdvancedOpen(true); void handleAddBot() }}
        onRefresh={() => { void refreshStates(); void loadBots() }}
        onTest={() => void handleQuickTest()}
        testing={testing}
      />

      <details
        className="group rounded-lg border border-border/60 bg-muted/10"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
          <span>高级设置与手动配置</span>
          <ChevronRight size={16} className="text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="space-y-8 border-t border-border/50 px-4 py-4">
          {/* 已连接的 Bot：配置完成后只需在这里维护 */}
          <SettingsSection
            title="Bot 管理"
            description="首次接入不用配置这里；需要修改凭证或管理多个 Bot 时再打开"
          >
            {bots.length === 0 ? (
              <SettingsCard divided={false}>
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  还没有配置飞书 Bot。点击上方「使用已有 Bot」后，在这里填写 App ID。
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

          <SessionMirrorSection bots={bots} />

          {/* 手动创建飞书 Bot 引导 */}
          <SettingsSection
            title="手动创建飞书 Bot"
            description="只有使用已有开发者应用时才需要这一步"
          >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-5 text-sm">
            {/* 步骤 1 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                <span className="font-medium text-foreground">创建自建应用</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                前往{' '}
                <Link href="https://open.feishu.cn/app">飞书开放平台</Link>
                {' '}（海外版：
                <Link href="https://open.larksuite.com/app">Lark 开放平台</Link>
                ），点击「创建自建应用」并填写名称描述。
              </p>
            </div>

            {/* 步骤 2 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                <span className="font-medium text-foreground">获取凭证</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入详情页，在「凭证与基础信息」中找到{' '}
                <span className="text-foreground font-medium">App ID</span> 和{' '}
                <span className="text-foreground font-medium">App Secret</span>，
                复制到上方的配置表单。
              </p>
            </div>

            {/* 步骤 3 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                <span className="font-medium text-foreground">启用机器人能力</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入「添加应用能力」页面，启用「机器人」能力。
                这样应用才能接收和发送飞书消息。
              </p>
            </div>

            {/* 步骤 4 */}
            <PermissionsStep />

            {/* 步骤 5 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">5</span>
                <span className="font-medium text-foreground">配置事件订阅（关键步骤）</span>
              </div>
              <div className="pl-7 space-y-2 text-muted-foreground">
                <p>
                  进入「事件与回调」页面，分别完成下面两项配置：
                </p>
                <div className="space-y-1.5">
                  <div className="text-foreground/80 font-medium text-xs">① 事件订阅</div>
                  <ol className="list-decimal pl-4 space-y-1">
                    <li>
                      订阅方式选择{' '}
                      <span className="text-foreground font-medium">「使用长连接接收事件」</span>
                      （而非 Webhook，无需公网 IP）
                    </li>
                    <li>
                      添加事件{' '}
                      <code className="bg-muted/50 px-1.5 py-0.5 rounded text-xs text-foreground/80">im.message.receive_v1</code>
                      {' '}（接收消息）
                    </li>
                  </ol>
                </div>
                <div className="space-y-1.5">
                  <div className="text-foreground/80 font-medium text-xs">② 回调配置</div>
                  <ol className="list-decimal pl-4 space-y-1">
                    <li>
                      回调方式同样选择{' '}
                      <span className="text-foreground font-medium">「使用长连接接收回调」</span>
                    </li>
                    <li>
                      添加回调{' '}
                      <code className="bg-muted/50 px-1.5 py-0.5 rounded text-xs text-foreground/80">card.action.trigger</code>
                      {' '}（卡片按钮回调，Profer 的流式卡片交互依赖此项）
                    </li>
                  </ol>
                </div>
              </div>
            </div>

            {/* 步骤 6 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">6</span>
                <span className="font-medium text-foreground">发布应用</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                进入「版本管理与发布」→ 创建版本 → 提交审核。
                需要企业管理员在{' '}
                <Link href="https://feishu.cn/admin">管理后台</Link>
                {' '}审核通过后，机器人才能正常使用。
              </p>
            </div>

            {/* 提示 */}
            <div className="pl-7 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              版本审核通过并发布后，在飞书中搜索机器人名称添加到聊天，
              即可通过飞书向 Profer Agent 发送指令。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

          {/* CLI 是默认的云端能力路径；先在目标工作区完成配置，再按需查看诊断或手动授权。 */}
          <FeishuCliSection />
          <LarkCloudCapabilitiesSection />

          {/* MCP 当前不展示给普通用户：它与 CLI 能力重叠且需要第二套 App/OAuth 配置。
              现有实现保留在代码中，待 CLI 覆盖不足时再作为实验性兜底入口开放。 */}
        </div>
      </details>

    </div>
  )
}

// ===== 主组件 =====

export function FeishuSettings(): React.ReactElement {
  return (
    <div className="space-y-6">
      {/* 默认只展示最短接入流程；绑定管理属于维护功能，不阻塞首次配置 */}
      <FeishuConfigTab />

      <details className="group rounded-lg border border-border/60 bg-muted/10">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
          <span>绑定管理</span>
          <ChevronRight size={16} className="text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="border-t border-border/50 px-4 py-4">
          <FeishuBindingsTab />
        </div>
      </details>
    </div>
  )
}
