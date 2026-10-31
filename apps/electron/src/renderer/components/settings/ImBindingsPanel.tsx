/**
 * ImBindingsPanel - IM 聊天绑定管理（钉钉 / 微信共用）
 *
 * 飞书有自己的绑定管理（含群聊/单聊分组、改绑会话），这里给另外两个平台用：
 * 展示「聊天 → 工作区 / 会话」的映射，支持解除绑定与刷新。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Link2Off, RefreshCw } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
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
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { IntegrationSettingsFeedback } from './IntegrationSettingsFeedback'

/** 面板需要的绑定字段（钉钉/微信各自的结构都满足） */
export interface ImBindingRow {
  chatId: string
  workspaceId: string
  sessionId: string
  /** 钉钉多 Bot 场景下的 Bot 名称 */
  botName?: string
}

interface ImBindingsPanelProps {
  title: string
  description: string
  bindings: ImBindingRow[]
  loading: boolean
  error: string
  emptyHint: string
  onRefresh: () => void
  onRemove: (chatId: string) => Promise<void> | void
}

/** chatId 通常很长，展示时保留首尾便于人工识别 */
function shortenChatId(chatId: string): string {
  if (chatId.length <= 18) return chatId
  return `${chatId.slice(0, 8)}…${chatId.slice(-6)}`
}

export function ImBindingsPanel({
  title,
  description,
  bindings,
  loading,
  error,
  emptyHint,
  onRefresh,
  onRemove,
}: ImBindingsPanelProps): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const [removing, setRemoving] = React.useState<string | null>(null)

  const workspaceName = React.useCallback(
    (id: string): string => workspaces.find((workspace) => workspace.id === id)?.name ?? '（工作区已删除）',
    [workspaces],
  )
  const sessionTitle = React.useCallback(
    (id: string): string => sessions.find((session) => session.id === id)?.title ?? '（会话已删除）',
    [sessions],
  )

  const handleRemove = React.useCallback(
    async (chatId: string) => {
      setRemoving(chatId)
      try {
        await onRemove(chatId)
      } finally {
        setRemoving(null)
      }
    },
    [onRemove],
  )

  return (
    <SettingsSection
      title={title}
      description={description}
      action={
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
          <span className="ml-1.5">刷新</span>
        </Button>
      }
    >
      {error && <IntegrationSettingsFeedback message={error} onRetry={onRefresh} />}

      {loading && bindings.length === 0 ? (
        <IntegrationSettingsFeedback loading message="正在读取聊天绑定…" />
      ) : bindings.length === 0 ? (
        <SettingsCard divided={false}>
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyHint}</div>
        </SettingsCard>
      ) : (
        <SettingsCard>
          {bindings.map((binding) => (
            <div
              key={binding.chatId}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="truncate text-sm font-medium text-foreground">
                  {shortenChatId(binding.chatId)}
                  {binding.botName && (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                      {binding.botName}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {workspaceName(binding.workspaceId)} · {sessionTitle(binding.sessionId)}
                </div>
              </div>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="ghost" disabled={removing === binding.chatId}>
                    <Link2Off className="size-3.5" />
                    <span className="ml-1.5">解除绑定</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>解除这个聊天绑定？</AlertDialogTitle>
                    <AlertDialogDescription>
                      解除后，该聊天下次发消息会重新创建一个会话，不会删除已有会话本身。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void handleRemove(binding.chatId)}>
                      解除绑定
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  )
}
