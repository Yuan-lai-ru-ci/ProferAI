/**
 * McpDetailSheet — MCP 服务器编辑 / 新增右侧抽屉
 *
 * 复用 McpServerForm（自带保存逻辑），server 为 null 时是新增模式。
 */

import * as React from 'react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ShieldCheck } from 'lucide-react'
import { McpServerForm } from '@/components/settings/McpServerForm'
import type { McpServerEntry } from '@profer/shared'

interface McpDetailSheetProps {
  open: boolean
  server: { name: string; entry: McpServerEntry } | null
  workspaceSlug: string
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  onChanged?: () => void
}

export function McpDetailSheet({ open, server, workspaceSlug, onOpenChange, onSaved, onChanged }: McpDetailSheetProps): React.ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent hideClose side="right" className="w-[560px] sm:max-w-[560px] overflow-y-auto scrollbar-thin pt-5" aria-describedby={undefined}>
        <SheetTitle className="sr-only">{server ? `编辑 MCP 服务器 ${server.name}` : '添加 MCP 服务器'}</SheetTitle>
        {open && server?.name === 'lark-mcp' && server.entry.isBuiltin === true ? (
          <div className="space-y-4 px-1 pt-3">
            <div className="flex items-center gap-2 text-lg font-medium text-foreground">
              <ShieldCheck className="size-5 text-blue-600 dark:text-blue-400" />
              官方 Lark MCP
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4 text-sm leading-6 text-foreground/80">
              此服务器由 Profer 的飞书集成托管。它的 <code>--tools</code> 参数内部使用逗号列表，不能通过通用 MCP 编辑器修改，否则会被拆成多个命令行参数并导致服务断开。
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/35 p-4 text-sm leading-6 text-muted-foreground">
              请到 <strong className="text-foreground">设置 → 远程连接 → 飞书</strong> 中使用“官方 Lark MCP”区域完成凭据保存、用户授权、连接测试、启用或停用。
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-border/70 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              关闭
            </button>
          </div>
        ) : open && (
          <McpServerForm
            key={server?.name ?? '__new__'}
            server={server}
            workspaceSlug={workspaceSlug}
            onSaved={onSaved}
            onChanged={onChanged}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
