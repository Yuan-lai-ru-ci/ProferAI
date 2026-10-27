/**
 * ChatImageContextMenu — 聊天窗口图片的右键菜单
 *
 * 覆盖所有「消息里的图片」表面：用户消息附件、Agent 工具产出缩略图、
 * 输入区待发送附件、markdown 内嵌图。菜单项：
 * - 复制图片：localPath 走主进程 IPC；预览 URL 走 fetch + ClipboardItem（见 lib）
 * - 保存图片：仅调用方传入 onSave 时出现
 *
 * 复制动作与 Lightbox 工具栏的「复制」按钮共用 useCopyChatImageAction，反馈一致。
 */

import * as React from 'react'
import { Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@profer/ui/primitives/context-menu'
import { copyChatImage, type CopyChatImageOptions } from '@/lib/copy-image-to-clipboard'

interface ChatImageContextMenuProps {
  /** 附件本地路径（已落盘），优先走主进程复制 */
  localPath?: string
  /** 预览 URL（blob: / data: / profer-file:，未落盘时的回退） */
  src?: string
  /** 保存图片回调；不传则不显示「保存图片」项 */
  onSave?: () => void
  children: React.ReactNode
}

export function ChatImageContextMenu({
  localPath,
  src,
  onSave,
  children,
}: ChatImageContextMenuProps): React.ReactElement {
  const copyImage = useCopyChatImageAction()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-36 z-[9999] min-w-0 p-0.5">
        <ContextMenuItem
          className="text-xs py-1 [&>svg]:size-3.5"
          onSelect={() => { void copyImage({ localPath, src }) }}
        >
          <Copy size={14} />
          复制图片
        </ContextMenuItem>
        {onSave && (
          <ContextMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={onSave}>
            <Download size={14} />
            保存图片
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 复制图片 + toast 反馈。右键菜单项与 Lightbox 工具栏按钮共用同一动作与文案。 */
export function useCopyChatImageAction(): (options: CopyChatImageOptions) => Promise<void> {
  return React.useCallback(async (options: CopyChatImageOptions): Promise<void> => {
    try {
      await copyChatImage(options)
      toast.success('图片已复制到剪贴板')
    } catch (error) {
      console.error('[ChatImageContextMenu] 复制图片失败:', error)
      toast.error(`复制图片失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])
}
