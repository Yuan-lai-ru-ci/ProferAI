/**
 * 聊天窗口图片复制到剪贴板。
 *
 * 两条路径，由调用方按「图片有没有落盘」选择：
 * - `copyAttachmentImage`：已落盘附件（消息附件 / Agent 工具产出图）→ 主进程 IPC，
 *   `clipboard.writeImage` 不依赖渲染层焦点与剪贴板权限，最稳；
 * - `copyPreviewUrlImage`：只有预览 URL（待发送附件的 blob:/data: URL、markdown 内嵌图的
 *   profer-file:// URL）→ renderer fetch + `ClipboardItem`。`profer-file` 协议注册时带
 *   `supportFetchAPI`，可被 fetch；调用点均在用户手势中，窗口聚焦，可用。
 */

/** 复制已落盘的附件图片（localPath 需通过主进程附件安全校验，否则抛错） */
export async function copyAttachmentImage(localPath: string): Promise<void> {
  const ok = await window.electronAPI.copyImage(localPath)
  if (!ok) throw new Error('图片数据为空或格式不受支持')
}

/** 复制预览 URL 图片（blob: / data: / profer-file: 等可 fetch 的地址） */
export async function copyPreviewUrlImage(src: string): Promise<void> {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`读取图片失败: HTTP ${response.status}`)
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error(`不是图片类型: ${blob.type || '未知'}`)
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

export interface CopyChatImageOptions {
  /** 附件本地路径（已落盘），优先走主进程 */
  localPath?: string
  /** 预览 URL（未落盘时的回退） */
  src?: string
}

/** 统一入口：优先 localPath，回退预览 URL，两者皆无则抛错 */
export async function copyChatImage(options: CopyChatImageOptions): Promise<void> {
  if (options.localPath) {
    await copyAttachmentImage(options.localPath)
    return
  }
  if (options.src) {
    await copyPreviewUrlImage(options.src)
    return
  }
  throw new Error('没有可复制的图片数据')
}
