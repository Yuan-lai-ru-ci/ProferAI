/**
 * BotHubSettings - 多平台机器人连接设置 Hub
 *
 * 左侧平台选择栏 + 右侧配置面板。
 * 支持飞书、钉钉、微信（WeClaw）三个平台。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { feishuBridgeStateAtom } from '@/atoms/feishu-atoms'
import { FeishuSettings } from './FeishuSettings'
import { DingTalkSettings } from './DingTalkSettings'
import { WeChatSettings } from './WeChatSettings'

// ===== 类型 =====

type BotPlatformId = 'feishu' | 'dingtalk' | 'wechat'

interface BotPlatformDef {
  id: BotPlatformId
  name: string
  /** 图标中显示的字符 */
  iconChar: string
  iconBgClass: string
  iconTextClass: string
}

// ===== 平台定义 =====

const PLATFORMS: readonly BotPlatformDef[] = [
  {
    id: 'feishu',
    name: '飞书',
    iconChar: '飞',
    iconBgClass: 'bg-blue-500/15',
    iconTextClass: 'text-blue-600 dark:text-blue-400',
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    iconChar: '钉',
    iconBgClass: 'bg-orange-500/15',
    iconTextClass: 'text-orange-600 dark:text-orange-400',
  },
  {
    id: 'wechat',
    name: '微信',
    iconChar: '微',
    iconBgClass: 'bg-green-500/15',
    iconTextClass: 'text-green-600 dark:text-green-400',
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
function PlatformStatusDot({ platformId }: { platformId: BotPlatformId }): React.ReactElement {
  const feishuState = useAtomValue(feishuBridgeStateAtom)

  // 飞书读取真实状态，其他平台暂时显示灰点
  const colorClass = platformId === 'feishu'
    ? BRIDGE_STATUS_COLORS[feishuState.status]
    : 'bg-gray-400'

  return <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', colorClass)} />
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
        'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors text-left',
        isActive
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
    >
      {/* 平台图标 */}
      <div className={cn(
        'flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold flex-shrink-0',
        platform.iconBgClass,
        platform.iconTextClass,
      )}>
        {platform.iconChar}
      </div>

      {/* 名称 */}
      <span className="text-sm font-medium flex-1 min-w-0 truncate">
        {platform.name}
      </span>

      {/* 状态点 */}
      <PlatformStatusDot platformId={platform.id} />
    </button>
  )
}

/** 根据平台 ID 渲染对应设置组件 */
function renderPlatformPanel(id: BotPlatformId): React.ReactElement {
  switch (id) {
    case 'feishu':
      return <FeishuSettings />
    case 'dingtalk':
      return <DingTalkSettings />
    case 'wechat':
      return <WeChatSettings />
  }
}

// ===== 主组件 =====

export function BotHubSettings(): React.ReactElement {
  const [selectedPlatform, setSelectedPlatform] = React.useState<BotPlatformId>('feishu')

  return (
    <div className="flex -mx-6 -my-4 h-full">
      {/* 左侧平台选择栏 */}
      <div className="w-[140px] border-r border-border/50 py-3 px-2 flex-shrink-0">
        <div className="space-y-0.5">
          {PLATFORMS.map((p) => (
            <PlatformSidebarItem
              key={p.id}
              platform={p}
              isActive={selectedPlatform === p.id}
              onClick={() => setSelectedPlatform(p.id)}
            />
          ))}
        </div>
      </div>

      {/* 右侧内容面板 */}
      <ScrollArea className="flex-1 min-w-0">
        <div className="px-6 py-4">
          {renderPlatformPanel(selectedPlatform)}
        </div>
      </ScrollArea>
    </div>
  )
}
