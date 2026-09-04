/**
 * TabletConnectionSettings — 平板「连接」设置页
 *
 * 展示本设备与电脑端 remote-service 的绑定状态（只读），提供解绑操作。
 * 服务器地址 / 访问令牌均只读：修改地址属于「重绑定」语义，走解绑 → 连接页重新输入。
 * 解绑通过 tabletUnbindRequestAtom 通知 tablet/main.tsx 的 App 组件执行完整清理。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Copy, Loader2, Link as LinkIcon, ShieldAlert, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsCard } from './primitives'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { tabletConnectionStatusAtom, tabletUnbindRequestAtom, type TabletConnectionStatus } from '@/atoms/tablet-settings'

/** 连接状态徽标文案与配色 */
const STATUS_META: Record<TabletConnectionStatus, { label: string; dot: string; text: string }> = {
  open: { label: '已连接', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-500' },
  connecting: { label: '正在连接…', dot: 'bg-amber-500 animate-pulse', text: 'text-amber-600 dark:text-amber-500' },
  reconnecting: { label: '重连中…', dot: 'bg-amber-500 animate-pulse', text: 'text-amber-600 dark:text-amber-500' },
  error: { label: '连接失败', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-500' },
  unauthorized: { label: '令牌无效', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-500' },
  idle: { label: '未绑定', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
}

function getStoredToken(): string { return localStorage.getItem('profer-remote-token') || '' }
function getStoredServerUrl(): string { return localStorage.getItem('profer-remote-server') || '' }

/** 掩码展示 Token：只保留后 4 位可见 */
function maskToken(token: string): string {
  if (token.length <= 4) return '••••'
  return '••••••••' + token.slice(-4)
}

/** 只读值行（带复制按钮） */
function ReadonlyValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }): React.ReactElement {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label}已复制`)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <code className={`mt-1 block truncate text-xs text-muted-foreground ${secret ? 'select-all' : ''}`}>{value}</code>
      </div>
      <Button variant="ghost" size="icon" className="shrink-0" onClick={() => void copy()} aria-label={`复制${label}`}>
        <Copy className="size-4" />
      </Button>
    </div>
  )
}

export function TabletConnectionSettings(): React.ReactElement {
  const status = useAtomValue(tabletConnectionStatusAtom)
  const setUnbindRequest = useSetAtom(tabletUnbindRequestAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const token = getStoredToken()
  const serverUrl = getStoredServerUrl()
  const statusMeta = STATUS_META[status] ?? STATUS_META.idle

  const confirmUnbind = (): void => {
    setConfirmOpen(false)
    setSettingsOpen(false)
    setUnbindRequest((n) => n + 1)
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="连接" description="本设备与电脑端 Profer 的连接状态">
        <SettingsCard>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="text-sm font-medium text-foreground">连接状态</div>
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <span className={`size-1.5 shrink-0 rounded-full ${statusMeta.dot}`} aria-hidden />
              <span className={statusMeta.text}>{statusMeta.label}</span>
            </span>
          </div>
          {status === 'connecting' || status === 'reconnecting' ? (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在尝试连接电脑端服务…
            </div>
          ) : null}
          {status === 'unauthorized' ? (
            <div className="flex items-start gap-2 px-4 py-3 text-xs leading-5 text-destructive">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              访问令牌无效或已失效，请解绑后在连接页重新输入电脑端启动日志中的 Token。
            </div>
          ) : null}
          {status === 'error' ? (
            <div className="flex items-start gap-2 px-4 py-3 text-xs leading-5 text-destructive">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              连接失败，请确认电脑端已开启移动模式，且本设备与电脑在同一局域网。
            </div>
          ) : null}
          <ReadonlyValue
            label="服务器地址"
            value={serverUrl || '自动推导（与当前页面同源）'}
          />
          <ReadonlyValue
            label="访问令牌"
            value={token ? maskToken(token) : '未保存'}
            secret={Boolean(token)}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="设备管理" description="解绑后本机保存的服务器地址与访问令牌将被清除，需要重新输入才能继续使用。">
        <SettingsCard divided={false}>
          <div className="px-4 py-3">
            <Button
              type="button"
              variant="outline"
              className="gap-2 text-destructive hover:text-destructive hover:border-destructive/40"
              onClick={() => setConfirmOpen(true)}
            >
              <Unplug className="size-4" />
              解绑此设备
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解绑此设备？</AlertDialogTitle>
            <AlertDialogDescription>
              解绑后将清除本机保存的服务器地址和访问令牌，断开当前连接并回到连接页，需要重新输入才能继续使用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmUnbind}>
              确认解绑
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
