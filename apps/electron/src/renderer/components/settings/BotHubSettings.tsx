/**
 * BotHubSettings - 多平台机器人连接设置 Hub
 *
 * 按设备、消息平台与偏好分组导航，右侧展示对应连接管理。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { ArrowUpRight, BriefcaseBusiness, Cpu, Image, Smartphone } from 'lucide-react'
import { feishuBotStatesAtom } from '@/atoms/feishu-atoms'
import { dingtalkBotStatesAtom } from '@/atoms/dingtalk-atoms'
import { wechatBridgeStateAtom } from '@/atoms/wechat-atoms'
import { FeishuSettings } from './FeishuSettings'
import { DingTalkSettings } from './DingTalkSettings'
import { WeChatSettings } from './WeChatSettings'
import { BotDefaultSettings } from './BotDefaultSettings'
import { ProferLogoSettings } from './ProferLogoSettings'
import { PocketModeSettings } from './PocketModeSettings'
import { RemoteCoreSettings } from './RemoteCoreSettings'
import feishuLogo from '@/assets/bots/feishu.png'
import dingtalkLogo from '@/assets/bots/dingding.png'
import wechatLogo from '@/assets/bots/wechat.png'
import proferModelLogo from '@/assets/models/profer.png'

// ===== 类型 =====

type BotPlatformId = 'feishu' | 'dingtalk' | 'wechat' | 'pocket' | 'core' | 'defaults' | 'logos'

interface BotPlatformDef {
  id: BotPlatformId
  name: string
  /** Logo 图片 src（有图片时使用） */
  iconSrc?: string
  icon?: React.ReactNode
  iconTextClass?: string
}

// ===== 平台定义 =====

const PLATFORMS: readonly BotPlatformDef[] = [
  {
    id: 'pocket',
    name: '移动端连接',
    icon: <Smartphone size={16} aria-hidden="true" />,
    iconTextClass: 'text-muted-foreground',
  },
  {
    id: 'core',
    name: '内核连接',
    icon: <Cpu size={16} aria-hidden="true" />,
    iconTextClass: 'text-primary',
  },
  {
    id: 'feishu',
    name: '飞书',
    iconSrc: feishuLogo,
  },
  {
    id: 'wechat',
    name: '微信',
    iconSrc: wechatLogo,
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    iconSrc: dingtalkLogo,
  },
  {
    id: 'defaults',
    name: '用法',
    icon: <BriefcaseBusiness size={16} aria-hidden="true" />,
    iconTextClass: 'text-muted-foreground',
  },
  {
    id: 'logos',
    name: '品牌素材',
    icon: <Image size={16} aria-hidden="true" />,
    iconSrc: proferModelLogo,
  },
] as const

/** 状态颜色只作辅助，连接状态同时提供文字语义。 */
const BRIDGE_STATUS_COLORS = {
  disconnected: 'bg-muted-foreground/40',
  connecting: 'bg-warning',
  connected: 'bg-success',
  error: 'bg-destructive',
} as const
const BRIDGE_STATUS_LABELS: Record<string, string> = {
  disconnected: '未连接', connecting: '连接中', connected: '已连接', error: '连接异常',
}

// ===== 子组件 =====

/** 平台连接状态指示点 */
function PlatformStatusDot({ platformId }: { platformId: BotPlatformId }): React.ReactElement | null {
  const feishuBotStates = useAtomValue(feishuBotStatesAtom)
  const dingtalkBotStates = useAtomValue(dingtalkBotStatesAtom)
  const wechatState = useAtomValue(wechatBridgeStateAtom)

  if (platformId === 'defaults' || platformId === 'logos' || platformId === 'pocket' || platformId === 'core') return null

  const statusMap: Record<string, string> = {
    feishu: getPlatformStatus(feishuBotStates),
    dingtalk: getPlatformStatus(dingtalkBotStates),
    wechat: wechatState.status,
  }
  const status = statusMap[platformId] ?? 'disconnected'
  const colorClass = BRIDGE_STATUS_COLORS[status as keyof typeof BRIDGE_STATUS_COLORS] ?? 'bg-muted-foreground/40'

  return (
    <span
      title={BRIDGE_STATUS_LABELS[status] ?? '未连接'}
      aria-label={`连接状态：${BRIDGE_STATUS_LABELS[status] ?? '未连接'}`}
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colorClass)}
    />
  )
}

/** 从多 Bot 状态推导平台级状态：任一 connected → connected，否则按 error > connecting > disconnected 优先级 */
function getPlatformStatus(states: Record<string, { status: string }>): string {
  const values = Object.values(states)
  if (values.length === 0) return 'disconnected'
  if (values.some((s) => s.status === 'connected')) return 'connected'
  if (values.some((s) => s.status === 'error')) return 'error'
  if (values.some((s) => s.status === 'connecting')) return 'connecting'
  return 'disconnected'
}

/** 左侧平台选择项 */
function PlatformSidebarItem({
  platform,
  isActive,
  onClick,
}: {
  platform: BotPlatformDef
  isActive: boolean
  onClick: () => void
}): React.ReactElement {
  const isDevice = platform.id === 'pocket' || platform.id === 'core'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex min-w-0 items-center gap-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none',
        isDevice ? 'rounded-xl border px-4 py-3' : 'rounded-lg px-2.5 py-2',
        isActive
          ? isDevice ? 'border-foreground/20 bg-card text-foreground shadow-sm' : 'bg-muted text-foreground font-medium'
          : isDevice ? 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/70' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
      id={`bot-settings-tab-${platform.id}`}
      aria-current={isActive ? 'page' : undefined}
      aria-controls={`bot-settings-panel-${platform.id}`}
      aria-label={platform.name}
    >
      {/* 平台图标 */}
      {platform.iconSrc ? (
        <img src={platform.iconSrc} alt="" className="h-5 w-5 rounded object-contain" />
      ) : (
        <span className={cn('flex shrink-0 items-center justify-center', isDevice ? 'size-8 rounded-lg bg-background shadow-sm' : 'size-5')}>
          {platform.icon}
        </span>
      )}

      {/* 名称 */}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', isDevice && 'font-semibold text-foreground')}>{platform.name}</span>
      </span>
      {isDevice ? <ArrowUpRight className={cn('size-4 shrink-0 transition-colors', isActive ? 'text-foreground' : 'text-muted-foreground/50')} aria-hidden="true" /> : <PlatformStatusDot platformId={platform.id} />}
    </button>
  )
}

/** 平台能力提示：不同平台的接入方式和能力边界差别很大，进面板先讲清楚 */
const PLATFORM_CAPABILITY_NOTES: Record<BotPlatformId, string> = {
  pocket: '手机 / 平板连接本机 Profer：扫码配对，需同一局域网或自建公网入口。',
  core: '桌面 Profer 连接已部署的远程内核，与手机连接本机的移动模式独立。',
  feishu: '扫码创建自建应用即可接入 · 支持多 Bot、群聊、会话绑定管理与会话镜像。',
  wechat: '扫码登录你的微信账号 · 单账号、仅单聊，不支持多 Bot 与群聊。',
  dingtalk: '需先在钉钉开放平台创建企业内部应用 · 支持多 Bot 与群聊。',
  defaults: '所有平台共享的默认工作区与命令说明。',
  logos: '机器人回复中使用的品牌素材。',
}

function PlatformCapabilityNote({ text }: { text: string }): React.ReactElement {
  return (
    <p className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
      {text}
    </p>
  )
}

/** 根据平台 ID 渲染对应设置组件 */
function renderPlatformPanel(id: BotPlatformId): React.ReactElement {
  const note = <PlatformCapabilityNote text={PLATFORM_CAPABILITY_NOTES[id]} />

  switch (id) {
    case 'feishu':
      return <div className="space-y-5">{note}<FeishuSettings /></div>
    case 'dingtalk':
      return <div className="space-y-5">{note}<DingTalkSettings /></div>
    case 'wechat':
      return <div className="space-y-5">{note}<WeChatSettings /></div>
    case 'pocket':
      return <PocketModeSettings />
    case 'core':
      return <RemoteCoreSettings />
    case 'defaults':
      return <div className="space-y-5">{note}<BotDefaultSettings /></div>
    case 'logos':
      return <div className="space-y-5">{note}<ProferLogoSettings /></div>
  }
}

// ===== 主组件 =====

export function BotHubSettings(): React.ReactElement {
  const [selectedPlatform, setSelectedPlatform] = React.useState<BotPlatformId>('pocket')

  return (
    <div className="min-w-0 space-y-6">
      <nav className="space-y-3" aria-label="远程连接平台">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="设备与内核">
          {PLATFORMS.filter(platform => platform.id === 'pocket' || platform.id === 'core').map(platform => <PlatformSidebarItem key={platform.id} platform={platform} isActive={selectedPlatform === platform.id} onClick={() => setSelectedPlatform(platform.id)} />)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50 pb-4">
          <div className="flex flex-wrap items-center gap-1" aria-label="消息平台">
            {PLATFORMS.filter(platform => ['feishu', 'wechat', 'dingtalk'].includes(platform.id)).map(platform => <PlatformSidebarItem key={platform.id} platform={platform} isActive={selectedPlatform === platform.id} onClick={() => setSelectedPlatform(platform.id)} />)}
          </div>
          <div className="flex flex-wrap gap-1" aria-label="连接偏好">
            {PLATFORMS.filter(platform => platform.id === 'defaults' || platform.id === 'logos').map(platform => <PlatformSidebarItem key={platform.id} platform={platform} isActive={selectedPlatform === platform.id} onClick={() => setSelectedPlatform(platform.id)} />)}
          </div>
        </div>
      </nav>
      <div
        className="min-w-0 pt-1"
        id={`bot-settings-panel-${selectedPlatform}`}
        role="region"
        aria-labelledby={`bot-settings-tab-${selectedPlatform}`}
      >
        {renderPlatformPanel(selectedPlatform)}
      </div>
    </div>
  )
}
