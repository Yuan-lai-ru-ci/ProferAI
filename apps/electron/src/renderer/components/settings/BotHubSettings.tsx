/**
 * BotHubSettings - 多平台机器人连接设置 Hub
 *
 * 左侧平台选择栏 + 右侧配置面板。
 * 支持飞书、钉钉、微信（WeClaw）三个平台。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { BriefcaseBusiness, ChevronRight, Globe, Image, Smartphone } from 'lucide-react'
import { feishuBotStatesAtom } from '@/atoms/feishu-atoms'
import { dingtalkBotStatesAtom } from '@/atoms/dingtalk-atoms'
import { wechatBridgeStateAtom } from '@/atoms/wechat-atoms'
import { FeishuSettings } from './FeishuSettings'
import { DingTalkSettings } from './DingTalkSettings'
import { WeChatSettings } from './WeChatSettings'
import { BotDefaultSettings } from './BotDefaultSettings'
import { ProferLogoSettings } from './ProferLogoSettings'
import { PocketModeSettings } from './PocketModeSettings'
import { WebuiSettings } from './WebuiSettings'
import feishuLogo from '@/assets/bots/feishu.png'
import dingtalkLogo from '@/assets/bots/dingding.png'
import wechatLogo from '@/assets/bots/wechat.png'
import proferModelLogo from '@/assets/models/profer.png'

// ===== 类型 =====

type BotPlatformId = 'feishu' | 'dingtalk' | 'wechat' | 'pocket' | 'webui' | 'defaults' | 'logos'

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
    id: 'webui',
    name: 'Web 会话',
    icon: <Globe size={16} aria-hidden="true" />,
    iconTextClass: 'text-emerald-600',
  },
  {
    id: 'pocket',
    name: '移动模式（试验版）',
    icon: <Smartphone size={16} aria-hidden="true" />,
    iconTextClass: 'text-violet-600',
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

/** 连接状态颜色映射 */
const BRIDGE_STATUS_COLORS = {
  disconnected: 'bg-gray-400',
  connecting: 'bg-yellow-400 animate-pulse',
  connected: 'bg-green-500',
  error: 'bg-red-500',
} as const

// ===== 子组件 =====

/** 平台连接状态指示点 */
function PlatformStatusDot({ platformId }: { platformId: BotPlatformId }): React.ReactElement | null {
  const feishuBotStates = useAtomValue(feishuBotStatesAtom)
  const dingtalkBotStates = useAtomValue(dingtalkBotStatesAtom)
  const wechatState = useAtomValue(wechatBridgeStateAtom)

  if (platformId === 'defaults' || platformId === 'logos' || platformId === 'pocket' || platformId === 'webui') return null

  const statusMap: Record<string, string> = {
    feishu: getPlatformStatus(feishuBotStates),
    dingtalk: getPlatformStatus(dingtalkBotStates),
    wechat: wechatState.status,
  }
  const status = statusMap[platformId] ?? 'disconnected'
  const colorClass = BRIDGE_STATUS_COLORS[status as keyof typeof BRIDGE_STATUS_COLORS] ?? 'bg-gray-400'

  return (
    <span
      aria-label={`连接状态：${status}`}
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        isActive
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
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
        <span className={cn('flex h-5 w-5 items-center justify-center', platform.iconTextClass)}>
          {platform.icon}
        </span>
      )}

      {/* 名称 */}
      <span className="min-w-0 truncate">{platform.name}</span>
      <PlatformStatusDot platformId={platform.id} />
      {isActive && <ChevronRight size={14} className="ml-auto shrink-0" aria-hidden="true" />}
    </button>
  )
}

/** 平台能力提示：不同平台的接入方式和能力边界差别很大，进面板先讲清楚 */
const PLATFORM_CAPABILITY_NOTES: Record<BotPlatformId, string> = {
  webui: '一个会话对应一个网页：选网卡、端口并发布会话后，用浏览器打开生成的地址即可查看与交流。',
  pocket: '手机 / 平板连接本机 Profer：扫码配对，需同一局域网或自建公网入口。',
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
      return <div className="space-y-5">{note}<PocketModeSettings /></div>
    case 'webui':
      return <div className="space-y-5">{note}<WebuiSettings /></div>
    case 'defaults':
      return <div className="space-y-5">{note}<BotDefaultSettings /></div>
    case 'logos':
      return <div className="space-y-5">{note}<ProferLogoSettings /></div>
  }
}

// ===== 主组件 =====

export function BotHubSettings(): React.ReactElement {
  const [selectedPlatform, setSelectedPlatform] = React.useState<BotPlatformId>('webui')

  return (
    <div className="space-y-5">
      <nav className="-mx-1 flex min-w-0 gap-1 overflow-x-auto border-b border-border/60 px-1" aria-label="远程连接平台">
        {PLATFORMS.map((p) => (
          <PlatformSidebarItem
            key={p.id}
            platform={p}
            isActive={selectedPlatform === p.id}
            onClick={() => setSelectedPlatform(p.id)}
          />
        ))}
      </nav>
      <div
        id={`bot-settings-panel-${selectedPlatform}`}
        role="region"
        aria-labelledby={`bot-settings-tab-${selectedPlatform}`}
        aria-live="polite"
      >
        {renderPlatformPanel(selectedPlatform)}
      </div>
    </div>
  )
}
