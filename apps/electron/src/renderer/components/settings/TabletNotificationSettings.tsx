/**
 * TabletNotificationSettings — 平板「通知」设置页
 *
 * 目前只包含「Agent 完成提醒音」一个开关：Agent 回合在电脑端完成时，
 * 若本设备正打开着其他会话（或未在查看该会话），播放短促提示音。
 *
 * 实现：Web Audio API 合成提示音（零插件依赖，浏览器与 Capacitor WebView 通用）；
 * 开关经 tabletNotifyCompleteAtom 持久化到 localStorage。
 *
 * 限制说明（如实告知用户）：App 在后台时 Android WebView 会被冻结、WebSocket 断开，
 * 收不到完成事件，因此无法推送系统通知栏提醒。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Bell } from 'lucide-react'
import { SettingsSection, SettingsCard, SettingsToggle } from './primitives'
import { tabletNotifyCompleteAtom } from '@/atoms/tablet-settings'

export function TabletNotificationSettings(): React.ReactElement {
  const [notifyComplete, setNotifyComplete] = useAtom(tabletNotifyCompleteAtom)

  return (
    <div className="space-y-6">
      <SettingsSection title="通知" description="Agent 在电脑端运行时的提醒方式">
        <SettingsCard>
          <SettingsToggle
            label="完成提醒音"
            description="Agent 回合完成时播放短促提示音（仅在其他会话完成时提醒，不打扰正在查看的会话）"
            checked={notifyComplete}
            onCheckedChange={setNotifyComplete}
          />
        </SettingsCard>
      </SettingsSection>

      <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        <Bell className="mt-0.5 size-4 shrink-0" />
        <span>
          仅在本设备保持前台时生效。App 进入后台后系统会冻结网页进程、断开与电脑的连接，无法收到完成事件，因此暂不支持系统通知栏推送。
        </span>
      </div>
    </div>
  )
}
